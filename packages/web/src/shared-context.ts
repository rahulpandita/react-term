/**
 * SharedWebGLContext — manages a single WebGL2 context shared across
 * multiple terminal panes.
 *
 * Chrome limits WebGL contexts to 16 per page. This class allows any number
 * of terminal panes to render through one context by using `gl.viewport` and
 * `gl.scissor` to partition the canvas into regions.
 *
 * The shared canvas is positioned as an overlay by the consumer (typically
 * TerminalPane). Each registered terminal provides its CellGrid, CursorState,
 * and a viewport rectangle (in CSS pixels relative to the canvas).
 */

import type { CellGrid, CursorState, SelectionRange, Theme } from "@react-term/core";
import { DEFAULT_THEME } from "@react-term/core";
import { build256Palette } from "./renderer.js";
import {
  BG_INSTANCE_FLOATS,
  GLYPH_INSTANCE_FLOATS,
  GlyphAtlas,
  hexToFloat4,
  packBgInstance,
  packGlyphInstance,
} from "./webgl-renderer.js";

// ---------------------------------------------------------------------------
// Attribute bit positions
// ---------------------------------------------------------------------------

const ATTR_BOLD = 0x01;
const ATTR_ITALIC = 0x02;
const ATTR_INVERSE = 0x40;

// ---------------------------------------------------------------------------
// Shader sources (same as webgl-renderer.ts)
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalEntry {
  grid: CellGrid;
  cursor: CursorState;
  selection: SelectionRange | null;
  viewport: { x: number; y: number; width: number; height: number };
}

// ---------------------------------------------------------------------------
// Shader compilation helpers
// ---------------------------------------------------------------------------

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
// SharedWebGLContext
// ---------------------------------------------------------------------------

export class SharedWebGLContext {
  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement;
  private terminals: Map<string, TerminalEntry> = new Map();
  private disposed = false;
  private rafId: number | null = null;

  // GL resources
  private bgProgram: WebGLProgram | null = null;
  private glyphProgram: WebGLProgram | null = null;
  private quadVBO: WebGLBuffer | null = null;
  private quadEBO: WebGLBuffer | null = null;
  private bgInstanceVBO: WebGLBuffer | null = null;
  private glyphInstanceVBO: WebGLBuffer | null = null;
  private bgVAO: WebGLVertexArrayObject | null = null;
  private glyphVAO: WebGLVertexArrayObject | null = null;

  // Instance data (CPU side)
  private bgInstances: Float32Array;
  private glyphInstances: Float32Array;

  // Glyph atlas
  private atlas: GlyphAtlas;

  // Theme / palette
  private theme: Theme;
  private palette: string[];
  private paletteFloat: Array<[number, number, number, number]> = [];
  private themeFgFloat: [number, number, number, number] = [0, 0, 0, 1];
  private themeBgFloat: [number, number, number, number] = [0, 0, 0, 1];
  private themeCursorFloat: [number, number, number, number] = [0, 0, 0, 1];

  private fontSize: number;
  private fontFamily: string;
  private dpr: number;
  private cellWidth = 0;
  private cellHeight = 0;

