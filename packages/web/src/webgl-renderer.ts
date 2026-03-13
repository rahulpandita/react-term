/**
 * WebGL2 renderer for react-term.
 *
 * Architecture (inspired by Alacritty, Warp, xterm.js WebGL addon):
 *   - Two draw calls per frame: backgrounds (instanced rects) + foreground (instanced glyphs)
 *   - Alpha-only glyph texture atlas with color multiplication at render time
 *   - Instance-based rendering via drawElementsInstanced
 */

import type { CursorState, SelectionRange, Theme } from "@react-term/core";
import { type CellGrid, DEFAULT_THEME, normalizeSelection } from "@react-term/core";
import type { HighlightRange, IRenderer, RendererOptions } from "./renderer.js";
import { build256Palette, Canvas2DRenderer } from "./renderer.js";

// ---------------------------------------------------------------------------
// Attribute bit positions (mirrors renderer.ts / cell-grid.ts)
// ---------------------------------------------------------------------------

const ATTR_BOLD = 0x01;
const ATTR_ITALIC = 0x02;
const _ATTR_UNDERLINE = 0x04;
const _ATTR_STRIKETHROUGH = 0x08;
const ATTR_INVERSE = 0x40;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/** Parse a hex color (#rrggbb or #rgb) to [r, g, b, a] in 0-1 range. */
export function hexToFloat4(hex: string): [number, number, number, number] {
  let r = 0,
    g = 0,
    b = 0;
  if (hex.startsWith("#")) {
    const h = hex.slice(1);
    if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16) / 255;
      g = parseInt(h[1] + h[1], 16) / 255;
      b = parseInt(h[2] + h[2], 16) / 255;
    } else if (h.length === 6) {
      r = parseInt(h.slice(0, 2), 16) / 255;
      g = parseInt(h.slice(2, 4), 16) / 255;
      b = parseInt(h.slice(4, 6), 16) / 255;
    }
  } else if (hex.startsWith("rgb(")) {
    const m = hex.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) {
      r = parseInt(m[1], 10) / 255;
      g = parseInt(m[2], 10) / 255;
      b = parseInt(m[3], 10) / 255;
    }
  }
  return [r, g, b, 1.0];
}

/** Build a glyph cache key from codepoint and style flags. */
export function glyphCacheKey(codepoint: number, bold: boolean, italic: boolean): string {
  return `${codepoint}_${bold ? 1 : 0}_${italic ? 1 : 0}`;
}

// ---------------------------------------------------------------------------
// GlyphInfo
// ---------------------------------------------------------------------------

export interface GlyphInfo {
  /** Texture U coordinate (0-1). */
  u: number;
  /** Texture V coordinate (0-1). */
  v: number;
  /** Width in texture coords (0-1). */
  w: number;
  /** Height in texture coords (0-1). */
  h: number;
  /** Pixel width. */
  pw: number;
  /** Pixel height. */
  ph: number;
}

// ---------------------------------------------------------------------------
// GlyphAtlas
// ---------------------------------------------------------------------------

export class GlyphAtlas {
  private texture: WebGLTexture | null = null;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  readonly cache: Map<string, GlyphInfo> = new Map();
  private nextX = 0;
  private nextY = 0;
  private rowHeight = 0;
  width: number;
  height: number;
  private dirty = false;

  private fontSize: number;
  private fontFamily: string;

  constructor(fontSize: number, fontFamily: string, initialSize = 512) {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.width = initialSize;
    this.height = initialSize;

    if (typeof OffscreenCanvas !== "undefined") {
      this.canvas = new OffscreenCanvas(this.width, this.height);
      const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Failed to get 2d context for glyph atlas");
      this.ctx = ctx;
    }
  }

