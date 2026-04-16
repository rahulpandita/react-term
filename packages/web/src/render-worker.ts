/**
 * Render Worker entry point.
 *
 * Receives an OffscreenCanvas (transferred from the main thread) and a
 * SharedArrayBuffer reference for the CellGrid.  Runs its own WebGL2
 * render loop at display refresh rate via requestAnimationFrame.
 *
 * The worker owns the glyph atlas and all GL resources. The main thread
 * only sends lightweight messages for cursor, selection, theme, font,
 * and resize events.
 */

import type { Theme } from "@next_term/core";
import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import { build256Palette } from "./renderer.js";
import { type ColorFloat4, resolveColorFloat } from "./webgl-utils.js";

// Type declaration for Web Worker global scope (not included in DOM lib)
declare type DedicatedWorkerGlobalScope = typeof globalThis & {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
};

import {
  BG_INSTANCE_FLOATS,
  GLYPH_INSTANCE_FLOATS,
  GlyphAtlas,
  hexToFloat4,
  packBgInstance,
  packGlyphInstance,
} from "./webgl-renderer.js";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface RenderWorkerInitMessage {
  type: "init";
  canvas: OffscreenCanvas;
  sharedBuffer: SharedArrayBuffer;
  cols: number;
  rows: number;
  theme: Theme;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  fontWeightBold: number;
  devicePixelRatio: number;
}

export interface RenderWorkerUpdateMessage {
  type: "update";
  cursor: { row: number; col: number; visible: boolean; style: string };
  selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
}

export interface RenderWorkerResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
  sharedBuffer: SharedArrayBuffer;
}

export interface RenderWorkerThemeMessage {
  type: "theme";
  theme: Theme;
}

export interface RenderWorkerFontMessage {
  type: "font";
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  fontWeightBold: number;
}

export interface RenderWorkerSyncedOutputMessage {
  type: "syncedOutput";
  enabled: boolean;
}

export interface RenderWorkerDisposeMessage {
  type: "dispose";
}

export type RenderWorkerInboundMessage =
  | RenderWorkerInitMessage
  | RenderWorkerUpdateMessage
  | RenderWorkerResizeMessage
  | RenderWorkerThemeMessage
  | RenderWorkerFontMessage
  | RenderWorkerSyncedOutputMessage
  | RenderWorkerDisposeMessage;

export interface RenderWorkerFrameMessage {
  type: "frame";
  fps: number;
}

// ---------------------------------------------------------------------------
// Attribute bit positions
// ---------------------------------------------------------------------------

const ATTR_BOLD = 0x01;
const ATTR_ITALIC = 0x02;
const ATTR_INVERSE = 0x40;

// ---------------------------------------------------------------------------
// Shader sources (duplicated from webgl-renderer.ts for worker isolation)
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
// Shader helpers
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
// Worker state
// ---------------------------------------------------------------------------

let canvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let grid: CellGrid | null = null;
let atlas: GlyphAtlas | null = null;

let cols = 0;
let rows = 0;
let dpr = 1;
let fontSize = 14;
let fontFamily = "monospace";
let fontWeight = 400;
let fontWeightBold = 700;
let theme: Theme = DEFAULT_THEME;
let palette: string[] = [];
let paletteFloat: ColorFloat4[] = [];
let themeFgFloat: ColorFloat4 = [0, 0, 0, 1];
let themeBgFloat: ColorFloat4 = [0, 0, 0, 1];
let themeCursorFloat: ColorFloat4 = [0, 0, 0, 1];

let cellWidth = 0;
let cellHeight = 0;

// Cursor & selection (updated via postMessage or SAB)
let cursorRow = 0;
let cursorCol = 0;
let cursorVisible = true;
let prevCursorRow = -1;
let prevCursorCol = -1;
let cursorStyle = "block";
let selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null = null;

// GL resources
let bgProgram: WebGLProgram | null = null;
let glyphProgram: WebGLProgram | null = null;
let quadVBO: WebGLBuffer | null = null;
let quadEBO: WebGLBuffer | null = null;
let bgInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
let glyphInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
let activeBufferIdx = 0;
const bgVAOs: [WebGLVertexArrayObject | null, WebGLVertexArrayObject | null] = [null, null];
const glyphVAOs: [WebGLVertexArrayObject | null, WebGLVertexArrayObject | null] = [null, null];