  constructor(options?: {
    fontSize?: number;
    fontFamily?: string;
    theme?: Partial<Theme>;
    devicePixelRatio?: number;
  }) {
    this.fontSize = options?.fontSize ?? 14;
    this.fontFamily = options?.fontFamily ?? "'Menlo', 'DejaVu Sans Mono', 'Consolas', monospace";
    this.theme = { ...DEFAULT_THEME, ...options?.theme };
    this.dpr =
      options?.devicePixelRatio ?? (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    this.palette = build256Palette(this.theme);
    this.buildPaletteFloat();
    this.measureCellSize();

    this.atlas = new GlyphAtlas(Math.round(this.fontSize * this.dpr), this.fontFamily);

    // Pre-allocate instance buffers
    const maxCells = 80 * 24;
    this.bgInstances = new Float32Array(maxCells * BG_INSTANCE_FLOATS);
    this.glyphInstances = new Float32Array(maxCells * GLYPH_INSTANCE_FLOATS);

    // Create the shared canvas
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.pointerEvents = "none";
  }

  /**
   * Initialize the WebGL context. Must be called after the canvas is in the
   * DOM (or at least after construction if you plan to append it yourself).
   */
  init(): void {
    this.gl = this.canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;

    if (!this.gl) {
      throw new Error("WebGL2 is not available");
    }

    this.initGLResources();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  addTerminal(id: string, grid: CellGrid, cursor: CursorState): void {
    this.terminals.set(id, {
      grid,
      cursor,
      selection: null,
      viewport: { x: 0, y: 0, width: 0, height: 0 },
    });
  }

  setViewport(id: string, x: number, y: number, width: number, height: number): void {
    const entry = this.terminals.get(id);
    if (entry) {
      entry.viewport = { x, y, width, height };
    }
  }

  updateTerminal(id: string, grid: CellGrid, cursor: CursorState): void {
    const entry = this.terminals.get(id);
    if (entry) {
      entry.grid = grid;
      entry.cursor = cursor;
    }
  }

  removeTerminal(id: string): void {
    this.terminals.delete(id);
  }

  getTerminalIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Render all terminals in one frame.
   */
  render(): void {
    if (this.disposed || !this.gl) return;

    const gl = this.gl;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    // Full-canvas clear
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Render each terminal in its viewport
    for (const [_id, entry] of this.terminals) {
      this.renderTerminal(entry);
    }

    gl.disable(gl.SCISSOR_TEST);
  }

  /**
   * Update the shared canvas size to match a container element.
   */
  syncCanvasSize(width: number, height: number): void {
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getCellSize(): { width: number; height: number } {
    return { width: this.cellWidth, height: this.cellHeight };
  }

  startRenderLoop(): void {
    if (this.disposed) return;
    const loop = () => {
      if (this.disposed) return;
      this.render();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stopRenderLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRenderLoop();

    const gl = this.gl;
    if (gl) {
      this.atlas.dispose(gl);
      if (this.bgProgram) gl.deleteProgram(this.bgProgram);
      if (this.glyphProgram) gl.deleteProgram(this.glyphProgram);
      if (this.quadVBO) gl.deleteBuffer(this.quadVBO);
      if (this.quadEBO) gl.deleteBuffer(this.quadEBO);
      if (this.bgInstanceVBO) gl.deleteBuffer(this.bgInstanceVBO);
      if (this.glyphInstanceVBO) gl.deleteBuffer(this.glyphInstanceVBO);
      if (this.bgVAO) gl.deleteVertexArray(this.bgVAO);
      if (this.glyphVAO) gl.deleteVertexArray(this.glyphVAO);
    }

    this.terminals.clear();
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.gl = null;
  }

  // -----------------------------------------------------------------------
  // Per-terminal rendering
  // -----------------------------------------------------------------------

  private renderTerminal(entry: TerminalEntry): void {
    if (!this.gl) return;
    const gl = this.gl;
    const { grid, cursor, viewport } = entry;
    const cols = grid.cols;
    const rows = grid.rows;

    // Convert CSS viewport to device pixels
    const vpX = Math.round(viewport.x * this.dpr);
    const vpY = Math.round(viewport.y * this.dpr);
    const vpW = Math.round(viewport.width * this.dpr);
    const vpH = Math.round(viewport.height * this.dpr);

    // WebGL viewport Y is from bottom; canvas Y is from top
    const canvasHeight = this.canvas.height;
    const glY = canvasHeight - vpY - vpH;

    gl.viewport(vpX, glY, vpW, vpH);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vpX, glY, vpW, vpH);

    // Clear this region with background color
    gl.clearColor(this.themeBgFloat[0], this.themeBgFloat[1], this.themeBgFloat[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Ensure instance buffers are large enough
    const totalCells = cols * rows;
    if (this.bgInstances.length < totalCells * BG_INSTANCE_FLOATS) {
      this.bgInstances = new Float32Array(totalCells * BG_INSTANCE_FLOATS);
    }
    if (this.glyphInstances.length < totalCells * GLYPH_INSTANCE_FLOATS) {
      this.glyphInstances = new Float32Array(totalCells * GLYPH_INSTANCE_FLOATS);
    }

    // Build instance data
    let bgCount = 0;
    let glyphCount = 0;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const codepoint = grid.getCodepoint(row, col);
        const fgIdx = grid.getFgIndex(row, col);
        const bgIdx = grid.getBgIndex(row, col);
        const attrs = grid.getAttrs(row, col);
        const fgIsRGB = grid.isFgRGB(row, col);
        const bgIsRGB = grid.isBgRGB(row, col);

        let fg = this.resolveColorFloat(fgIdx, fgIsRGB, grid, col, true);
        let bg = this.resolveColorFloat(bgIdx, bgIsRGB, grid, col, false);

        if (attrs & ATTR_INVERSE) {
          const tmp = fg;
          fg = bg;
          bg = tmp;
        }

        packBgInstance(
          this.bgInstances,
          bgCount * BG_INSTANCE_FLOATS,
          col,
          row,
          bg[0],
          bg[1],
          bg[2],
          bg[3],
        );
        bgCount++;

        if (codepoint > 0x20) {
          const bold = !!(attrs & ATTR_BOLD);
          const italic = !!(attrs & ATTR_ITALIC);
          const glyph = this.atlas.getGlyph(codepoint, bold, italic);

          if (glyph) {
            packGlyphInstance(
              this.glyphInstances,
              glyphCount * GLYPH_INSTANCE_FLOATS,
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
            glyphCount++;
          }
        }
      }
      grid.clearDirty(row);
    }

    // Upload atlas if dirty
    this.atlas.upload(gl);

    const cellW = this.cellWidth * this.dpr;
    const cellH = this.cellHeight * this.dpr;

    // --- Background pass ---
    if (bgCount > 0 && this.bgProgram && this.bgVAO && this.bgInstanceVBO) {
      gl.useProgram(this.bgProgram);
      gl.uniform2f(gl.getUniformLocation(this.bgProgram, "u_resolution"), vpW, vpH);
      gl.uniform2f(gl.getUniformLocation(this.bgProgram, "u_cellSize"), cellW, cellH);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.bgInstances.subarray(0, bgCount * BG_INSTANCE_FLOATS),
        gl.DYNAMIC_DRAW,
      );

      gl.bindVertexArray(this.bgVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, bgCount);
    }

    // --- Glyph pass ---
    if (glyphCount > 0 && this.glyphProgram && this.glyphVAO && this.glyphInstanceVBO) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.glyphProgram);
      gl.uniform2f(gl.getUniformLocation(this.glyphProgram, "u_resolution"), vpW, vpH);
      gl.uniform2f(gl.getUniformLocation(this.glyphProgram, "u_cellSize"), cellW, cellH);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.getTexture());
      gl.uniform1i(gl.getUniformLocation(this.glyphProgram, "u_atlas"), 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInstanceVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.glyphInstances.subarray(0, glyphCount * GLYPH_INSTANCE_FLOATS),
        gl.DYNAMIC_DRAW,
      );

      gl.bindVertexArray(this.glyphVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, glyphCount);

      gl.disable(gl.BLEND);
    }

    // --- Cursor ---
    if (cursor.visible && this.bgProgram && this.bgVAO && this.bgInstanceVBO) {
      const cc = this.themeCursorFloat;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.bgProgram);
      gl.uniform2f(gl.getUniformLocation(this.bgProgram, "u_resolution"), vpW, vpH);
      gl.uniform2f(gl.getUniformLocation(this.bgProgram, "u_cellSize"), cellW, cellH);

      const cursorData = new Float32Array([cursor.col, cursor.row, cc[0], cc[1], cc[2], 0.5]);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
      gl.bufferData(gl.ARRAY_BUFFER, cursorData, gl.DYNAMIC_DRAW);

      gl.bindVertexArray(this.bgVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, 1);

      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);
  }

  // -----------------------------------------------------------------------
  // GL resource initialization
  // -----------------------------------------------------------------------

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

    this.bgInstanceVBO = gl.createBuffer();
    this.glyphInstanceVBO = gl.createBuffer();

    this.bgVAO = gl.createVertexArray();
    gl.bindVertexArray(this.bgVAO);
    this.setupBgVAO(gl);
    gl.bindVertexArray(null);

    this.glyphVAO = gl.createVertexArray();
    gl.bindVertexArray(this.glyphVAO);
    this.setupGlyphVAO(gl);
    gl.bindVertexArray(null);
  }

  private setupBgVAO(gl: WebGL2RenderingContext): void {
    const FLOAT = 4;
    if (!this.bgProgram) return;
    const program = this.bgProgram;

    const aPos = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
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

  private setupGlyphVAO(gl: WebGL2RenderingContext): void {
    const FLOAT = 4;
    if (!this.glyphProgram) return;
    const program = this.glyphProgram;

    const aPos = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInstanceVBO);
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

  // -----------------------------------------------------------------------
  // Color resolution
  // -----------------------------------------------------------------------

  private buildPaletteFloat(): void {
    this.paletteFloat = this.palette.map((c) => hexToFloat4(c));
    this.themeFgFloat = hexToFloat4(this.theme.foreground);
    this.themeBgFloat = hexToFloat4(this.theme.background);
    this.themeCursorFloat = hexToFloat4(this.theme.cursor);
  }

  private resolveColorFloat(
    colorIdx: number,
    isRGB: boolean,
    grid: CellGrid,
    col: number,
    isForeground: boolean,
  ): [number, number, number, number] {
    if (isRGB) {
      const offset = isForeground ? col : 256 + col;
      const rgb = grid.rgbColors[offset];
      const r = ((rgb >> 16) & 0xff) / 255;
      const g = ((rgb >> 8) & 0xff) / 255;
      const b = (rgb & 0xff) / 255;
      return [r, g, b, 1.0];
    }

    if (isForeground && colorIdx === 7) return this.themeFgFloat;
    if (!isForeground && colorIdx === 0) return this.themeBgFloat;

    if (colorIdx >= 0 && colorIdx < 256) {
      return this.paletteFloat[colorIdx];
    }

    return isForeground ? this.themeFgFloat : this.themeBgFloat;
  }

  // -----------------------------------------------------------------------
  // Cell measurement
  // -----------------------------------------------------------------------

  private measureCellSize(): void {
    const offscreen = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(100, 100) : null;

    let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

    if (offscreen) {
      measureCtx = offscreen.getContext("2d");
    } else if (typeof document !== "undefined") {
      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = 100;
      tmpCanvas.height = 100;
      measureCtx = tmpCanvas.getContext("2d");
    }

    if (!measureCtx) {
      this.cellWidth = Math.ceil(this.fontSize * 0.6);
      this.cellHeight = Math.ceil(this.fontSize * 1.2);
      return;
    }

    const font = `${this.fontSize}px ${this.fontFamily}`;
    measureCtx.font = font;
    const metrics = measureCtx.measureText("M");

    this.cellWidth = Math.ceil(metrics.width);
    if (
      typeof metrics.fontBoundingBoxAscent === "number" &&
      typeof metrics.fontBoundingBoxDescent === "number"
    ) {
      this.cellHeight = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
    } else {
      this.cellHeight = Math.ceil(this.fontSize * 1.2);
    }

    if (this.cellWidth <= 0) this.cellWidth = Math.ceil(this.fontSize * 0.6);
    if (this.cellHeight <= 0) this.cellHeight = Math.ceil(this.fontSize * 1.2);
  }
}