  /**
   * Get (or rasterize) a glyph. Returns the GlyphInfo with atlas coordinates.
   */
  getGlyph(codepoint: number, bold: boolean, italic: boolean): GlyphInfo | null {
    const key = glyphCacheKey(codepoint, bold, italic);
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (!this.ctx || !this.canvas) return null;

    const ch = String.fromCodePoint(codepoint);
    const font = this.buildFont(bold, italic);
    this.ctx.font = font;
    const metrics = this.ctx.measureText(ch);

    const pw = Math.ceil(metrics.width) + 2; // 1px padding each side
    const ascent =
      typeof metrics.fontBoundingBoxAscent === "number"
        ? metrics.fontBoundingBoxAscent
        : this.fontSize;
    const descent =
      typeof metrics.fontBoundingBoxDescent === "number"
        ? metrics.fontBoundingBoxDescent
        : Math.ceil(this.fontSize * 0.2);
    const ph = Math.ceil(ascent + descent) + 2;

    // Check if we need to wrap to next row
    if (this.nextX + pw > this.width) {
      this.nextX = 0;
      this.nextY += this.rowHeight;
      this.rowHeight = 0;
    }

    // Check if we need to grow the atlas
    if (this.nextY + ph > this.height) {
      const newHeight = Math.min(this.height * 2, 4096);
      if (newHeight <= this.height) {
        // Can't grow further; return null as we've hit the limit
        return null;
      }
      this.growAtlas(this.width, newHeight);
    }

    // Rasterize
    this.ctx.font = font;
    this.ctx.fillStyle = "white";
    this.ctx.textBaseline = "alphabetic";
    this.ctx.fillText(ch, this.nextX + 1, this.nextY + 1 + ascent);

    const info: GlyphInfo = {
      u: this.nextX / this.width,
      v: this.nextY / this.height,
      w: pw / this.width,
      h: ph / this.height,
      pw,
      ph,
    };

    this.cache.set(key, info);
    this.nextX += pw;
    this.rowHeight = Math.max(this.rowHeight, ph);
    this.dirty = true;

    return info;
  }

  /**
   * Upload the atlas texture to GPU. Call once per frame if dirty.
   */
  upload(gl: WebGL2RenderingContext): void {
    if (!this.canvas) return;

    if (!this.texture) {
      this.texture = gl.createTexture();
    }

    if (!this.dirty && this.texture) return;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.dirty = false;
  }

  getTexture(): WebGLTexture | null {
    return this.texture;
  }

  /** Recreate GL texture (for context restore). */
  recreateTexture(): void {
    this.texture = null;
    this.dirty = true;
  }

  dispose(gl: WebGL2RenderingContext | null): void {
    if (gl && this.texture) {
      gl.deleteTexture(this.texture);
    }
    this.texture = null;
    this.cache.clear();
  }

  private buildFont(bold: boolean, italic: boolean): string {
    let font = "";
    if (italic) font += "italic ";
    if (bold) font += "bold ";
    font += `${this.fontSize}px ${this.fontFamily}`;
    return font;
  }

  private growAtlas(newWidth: number, newHeight: number): void {
    if (!this.canvas || !this.ctx) return;

    // Save existing content
    const imageData = this.ctx.getImageData(0, 0, this.width, this.height);

    this.width = newWidth;
    this.height = newHeight;
    this.canvas.width = newWidth;
    this.canvas.height = newHeight;

    // Restore content
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!this.ctx) return;
    this.ctx.putImageData(imageData, 0, 0);

    // Recalculate UV coordinates for all cached glyphs
    for (const [_key, info] of this.cache) {
      // Convert back to pixel coords and recalculate
      const px = info.u * imageData.width;
      const py = info.v * imageData.height;
      info.u = px / newWidth;
      info.v = py / newHeight;
      info.w = info.pw / newWidth;
      info.h = info.ph / newHeight;
    }

    this.dirty = true;
  }
}

// ---------------------------------------------------------------------------
// Shader sources
// ---------------------------------------------------------------------------