// Cached uniform locations
let bgResolutionLoc: WebGLUniformLocation | null = null;
let bgCellSizeLoc: WebGLUniformLocation | null = null;
let glyphResolutionLoc: WebGLUniformLocation | null = null;
let glyphCellSizeLoc: WebGLUniformLocation | null = null;
let glyphAtlasLoc: WebGLUniformLocation | null = null;

let bgInstances: Float32Array = new Float32Array(0);
let glyphInstances: Float32Array = new Float32Array(0);
let bgCount = 0;
let glyphCount = 0;

// Pre-allocated overlay buffers
const cursorDataBuf = new Float32Array(BG_INSTANCE_FLOATS);
let selBuffer = new Float32Array(256 * BG_INSTANCE_FLOATS);

let rafId: number | null = null;
let disposed = false;
let contextLost = false;

// FPS tracking
let frameCount = 0;
let lastFpsTime = 0;
let currentFps = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPaletteFloat(): void {
  palette = build256Palette(theme);
  paletteFloat = palette.map((c) => hexToFloat4(c));
  themeFgFloat = hexToFloat4(theme.foreground);
  themeBgFloat = hexToFloat4(theme.background);
  themeCursorFloat = hexToFloat4(theme.cursor);
}

function measureCellSize(): void {
  const measureCanvas = new OffscreenCanvas(100, 100);
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) {
    cellWidth = Math.ceil(fontSize * 0.6);
    cellHeight = Math.ceil(fontSize * 1.2);
    return;
  }

  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const metrics = ctx.measureText("M");

  cellWidth = Math.ceil(metrics.width);
  if (
    typeof metrics.fontBoundingBoxAscent === "number" &&
    typeof metrics.fontBoundingBoxDescent === "number"
  ) {
    cellHeight = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
  } else {
    cellHeight = Math.ceil(fontSize * 1.2);
  }

  if (cellWidth <= 0) cellWidth = Math.ceil(fontSize * 0.6);
  if (cellHeight <= 0) cellHeight = Math.ceil(fontSize * 1.2);
}

function createGridFromSAB(buffer: SharedArrayBuffer, c: number, r: number): CellGrid {
  // Create a CellGrid view over the shared buffer.
  // We construct a CellGrid with matching dims then overlay the buffer.
  // Since CellGrid constructor allocates its own buffer, we need to construct
  // a lightweight wrapper that uses the shared buffer directly.
  const g = Object.create(CellGrid.prototype) as CellGrid;
  const CELL_SIZE = 4;
  const cellBytes = c * r * CELL_SIZE * 4;
  const dirtyBytes = r * 4;
  const cursorBytes = 4 * 4;

  // Use Object.defineProperty to set readonly properties
  Object.defineProperty(g, "cols", { value: c, writable: false });
  Object.defineProperty(g, "rows", { value: r, writable: false });
  Object.defineProperty(g, "isShared", { value: true, writable: false });
  Object.defineProperty(g, "data", {
    value: new Uint32Array(buffer, 0, c * r * CELL_SIZE),
    writable: false,
  });
  Object.defineProperty(g, "dirtyRows", {
    value: new Int32Array(buffer, cellBytes, r),
    writable: false,
  });
  Object.defineProperty(g, "cursorData", {
    value: new Int32Array(buffer, cellBytes + dirtyBytes, 4),
    writable: false,
  });
  Object.defineProperty(g, "rowOffsetData", {
    value: new Int32Array(buffer, cellBytes + dirtyBytes + cursorBytes, 1),
    writable: false,
  });
  // Set private buffer field for getBuffer()
  Object.defineProperty(g, "buffer", { value: buffer, writable: false });

  return g;
}

// ---------------------------------------------------------------------------
// GL resource management
// ---------------------------------------------------------------------------

