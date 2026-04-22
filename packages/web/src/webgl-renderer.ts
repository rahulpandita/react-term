/**
 * WebGL2 renderer for react-term.
 *
 * Architecture (inspired by Alacritty, Warp, xterm.js WebGL addon):
 *   - Two draw calls per frame: backgrounds (instanced rects) + foreground (instanced glyphs)
 *   - Alpha-only glyph texture atlas with color multiplication at render time
 *   - Instance-based rendering via drawElementsInstanced
 */

import type { CursorState, SelectionRange, Theme } from "@next_term/core";
import { type CellGrid, DEFAULT_THEME, normalizeSelection } from "@next_term/core";
import { ATTR_BOLD, ATTR_INVERSE, ATTR_ITALIC } from "./cell-attrs.js";
import type { HighlightRange, IRenderer, RendererOptions } from "./renderer.js";
import { build256Palette, Canvas2DRenderer } from "./renderer.js";
import { type ColorFloat4, resolveColorFloat } from "./webgl-utils.js";

/**
 * When the dirty region exceeds 1/FULL_UPLOAD_THRESHOLD_INV of the atlas area,
 * use texImage2D(canvas) (no CPU readback) instead of getImageData +
 * texSubImage2D. Value of 4 means >25% dirty triggers full upload.
 */
const FULL_UPLOAD_THRESHOLD_INV = 4;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/**
 * Parse any CSS color string to [r, g, b, a] in 0-1 range.
 *
 * Fast path for #rrggbb/#rgb hex (no canvas overhead).
 * All other formats (rgb(), rgba(), hsl(), oklch(), color(), named colors)
 * are resolved by the browser's native CSS engine via a 1x1 canvas.
 */
// Singleton canvas context for CSS color resolution (works in main thread
// and Web Workers via OffscreenCanvas)
let _colorCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
let _colorCtxFailed = false;

function getColorCtx(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  if (_colorCtx || _colorCtxFailed) return _colorCtx;
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      _colorCtx = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
    } else if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      _colorCtx = c.getContext("2d", { willReadFrequently: true });
    }
  } catch {
    // No canvas available (SSR / test environment)
  }
  if (!_colorCtx) _colorCtxFailed = true;
  return _colorCtx;
}