const BG_VERTEX_SHADER = `#version 300 es
// Per-vertex: unit quad
in vec2 a_position;

// Per-instance
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

// Per-instance
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
// Instance buffer packing helpers
// ---------------------------------------------------------------------------

/** Floats per background instance: cellCol, cellRow, r, g, b, a */
export const BG_INSTANCE_FLOATS = 6;

/** Floats per glyph instance: cellCol, cellRow, r, g, b, a, u, v, tw, th, pw, ph */
export const GLYPH_INSTANCE_FLOATS = 12;

/**
 * Pack a background instance into a Float32Array at the given offset.
 */
export function packBgInstance(
  buf: Float32Array,
  offset: number,
  col: number,
  row: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  buf[offset] = col;
  buf[offset + 1] = row;
  buf[offset + 2] = r;
  buf[offset + 3] = g;
  buf[offset + 4] = b;
  buf[offset + 5] = a;
}

/**
 * Pack a glyph instance into a Float32Array at the given offset.
 */
export function packGlyphInstance(
  buf: Float32Array,
  offset: number,
  col: number,
  row: number,
  r: number,
  g: number,
  b: number,
  a: number,
  u: number,
  v: number,
  tw: number,
  th: number,
  pw: number,
  ph: number,
): void {
  buf[offset] = col;
  buf[offset + 1] = row;
  buf[offset + 2] = r;
  buf[offset + 3] = g;
  buf[offset + 4] = b;
  buf[offset + 5] = a;
  buf[offset + 6] = u;
  buf[offset + 7] = v;
  buf[offset + 8] = tw;
  buf[offset + 9] = th;
  buf[offset + 10] = pw;
  buf[offset + 11] = ph;
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
  // Shaders can be detached after linking
  gl.detachShader(program, vert);
  gl.detachShader(program, frag);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return program;
}

// ---------------------------------------------------------------------------
// WebGLRenderer
// ---------------------------------------------------------------------------

export class WebGLRenderer implements IRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private grid: CellGrid | null = null;
  private cursor: CursorState | null = null;

  private cellWidth = 0;
  private cellHeight = 0;
  private baselineOffset = 0;

  private fontSize: number;
  private fontFamily: string;
  private theme: Theme;
  private dpr: number;
  private palette: string[];

  private selection: SelectionRange | null = null;
  private highlights: HighlightRange[] = [];

  // Track previous cursor position to force redraw when cursor moves
  private prevCursorRow = -1;
  private prevCursorCol = -1;

  private rafId: number | null = null;
  private disposed = false;
  private contextLost = false;

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
  private bgCount = 0;
  private glyphCount = 0;

  // Glyph atlas
  private atlas: GlyphAtlas;

  // Palette as float arrays (cached for performance)
  private paletteFloat: Array<[number, number, number, number]> = [];
  private themeFgFloat: [number, number, number, number] = [0, 0, 0, 1];
  private themeBgFloat: [number, number, number, number] = [0, 0, 0, 1];
  private themeCursorFloat: [number, number, number, number] = [0, 0, 0, 1];

  // Context loss handlers
  private handleContextLost: ((e: Event) => void) | null = null;
  private handleContextRestored: (() => void) | null = null;

  constructor(options: RendererOptions) {
    this.fontSize = options.fontSize;
    this.fontFamily = options.fontFamily;
    this.theme = options.theme ?? DEFAULT_THEME;
    this.dpr =
      options.devicePixelRatio ?? (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    this.palette = build256Palette(this.theme);
    this.measureCellSize();
    this.buildPaletteFloat();

    this.atlas = new GlyphAtlas(Math.round(this.fontSize * this.dpr), this.fontFamily);

    // Pre-allocate instance buffers for a reasonable default size
    const maxCells = 80 * 24;
    this.bgInstances = new Float32Array(maxCells * BG_INSTANCE_FLOATS);
    this.glyphInstances = new Float32Array(maxCells * GLYPH_INSTANCE_FLOATS);
  }

  // -----------------------------------------------------------------------
  // IRenderer
  // -----------------------------------------------------------------------

  attach(canvas: HTMLCanvasElement, grid: CellGrid, cursor: CursorState): void {
    this.canvas = canvas;
    this.grid = grid;
    this.cursor = cursor;

    // Get WebGL2 context
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;

    if (!this.gl) {
      throw new Error("WebGL2 is not available");
    }

    // Set up context loss handlers
    this.handleContextLost = (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
      this.stopRenderLoop();
    };
    this.handleContextRestored = () => {
      this.contextLost = false;
      this.initGLResources();
      if (this.grid) this.grid.markAllDirty();
      this.startRenderLoop();
    };
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);

    this.syncCanvasSize();
    this.initGLResources();
    this.ensureInstanceBuffers();
    grid.markAllDirty();
  }

  render(): void {
    if (this.disposed || this.contextLost || !this.gl || !this.grid || !this.cursor) return;

    const gl = this.gl;
    const grid = this.grid;
    const cols = grid.cols;
    const rows = grid.rows;

    // If cursor moved, mark old and new rows dirty to erase ghost and draw fresh
    const curRow = this.cursor.row;
    const curCol = this.cursor.col;
    if (
      this.prevCursorRow >= 0 &&
      this.prevCursorRow < rows &&
      (this.prevCursorRow !== curRow || this.prevCursorCol !== curCol)
    ) {
      grid.markDirty(this.prevCursorRow);
    }
    if (curRow >= 0 && curRow < rows) {
      grid.markDirty(curRow);
    }
    this.prevCursorRow = curRow;
    this.prevCursorCol = curCol;

    // Check if any rows are dirty
    let anyDirty = false;
    for (let r = 0; r < rows; r++) {
      if (grid.isDirty(r)) {
        anyDirty = true;
        break;
      }
    }
    if (!anyDirty) {
      return;
    }

    // Rebuild instance data
    this.bgCount = 0;
    this.glyphCount = 0;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const codepoint = grid.getCodepoint(row, col);
        const fgIdx = grid.getFgIndex(row, col);
        const bgIdx = grid.getBgIndex(row, col);
        const attrs = grid.getAttrs(row, col);
        const fgIsRGB = grid.isFgRGB(row, col);
        const bgIsRGB = grid.isBgRGB(row, col);
        const isWide = grid.isWide(row, col);

        let fg = this.resolveColorFloat(fgIdx, fgIsRGB, grid, col, true);
        let bg = this.resolveColorFloat(bgIdx, bgIsRGB, grid, col, false);

        // Handle inverse
        if (attrs & ATTR_INVERSE) {
          const tmp = fg;
          fg = bg;
          bg = tmp;
        }

        // Background instance — emit for all cells to paint default bg too
        packBgInstance(
          this.bgInstances,
          this.bgCount * BG_INSTANCE_FLOATS,
          col,
          row,
          bg[0],
          bg[1],
          bg[2],
          bg[3],
        );
        this.bgCount++;

        // Glyph instance — skip spaces and control chars
        if (codepoint > 0x20) {
          const bold = !!(attrs & ATTR_BOLD);
          const italic = !!(attrs & ATTR_ITALIC);
          const glyph = this.atlas.getGlyph(codepoint, bold, italic);

          if (glyph) {
            const glyphPw = isWide ? glyph.pw : glyph.pw;
            const glyphPh = glyph.ph;
            packGlyphInstance(
              this.glyphInstances,
              this.glyphCount * GLYPH_INSTANCE_FLOATS,
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
              glyphPw,
              glyphPh,
            );
            this.glyphCount++;
          }
        }
      }

      grid.clearDirty(row);
    }

    // Upload atlas if dirty
    this.atlas.upload(gl);

    // Set up GL state
    const canvasWidth = this.canvas?.width ?? 0;
    const canvasHeight = this.canvas?.height ?? 0;
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(this.themeBgFloat[0], this.themeBgFloat[1], this.themeBgFloat[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const cellW = this.cellWidth * this.dpr;
    const cellH = this.cellHeight * this.dpr;

    // --- Background pass ---
    if (this.bgCount > 0 && this.bgProgram && this.bgVAO && this.bgInstanceVBO) {
      gl.useProgram(this.bgProgram);

      gl.uniform2f(
        gl.getUniformLocation(this.bgProgram, "u_resolution"),
        canvasWidth,
        canvasHeight,
      );
      gl.uniform2f(gl.getUniformLocation(this.bgProgram, "u_cellSize"), cellW, cellH);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.bgInstances.subarray(0, this.bgCount * BG_INSTANCE_FLOATS),
        gl.DYNAMIC_DRAW,
      );

      gl.bindVertexArray(this.bgVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.bgCount);
    }

    // --- Glyph pass ---
    if (this.glyphCount > 0 && this.glyphProgram && this.glyphVAO && this.glyphInstanceVBO) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.glyphProgram);

      gl.uniform2f(
        gl.getUniformLocation(this.glyphProgram, "u_resolution"),
        canvasWidth,
        canvasHeight,
      );
      gl.uniform2f(gl.getUniformLocation(this.glyphProgram, "u_cellSize"), cellW, cellH);

      // Bind atlas texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.getTexture());
      gl.uniform1i(gl.getUniformLocation(this.glyphProgram, "u_atlas"), 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInstanceVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.glyphInstances.subarray(0, this.glyphCount * GLYPH_INSTANCE_FLOATS),
        gl.DYNAMIC_DRAW,
      );

      gl.bindVertexArray(this.glyphVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.glyphCount);

      gl.disable(gl.BLEND);
    }

    // --- Highlights (search results) ---
    this.drawHighlights();

    // --- Selection overlay ---
    this.drawSelection();

    // --- Cursor ---
    this.drawCursor();

    gl.bindVertexArray(null);
  }

  resize(_cols: number, _rows: number): void {
    if (!this.canvas || !this.grid) return;
    this.syncCanvasSize();
    this.ensureInstanceBuffers();
    this.grid.markAllDirty();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.palette = build256Palette(theme);
    this.buildPaletteFloat();
    if (this.grid) {
      this.grid.markAllDirty();
    }
  }

  setSelection(selection: SelectionRange | null): void {
    this.selection = selection;
    if (this.grid) {
      this.grid.markAllDirty();
    }
  }

  setHighlights(highlights: HighlightRange[]): void {
    this.highlights = highlights;
    if (this.grid) {
      this.grid.markAllDirty();
    }
  }

  setFont(fontSize: number, fontFamily: string): void {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.measureCellSize();

    // Recreate atlas with new font size
    if (this.gl) {
      this.atlas.dispose(this.gl);
    }
    this.atlas = new GlyphAtlas(Math.round(this.fontSize * this.dpr), this.fontFamily);

    if (this.grid) {
      this.syncCanvasSize();
      this.grid.markAllDirty();
    }
  }

  getCellSize(): { width: number; height: number } {
    return { width: this.cellWidth, height: this.cellHeight };
  }

  dispose(): void {
    this.disposed = true;
    this.stopRenderLoop();

    if (this.canvas) {
      if (this.handleContextLost) {
        this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
      }
      if (this.handleContextRestored) {
        this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
      }
    }

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

    this.canvas = null;
    this.gl = null;
    this.grid = null;
    this.cursor = null;
  }

  // -----------------------------------------------------------------------
  // Render loop
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // GL resource initialization
  // -----------------------------------------------------------------------

  private initGLResources(): void {
    const gl = this.gl;
    if (!gl) return;

    // Compile programs
    this.bgProgram = createProgram(gl, BG_VERTEX_SHADER, BG_FRAGMENT_SHADER);
    this.glyphProgram = createProgram(gl, GLYPH_VERTEX_SHADER, GLYPH_FRAGMENT_SHADER);

    // Unit quad vertices and indices
    const quadVerts = new Float32Array([
      0,
      0, // bottom-left
      1,
      0, // bottom-right
      0,
      1, // top-left
      1,
      1, // top-right
    ]);
    const quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);

    this.quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    this.quadEBO = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    // Instance buffers
    this.bgInstanceVBO = gl.createBuffer();
    this.glyphInstanceVBO = gl.createBuffer();

    // Set up background VAO
    this.bgVAO = gl.createVertexArray();
    gl.bindVertexArray(this.bgVAO);
    this.setupBgVAO(gl);
    gl.bindVertexArray(null);

    // Set up glyph VAO
    this.glyphVAO = gl.createVertexArray();
    gl.bindVertexArray(this.glyphVAO);
    this.setupGlyphVAO(gl);
    gl.bindVertexArray(null);

    // Recreate atlas texture
    this.atlas.recreateTexture();
  }

  private setupBgVAO(gl: WebGL2RenderingContext): void {
    const FLOAT = 4;
    if (!this.bgProgram) return;
    const program = this.bgProgram;

    // Quad vertex positions
    const aPos = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Element buffer
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    // Instance data
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

    // Quad vertex positions
    const aPos = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Element buffer
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    // Instance data
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
  // Instance buffer management
  // -----------------------------------------------------------------------

  private ensureInstanceBuffers(): void {
    if (!this.grid) return;
    const totalCells = this.grid.cols * this.grid.rows;
    const neededBg = totalCells * BG_INSTANCE_FLOATS;
    const neededGlyph = totalCells * GLYPH_INSTANCE_FLOATS;

    if (this.bgInstances.length < neededBg) {
      this.bgInstances = new Float32Array(neededBg);
    }
    if (this.glyphInstances.length < neededGlyph) {
      this.glyphInstances = new Float32Array(neededGlyph);
    }
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
  // Cursor
  // -----------------------------------------------------------------------

  private drawHighlights(): void {
    if (!this.gl || !this.highlights.length) return;

    const gl = this.gl;
    if (!this.bgProgram || !this.bgVAO || !this.bgInstanceVBO) return;

    const hlInstances: number[] = [];

    for (const hl of this.highlights) {
      // Current match: orange, other matches: semi-transparent yellow
      const r = hl.isCurrent ? 1.0 : 1.0;
      const g = hl.isCurrent ? 0.647 : 1.0;
      const b = hl.isCurrent ? 0.0 : 0.0;
      const a = hl.isCurrent ? 0.5 : 0.3;

      for (let col = hl.startCol; col <= hl.endCol; col++) {
        hlInstances.push(col, hl.row, r, g, b, a);
      }
    }

    if (hlInstances.length === 0) return;

    const hlData = new Float32Array(hlInstances);
    const hlCount = hlInstances.length / BG_INSTANCE_FLOATS;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.bgProgram);
    gl.uniform2f(
      gl.getUniformLocation(this.bgProgram, "u_resolution"),
      this.canvas?.width ?? 0,
      this.canvas?.height ?? 0,
    );
    gl.uniform2f(
      gl.getUniformLocation(this.bgProgram, "u_cellSize"),
      this.cellWidth * this.dpr,
      this.cellHeight * this.dpr,
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, hlData, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(this.bgVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, hlCount);

    gl.disable(gl.BLEND);
  }

  private drawSelection(): void {
    if (!this.gl || !this.grid || !this.selection) return;

    const gl = this.gl;
    const grid = this.grid;
    const sel = normalizeSelection(this.selection);

    const sr = Math.max(0, sel.startRow);
    const er = Math.min(grid.rows - 1, sel.endRow);

    // Skip if selection is empty (same cell)
    if (sr === er && sel.startCol === sel.endCol) return;

    if (!this.bgProgram || !this.bgVAO || !this.bgInstanceVBO) return;

    // Parse the selection background color
    const selColor = hexToFloat4(this.theme.selectionBackground);

    // Build instance data for selection rects
    const selInstances: number[] = [];

    for (let row = sr; row <= er; row++) {
      let colStart: number;
      let colEnd: number;

      if (sr === er) {
        colStart = sel.startCol;
        colEnd = sel.endCol;
      } else if (row === sr) {
        colStart = sel.startCol;
        colEnd = grid.cols - 1;
      } else if (row === er) {
        colStart = 0;
        colEnd = sel.endCol;
      } else {
        colStart = 0;
        colEnd = grid.cols - 1;
      }

      for (let col = colStart; col <= colEnd; col++) {
        selInstances.push(col, row, selColor[0], selColor[1], selColor[2], 0.5);
      }
    }

    if (selInstances.length === 0) return;

    const selData = new Float32Array(selInstances);
    const selCount = selInstances.length / BG_INSTANCE_FLOATS;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.bgProgram);
    gl.uniform2f(
      gl.getUniformLocation(this.bgProgram, "u_resolution"),
      this.canvas?.width ?? 0,
      this.canvas?.height ?? 0,
    );
    gl.uniform2f(
      gl.getUniformLocation(this.bgProgram, "u_cellSize"),
      this.cellWidth * this.dpr,
      this.cellHeight * this.dpr,
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, selData, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(this.bgVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, selCount);

    gl.disable(gl.BLEND);
  }

  private drawCursor(): void {
    if (!this.gl || !this.cursor || !this.cursor.visible) return;

    const gl = this.gl;
    const cursor = this.cursor;
    const cellW = this.cellWidth * this.dpr;
    const cellH = this.cellHeight * this.dpr;
    const cc = this.themeCursorFloat;

    // Use the bg program to draw a simple colored rect for the cursor
    if (!this.bgProgram || !this.bgVAO || !this.bgInstanceVBO) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.bgProgram);
    gl.uniform2f(
      gl.getUniformLocation(this.bgProgram, "u_resolution"),
      this.canvas?.width ?? 0,
      this.canvas?.height ?? 0,
    );
    gl.uniform2f(gl.getUniformLocation(this.bgProgram, "u_cellSize"), cellW, cellH);

    // For bar and underline styles, we draw a thin rect.
    // We abuse cellPos with fractional values to position correctly.
    let cursorData: Float32Array;

    switch (cursor.style) {
      case "block":
        cursorData = new Float32Array([
          cursor.col,
          cursor.row,
          cc[0],
          cc[1],
          cc[2],
          0.5, // 50% alpha for block
        ]);
        break;

      case "underline": {
        // Draw a thin line at the bottom of the cell
        // We position it by adjusting cellPos row to be near bottom
        const lineH = Math.max(2 * this.dpr, 1);
        const fractionalRow = cursor.row + (cellH - lineH) / cellH;
        cursorData = new Float32Array([cursor.col, fractionalRow, cc[0], cc[1], cc[2], cc[3]]);
        // We'd need a different cell size for this, but we can approximate
        // by using the full cell width and adjusting position
        break;
      }

      case "bar": {
        // Draw a thin vertical bar at the left of the cell
        cursorData = new Float32Array([cursor.col, cursor.row, cc[0], cc[1], cc[2], cc[3]]);
        break;
      }

      default:
        cursorData = new Float32Array([cursor.col, cursor.row, cc[0], cc[1], cc[2], 0.5]);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, cursorData, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(this.bgVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, 1);

    gl.disable(gl.BLEND);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
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
      this.baselineOffset = Math.ceil(this.fontSize);
      return;
    }

    const font = this.buildFontString(false, false);
    measureCtx.font = font;
    const metrics = measureCtx.measureText("M");

    this.cellWidth = Math.ceil(metrics.width);
    if (
      typeof metrics.fontBoundingBoxAscent === "number" &&
      typeof metrics.fontBoundingBoxDescent === "number"
    ) {
      const ascent = metrics.fontBoundingBoxAscent;
      const descent = metrics.fontBoundingBoxDescent;
      this.cellHeight = Math.ceil(ascent + descent);
      this.baselineOffset = Math.ceil(ascent);
    } else {
      this.cellHeight = Math.ceil(this.fontSize * 1.2);
      this.baselineOffset = Math.ceil(this.fontSize);
    }

    if (this.cellWidth <= 0) this.cellWidth = Math.ceil(this.fontSize * 0.6);
    if (this.cellHeight <= 0) this.cellHeight = Math.ceil(this.fontSize * 1.2);
  }

  private syncCanvasSize(): void {
    if (!this.canvas || !this.grid) return;
    const { cols, rows } = this.grid;
    const width = cols * this.cellWidth;
    const height = rows * this.cellHeight;

    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  private buildFontString(bold: boolean, italic: boolean): string {
    let font = "";
    if (italic) font += "italic ";
    if (bold) font += "bold ";
    font += `${this.fontSize}px ${this.fontFamily}`;
    return font;
  }
}

// ---------------------------------------------------------------------------
// Factory function with fallback
// ---------------------------------------------------------------------------

/**
 * Create a renderer with the given strategy.
 *
 * - 'auto' (default): try WebGL2 first, fall back to Canvas 2D
 * - 'webgl': force WebGL2 (throws if unavailable)
 * - 'canvas2d': force Canvas 2D
 */
export function createRenderer(
  options: RendererOptions,
  type: "auto" | "webgl" | "canvas2d" = "auto",
): IRenderer {
  if (type === "canvas2d") {
    return new Canvas2DRenderer(options);
  }

  if (type === "webgl") {
    return new WebGLRenderer(options);
  }

  // 'auto': try WebGL2 first
  // We can't easily test WebGL2 availability without a canvas,
  // so we create the WebGLRenderer and let attach() throw if unavailable.
  // Instead, probe with a temporary canvas.
  if (typeof document !== "undefined") {
    const testCanvas = document.createElement("canvas");
    const testGl = testCanvas.getContext("webgl2");
    if (testGl) {
      return new WebGLRenderer(options);
    }
  }

  return new Canvas2DRenderer(options);
}