function initGLResources(): void {
  if (!gl) return;

  bgProgram = createProgram(gl, BG_VERTEX_SHADER, BG_FRAGMENT_SHADER);
  glyphProgram = createProgram(gl, GLYPH_VERTEX_SHADER, GLYPH_FRAGMENT_SHADER);

  const quadVerts = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
  const quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);

  quadVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

  quadEBO = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadEBO);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

  bgInstanceVBOs = [gl.createBuffer(), gl.createBuffer()];
  glyphInstanceVBOs = [gl.createBuffer(), gl.createBuffer()];
  activeBufferIdx = 0;

  // Cache uniform locations
  bgResolutionLoc = gl.getUniformLocation(bgProgram, "u_resolution");
  bgCellSizeLoc = gl.getUniformLocation(bgProgram, "u_cellSize");
  glyphResolutionLoc = gl.getUniformLocation(glyphProgram, "u_resolution");
  glyphCellSizeLoc = gl.getUniformLocation(glyphProgram, "u_cellSize");
  glyphAtlasLoc = gl.getUniformLocation(glyphProgram, "u_atlas");

  for (let i = 0; i < 2; i++) {
    bgVAOs[i] = gl.createVertexArray();
    gl.bindVertexArray(bgVAOs[i]);
    setupBgVAO(gl, i);
    gl.bindVertexArray(null);

    glyphVAOs[i] = gl.createVertexArray();
    gl.bindVertexArray(glyphVAOs[i]);
    setupGlyphVAO(gl, i);
    gl.bindVertexArray(null);
  }

  if (atlas) atlas.recreateTexture();
}

function setupBgVAO(g: WebGL2RenderingContext, bufIdx: number): void {
  const FLOAT = 4;
  if (!bgProgram) return;
  const program = bgProgram;

  const aPos = g.getAttribLocation(program, "a_position");
  g.bindBuffer(g.ARRAY_BUFFER, quadVBO);
  g.enableVertexAttribArray(aPos);
  g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0);

  g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, quadEBO);

  g.bindBuffer(g.ARRAY_BUFFER, bgInstanceVBOs[bufIdx]);
  const stride = BG_INSTANCE_FLOATS * FLOAT;

  const aCellPos = g.getAttribLocation(program, "a_cellPos");
  g.enableVertexAttribArray(aCellPos);
  g.vertexAttribPointer(aCellPos, 2, g.FLOAT, false, stride, 0);
  g.vertexAttribDivisor(aCellPos, 1);

  const aColor = g.getAttribLocation(program, "a_color");
  g.enableVertexAttribArray(aColor);
  g.vertexAttribPointer(aColor, 4, g.FLOAT, false, stride, 2 * FLOAT);
  g.vertexAttribDivisor(aColor, 1);
}

function setupGlyphVAO(g: WebGL2RenderingContext, bufIdx: number): void {
  const FLOAT = 4;
  if (!glyphProgram) return;
  const program = glyphProgram;

  const aPos = g.getAttribLocation(program, "a_position");
  g.bindBuffer(g.ARRAY_BUFFER, quadVBO);
  g.enableVertexAttribArray(aPos);
  g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0);

  g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, quadEBO);

  g.bindBuffer(g.ARRAY_BUFFER, glyphInstanceVBOs[bufIdx]);
  const stride = GLYPH_INSTANCE_FLOATS * FLOAT;

  const aCellPos = g.getAttribLocation(program, "a_cellPos");
  g.enableVertexAttribArray(aCellPos);
  g.vertexAttribPointer(aCellPos, 2, g.FLOAT, false, stride, 0);
  g.vertexAttribDivisor(aCellPos, 1);

  const aColor = g.getAttribLocation(program, "a_color");
  g.enableVertexAttribArray(aColor);
  g.vertexAttribPointer(aColor, 4, g.FLOAT, false, stride, 2 * FLOAT);
  g.vertexAttribDivisor(aColor, 1);

  const aTexCoord = g.getAttribLocation(program, "a_texCoord");
  g.enableVertexAttribArray(aTexCoord);
  g.vertexAttribPointer(aTexCoord, 4, g.FLOAT, false, stride, 6 * FLOAT);
  g.vertexAttribDivisor(aTexCoord, 1);

  const aGlyphSize = g.getAttribLocation(program, "a_glyphSize");
  g.enableVertexAttribArray(aGlyphSize);
  g.vertexAttribPointer(aGlyphSize, 2, g.FLOAT, false, stride, 10 * FLOAT);
  g.vertexAttribDivisor(aGlyphSize, 1);
}