export function hexToFloat4(color: string): [number, number, number, number] {
  // Fast path: #rrggbb (most common — default theme + 256-palette are all hex)
  if (color.length === 7 && color.charCodeAt(0) === 0x23 /* # */) {
    return [
      parseInt(color.slice(1, 3), 16) / 255,
      parseInt(color.slice(3, 5), 16) / 255,
      parseInt(color.slice(5, 7), 16) / 255,
      1.0,
    ];
  }
  // Fast path: #rgb
  if (color.length === 4 && color.charCodeAt(0) === 0x23) {
    return [
      parseInt(color[1] + color[1], 16) / 255,
      parseInt(color[2] + color[2], 16) / 255,
      parseInt(color[3] + color[3], 16) / 255,
      1.0,
    ];
  }
  // Fast path: rgb(r,g,b) or rgb(r, g, b) — catches custom themes
  if (color.charCodeAt(0) === 0x72 /* r */ && color.startsWith("rgb(")) {
    const s = color;
    let i = 4;
    while (s.charCodeAt(i) === 0x20) i++; // skip spaces
    let r = 0;
    while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39)
      r = r * 10 + s.charCodeAt(i++) - 0x30;
    while (s.charCodeAt(i) === 0x20 || s.charCodeAt(i) === 0x2c) i++; // skip , and spaces
    let g = 0;
    while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39)
      g = g * 10 + s.charCodeAt(i++) - 0x30;
    while (s.charCodeAt(i) === 0x20 || s.charCodeAt(i) === 0x2c) i++;
    let b = 0;
    while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39)
      b = b * 10 + s.charCodeAt(i++) - 0x30;
    if (r <= 255 && g <= 255 && b <= 255) return [r / 255, g / 255, b / 255, 1.0];
  }
  // Universal path: let the browser parse any CSS color
  const ctx = getColorCtx();
  if (ctx) {
    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      const a = d[3] / 255;
      if (a === 0) {
        // Invalid color or fully transparent — return opaque black
        return [0, 0, 0, 1.0];
      }
      // Unpremultiply RGB (getImageData returns premultiplied on some browsers)
      return a >= 1
        ? [d[0] / 255, d[1] / 255, d[2] / 255, 1.0]
        : [d[0] / 255 / a, d[1] / 255 / a, d[2] / 255 / a, a];
    } catch {
      // Partial canvas implementation (e.g., jsdom) — fall through
    }
  }
  // No canvas fallback — return black
  return [0, 0, 0, 1.0];
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
  /** Full re-upload needed (first upload, resize, context restore). */
  private needsFullUpload = true;
  /** Dirty sub-region for incremental texSubImage2D uploads. */
  private dirtyMinX = 0;
  private dirtyMinY = 0;
  private dirtyMaxX = 0;
  private dirtyMaxY = 0;
  private hasDirtyRegion = false;

  private fontSize: number;
  private fontFamily: string;
  private fontWeight: number;
  private fontWeightBold: number;

  constructor(
    fontSize: number,
    fontFamily: string,
    fontWeight = 400,
    fontWeightBold = 700,
    initialSize = 512,
  ) {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.fontWeight = fontWeight;
    this.fontWeightBold = fontWeightBold;
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
   * Pre-rasterize ASCII printable characters (33-126) in normal and bold
   * weights so they are atlas-resident before any terminal content arrives.
   * Eliminates first-frame cache-miss stutter for common text.
   */
  prewarmASCII(): void {
    for (let cp = 33; cp <= 126; cp++) {
      this.getGlyph(cp, false, false); // normal
      this.getGlyph(cp, true, false); // bold
    }
  }

  /**
   * Clear the glyph cache so all glyphs are re-rasterized on next access.
   * Used when the underlying font changes (e.g., after a web font loads).
   */
  clearCache(): void {
    this.cache.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.rowHeight = 0;
    this.needsFullUpload = true;
    this.hasDirtyRegion = false;
    // Clear the atlas canvas
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    // Re-warm ASCII so common characters are immediately available
    this.prewarmASCII();
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

    // Track dirty sub-region for incremental upload
    const glyphX = this.nextX;
    const glyphY = this.nextY;
    if (this.hasDirtyRegion) {
      this.dirtyMinX = Math.min(this.dirtyMinX, glyphX);
      this.dirtyMinY = Math.min(this.dirtyMinY, glyphY);
      this.dirtyMaxX = Math.max(this.dirtyMaxX, glyphX + pw);
      this.dirtyMaxY = Math.max(this.dirtyMaxY, glyphY + ph);
    } else {
      this.dirtyMinX = glyphX;
      this.dirtyMinY = glyphY;
      this.dirtyMaxX = glyphX + pw;
      this.dirtyMaxY = glyphY + ph;
      this.hasDirtyRegion = true;
    }

    this.nextX += pw;
    this.rowHeight = Math.max(this.rowHeight, ph);

    return info;
  }

  /**
   * Upload the atlas texture to GPU. Call once per frame if dirty.
   */
  upload(gl: WebGL2RenderingContext): void {
    if (!this.canvas || !this.ctx) return;

    if (!this.texture) {
      this.texture = gl.createTexture();
      this.needsFullUpload = true;
    }

    if (!this.needsFullUpload && !this.hasDirtyRegion) return;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    if (this.needsFullUpload) {
      // Full upload: first frame, resize, or context restore.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.needsFullUpload = false;
    } else {
      // Incremental: use full canvas upload (no CPU readback) for small
      // atlases or large dirty regions. Fall back to getImageData +
      // texSubImage2D only when the dirty rect is a small fraction of
      // a large atlas, where uploading the full texture is wasteful.
      const dirtyArea = (this.dirtyMaxX - this.dirtyMinX) * (this.dirtyMaxY - this.dirtyMinY);
      const totalArea = this.width * this.height;

      if (dirtyArea * FULL_UPLOAD_THRESHOLD_INV > totalArea) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
      } else {
        const x = this.dirtyMinX;
        const y = this.dirtyMinY;
        const w = this.dirtyMaxX - x;
        const h = this.dirtyMaxY - y;
        const pixels = this.ctx.getImageData(x, y, w, h);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
    }

    this.hasDirtyRegion = false;
  }

  getTexture(): WebGLTexture | null {
    return this.texture;
  }

  /** Recreate GL texture (for context restore). */
  recreateTexture(): void {
    this.texture = null;
    this.needsFullUpload = true;
    this.hasDirtyRegion = false;
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
    font += `${bold ? this.fontWeightBold : this.fontWeight} `;
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

    this.needsFullUpload = true;
    this.hasDirtyRegion = false;
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
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read via destructuring in render()
  private baselineOffset = 0;

  private fontSize: number;
  private fontFamily: string;
  private fontWeight: number;
  private fontWeightBold: number;
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
  // Double-buffered instance VBOs to avoid GPU read/write conflicts
  private bgInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
  private glyphInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
  private activeBufferIdx = 0;
  // Dedicated overlay VBO for cursor/selection/highlights so we don't
  // overwrite the active bg VBO and neutralize double-buffering.
  private overlayVBO: WebGLBuffer | null = null;
  private bgVAO: WebGLVertexArrayObject | null = null;
  private glyphVAO: WebGLVertexArrayObject | null = null;

  // Cached uniform locations (populated in initGLResources)
  private bgResolutionLoc: WebGLUniformLocation | null = null;
  private bgCellSizeLoc: WebGLUniformLocation | null = null;
  private glyphResolutionLoc: WebGLUniformLocation | null = null;
  private glyphCellSizeLoc: WebGLUniformLocation | null = null;
  private glyphAtlasLoc: WebGLUniformLocation | null = null;

  // Instance data (CPU side)
  private bgInstances: Float32Array;
  private glyphInstances: Float32Array;
  private bgCount = 0;
  private glyphCount = 0;

  // Per-row dirty tracking for incremental instance rebuilds
  private rowBgOffsets: number[] = []; // starting bgCount index per row
  private rowBgCounts: number[] = []; // number of bg instances per row
  private rowGlyphOffsets: number[] = []; // starting glyphCount index per row
  private rowGlyphCounts: number[] = []; // number of glyph instances per row
  private hasRenderedOnce = false;

  // Pre-allocated overlay buffers (reused each frame)
  private cursorData = new Float32Array(BG_INSTANCE_FLOATS);
  private selBuffer = new Float32Array(256 * BG_INSTANCE_FLOATS);
  private hlBuffer = new Float32Array(256 * BG_INSTANCE_FLOATS);

  // Glyph atlas
  private atlas: GlyphAtlas;

  // Palette as float arrays (cached for performance)
  private paletteFloat: ColorFloat4[] = [];
  private themeFgFloat: ColorFloat4 = [0, 0, 0, 1];
  private themeBgFloat: ColorFloat4 = [0, 0, 0, 1];
  private themeCursorFloat: ColorFloat4 = [0, 0, 0, 1];

  // Context loss handlers
  private handleContextLost: ((e: Event) => void) | null = null;
  private handleContextRestored: (() => void) | null = null;

  constructor(options: RendererOptions) {
    this.fontSize = options.fontSize;
    this.fontFamily = options.fontFamily;
    this.fontWeight = options.fontWeight ?? 400;
    this.fontWeightBold = options.fontWeightBold ?? 700;
    this.theme = options.theme ?? DEFAULT_THEME;
    this.dpr =
      options.devicePixelRatio ?? (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    this.palette = build256Palette(this.theme);
    this.measureCellSize();
    this.buildPaletteFloat();

    this.atlas = new GlyphAtlas(
      Math.round(this.fontSize * this.dpr),
      this.fontFamily,
      this.fontWeight,
      this.fontWeightBold,
    );
    this.atlas.prewarmASCII();

    // Pre-allocate instance buffers for a reasonable default size
    const maxCells = 80 * 24;
    this.bgInstances = new Float32Array(maxCells * BG_INSTANCE_FLOATS);
    this.glyphInstances = new Float32Array(maxCells * GLYPH_INSTANCE_FLOATS);
  }

  // -----------------------------------------------------------------------
  // IRenderer
  // -----------------------------------------------------------------------

  attach(canvas: HTMLCanvasElement, grid: CellGrid, cursor: CursorState): void {
    // Remove old context-loss listeners if re-attaching to the same canvas
    if (this.canvas && this.handleContextLost) {
      this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    }
    if (this.canvas && this.handleContextRestored) {
      this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    }

    this.canvas = canvas;
    this.grid = grid;
    this.cursor = cursor;
    this.hasRenderedOnce = false;

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

    // Flip active double-buffer index
    this.activeBufferIdx = 1 - this.activeBufferIdx;

    // Incremental rebuild — only re-pack dirty rows
    // On first render or if grid dimensions changed, initialize per-row tracking
    if (!this.hasRenderedOnce || this.rowBgOffsets.length !== rows) {
      this.rowBgOffsets = new Array(rows).fill(0);
      this.rowBgCounts = new Array(rows).fill(0);
      this.rowGlyphOffsets = new Array(rows).fill(0);
      this.rowGlyphCounts = new Array(rows).fill(0);

      // Compute fixed offsets: each row has exactly `cols` bg instances
      // Glyph offsets are variable, so on first pass we do a full rebuild
      let bgOff = 0;
      let glyphOff = 0;
      for (let r = 0; r < rows; r++) {
        this.rowBgOffsets[r] = bgOff;
        this.rowBgCounts[r] = cols; // one bg instance per cell
        bgOff += cols;
        // For glyphs, allocate max possible (cols) per row on first pass
        this.rowGlyphOffsets[r] = glyphOff;
        this.rowGlyphCounts[r] = cols; // cols (not 0) so cleanup loop zeros all stale slots
        glyphOff += cols;
      }
      this.bgCount = bgOff;
      this.glyphCount = 0; // will be summed below
    }

    for (let row = 0; row < rows; row++) {
      // Skip non-dirty rows — their data persists in the arrays
      if (!grid.isDirty(row)) continue;

      const bgBase = this.rowBgOffsets[row] * BG_INSTANCE_FLOATS;
      const glyphBase = this.rowGlyphOffsets[row] * GLYPH_INSTANCE_FLOATS;
      let rowGlyphCount = 0;

      for (let col = 0; col < cols; col++) {
        const codepoint = grid.getCodepoint(row, col);
        const fgIdx = grid.getFgIndex(row, col);
        const bgIdx = grid.getBgIndex(row, col);
        const attrs = grid.getAttrs(row, col);
        const fgIsRGB = grid.isFgRGB(row, col);
        const bgIsRGB = grid.isBgRGB(row, col);
        const wide = grid.isWide(row, col);

        // Skip spacer cells (right half of wide character)
        if (grid.isSpacerCell(row, col)) {
          // Still need to emit a bg instance for this column
          packBgInstance(
            this.bgInstances,
            bgBase + col * BG_INSTANCE_FLOATS,
            col,
            row,
            0,
            0,
            0,
            0, // transparent — wide char bg already covers this
          );
          continue;
        }

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

        // Handle inverse
        if (attrs & ATTR_INVERSE) {
          const tmp = fg;
          fg = bg;
          bg = tmp;
        }

        // Background instance — wide chars get 2x width via two bg cells
        packBgInstance(
          this.bgInstances,
          bgBase + col * BG_INSTANCE_FLOATS,
          col,
          row,
          bg[0],
          bg[1],
          bg[2],
          bg[3],
        );
        if (wide && col + 1 < cols) {
          // Paint right-half bg with same color
          packBgInstance(
            this.bgInstances,
            bgBase + (col + 1) * BG_INSTANCE_FLOATS,
            col + 1,
            row,
            bg[0],
            bg[1],
            bg[2],
            bg[3],
          );
        }

        // Glyph instance — skip spaces and control chars
        if (codepoint > 0x20) {
          const bold = !!(attrs & ATTR_BOLD);
          const italic = !!(attrs & ATTR_ITALIC);
          const glyph = this.atlas.getGlyph(codepoint, bold, italic);

          if (glyph) {
            const glyphPh = glyph.ph;
            packGlyphInstance(
              this.glyphInstances,
              glyphBase + rowGlyphCount * GLYPH_INSTANCE_FLOATS,
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
              glyphPh,
            );
            rowGlyphCount++;
          }
        }
      }

      // Zero out remaining glyph slots for this row (if fewer glyphs than last time)
      const maxGlyphSlots = cols;
      for (let i = rowGlyphCount; i < this.rowGlyphCounts[row]; i++) {
        // Zero the codepoint/color to make invisible (alpha=0 effectively)
        const off = glyphBase + i * GLYPH_INSTANCE_FLOATS;
        for (let j = 0; j < GLYPH_INSTANCE_FLOATS; j++) {
          this.glyphInstances[off + j] = 0;
        }
      }
      // Keep max of old and new count to ensure we still upload zeroed slots
      if (rowGlyphCount > maxGlyphSlots) rowGlyphCount = maxGlyphSlots;
      this.rowGlyphCounts[row] = rowGlyphCount;

      grid.clearDirty(row);
    }

    this.hasRenderedOnce = true;

    // Both bg and glyph instance arrays are sized for rows * cols slots;
    // data is packed per-row at fixed offsets so we always upload the full region.
    this.bgCount = rows * cols;
    this.glyphCount = rows * cols;

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

    const _FLOAT = 4;
    const activeBgVBO = this.bgInstanceVBOs[this.activeBufferIdx];
    const activeGlyphVBO = this.glyphInstanceVBOs[this.activeBufferIdx];

    // --- Background pass ---
    if (this.bgCount > 0 && this.bgProgram && this.bgVAO && activeBgVBO) {
      gl.useProgram(this.bgProgram);

      // Use cached uniform locations
      gl.uniform2f(this.bgResolutionLoc, canvasWidth, canvasHeight);
      gl.uniform2f(this.bgCellSizeLoc, cellW, cellH);

      // Bind active double-buffered VBO and re-setup instance attrib pointers
      gl.bindBuffer(gl.ARRAY_BUFFER, activeBgVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.bgInstances.subarray(0, this.bgCount * BG_INSTANCE_FLOATS),
        gl.STREAM_DRAW, // STREAM_DRAW for per-frame uploads
      );

      gl.bindVertexArray(this.bgVAO);
      // Rebind instance attribs to the active VBO (VAO captured the old one)
      this.rebindBgInstanceAttribs(gl, activeBgVBO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.bgCount);
    }

    // --- Glyph pass ---
    if (this.glyphCount > 0 && this.glyphProgram && this.glyphVAO && activeGlyphVBO) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.glyphProgram);

      // Use cached uniform locations
      gl.uniform2f(this.glyphResolutionLoc, canvasWidth, canvasHeight);
      gl.uniform2f(this.glyphCellSizeLoc, cellW, cellH);

      // Bind atlas texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.getTexture());
      gl.uniform1i(this.glyphAtlasLoc, 0);

      // Bind active double-buffered VBO
      gl.bindBuffer(gl.ARRAY_BUFFER, activeGlyphVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.glyphInstances.subarray(0, this.glyphCount * GLYPH_INSTANCE_FLOATS),
        gl.STREAM_DRAW, // STREAM_DRAW for per-frame uploads
      );

      gl.bindVertexArray(this.glyphVAO);
      // Rebind instance attribs to the active VBO
      this.rebindGlyphInstanceAttribs(gl, activeGlyphVBO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.glyphCount);

      gl.disable(gl.BLEND);
    }

    // Enable BLEND once for all overlay passes
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // --- Highlights (search results) ---
    this.drawHighlights();

    // --- Selection overlay ---
    this.drawSelection();

    // --- Cursor ---
    this.drawCursor();

    gl.disable(gl.BLEND);

    gl.bindVertexArray(null);
  }

  resize(_cols: number, _rows: number): void {
    if (!this.canvas || !this.grid) return;
    this.syncCanvasSize();
    this.hasRenderedOnce = false; // force full rebuild on any resize (not just grow)
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

  setFont(
    fontSize: number,
    fontFamily: string,
    fontWeight?: number,
    fontWeightBold?: number,
  ): void {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    if (fontWeight !== undefined) this.fontWeight = fontWeight;
    if (fontWeightBold !== undefined) this.fontWeightBold = fontWeightBold;
    this.measureCellSize();

    // Recreate atlas with new font size/weight
    if (this.gl) {
      this.atlas.dispose(this.gl);
    }
    this.atlas = new GlyphAtlas(
      Math.round(this.fontSize * this.dpr),
      this.fontFamily,
      this.fontWeight,
      this.fontWeightBold,
    );
    this.atlas.prewarmASCII();

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
      if (this.bgInstanceVBOs[0]) gl.deleteBuffer(this.bgInstanceVBOs[0]);
      if (this.bgInstanceVBOs[1]) gl.deleteBuffer(this.bgInstanceVBOs[1]);
      if (this.glyphInstanceVBOs[0]) gl.deleteBuffer(this.glyphInstanceVBOs[0]);
      if (this.glyphInstanceVBOs[1]) gl.deleteBuffer(this.glyphInstanceVBOs[1]);
      if (this.overlayVBO) gl.deleteBuffer(this.overlayVBO);
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

    // Double-buffered instance VBOs
    this.bgInstanceVBOs = [gl.createBuffer(), gl.createBuffer()];
    this.glyphInstanceVBOs = [gl.createBuffer(), gl.createBuffer()];
    // Dedicated overlay VBO for cursor/selection/highlights
    this.overlayVBO = gl.createBuffer();

    // Set up background VAO (quad + EBO only; instance buffer bound per-frame)
    this.bgVAO = gl.createVertexArray();
    gl.bindVertexArray(this.bgVAO);
    this.setupBgVAO(gl);
    gl.bindVertexArray(null);

    // Set up glyph VAO (quad + EBO only; instance buffer bound per-frame)
    this.glyphVAO = gl.createVertexArray();
    gl.bindVertexArray(this.glyphVAO);
    this.setupGlyphVAO(gl);
    gl.bindVertexArray(null);

    // Cache all uniform locations after programs are compiled
    this.bgResolutionLoc = gl.getUniformLocation(this.bgProgram, "u_resolution");
    this.bgCellSizeLoc = gl.getUniformLocation(this.bgProgram, "u_cellSize");
    this.glyphResolutionLoc = gl.getUniformLocation(this.glyphProgram, "u_resolution");
    this.glyphCellSizeLoc = gl.getUniformLocation(this.glyphProgram, "u_cellSize");
    this.glyphAtlasLoc = gl.getUniformLocation(this.glyphProgram, "u_atlas");

    // Cache attribute locations
    this.bgAttribLocs = {
      cellPos: gl.getAttribLocation(this.bgProgram, "a_cellPos"),
      color: gl.getAttribLocation(this.bgProgram, "a_color"),
    };
    this.glyphAttribLocs = {
      cellPos: gl.getAttribLocation(this.glyphProgram, "a_cellPos"),
      color: gl.getAttribLocation(this.glyphProgram, "a_color"),
      texCoord: gl.getAttribLocation(this.glyphProgram, "a_texCoord"),
      glyphSize: gl.getAttribLocation(this.glyphProgram, "a_glyphSize"),
    };

    // Reset dirty-row tracking state on GL reinit
    this.hasRenderedOnce = false;

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

    // Instance data — bind initial buffer; will be rebound per-frame for double buffering
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBOs[0]);
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

    // Instance data — bind initial buffer; will be rebound per-frame for double buffering
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInstanceVBOs[0]);
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
      this.hasRenderedOnce = false; // force full rebuild on resize
    }
    if (this.glyphInstances.length < neededGlyph) {
      this.glyphInstances = new Float32Array(neededGlyph);
      this.hasRenderedOnce = false;
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

  // -----------------------------------------------------------------------
  // Cursor
  // -----------------------------------------------------------------------

  private drawHighlights(): void {
    if (!this.gl || !this.highlights.length) return;

    const gl = this.gl;
    if (!this.bgProgram || !this.bgVAO || !this.overlayVBO) return;

    // Pack into pre-allocated hlBuffer, growing only if needed
    let hlIdx = 0;
    for (const hl of this.highlights) {
      const r = hl.isCurrent ? 1.0 : 1.0;
      const g = hl.isCurrent ? 0.647 : 1.0;
      const b = hl.isCurrent ? 0.0 : 0.0;
      const a = hl.isCurrent ? 0.5 : 0.3;

      for (let col = hl.startCol; col <= hl.endCol; col++) {
        const needed = (hlIdx + 1) * BG_INSTANCE_FLOATS;
        if (needed > this.hlBuffer.length) {
          const newBuf = new Float32Array(this.hlBuffer.length * 2);
          newBuf.set(this.hlBuffer);
          this.hlBuffer = newBuf;
        }
        const off = hlIdx * BG_INSTANCE_FLOATS;
        this.hlBuffer[off] = col;
        this.hlBuffer[off + 1] = hl.row;
        this.hlBuffer[off + 2] = r;
        this.hlBuffer[off + 3] = g;
        this.hlBuffer[off + 4] = b;
        this.hlBuffer[off + 5] = a;
        hlIdx++;
      }
    }

    if (hlIdx === 0) return;

    // BLEND already enabled by caller
    gl.useProgram(this.bgProgram);
    // Use cached uniform locations
    gl.uniform2f(this.bgResolutionLoc, this.canvas?.width ?? 0, this.canvas?.height ?? 0);
    gl.uniform2f(this.bgCellSizeLoc, this.cellWidth * this.dpr, this.cellHeight * this.dpr);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayVBO);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.hlBuffer.subarray(0, hlIdx * BG_INSTANCE_FLOATS),
      gl.STREAM_DRAW,
    );

    gl.bindVertexArray(this.bgVAO);
    this.rebindBgInstanceAttribs(gl, this.overlayVBO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, hlIdx);
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

    if (!this.bgProgram || !this.bgVAO || !this.overlayVBO) return;

    // Parse the selection background color
    const selColor = hexToFloat4(this.theme.selectionBackground);

    // Pack into pre-allocated selBuffer, growing only if needed
    let selIdx = 0;

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
        const needed = (selIdx + 1) * BG_INSTANCE_FLOATS;
        if (needed > this.selBuffer.length) {
          const newBuf = new Float32Array(this.selBuffer.length * 2);
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

    // BLEND already enabled by caller
    gl.useProgram(this.bgProgram);
    // Use cached uniform locations
    gl.uniform2f(this.bgResolutionLoc, this.canvas?.width ?? 0, this.canvas?.height ?? 0);
    gl.uniform2f(this.bgCellSizeLoc, this.cellWidth * this.dpr, this.cellHeight * this.dpr);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayVBO);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.selBuffer.subarray(0, selIdx * BG_INSTANCE_FLOATS),
      gl.STREAM_DRAW,
    );

    gl.bindVertexArray(this.bgVAO);
    this.rebindBgInstanceAttribs(gl, this.overlayVBO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, selIdx);
  }

  private drawCursor(): void {
    if (!this.gl || !this.cursor || !this.cursor.visible) return;

    const gl = this.gl;
    const cursor = this.cursor;
    const cellW = this.cellWidth * this.dpr;
    const cellH = this.cellHeight * this.dpr;
    const cc = this.themeCursorFloat;

    // Use the bg program to draw a simple colored rect for the cursor
    if (!this.bgProgram || !this.bgVAO || !this.overlayVBO) return;

    // BLEND already enabled by caller
    gl.useProgram(this.bgProgram);
    // Use cached uniform locations
    gl.uniform2f(this.bgResolutionLoc, this.canvas?.width ?? 0, this.canvas?.height ?? 0);
    gl.uniform2f(this.bgCellSizeLoc, cellW, cellH);

    // Write into pre-allocated cursorData instead of allocating
    // For bar and underline styles, we draw a thin rect.
    // We abuse cellPos with fractional values to position correctly.
    switch (cursor.style) {
      case "block":
        this.cursorData[0] = cursor.col;
        this.cursorData[1] = cursor.row;
        this.cursorData[2] = cc[0];
        this.cursorData[3] = cc[1];
        this.cursorData[4] = cc[2];
        this.cursorData[5] = 0.5; // 50% alpha for block
        break;

      case "underline": {
        // Draw a thin line at the bottom of the cell
        const lineH = Math.max(2 * this.dpr, 1);
        const fractionalRow = cursor.row + (cellH - lineH) / cellH;
        this.cursorData[0] = cursor.col;
        this.cursorData[1] = fractionalRow;
        this.cursorData[2] = cc[0];
        this.cursorData[3] = cc[1];
        this.cursorData[4] = cc[2];
        this.cursorData[5] = cc[3];
        break;
      }

      case "bar": {
        this.cursorData[0] = cursor.col;
        this.cursorData[1] = cursor.row;
        this.cursorData[2] = cc[0];
        this.cursorData[3] = cc[1];
        this.cursorData[4] = cc[2];
        this.cursorData[5] = cc[3];
        break;
      }

      default:
        this.cursorData[0] = cursor.col;
        this.cursorData[1] = cursor.row;
        this.cursorData[2] = cc[0];
        this.cursorData[3] = cc[1];
        this.cursorData[4] = cc[2];
        this.cursorData[5] = 0.5;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.cursorData, gl.STREAM_DRAW);

    gl.bindVertexArray(this.bgVAO);
    this.rebindBgInstanceAttribs(gl, this.overlayVBO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, 1);
  }

  // -----------------------------------------------------------------------
  // Instance attribute rebinding helpers for double-buffered VBOs
  // -----------------------------------------------------------------------

  // Cached attribute locations (populated in initGLResources)
  private bgAttribLocs: { cellPos: number; color: number } = { cellPos: -1, color: -1 };
  private glyphAttribLocs: { cellPos: number; color: number; texCoord: number; glyphSize: number } =
    { cellPos: -1, color: -1, texCoord: -1, glyphSize: -1 };

  private rebindBgInstanceAttribs(gl: WebGL2RenderingContext, vbo: WebGLBuffer): void {
    const FLOAT = 4;
    const stride = BG_INSTANCE_FLOATS * FLOAT;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.vertexAttribPointer(this.bgAttribLocs.cellPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(this.bgAttribLocs.color, 4, gl.FLOAT, false, stride, 2 * FLOAT);
  }

  private rebindGlyphInstanceAttribs(gl: WebGL2RenderingContext, vbo: WebGLBuffer): void {
    const FLOAT = 4;
    const stride = GLYPH_INSTANCE_FLOATS * FLOAT;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.vertexAttribPointer(this.glyphAttribLocs.cellPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(this.glyphAttribLocs.color, 4, gl.FLOAT, false, stride, 2 * FLOAT);
    gl.vertexAttribPointer(this.glyphAttribLocs.texCoord, 4, gl.FLOAT, false, stride, 6 * FLOAT);
    gl.vertexAttribPointer(this.glyphAttribLocs.glyphSize, 2, gl.FLOAT, false, stride, 10 * FLOAT);
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
    font += `${bold ? this.fontWeightBold : this.fontWeight} `;
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
