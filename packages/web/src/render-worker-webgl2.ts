/**
 * WebGL2 render backend — runs inside the render worker.
 *
 * Reads cells from the SAB-backed CellGrid, packs per-cell instance data,
 * and draws via instanced quads against a glyph atlas texture.
 */

import type { Theme } from "@next_term/core";
import { normalizeSelection } from "@next_term/core";
import { ATTR_BOLD, ATTR_INVERSE, ATTR_ITALIC } from "./cell-attrs.js";
import type { BackendInitOptions, RenderBackend, RenderFrame } from "./render-worker-backend.js";
import { build256Palette } from "./renderer.js";
import {
  BG_INSTANCE_FLOATS,
  GLYPH_INSTANCE_FLOATS,
  GlyphAtlas,
  hexToFloat4,
  packBgInstance,
  packGlyphInstance,
} from "./webgl-renderer.js";
import { type ColorFloat4, resolveColorFloat } from "./webgl-utils.js";

// ---------------------------------------------------------------------------
// Shader sources
// ---------------------------------------------------------------------------

const BG_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_cellPos;
in vec4 a_color;
uniform vec2 u_resolution;
uniform vec2 u_cellSize;
out vec4 v_color;
void main() {
  vec2 cellPixelPos = a_cellPos * u_cellSize;
  vec2 pos = cellPixelPos + a_position * u_cellSize;
  vec2 clipPos = (pos / u_resolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y;
  gl_Position = vec4(clipPos, 0.0, 1.0);
  v_color = a_color;
}
`;

const BG_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() {
  fragColor = v_color;
}
`;

const GLYPH_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_cellPos;
in vec4 a_color;
in vec4 a_texCoord;
in vec2 a_glyphSize;
uniform vec2 u_resolution;
uniform vec2 u_cellSize;
out vec4 v_color;
out vec2 v_texCoord;
void main() {
  vec2 cellPixelPos = a_cellPos * u_cellSize;
  vec2 size = (a_glyphSize.x > 0.0) ? a_glyphSize : u_cellSize;
  vec2 pos = cellPixelPos + a_position * size;
  vec2 clipPos = (pos / u_resolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y;
  gl_Position = vec4(clipPos, 0.0, 1.0);
  v_color = a_color;
  v_texCoord = a_texCoord.xy + a_position * a_texCoord.zw;
}
`;

const GLYPH_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
in vec2 v_texCoord;
uniform sampler2D u_atlas;
out vec4 fragColor;
void main() {
  float alpha = texture(u_atlas, v_texCoord).a;
  fragColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("Failed to create program");
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  gl.detachShader(program, vert);
  gl.detachShader(program, frag);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return program;
}

// ---------------------------------------------------------------------------
// WebGL2Backend
// ---------------------------------------------------------------------------

export class WebGL2Backend implements RenderBackend {
  private canvas: OffscreenCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private atlas: GlyphAtlas | null = null;
  private contextLost = false;

  private theme!: Theme;
  private palette: string[] = [];
  private paletteFloat: ColorFloat4[] = [];
  private themeFgFloat: ColorFloat4 = [0, 0, 0, 1];
  private themeBgFloat: ColorFloat4 = [0, 0, 0, 1];
  private themeCursorFloat: ColorFloat4 = [0, 0, 0, 1];

  private fontSize = 14;
  private fontFamily = "monospace";
  private fontWeight = 400;
  private fontWeightBold = 700;
  private dpr = 1;
  private cellWidth = 0;
  private cellHeight = 0;

  // GL resources
  private bgProgram: WebGLProgram | null = null;
  private glyphProgram: WebGLProgram | null = null;
  private quadVBO: WebGLBuffer | null = null;
  private quadEBO: WebGLBuffer | null = null;
  private bgInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
  private glyphInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
  private activeBufferIdx = 0;
  private bgVAOs: [WebGLVertexArrayObject | null, WebGLVertexArrayObject | null] = [null, null];
  private glyphVAOs: [WebGLVertexArrayObject | null, WebGLVertexArrayObject | null] = [null, null];

  // Cached uniform locations
  private bgResolutionLoc: WebGLUniformLocation | null = null;
  private bgCellSizeLoc: WebGLUniformLocation | null = null;
  private glyphResolutionLoc: WebGLUniformLocation | null = null;
  private glyphCellSizeLoc: WebGLUniformLocation | null = null;
  private glyphAtlasLoc: WebGLUniformLocation | null = null;

  private bgInstances: Float32Array = new Float32Array(0);
  private glyphInstances: Float32Array = new Float32Array(0);

  private readonly cursorDataBuf = new Float32Array(BG_INSTANCE_FLOATS);
  private selBuffer = new Float32Array(256 * BG_INSTANCE_FLOATS);

  // Hooks for context loss — the worker entry wires these to its render loop.
  private onContextLost: (() => void) | null = null;
  private onContextRestored: (() => void) | null = null;

  setContextHandlers(onLost: () => void, onRestored: () => void): void {
    this.onContextLost = onLost;
    this.onContextRestored = onRestored;
  }

  init(opts: BackendInitOptions): void {
    this.canvas = opts.canvas;
    this.theme = opts.theme;
    this.fontSize = opts.fontSize;
    this.fontFamily = opts.fontFamily;
    this.fontWeight = opts.fontWeight;
    this.fontWeightBold = opts.fontWeightBold;
    this.dpr = opts.dpr;
    this.cellWidth = opts.cellWidth;
    this.cellHeight = opts.cellHeight;

    this.buildPaletteFloat();

    const gl = opts.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;

    if (!gl) throw new Error("WebGL2 not available in worker");

    // NOTE: software-renderer detection lives on the main thread
    // (hasHardwareWebGL2 in web-terminal.ts), which is the single source of
    // truth for picking the backend. The backend obeys the main thread's
    // choice — that's what makes renderer:"webgl" actually force WebGL2 even
    // on software rasterizers, as documented.

    this.gl = gl;

    opts.canvas.addEventListener("webglcontextlost", (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    opts.canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      this.initGLResources();
      this.onContextRestored?.();
    });

    this.syncCanvasSize(opts.cols, opts.rows, opts.cellWidth, opts.cellHeight, opts.dpr);
    this.initGLResources();
    this.ensureInstanceBuffers(opts.cols, opts.rows);

    this.atlas = new GlyphAtlas(
      Math.round(opts.fontSize * opts.dpr),
      opts.fontFamily,
      opts.fontWeight,
      opts.fontWeightBold,
    );
    this.atlas.prewarmASCII();
  }

  syncCanvasSize(
    cols: number,
    rows: number,
    cellWidth: number,
    cellHeight: number,
    dpr: number,
  ): void {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.dpr = dpr;
    if (!this.canvas) return;
    const width = cols * cellWidth;
    const height = rows * cellHeight;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ensureInstanceBuffers(cols, rows);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.buildPaletteFloat();
  }

  setFont(
    fontSize: number,
    fontFamily: string,
    fontWeight: number,
    fontWeightBold: number,
    dpr: number,
    cellWidth: number,
    cellHeight: number,
  ): void {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.fontWeight = fontWeight;
    this.fontWeightBold = fontWeightBold;
    this.dpr = dpr;
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;

    if (this.gl && this.atlas) {
      this.atlas.dispose(this.gl);
    }
    this.atlas = new GlyphAtlas(Math.round(fontSize * dpr), fontFamily, fontWeight, fontWeightBold);
    this.atlas.prewarmASCII();

    if (this.gl) {
      this.initGLResources();
    }
  }

  render(frame: RenderFrame): void {
    if (this.contextLost) return;
    const gl = this.gl;
    const atlas = this.atlas;
    if (!gl || !atlas) return;
    const {
      grid,
      cols,
      rows,
      cursorRow,
      cursorCol,
      cursorVisible,
      cursorStyle,
      selection,
      highlights,
    } = frame;

    // Instance packing — background for every cell, glyphs for non-space cells.
    const bgCount = cols * rows;
    let glyphCount = 0;

    for (let row = 0; row < rows; row++) {
      if (!grid.isDirty(row)) {
        // Count glyphs in clean rows so glyphCount stays correct.
        for (let col = 0; col < cols; col++) {
          const codepoint = grid.getCodepoint(row, col);
          if (grid.isSpacerCell(row, col)) continue;
          if (codepoint > 0x20) glyphCount++;
        }
        continue;
      }

      for (let col = 0; col < cols; col++) {
        const codepoint = grid.getCodepoint(row, col);

        if (grid.isSpacerCell(row, col)) {
          packBgInstance(
            this.bgInstances,
            (row * cols + col) * BG_INSTANCE_FLOATS,
            col,
            row,
            0,
            0,
            0,
            0,
          );
          continue;
        }

        const fgIdx = grid.getFgIndex(row, col);
        const bgIdx = grid.getBgIndex(row, col);
        const attrs = grid.getAttrs(row, col);
        const fgIsRGB = grid.isFgRGB(row, col);
        const bgIsRGB = grid.isBgRGB(row, col);
        const wide = grid.isWide(row, col);

        let fg = resolveColorFloat(
          fgIdx,
          fgIsRGB,
          grid.getFgRGB(row, col),
          true,
          this.paletteFloat,
          this.themeFgFloat,
          this.themeBgFloat,
        );
        let bg = resolveColorFloat(
          bgIdx,
          bgIsRGB,
          grid.getBgRGB(row, col),
          false,
          this.paletteFloat,
          this.themeFgFloat,
          this.themeBgFloat,
        );

        if (attrs & ATTR_INVERSE) {
          const tmp = fg;
          fg = bg;
          bg = tmp;
        }

        packBgInstance(
          this.bgInstances,
          (row * cols + col) * BG_INSTANCE_FLOATS,
          col,
          row,
          bg[0],
          bg[1],
          bg[2],
          bg[3],
        );

        if (wide && col + 1 < cols) {
          packBgInstance(
            this.bgInstances,
            (row * cols + col + 1) * BG_INSTANCE_FLOATS,
            col + 1,
            row,
            bg[0],
            bg[1],
            bg[2],
            bg[3],
          );
        }

        if (codepoint > 0x20) {
          const bold = !!(attrs & ATTR_BOLD);
          const italic = !!(attrs & ATTR_ITALIC);
          const glyph = atlas.getGlyph(codepoint, bold, italic);
          if (glyph) glyphCount++;
        }
      }
      grid.clearDirty(row);
    }

    // Glyph instances are sparse — rebuild the array from scratch.
    let gi = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const codepoint = grid.getCodepoint(row, col);
        if (codepoint <= 0x20) continue;
        if (grid.isSpacerCell(row, col)) continue;
        const fgIdx = grid.getFgIndex(row, col);
        const attrs = grid.getAttrs(row, col);
        const fgIsRGB = grid.isFgRGB(row, col);
        const bgIsRGB = grid.isBgRGB(row, col);
        const bgIdx = grid.getBgIndex(row, col);
        let fg = resolveColorFloat(
          fgIdx,
          fgIsRGB,
          grid.getFgRGB(row, col),
          true,
          this.paletteFloat,
          this.themeFgFloat,
          this.themeBgFloat,
        );
        let bg = resolveColorFloat(
          bgIdx,
          bgIsRGB,
          grid.getBgRGB(row, col),
          false,
          this.paletteFloat,
          this.themeFgFloat,
          this.themeBgFloat,
        );
        if (attrs & ATTR_INVERSE) {
          const tmp = fg;
          fg = bg;
          bg = tmp;
        }
        const bold = !!(attrs & ATTR_BOLD);
        const italic = !!(attrs & ATTR_ITALIC);
        const glyph = atlas.getGlyph(codepoint, bold, italic);
        if (glyph) {
          packGlyphInstance(
            this.glyphInstances,
            gi * GLYPH_INSTANCE_FLOATS,
            col,
            row,
            fg[0],
            fg[1],
            fg[2],
            fg[3],
            glyph.u,
            glyph.v,
            glyph.w,
            glyph.h,
            glyph.pw,
            glyph.ph,
          );
          gi++;
        }
      }
    }
    glyphCount = gi;

    atlas.upload(gl);

    const canvasWidth = this.canvas?.width ?? 0;
    const canvasHeight = this.canvas?.height ?? 0;
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(this.themeBgFloat[0], this.themeBgFloat[1], this.themeBgFloat[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const cellW = this.cellWidth * this.dpr;
    const cellH = this.cellHeight * this.dpr;

    // Alternate VBOs — write to current index, GPU reads previous.
    const writeIdx = this.activeBufferIdx;
    this.activeBufferIdx ^= 1;

    const curBgVBO = this.bgInstanceVBOs[writeIdx];
    const curGlyphVBO = this.glyphInstanceVBOs[writeIdx];
    const curBgVAO = this.bgVAOs[writeIdx];
    const curGlyphVAO = this.glyphVAOs[writeIdx];

    if (bgCount > 0 && this.bgProgram && curBgVAO && curBgVBO) {
      gl.useProgram(this.bgProgram);
      gl.uniform2f(this.bgResolutionLoc, canvasWidth, canvasHeight);
      gl.uniform2f(this.bgCellSizeLoc, cellW, cellH);
      gl.bindBuffer(gl.ARRAY_BUFFER, curBgVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.bgInstances.subarray(0, bgCount * BG_INSTANCE_FLOATS),
        gl.STREAM_DRAW,
      );
      gl.bindVertexArray(curBgVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, bgCount);
    }

    if (glyphCount > 0 && this.glyphProgram && curGlyphVAO && curGlyphVBO) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.glyphProgram);
      gl.uniform2f(this.glyphResolutionLoc, canvasWidth, canvasHeight);
      gl.uniform2f(this.glyphCellSizeLoc, cellW, cellH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas.getTexture() ?? null);
      gl.uniform1i(this.glyphAtlasLoc, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, curGlyphVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.glyphInstances.subarray(0, glyphCount * GLYPH_INSTANCE_FLOATS),
        gl.STREAM_DRAW,
      );
      gl.bindVertexArray(curGlyphVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, glyphCount);
      gl.disable(gl.BLEND);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Highlights first, then selection, then cursor — matches every other
    // renderer (Canvas2DBackend, main-thread Canvas2DRenderer, both shared
    // contexts) so layering stays consistent when search matches overlap
    // selections.
    this.drawHighlights(highlights, cols);
    this.drawSelection(selection, cols, rows);
    this.drawCursor(cursorRow, cursorCol, cursorVisible, cursorStyle);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    if (gl) {
      if (this.atlas) this.atlas.dispose(gl);
      if (this.bgProgram) gl.deleteProgram(this.bgProgram);
      if (this.glyphProgram) gl.deleteProgram(this.glyphProgram);
      if (this.quadVBO) gl.deleteBuffer(this.quadVBO);
      if (this.quadEBO) gl.deleteBuffer(this.quadEBO);
      if (this.bgInstanceVBOs[0]) gl.deleteBuffer(this.bgInstanceVBOs[0]);
      if (this.bgInstanceVBOs[1]) gl.deleteBuffer(this.bgInstanceVBOs[1]);
      if (this.glyphInstanceVBOs[0]) gl.deleteBuffer(this.glyphInstanceVBOs[0]);
      if (this.glyphInstanceVBOs[1]) gl.deleteBuffer(this.glyphInstanceVBOs[1]);
      if (this.bgVAOs[0]) gl.deleteVertexArray(this.bgVAOs[0]);
      if (this.bgVAOs[1]) gl.deleteVertexArray(this.bgVAOs[1]);
      if (this.glyphVAOs[0]) gl.deleteVertexArray(this.glyphVAOs[0]);
      if (this.glyphVAOs[1]) gl.deleteVertexArray(this.glyphVAOs[1]);
    }
    this.canvas = null;
    this.gl = null;
    this.atlas = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildPaletteFloat(): void {
    this.palette = build256Palette(this.theme);
    this.paletteFloat = this.palette.map((c) => hexToFloat4(c));
    this.themeFgFloat = hexToFloat4(this.theme.foreground);
    this.themeBgFloat = hexToFloat4(this.theme.background);
    this.themeCursorFloat = hexToFloat4(this.theme.cursor);
  }

  private initGLResources(): void {
    const gl = this.gl;
    if (!gl) return;

    this.bgProgram = createProgram(gl, BG_VERTEX_SHADER, BG_FRAGMENT_SHADER);
    this.glyphProgram = createProgram(gl, GLYPH_VERTEX_SHADER, GLYPH_FRAGMENT_SHADER);

    const quadVerts = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);

    this.quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    this.quadEBO = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    this.bgInstanceVBOs = [gl.createBuffer(), gl.createBuffer()];
    this.glyphInstanceVBOs = [gl.createBuffer(), gl.createBuffer()];
    this.activeBufferIdx = 0;

    this.bgResolutionLoc = gl.getUniformLocation(this.bgProgram, "u_resolution");
    this.bgCellSizeLoc = gl.getUniformLocation(this.bgProgram, "u_cellSize");
    this.glyphResolutionLoc = gl.getUniformLocation(this.glyphProgram, "u_resolution");
    this.glyphCellSizeLoc = gl.getUniformLocation(this.glyphProgram, "u_cellSize");
    this.glyphAtlasLoc = gl.getUniformLocation(this.glyphProgram, "u_atlas");

    for (let i = 0; i < 2; i++) {
      this.bgVAOs[i] = gl.createVertexArray();
      gl.bindVertexArray(this.bgVAOs[i]);
      this.setupBgVAO(gl, i);
      gl.bindVertexArray(null);

      this.glyphVAOs[i] = gl.createVertexArray();
      gl.bindVertexArray(this.glyphVAOs[i]);
      this.setupGlyphVAO(gl, i);
      gl.bindVertexArray(null);
    }

    if (this.atlas) this.atlas.recreateTexture();
  }

  private setupBgVAO(gl: WebGL2RenderingContext, bufIdx: number): void {
    const FLOAT = 4;
    const program = this.bgProgram;
    if (!program) return;

    const aPos = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBOs[bufIdx]);
    const stride = BG_INSTANCE_FLOATS * FLOAT;

    const aCellPos = gl.getAttribLocation(program, "a_cellPos");
    gl.enableVertexAttribArray(aCellPos);
    gl.vertexAttribPointer(aCellPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(aCellPos, 1);

    const aColor = gl.getAttribLocation(program, "a_color");
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, stride, 2 * FLOAT);
    gl.vertexAttribDivisor(aColor, 1);
  }

  private setupGlyphVAO(gl: WebGL2RenderingContext, bufIdx: number): void {
    const FLOAT = 4;
    const program = this.glyphProgram;
    if (!program) return;

    const aPos = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInstanceVBOs[bufIdx]);
    const stride = GLYPH_INSTANCE_FLOATS * FLOAT;

    const aCellPos = gl.getAttribLocation(program, "a_cellPos");
    gl.enableVertexAttribArray(aCellPos);
    gl.vertexAttribPointer(aCellPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(aCellPos, 1);

    const aColor = gl.getAttribLocation(program, "a_color");
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, stride, 2 * FLOAT);
    gl.vertexAttribDivisor(aColor, 1);

    const aTexCoord = gl.getAttribLocation(program, "a_texCoord");
    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aTexCoord, 4, gl.FLOAT, false, stride, 6 * FLOAT);
    gl.vertexAttribDivisor(aTexCoord, 1);

    const aGlyphSize = gl.getAttribLocation(program, "a_glyphSize");
    gl.enableVertexAttribArray(aGlyphSize);
    gl.vertexAttribPointer(aGlyphSize, 2, gl.FLOAT, false, stride, 10 * FLOAT);
    gl.vertexAttribDivisor(aGlyphSize, 1);
  }

  private ensureInstanceBuffers(cols: number, rows: number): void {
    const totalCells = cols * rows;
    const neededBg = totalCells * BG_INSTANCE_FLOATS;
    const neededGlyph = totalCells * GLYPH_INSTANCE_FLOATS;
    if (this.bgInstances.length < neededBg) {
      this.bgInstances = new Float32Array(neededBg);
    }
    if (this.glyphInstances.length < neededGlyph) {
      this.glyphInstances = new Float32Array(neededGlyph);
    }
  }

  private drawSelection(selection: RenderFrame["selection"], cols: number, rows: number): void {
    const gl = this.gl;
    if (!gl || !selection) return;
    if (!this.bgProgram || !this.bgVAOs[0] || !this.bgInstanceVBOs[0]) return;

    // Normalize so reversed (bottom-up) drags still render — without this the
    // `sr > er` case leaves `sr <= er` false and the whole loop is skipped.
    const norm = normalizeSelection(selection);
    const sr = Math.max(0, norm.startRow);
    const er = Math.min(rows - 1, norm.endRow);
    if (sr === er && norm.startCol === norm.endCol) return;

    const selColor = hexToFloat4(this.theme.selectionBackground);
    let selIdx = 0;

    for (let row = sr; row <= er; row++) {
      let colStart: number;
      let colEnd: number;
      if (sr === er) {
        colStart = norm.startCol;
        colEnd = norm.endCol;
      } else if (row === sr) {
        colStart = norm.startCol;
        colEnd = cols - 1;
      } else if (row === er) {
        colStart = 0;
        colEnd = norm.endCol;
      } else {
        colStart = 0;
        colEnd = cols - 1;
      }

      for (let col = colStart; col <= colEnd; col++) {
        const needed = (selIdx + 1) * BG_INSTANCE_FLOATS;
        if (needed > this.selBuffer.length) {
          const newBuf = new Float32Array(needed * 2);
          newBuf.set(this.selBuffer);
          this.selBuffer = newBuf;
        }
        const off = selIdx * BG_INSTANCE_FLOATS;
        this.selBuffer[off] = col;
        this.selBuffer[off + 1] = row;
        this.selBuffer[off + 2] = selColor[0];
        this.selBuffer[off + 3] = selColor[1];
        this.selBuffer[off + 4] = selColor[2];
        this.selBuffer[off + 5] = 0.5;
        selIdx++;
      }
    }

    if (selIdx === 0) return;

    gl.useProgram(this.bgProgram);
    gl.uniform2f(this.bgResolutionLoc, this.canvas?.width ?? 0, this.canvas?.height ?? 0);
    gl.uniform2f(this.bgCellSizeLoc, this.cellWidth * this.dpr, this.cellHeight * this.dpr);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBOs[0]);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.selBuffer.subarray(0, selIdx * BG_INSTANCE_FLOATS),
      gl.STREAM_DRAW,
    );

    gl.bindVertexArray(this.bgVAOs[0]);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, selIdx);
  }

  private drawHighlights(highlights: RenderFrame["highlights"], cols: number): void {
    const gl = this.gl;
    if (!gl || highlights.length === 0) return;
    if (!this.bgProgram || !this.bgVAOs[0] || !this.bgInstanceVBOs[0]) return;

    // Pack: cellCol, cellRow, r, g, b, a per instance (BG_INSTANCE_FLOATS).
    // Current match: orange ~ (1.0, 0.647, 0.0, 0.5). Other: yellow (1, 1, 0, 0.3).
    let idx = 0;
    for (const hl of highlights) {
      const width = hl.endCol - hl.startCol + 1;
      if (width <= 0) continue;
      const neededCells = idx + width;
      const neededFloats = neededCells * BG_INSTANCE_FLOATS;
      if (neededFloats > this.selBuffer.length) {
        const grown = new Float32Array(neededFloats * 2);
        grown.set(this.selBuffer);
        this.selBuffer = grown;
      }
      const r = hl.isCurrent ? 1.0 : 1.0;
      const g = hl.isCurrent ? 0.647 : 1.0;
      const b = hl.isCurrent ? 0.0 : 0.0;
      const a = hl.isCurrent ? 0.5 : 0.3;
      for (let c = hl.startCol; c <= hl.endCol && c < cols; c++) {
        const off = idx * BG_INSTANCE_FLOATS;
        this.selBuffer[off] = c;
        this.selBuffer[off + 1] = hl.row;
        this.selBuffer[off + 2] = r;
        this.selBuffer[off + 3] = g;
        this.selBuffer[off + 4] = b;
        this.selBuffer[off + 5] = a;
        idx++;
      }
    }
    if (idx === 0) return;

    gl.useProgram(this.bgProgram);
    gl.uniform2f(this.bgResolutionLoc, this.canvas?.width ?? 0, this.canvas?.height ?? 0);
    gl.uniform2f(this.bgCellSizeLoc, this.cellWidth * this.dpr, this.cellHeight * this.dpr);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBOs[0]);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.selBuffer.subarray(0, idx * BG_INSTANCE_FLOATS),
      gl.STREAM_DRAW,
    );
    gl.bindVertexArray(this.bgVAOs[0]);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, idx);
  }

  private drawCursor(
    cursorRow: number,
    cursorCol: number,
    cursorVisible: boolean,
    cursorStyle: string,
  ): void {
    const gl = this.gl;
    if (!gl || !cursorVisible) return;
    if (!this.bgProgram || !this.bgVAOs[0] || !this.bgInstanceVBOs[0]) return;

    const cc = this.themeCursorFloat;

    gl.useProgram(this.bgProgram);
    gl.uniform2f(this.bgResolutionLoc, this.canvas?.width ?? 0, this.canvas?.height ?? 0);
    gl.uniform2f(this.bgCellSizeLoc, this.cellWidth * this.dpr, this.cellHeight * this.dpr);

    const buf = this.cursorDataBuf;
    buf[0] = cursorCol;
    buf[2] = cc[0];
    buf[3] = cc[1];
    buf[4] = cc[2];

    switch (cursorStyle) {
      case "block":
        buf[1] = cursorRow;
        buf[5] = 0.5;
        break;
      case "underline": {
        const lineH = Math.max(2 * this.dpr, 1);
        buf[1] = cursorRow + (this.cellHeight * this.dpr - lineH) / (this.cellHeight * this.dpr);
        buf[5] = cc[3];
        break;
      }
      case "bar":
        buf[1] = cursorRow;
        buf[5] = cc[3];
        break;
      default:
        buf[1] = cursorRow;
        buf[5] = 0.5;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBOs[0]);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STREAM_DRAW);

    gl.bindVertexArray(this.bgVAOs[0]);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, 1);
  }
}