function ensureInstanceBuffers(): void {
  const totalCells = cols * rows;
  const neededBg = totalCells * BG_INSTANCE_FLOATS;
  const neededGlyph = totalCells * GLYPH_INSTANCE_FLOATS;

  if (bgInstances.length < neededBg) {
    bgInstances = new Float32Array(neededBg);
  }
  if (glyphInstances.length < neededGlyph) {
    glyphInstances = new Float32Array(neededGlyph);
  }
}

function syncCanvasSize(): void {
  if (!canvas) return;
  const width = cols * cellWidth;
  const height = rows * cellHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): void {
  if (disposed || contextLost || !gl || !grid) return;

  // Read cursor from SAB
  const cursor = grid.getCursor();
  cursorRow = cursor.row;
  cursorCol = cursor.col;
  cursorVisible = cursor.visible;
  cursorStyle = cursor.style;

  // If cursor moved, mark old and new rows dirty to erase ghost and draw fresh
  if (
    prevCursorRow >= 0 &&
    prevCursorRow < rows &&
    (prevCursorRow !== cursorRow || prevCursorCol !== cursorCol)
  ) {
    grid.markDirty(prevCursorRow);
  }
  if (cursorRow >= 0 && cursorRow < rows) {
    grid.markDirty(cursorRow);
  }
  prevCursorRow = cursorRow;
  prevCursorCol = cursorCol;

  // Check dirty rows
  let anyDirty = false;
  for (let r = 0; r < rows; r++) {
    if (grid.isDirty(r)) {
      anyDirty = true;
      break;
    }
  }
  if (!anyDirty) return;

  // Only rebuild dirty rows — clean rows retain data from previous frame
  bgCount = cols * rows;
  glyphCount = 0;

  for (let row = 0; row < rows; row++) {
    if (!grid.isDirty(row)) {
      // Count glyphs in clean rows so glyphCount stays correct
      for (let col = 0; col < cols; col++) {
        const codepoint = grid.getCodepoint(row, col);
        // Skip spacer cells (right half of wide char)
        if (grid.isSpacerCell(row, col)) continue;
        if (codepoint > 0x20) glyphCount++;
      }
      continue;
    }

    // Row-level glyph packing: we need to rebuild glyph data for this row.
    // Since glyph instances are sparse, we collect glyph count for all rows
    // and repack below.
    for (let col = 0; col < cols; col++) {
      const codepoint = grid.getCodepoint(row, col);

      // Skip spacer cells (right half of wide character)
      if (grid.isSpacerCell(row, col)) {
        packBgInstance(bgInstances, (row * cols + col) * BG_INSTANCE_FLOATS, col, row, 0, 0, 0, 0);
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
        paletteFloat,
        themeFgFloat,
        themeBgFloat,
      );
      let bg = resolveColorFloat(
        bgIdx,
        bgIsRGB,
        grid.getBgRGB(row, col),
        false,
        paletteFloat,
        themeFgFloat,
        themeBgFloat,
      );

      if (attrs & ATTR_INVERSE) {
        const tmp = fg;
        fg = bg;
        bg = tmp;
      }

      // BG offset is deterministic: row * cols + col
      packBgInstance(
        bgInstances,
        (row * cols + col) * BG_INSTANCE_FLOATS,
        col,
        row,
        bg[0],
        bg[1],
        bg[2],
        bg[3],
      );

      // Wide char: paint bg for right-half too
      if (wide && col + 1 < cols) {
        packBgInstance(
          bgInstances,
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
        const glyph = atlas?.getGlyph(codepoint, bold, italic);

        if (glyph) {
          glyphCount++;
        }
      }
    }
    grid.clearDirty(row);
  }

  // Glyph instances are sparse — rebuild fully (fast; only glyph cells are touched)
  let gi = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const codepoint = grid.getCodepoint(row, col);
      if (codepoint <= 0x20) continue;
      // Skip spacer cells (right half of wide character)
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
        paletteFloat,
        themeFgFloat,
        themeBgFloat,
      );
      let bg = resolveColorFloat(
        bgIdx,
        bgIsRGB,
        grid.getBgRGB(row, col),
        false,
        paletteFloat,
        themeFgFloat,
        themeBgFloat,
      );
      if (attrs & ATTR_INVERSE) {
        const tmp = fg;
        fg = bg;
        bg = tmp;
      }
      const bold = !!(attrs & ATTR_BOLD);
      const italic = !!(attrs & ATTR_ITALIC);
      const glyph = atlas?.getGlyph(codepoint, bold, italic);
      if (glyph) {
        packGlyphInstance(
          glyphInstances,
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

  // Upload atlas
  atlas?.upload(gl);

  const canvasWidth = canvas?.width ?? 0;
  const canvasHeight = canvas?.height ?? 0;
  gl.viewport(0, 0, canvasWidth, canvasHeight);
  gl.clearColor(themeBgFloat[0], themeBgFloat[1], themeBgFloat[2], 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const cellW = cellWidth * dpr;
  const cellH = cellHeight * dpr;

  // Alternate VBOs each frame — write to current index, GPU reads previous
  const writeIdx = activeBufferIdx;
  activeBufferIdx ^= 1;

  const curBgVBO = bgInstanceVBOs[writeIdx];
  const curGlyphVBO = glyphInstanceVBOs[writeIdx];
  const curBgVAO = bgVAOs[writeIdx];
  const curGlyphVAO = glyphVAOs[writeIdx];
  if (bgCount > 0 && bgProgram && curBgVAO && curBgVBO) {
    gl.useProgram(bgProgram);
    gl.uniform2f(bgResolutionLoc, canvasWidth, canvasHeight);
    gl.uniform2f(bgCellSizeLoc, cellW, cellH);

    gl.bindBuffer(gl.ARRAY_BUFFER, curBgVBO);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      bgInstances.subarray(0, bgCount * BG_INSTANCE_FLOATS),
      gl.STREAM_DRAW,
    );

    gl.bindVertexArray(curBgVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, bgCount);
  }

  // Glyph pass
  if (glyphCount > 0 && glyphProgram && curGlyphVAO && curGlyphVBO) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(glyphProgram);
    gl.uniform2f(glyphResolutionLoc, canvasWidth, canvasHeight);
    gl.uniform2f(glyphCellSizeLoc, cellW, cellH);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas?.getTexture() ?? null);
    gl.uniform1i(glyphAtlasLoc, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, curGlyphVBO);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      glyphInstances.subarray(0, glyphCount * GLYPH_INSTANCE_FLOATS),
      gl.STREAM_DRAW,
    );

    gl.bindVertexArray(curGlyphVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, glyphCount);

    gl.disable(gl.BLEND);
  }

  // enable BLEND once for both overlay passes
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // Selection overlay
  drawSelection();

  // Cursor
  drawCursor();

  gl.disable(gl.BLEND);

  gl.bindVertexArray(null);
}

function drawSelection(): void {
  if (!gl || !grid || !selection) return;
  if (!bgProgram || !bgVAOs[0] || !bgInstanceVBOs[0]) return;

  const sr = Math.max(0, selection.startRow);
  const er = Math.min(rows - 1, selection.endRow);
  if (sr === er && selection.startCol === selection.endCol) return;

  const selColor = hexToFloat4(theme.selectionBackground);
  let selIdx = 0;

  for (let row = sr; row <= er; row++) {
    let colStart: number;
    let colEnd: number;

    if (sr === er) {
      colStart = selection.startCol;
      colEnd = selection.endCol;
    } else if (row === sr) {
      colStart = selection.startCol;
      colEnd = cols - 1;
    } else if (row === er) {
      colStart = 0;
      colEnd = selection.endCol;
    } else {
      colStart = 0;
      colEnd = cols - 1;
    }

    for (let col = colStart; col <= colEnd; col++) {
      const needed = (selIdx + 1) * BG_INSTANCE_FLOATS;
      if (needed > selBuffer.length) {
        const newBuf = new Float32Array(needed * 2);
        newBuf.set(selBuffer);
        selBuffer = newBuf;
      }
      const off = selIdx * BG_INSTANCE_FLOATS;
      selBuffer[off] = col;
      selBuffer[off + 1] = row;
      selBuffer[off + 2] = selColor[0];
      selBuffer[off + 3] = selColor[1];
      selBuffer[off + 4] = selColor[2];
      selBuffer[off + 5] = 0.5;
      selIdx++;
    }
  }

  if (selIdx === 0) return;

  // BLEND already enabled by caller
  gl.useProgram(bgProgram);
  gl.uniform2f(bgResolutionLoc, canvas?.width ?? 0, canvas?.height ?? 0);
  gl.uniform2f(bgCellSizeLoc, cellWidth * dpr, cellHeight * dpr);

  gl.bindBuffer(gl.ARRAY_BUFFER, bgInstanceVBOs[0]);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    selBuffer.subarray(0, selIdx * BG_INSTANCE_FLOATS),
    gl.STREAM_DRAW,
  );

  gl.bindVertexArray(bgVAOs[0]);
  gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, selIdx);
}

function drawCursor(): void {
  if (!gl || !cursorVisible) return;
  if (!bgProgram || !bgVAOs[0] || !bgInstanceVBOs[0]) return;

  const cc = themeCursorFloat;

  // BLEND already enabled by caller
  gl.useProgram(bgProgram);
  gl.uniform2f(bgResolutionLoc, canvas?.width ?? 0, canvas?.height ?? 0);
  gl.uniform2f(bgCellSizeLoc, cellWidth * dpr, cellHeight * dpr);

  // reuse pre-allocated cursorDataBuf
  cursorDataBuf[0] = cursorCol;
  cursorDataBuf[2] = cc[0];
  cursorDataBuf[3] = cc[1];
  cursorDataBuf[4] = cc[2];

  switch (cursorStyle) {
    case "block":
      cursorDataBuf[1] = cursorRow;
      cursorDataBuf[5] = 0.5;
      break;
    case "underline": {
      const lineH = Math.max(2 * dpr, 1);
      cursorDataBuf[1] = cursorRow + (cellHeight * dpr - lineH) / (cellHeight * dpr);
      cursorDataBuf[5] = cc[3];
      break;
    }
    case "bar":
      cursorDataBuf[1] = cursorRow;
      cursorDataBuf[5] = cc[3];
      break;
    default:
      cursorDataBuf[1] = cursorRow;
      cursorDataBuf[5] = 0.5;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, bgInstanceVBOs[0]);
  gl.bufferData(gl.ARRAY_BUFFER, cursorDataBuf, gl.STREAM_DRAW);

  gl.bindVertexArray(bgVAOs[0]);
  gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, 1);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function startRenderLoop(): void {
  if (disposed) return;
  if (rafId !== null) return; // already running — prevent stacking
  lastFpsTime = performance.now();
  frameCount = 0;

  const loop = () => {
    if (disposed) return;

    render();

    // FPS tracking
    frameCount++;
    const now = performance.now();
    const elapsed = now - lastFpsTime;
    if (elapsed >= 1000) {
      currentFps = Math.round((frameCount * 1000) / elapsed);
      frameCount = 0;
      lastFpsTime = now;

      // Report FPS back to main thread
      const msg: RenderWorkerFrameMessage = { type: "frame", fps: currentFps };
      (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
    }

    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function stopRenderLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

function disposeResources(): void {
  disposed = true;
  stopRenderLoop();

  if (gl) {
    if (atlas) atlas.dispose(gl);
    if (bgProgram) gl.deleteProgram(bgProgram);
    if (glyphProgram) gl.deleteProgram(glyphProgram);
    if (quadVBO) gl.deleteBuffer(quadVBO);
    if (quadEBO) gl.deleteBuffer(quadEBO);
    if (bgInstanceVBOs[0]) gl.deleteBuffer(bgInstanceVBOs[0]);
    if (bgInstanceVBOs[1]) gl.deleteBuffer(bgInstanceVBOs[1]);
    if (glyphInstanceVBOs[0]) gl.deleteBuffer(glyphInstanceVBOs[0]);
    if (glyphInstanceVBOs[1]) gl.deleteBuffer(glyphInstanceVBOs[1]);
    if (bgVAOs[0]) gl.deleteVertexArray(bgVAOs[0]);
    if (bgVAOs[1]) gl.deleteVertexArray(bgVAOs[1]);
    if (glyphVAOs[0]) gl.deleteVertexArray(glyphVAOs[0]);
    if (glyphVAOs[1]) gl.deleteVertexArray(glyphVAOs[1]);
  }

  canvas = null;
  gl = null;
  grid = null;
  atlas = null;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

function handleMessage(msg: RenderWorkerInboundMessage): void {
  switch (msg.type) {
    case "init": {
      canvas = msg.canvas;
      cols = msg.cols;
      rows = msg.rows;
      theme = msg.theme;
      fontSize = msg.fontSize;
      fontFamily = msg.fontFamily;
      fontWeight = msg.fontWeight;
      fontWeightBold = msg.fontWeightBold;
      dpr = msg.devicePixelRatio;

      buildPaletteFloat();
      measureCellSize();

      grid = createGridFromSAB(msg.sharedBuffer, cols, rows);

      atlas = new GlyphAtlas(Math.round(fontSize * dpr), fontFamily, fontWeight, fontWeightBold);

      gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      }) as WebGL2RenderingContext | null;

      if (!gl) {
        const err = { type: "error" as const, message: "WebGL2 not available in worker" };
        (self as unknown as DedicatedWorkerGlobalScope).postMessage(err);
        return;
      }

      // Detect software renderers — Canvas2D is faster on SwiftShader/llvmpipe
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string;
        if (/swiftshader|llvmpipe|software/i.test(renderer)) {
          gl = null;
          const err = {
            type: "error" as const,
            message: `Software renderer detected (${renderer}), falling back`,
          };
          (self as unknown as DedicatedWorkerGlobalScope).postMessage(err);
          return;
        }
      }

      // Handle context loss on the OffscreenCanvas
      canvas.addEventListener("webglcontextlost", (e: Event) => {
        e.preventDefault();
        contextLost = true;
        stopRenderLoop();
      });
      canvas.addEventListener("webglcontextrestored", () => {
        contextLost = false;
        initGLResources();
        if (grid) grid.markAllDirty();
        startRenderLoop();
      });

      syncCanvasSize();
      initGLResources();
      ensureInstanceBuffers();
      atlas.prewarmASCII();
      grid.markAllDirty();
      startRenderLoop();
      break;
    }

    case "update": {
      cursorRow = msg.cursor.row;
      cursorCol = msg.cursor.col;
      cursorVisible = msg.cursor.visible;
      cursorStyle = msg.cursor.style;
      selection = msg.selection;

      // Also write cursor to SAB for consistency
      if (grid) {
        grid.setCursor(cursorRow, cursorCol, cursorVisible, cursorStyle);
      }

      // Mark all dirty so the next frame picks up changes
      if (grid) grid.markAllDirty();
      break;
    }

    case "resize": {
      cols = msg.cols;
      rows = msg.rows;
      grid = createGridFromSAB(msg.sharedBuffer, cols, rows);

      syncCanvasSize();
      ensureInstanceBuffers();
      grid.markAllDirty();
      break;
    }

    case "theme": {
      theme = msg.theme;
      buildPaletteFloat();
      if (grid) grid.markAllDirty();
      break;
    }

    case "font": {
      fontSize = msg.fontSize;
      fontFamily = msg.fontFamily;
      fontWeight = msg.fontWeight;
      fontWeightBold = msg.fontWeightBold;
      measureCellSize();

      if (gl && atlas) {
        atlas.dispose(gl);
      }
      atlas = new GlyphAtlas(Math.round(fontSize * dpr), fontFamily, fontWeight, fontWeightBold);
      atlas.prewarmASCII();

      if (gl) {
        initGLResources();
      }
      syncCanvasSize();
      ensureInstanceBuffers();
      if (grid) grid.markAllDirty();
      break;
    }

    case "syncedOutput": {
      // DECSET ?2026: gate the render loop for synchronized updates.
      if (msg.enabled) {
        stopRenderLoop();
      } else {
        if (grid) grid.markAllDirty();
        startRenderLoop();
      }
      break;
    }

    case "dispose": {
      disposeResources();
      (self as unknown as DedicatedWorkerGlobalScope).close();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(self as unknown as DedicatedWorkerGlobalScope).addEventListener(
  "message",
  (event: MessageEvent<RenderWorkerInboundMessage>) => {
    try {
      handleMessage(event.data);
    } catch (e: unknown) {
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({
        type: "error",
        message: e instanceof Error ? e.message : "Internal render error",
      });
    }
  },
);
