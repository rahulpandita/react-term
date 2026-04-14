/**
 * SharedWebGLContext — manages a single WebGL2 context shared across
 * multiple terminal panes.
 *
 * Chrome limits WebGL contexts to 16 per page. This class allows any number
 * of terminal panes to render through one context using **batched rendering**:
 * all terminals' instance data is packed into a single buffer with per-instance
 * viewport offsets, then uploaded and drawn in one call per pass.
 *
 * The shared canvas is positioned as an overlay by the consumer (typically
 * TerminalPane). Each registered terminal provides its CellGrid, CursorState,
 * and a viewport rectangle (in CSS pixels relative to the canvas).
 */

import type { CellGrid, CursorState, SelectionRange, Theme } from "@next_term/core";
import { DEFAULT_THEME } from "@next_term/core";
import { build256Palette } from "./renderer.js";
import { GlyphAtlas, hexToFloat4 } from "./webgl-renderer.js";
import { type ColorFloat4, resolveColorFloat } from "./webgl-utils.js";

// ---------------------------------------------------------------------------
// Attribute bit positions
// ---------------------------------------------------------------------------

const ATTR_BOLD = 0x01;
const ATTR_ITALIC = 0x02;
const ATTR_INVERSE = 0x40;

// ---------------------------------------------------------------------------
// Shader sources (same as webgl-renderer.ts)
// ---------------------------------------------------------------------------

// Instance floats for shared-context batched rendering (include viewport offset)
const SC_BG_INSTANCE_FLOATS = 8; // cellCol, cellRow, r, g, b, a, offsetX, offsetY
const SC_GLYPH_INSTANCE_FLOATS = 14; // cellCol, cellRow, r, g, b, a, u, v, tw, th, pw, ph, offsetX, offsetY

const BG_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_cellPos;
in vec4 a_color;
in vec2 a_offset;

uniform vec2 u_resolution;
uniform vec2 u_cellSize;

out vec4 v_color;

void main() {
  vec2 cellPixelPos = a_cellPos * u_cellSize + a_offset;
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
in vec2 a_offset;

uniform vec2 u_resolution;
uniform vec2 u_cellSize;

out vec4 v_color;
out vec2 v_texCoord;

void main() {
  vec2 cellPixelPos = a_cellPos * u_cellSize + a_offset;
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
  /** Set when a terminal is removed — forces one canvas clear to erase stale pixels. */
  private needsFullClear = false;
  private rafId: number | null = null;

  // GL resources
  private bgProgram: WebGLProgram | null = null;
  private glyphProgram: WebGLProgram | null = null;
  private quadVBO: WebGLBuffer | null = null;
  private quadEBO: WebGLBuffer | null = null;
  // Double-buffered VBOs — two each for bg and glyph instance data
  private bgInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
  private glyphInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
  private bufferIndex = 0; // toggles 0/1 each frame
  private bgVAOs: [WebGLVertexArrayObject | null, WebGLVertexArrayObject | null] = [null, null];
  private glyphVAOs: [WebGLVertexArrayObject | null, WebGLVertexArrayObject | null] = [null, null];

  // Cached uniform locations
  private bgUniforms: {
    u_resolution: WebGLUniformLocation | null;
    u_cellSize: WebGLUniformLocation | null;
  } = { u_resolution: null, u_cellSize: null };
  private glyphUniforms: {
    u_resolution: WebGLUniformLocation | null;
    u_cellSize: WebGLUniformLocation | null;
    u_atlas: WebGLUniformLocation | null;
  } = { u_resolution: null, u_cellSize: null, u_atlas: null };

  // Cached attribute locations (looked up once in initGLResources)
  private bgAttribLocs: {
    a_position: number;
    a_cellPos: number;
    a_color: number;
    a_offset: number;
  } = { a_position: -1, a_cellPos: -1, a_color: -1, a_offset: -1 };
  private glyphAttribLocs: {
    a_position: number;
    a_cellPos: number;
    a_color: number;
    a_texCoord: number;
    a_glyphSize: number;
    a_offset: number;
  } = {
    a_position: -1,
    a_cellPos: -1,
    a_color: -1,
    a_texCoord: -1,
    a_glyphSize: -1,
    a_offset: -1,
  };

  // Instance data (CPU side) — persistent across frames for dirty-row optimization
  // Sized for ALL terminals combined (not per-terminal)
  private bgInstances: Float32Array;
  private glyphInstances: Float32Array;

  // Per-terminal dirty tracking state
  private terminalBgCounts = new Map<string, number>();
  private terminalGlyphCounts = new Map<string, number>();
  private terminalRowBgOffsets = new Map<string, number[]>(); // bgCount at start of each row
  private terminalRowGlyphOffsets = new Map<string, number[]>(); // glyphCount at start of each row
  private terminalRowBgCounts = new Map<string, number[]>(); // bg instances per row
  private terminalRowGlyphCounts = new Map<string, number[]>(); // glyph instances per row
  private terminalFullyRendered = new Set<string>(); // tracks if terminal has had initial full render

  // Per-terminal cached instance data (for reuse when terminal is clean)
  private terminalBgData = new Map<string, Float32Array>();
  private terminalGlyphData = new Map<string, Float32Array>();

  // Reusable cursor data buffer — grows as needed, never shrinks
  private cursorBuffer = new Float32Array(4 * SC_BG_INSTANCE_FLOATS);

  // Glyph atlas
  private atlas: GlyphAtlas;

  // Theme / palette
  private theme: Theme;
  private palette: string[];
  private paletteFloat: ColorFloat4[] = [];
  private themeFgFloat: ColorFloat4 = [0, 0, 0, 1];
  private themeBgFloat: ColorFloat4 = [0, 0, 0, 1];
  private themeCursorFloat: ColorFloat4 = [0, 0, 0, 1];

  private fontSize: number;
  private fontFamily: string;
  private fontWeight: number;
  private fontWeightBold: number;
  private dpr: number;
  private cellWidth = 0;
  private cellHeight = 0;

  constructor(options?: {
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: number;
    fontWeightBold?: number;
    theme?: Partial<Theme>;
    devicePixelRatio?: number;
  }) {
    this.fontSize = options?.fontSize ?? 14;
    this.fontFamily = options?.fontFamily ?? "'Menlo', 'DejaVu Sans Mono', 'Consolas', monospace";
    this.fontWeight = options?.fontWeight ?? 400;
    this.fontWeightBold = options?.fontWeightBold ?? 700;
    this.theme = { ...DEFAULT_THEME, ...options?.theme };
    this.dpr =
      options?.devicePixelRatio ?? (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    this.palette = build256Palette(this.theme);
    this.buildPaletteFloat();
    this.measureCellSize();

    this.atlas = new GlyphAtlas(
      Math.round(this.fontSize * this.dpr),
      this.fontFamily,
      this.fontWeight,
      this.fontWeightBold,
    );

    // Pre-allocate instance buffers for batched rendering (all terminals combined)
    const maxCells = 80 * 24 * 4; // start with 4 terminals worth
    this.bgInstances = new Float32Array(maxCells * SC_BG_INSTANCE_FLOATS);
    this.glyphInstances = new Float32Array(maxCells * SC_GLYPH_INSTANCE_FLOATS);

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
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;

    if (!this.gl) {
      throw new Error("WebGL2 is not available");
    }

    // Detect software rendering (SwiftShader) — shared context is a net loss
    // on software renderers because it concentrates all panes on one slow context.
    // Fall back to independent per-pane rendering in that case.
    const debugInfo = this.gl.getExtension("WEBGL_debug_renderer_info");
    if (debugInfo) {
      const renderer = this.gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string;
      if (/swiftshader|llvmpipe|software/i.test(renderer)) {
        this.gl = null;
        throw new Error(`Software renderer detected (${renderer}), skipping shared context`);
      }
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
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    )
      return;
    const entry = this.terminals.get(id);
    if (entry) {
      const vp = entry.viewport;
      if (vp.x === x && vp.y === y && vp.width === width && vp.height === height) return;
      entry.viewport = { x, y, width, height };
      // Invalidate so the render loop processes this terminal on the next frame.
      // Critical for zero→non-zero transitions (showing a hidden pane).
      this.terminalFullyRendered.delete(id);
    }
  }

  updateTerminal(id: string, grid: CellGrid, cursor: CursorState): void {
    const entry = this.terminals.get(id);
    if (entry) {
      entry.grid = grid;
      entry.cursor = cursor;
      // Reset dirty tracking — new grid may have different content
      this.terminalFullyRendered.delete(id);
    }
  }

  removeTerminal(id: string): void {
    this.terminals.delete(id);
    // Force one clear frame to erase the removed terminal's stale pixels
    this.needsFullClear = true;
    // Clean up per-terminal dirty tracking state
    this.terminalBgCounts.delete(id);
    this.terminalGlyphCounts.delete(id);
    this.terminalRowBgOffsets.delete(id);
    this.terminalRowGlyphOffsets.delete(id);
    this.terminalRowBgCounts.delete(id);
    this.terminalRowGlyphCounts.delete(id);
    this.terminalFullyRendered.delete(id);
    this.terminalBgData.delete(id);
    this.terminalGlyphData.delete(id);
  }

  getTerminalIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Render all terminals in one frame using batched rendering.
   *
   * All terminals' instance data is packed into combined buffers with
   * per-instance viewport offsets, then uploaded and drawn in single calls.
   * This reduces GL state changes from O(N) to O(1) per pass.
   */
  render(): void {
    if (this.disposed || !this.gl) return;

    const gl = this.gl;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    // Toggle double-buffer index
    this.bufferIndex ^= 1;
    const bi = this.bufferIndex;

    // --- Early out: check if any terminal has dirty rows ---
    const cellW = this.cellWidth * this.dpr;
    const cellH = this.cellHeight * this.dpr;

    let anyTerminalDirty = false;
    for (const [id, entry] of this.terminals) {
      const { grid, viewport } = entry;
      // Zero-viewport terminals are invisible — skip dirty-row checks.
      // But if NOT yet marked fully rendered, we need one more frame to
      // clear stale pixels from the canvas before marking as rendered.
      if (viewport.width <= 0 || viewport.height <= 0) {
        if (!this.terminalFullyRendered.has(id)) {
          anyTerminalDirty = true;
        }
        continue;
      }
      if (!this.terminalFullyRendered.has(id)) {
        anyTerminalDirty = true;
        break;
      }
      for (let row = 0; row < grid.rows; row++) {
        if (grid.isDirty(row)) {
          anyTerminalDirty = true;
          break;
        }
      }
      if (anyTerminalDirty) break;
    }

    // Nothing changed — skip everything, reuse last frame
    if (!anyTerminalDirty && !this.needsFullClear) return;
    this.needsFullClear = false;

    // Mark zero-viewport terminals as fully rendered now that we're about
    // to clear the canvas — their stale pixels will be erased by gl.clear().
    for (const [id, entry] of this.terminals) {
      const { viewport } = entry;
      if (viewport.width <= 0 || viewport.height <= 0) {
        this.terminalFullyRendered.add(id);
      }
    }

    // --- Phase 1: Clear viewports ---
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.SCISSOR_TEST);
    const bgR = this.themeBgFloat[0];
    const bgG = this.themeBgFloat[1];
    const bgB = this.themeBgFloat[2];
    gl.clearColor(bgR, bgG, bgB, 1.0);
    for (const [, entry] of this.terminals) {
      const { viewport } = entry;
      if (viewport.width <= 0 || viewport.height <= 0) continue;
      const vpX = Math.round(viewport.x * this.dpr);
      const vpY = Math.round(viewport.y * this.dpr);
      const vpW = Math.round(viewport.width * this.dpr);
      const vpH = Math.round(viewport.height * this.dpr);
      const glY = canvasHeight - vpY - vpH;
      gl.viewport(vpX, glY, vpW, vpH);
      gl.scissor(vpX, glY, vpW, vpH);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.SCISSOR_TEST);

    // --- Phase 2: Build combined instance data for all terminals ---
    let totalBgCount = 0;
    let totalGlyphCount = 0;

    for (const [id, entry] of this.terminals) {
      const { viewport } = entry;
      if (viewport.width <= 0 || viewport.height <= 0) continue;
      const { bgCount, glyphCount } = this.buildTerminalInstances(id, entry);
      const bgData = this.terminalBgData.get(id);
      const glyphData = this.terminalGlyphData.get(id);

      // Ensure combined buffers are large enough
      const neededBg = (totalBgCount + bgCount) * SC_BG_INSTANCE_FLOATS;
      if (neededBg > this.bgInstances.length) {
        const newBuf = new Float32Array(neededBg * 2);
        newBuf.set(this.bgInstances.subarray(0, totalBgCount * SC_BG_INSTANCE_FLOATS));
        this.bgInstances = newBuf;
      }
      const neededGlyph = (totalGlyphCount + glyphCount) * SC_GLYPH_INSTANCE_FLOATS;
      if (neededGlyph > this.glyphInstances.length) {
        const newBuf = new Float32Array(neededGlyph * 2);
        newBuf.set(this.glyphInstances.subarray(0, totalGlyphCount * SC_GLYPH_INSTANCE_FLOATS));
        this.glyphInstances = newBuf;
      }

      // Copy per-terminal data into combined buffer
      if (bgData && bgCount > 0) {
        this.bgInstances.set(
          bgData.subarray(0, bgCount * SC_BG_INSTANCE_FLOATS),
          totalBgCount * SC_BG_INSTANCE_FLOATS,
        );
      }
      if (glyphData && glyphCount > 0) {
        this.glyphInstances.set(
          glyphData.subarray(0, glyphCount * SC_GLYPH_INSTANCE_FLOATS),
          totalGlyphCount * SC_GLYPH_INSTANCE_FLOATS,
        );
      }

      totalBgCount += bgCount;
      totalGlyphCount += glyphCount;
    }

    // Upload atlas if dirty
    this.atlas.upload(gl);

    // --- Phase 3: Single viewport for all draws (full canvas) ---
    gl.viewport(0, 0, canvasWidth, canvasHeight);

    // --- Background pass: single upload + single draw ---
    const activeBgVBO = this.bgInstanceVBOs[bi];
    const activeBgVAO = this.bgVAOs[bi];
    if (totalBgCount > 0 && this.bgProgram && activeBgVAO && activeBgVBO) {
      gl.useProgram(this.bgProgram);
      gl.uniform2f(this.bgUniforms.u_resolution, canvasWidth, canvasHeight);
      gl.uniform2f(this.bgUniforms.u_cellSize, cellW, cellH);

      gl.bindBuffer(gl.ARRAY_BUFFER, activeBgVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.bgInstances.subarray(0, totalBgCount * SC_BG_INSTANCE_FLOATS),
        gl.STREAM_DRAW,
      );

      gl.bindVertexArray(activeBgVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, totalBgCount);
    }

    // --- Glyph pass: single upload + single draw ---
    const activeGlyphVBO = this.glyphInstanceVBOs[bi];
    const activeGlyphVAO = this.glyphVAOs[bi];
    if (totalGlyphCount > 0 && this.glyphProgram && activeGlyphVAO && activeGlyphVBO) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.glyphProgram);
      gl.uniform2f(this.glyphUniforms.u_resolution, canvasWidth, canvasHeight);
      gl.uniform2f(this.glyphUniforms.u_cellSize, cellW, cellH);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.getTexture());
      gl.uniform1i(this.glyphUniforms.u_atlas, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, activeGlyphVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.glyphInstances.subarray(0, totalGlyphCount * SC_GLYPH_INSTANCE_FLOATS),
        gl.STREAM_DRAW,
      );

      gl.bindVertexArray(activeGlyphVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, totalGlyphCount);

      gl.disable(gl.BLEND);
    }

    // --- Cursor pass: batch all cursors into one draw ---
    let cursorCount = 0;
    const neededCursor = this.terminals.size * SC_BG_INSTANCE_FLOATS;
    if (neededCursor > this.cursorBuffer.length) {
      this.cursorBuffer = new Float32Array(neededCursor);
    }
    const cc = this.themeCursorFloat;
    for (const [, entry] of this.terminals) {
      const { cursor, viewport } = entry;
      if (!cursor.visible) continue;
      if (viewport.width <= 0 || viewport.height <= 0) continue;
      const off = cursorCount * SC_BG_INSTANCE_FLOATS;
      this.cursorBuffer[off] = cursor.col;
      this.cursorBuffer[off + 1] = cursor.row;
      this.cursorBuffer[off + 2] = cc[0];
      this.cursorBuffer[off + 3] = cc[1];
      this.cursorBuffer[off + 4] = cc[2];
      this.cursorBuffer[off + 5] = 0.5;
      this.cursorBuffer[off + 6] = Math.round(viewport.x * this.dpr);
      this.cursorBuffer[off + 7] = Math.round(viewport.y * this.dpr);
      cursorCount++;
    }

    if (cursorCount > 0 && this.bgProgram && activeBgVAO && activeBgVBO) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.bgProgram);
      gl.uniform2f(this.bgUniforms.u_resolution, canvasWidth, canvasHeight);
      gl.uniform2f(this.bgUniforms.u_cellSize, cellW, cellH);

      gl.bindBuffer(gl.ARRAY_BUFFER, activeBgVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.cursorBuffer.subarray(0, cursorCount * SC_BG_INSTANCE_FLOATS),
        gl.STREAM_DRAW,
      );

      gl.bindVertexArray(activeBgVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, cursorCount);

      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);
  }

  /**
   * Update the shared canvas size to match a container element.
   */
  syncCanvasSize(width: number, height: number): void {
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    // Setting canvas.width/height clears all WebGL pixels (spec behavior).
    // Force all terminals to re-render on the next frame.
    this.terminalFullyRendered.clear();
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
      // Clean up double-buffered resources
      for (let i = 0; i < 2; i++) {
        if (this.bgInstanceVBOs[i]) gl.deleteBuffer(this.bgInstanceVBOs[i]);
        if (this.glyphInstanceVBOs[i]) gl.deleteBuffer(this.glyphInstanceVBOs[i]);
        if (this.bgVAOs[i]) gl.deleteVertexArray(this.bgVAOs[i]);
        if (this.glyphVAOs[i]) gl.deleteVertexArray(this.glyphVAOs[i]);
      }
    }

    this.terminals.clear();
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.gl = null;
  }

  // -----------------------------------------------------------------------
  // Per-terminal instance data building (CPU-side only, no GL calls)
  // -----------------------------------------------------------------------

  /**
   * Build instance data for a single terminal into its per-terminal cache.
   * Returns the bg and glyph instance counts. The caller assembles all
   * terminals' data into the combined buffer before issuing GL draws.
   */
  private buildTerminalInstances(
    id: string,
    entry: TerminalEntry,
  ): { bgCount: number; glyphCount: number } {
    const { grid, viewport } = entry;
    // Clamp rows and cols to what fits in the viewport — during resize
    // the grid may be larger than the viewport (fit() is debounced).
    // Use floor so partial rows/cols that would bleed past the viewport
    // boundary are excluded (Phase 3 draws without scissor).
    const rows =
      this.cellHeight > 0
        ? Math.min(grid.rows, Math.floor(viewport.height / this.cellHeight))
        : grid.rows;
    const cols =
      this.cellWidth > 0
        ? Math.min(grid.cols, Math.floor(viewport.width / this.cellWidth))
        : grid.cols;

    // Viewport offset in device pixels for canvas-space coordinates
    const vpX = Math.round(viewport.x * this.dpr);
    const vpY = Math.round(viewport.y * this.dpr);

    // Check if any rows are dirty; if not, use cached counts
    const isFirstRender = !this.terminalFullyRendered.has(id);
    let anyDirty = isFirstRender;
    if (!anyDirty) {
      for (let row = 0; row < rows; row++) {
        if (grid.isDirty(row)) {
          anyDirty = true;
          break;
        }
      }
    }

    if (!anyDirty) {
      // No dirty rows — reuse cached instance data and counts
      return {
        bgCount: this.terminalBgCounts.get(id) ?? 0,
        glyphCount: this.terminalGlyphCounts.get(id) ?? 0,
      };
    }

    // Ensure per-terminal data buffers are large enough
    const totalCells = cols * rows;
    let bgData = this.terminalBgData.get(id);
    if (!bgData || bgData.length < totalCells * SC_BG_INSTANCE_FLOATS) {
      bgData = new Float32Array(totalCells * SC_BG_INSTANCE_FLOATS);
      this.terminalBgData.set(id, bgData);
    }
    let glyphData = this.terminalGlyphData.get(id);
    if (!glyphData || glyphData.length < totalCells * SC_GLYPH_INSTANCE_FLOATS) {
      glyphData = new Float32Array(totalCells * SC_GLYPH_INSTANCE_FLOATS);
      this.terminalGlyphData.set(id, glyphData);
    }

    // Initialize or retrieve per-row offset tracking
    let rowBgOffsets = this.terminalRowBgOffsets.get(id);
    let rowGlyphOffsets = this.terminalRowGlyphOffsets.get(id);
    let rowBgCounts = this.terminalRowBgCounts.get(id);
    let rowGlyphCounts = this.terminalRowGlyphCounts.get(id);

    if (!rowBgOffsets || rowBgOffsets.length !== rows) {
      rowBgOffsets = new Array(rows).fill(0);
      this.terminalRowBgOffsets.set(id, rowBgOffsets);
    }
    if (!rowGlyphOffsets || rowGlyphOffsets.length !== rows) {
      rowGlyphOffsets = new Array(rows).fill(0);
      this.terminalRowGlyphOffsets.set(id, rowGlyphOffsets);
    }
    if (!rowBgCounts || rowBgCounts.length !== rows) {
      rowBgCounts = new Array(rows).fill(cols);
      this.terminalRowBgCounts.set(id, rowBgCounts);
    }
    if (!rowGlyphCounts || rowGlyphCounts.length !== rows) {
      rowGlyphCounts = new Array(rows).fill(cols);
      this.terminalRowGlyphCounts.set(id, rowGlyphCounts);
    }

    let bgCount = 0;
    let glyphCount = 0;

    for (let row = 0; row < rows; row++) {
      const rowDirty = isFirstRender || grid.isDirty(row);

      if (!rowDirty) {
        // Row is clean — copy previous data to new offsets if they shifted
        const prevBgOffset = rowBgOffsets[row];
        const prevBgCount = rowBgCounts[row];
        const prevGlyphOffset = rowGlyphOffsets[row];
        const prevGlyphCount = rowGlyphCounts[row];

        if (bgCount !== prevBgOffset && prevBgCount > 0) {
          bgData.copyWithin(
            bgCount * SC_BG_INSTANCE_FLOATS,
            prevBgOffset * SC_BG_INSTANCE_FLOATS,
            (prevBgOffset + prevBgCount) * SC_BG_INSTANCE_FLOATS,
          );
        }
        if (glyphCount !== prevGlyphOffset && prevGlyphCount > 0) {
          glyphData.copyWithin(
            glyphCount * SC_GLYPH_INSTANCE_FLOATS,
            prevGlyphOffset * SC_GLYPH_INSTANCE_FLOATS,
            (prevGlyphOffset + prevGlyphCount) * SC_GLYPH_INSTANCE_FLOATS,
          );
        }

        rowBgOffsets[row] = bgCount;
        rowGlyphOffsets[row] = glyphCount;
        bgCount += prevBgCount;
        glyphCount += prevGlyphCount;
      } else {
        // Row is dirty — re-pack cell data with viewport offsets
        rowBgOffsets[row] = bgCount;
        rowGlyphOffsets[row] = glyphCount;
        let rowBg = 0;
        let rowGlyph = 0;

        for (let col = 0; col < cols; col++) {
          const codepoint = grid.getCodepoint(row, col);
          const fgIdx = grid.getFgIndex(row, col);
          const bgIdx = grid.getBgIndex(row, col);
          const attrs = grid.getAttrs(row, col);
          const fgIsRGB = grid.isFgRGB(row, col);
          const bgIsRGB = grid.isBgRGB(row, col);

          // Skip spacer cells (right half of wide character)
          if (grid.isSpacerCell(row, col)) {
            // Emit transparent bg to fill the slot
            const bOff = bgCount * SC_BG_INSTANCE_FLOATS;
            bgData[bOff] = col;
            bgData[bOff + 1] = row;
            bgData[bOff + 2] = 0;
            bgData[bOff + 3] = 0;
            bgData[bOff + 4] = 0;
            bgData[bOff + 5] = 0;
            bgData[bOff + 6] = vpX;
            bgData[bOff + 7] = vpY;
            bgCount++;
            rowBg++;
            continue;
          }

          const wide = grid.isWide(row, col);

          let fg = resolveColorFloat(
            fgIdx,
            fgIsRGB,
            grid,
            col,
            true,
            this.paletteFloat,
            this.themeFgFloat,
            this.themeBgFloat,
          );
          let bg = resolveColorFloat(
            bgIdx,
            bgIsRGB,
            grid,
            col,
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

          // Pack bg instance with viewport offset
          const bOff = bgCount * SC_BG_INSTANCE_FLOATS;
          bgData[bOff] = col;
          bgData[bOff + 1] = row;
          bgData[bOff + 2] = bg[0];
          bgData[bOff + 3] = bg[1];
          bgData[bOff + 4] = bg[2];
          bgData[bOff + 5] = bg[3];
          bgData[bOff + 6] = vpX;
          bgData[bOff + 7] = vpY;
          bgCount++;
          rowBg++;

          // Wide char: paint bg for right-half too
          if (wide && col + 1 < cols) {
            const bOff2 = bgCount * SC_BG_INSTANCE_FLOATS;
            bgData[bOff2] = col + 1;
            bgData[bOff2 + 1] = row;
            bgData[bOff2 + 2] = bg[0];
            bgData[bOff2 + 3] = bg[1];
            bgData[bOff2 + 4] = bg[2];
            bgData[bOff2 + 5] = bg[3];
            bgData[bOff2 + 6] = vpX;
            bgData[bOff2 + 7] = vpY;
            bgCount++;
            rowBg++;
          }

          if (codepoint > 0x20) {
            const bold = !!(attrs & ATTR_BOLD);
            const italic = !!(attrs & ATTR_ITALIC);
            const glyph = this.atlas.getGlyph(codepoint, bold, italic);

            if (glyph) {
              // Pack glyph instance with viewport offset
              const gOff = glyphCount * SC_GLYPH_INSTANCE_FLOATS;
              glyphData[gOff] = col;
              glyphData[gOff + 1] = row;
              glyphData[gOff + 2] = fg[0];
              glyphData[gOff + 3] = fg[1];
              glyphData[gOff + 4] = fg[2];
              glyphData[gOff + 5] = fg[3];
              glyphData[gOff + 6] = glyph.u;
              glyphData[gOff + 7] = glyph.v;
              glyphData[gOff + 8] = glyph.w;
              glyphData[gOff + 9] = glyph.h;
              glyphData[gOff + 10] = glyph.pw;
              glyphData[gOff + 11] = glyph.ph;
              glyphData[gOff + 12] = vpX;
              glyphData[gOff + 13] = vpY;
              glyphCount++;
              rowGlyph++;
            }
          }
        }

        rowBgCounts[row] = rowBg;
        rowGlyphCounts[row] = rowGlyph;
        grid.clearDirty(row);
      }
    }

    // Clear dirty flags for overflow rows that were skipped by the
    // clamped loop — otherwise they stay dirty and force a full rebuild
    // every frame during the resize debounce window.
    for (let row = rows; row < grid.rows; row++) {
      grid.clearDirty(row);
    }

    this.terminalBgCounts.set(id, bgCount);
    this.terminalGlyphCounts.set(id, glyphCount);
    this.terminalFullyRendered.add(id);

    return { bgCount, glyphCount };
  }

  // -----------------------------------------------------------------------
  // GL resource initialization
  // -----------------------------------------------------------------------

  private initGLResources(): void {
    const gl = this.gl;
    if (!gl) return;

    this.bgProgram = createProgram(gl, BG_VERTEX_SHADER, BG_FRAGMENT_SHADER);
    this.glyphProgram = createProgram(gl, GLYPH_VERTEX_SHADER, GLYPH_FRAGMENT_SHADER);

    // Cache all uniform locations after program creation
    this.bgUniforms.u_resolution = gl.getUniformLocation(this.bgProgram, "u_resolution");
    this.bgUniforms.u_cellSize = gl.getUniformLocation(this.bgProgram, "u_cellSize");
    this.glyphUniforms.u_resolution = gl.getUniformLocation(this.glyphProgram, "u_resolution");
    this.glyphUniforms.u_cellSize = gl.getUniformLocation(this.glyphProgram, "u_cellSize");
    this.glyphUniforms.u_atlas = gl.getUniformLocation(this.glyphProgram, "u_atlas");

    // Cache all attribute locations after program creation
    this.bgAttribLocs = {
      a_position: gl.getAttribLocation(this.bgProgram, "a_position"),
      a_cellPos: gl.getAttribLocation(this.bgProgram, "a_cellPos"),
      a_color: gl.getAttribLocation(this.bgProgram, "a_color"),
      a_offset: gl.getAttribLocation(this.bgProgram, "a_offset"),
    };
    this.glyphAttribLocs = {
      a_position: gl.getAttribLocation(this.glyphProgram, "a_position"),
      a_cellPos: gl.getAttribLocation(this.glyphProgram, "a_cellPos"),
      a_color: gl.getAttribLocation(this.glyphProgram, "a_color"),
      a_texCoord: gl.getAttribLocation(this.glyphProgram, "a_texCoord"),
      a_glyphSize: gl.getAttribLocation(this.glyphProgram, "a_glyphSize"),
      a_offset: gl.getAttribLocation(this.glyphProgram, "a_offset"),
    };

    const quadVerts = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);

    this.quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    this.quadEBO = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    // Create double-buffered VBOs and VAOs
    for (let i = 0; i < 2; i++) {
      this.bgInstanceVBOs[i] = gl.createBuffer();
      this.glyphInstanceVBOs[i] = gl.createBuffer();

      this.bgVAOs[i] = gl.createVertexArray();
      gl.bindVertexArray(this.bgVAOs[i]);
      const bgVBO = this.bgInstanceVBOs[i];
      if (bgVBO) this.setupBgVAO(gl, bgVBO);
      gl.bindVertexArray(null);

      this.glyphVAOs[i] = gl.createVertexArray();
      gl.bindVertexArray(this.glyphVAOs[i]);
      const glyphVBO = this.glyphInstanceVBOs[i];
      if (glyphVBO) this.setupGlyphVAO(gl, glyphVBO);
      gl.bindVertexArray(null);
    }
  }

  private setupBgVAO(gl: WebGL2RenderingContext, instanceVBO: WebGLBuffer): void {
    const FLOAT = 4;
    const locs = this.bgAttribLocs;

    // Quad position (per-vertex, from quadVBO)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(locs.a_position);
    gl.vertexAttribPointer(locs.a_position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    // Instance attributes (from instanceVBO)
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceVBO);
    const stride = SC_BG_INSTANCE_FLOATS * FLOAT;

    gl.enableVertexAttribArray(locs.a_cellPos);
    gl.vertexAttribPointer(locs.a_cellPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(locs.a_cellPos, 1);

    gl.enableVertexAttribArray(locs.a_color);
    gl.vertexAttribPointer(locs.a_color, 4, gl.FLOAT, false, stride, 2 * FLOAT);
    gl.vertexAttribDivisor(locs.a_color, 1);

    gl.enableVertexAttribArray(locs.a_offset);
    gl.vertexAttribPointer(locs.a_offset, 2, gl.FLOAT, false, stride, 6 * FLOAT);
    gl.vertexAttribDivisor(locs.a_offset, 1);
  }

  private setupGlyphVAO(gl: WebGL2RenderingContext, instanceVBO: WebGLBuffer): void {
    const FLOAT = 4;
    const locs = this.glyphAttribLocs;

    // Quad position (per-vertex, from quadVBO)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(locs.a_position);
    gl.vertexAttribPointer(locs.a_position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    // Instance attributes (from instanceVBO)
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceVBO);
    const stride = SC_GLYPH_INSTANCE_FLOATS * FLOAT;

    gl.enableVertexAttribArray(locs.a_cellPos);
    gl.vertexAttribPointer(locs.a_cellPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(locs.a_cellPos, 1);

    gl.enableVertexAttribArray(locs.a_color);
    gl.vertexAttribPointer(locs.a_color, 4, gl.FLOAT, false, stride, 2 * FLOAT);
    gl.vertexAttribDivisor(locs.a_color, 1);

    gl.enableVertexAttribArray(locs.a_texCoord);
    gl.vertexAttribPointer(locs.a_texCoord, 4, gl.FLOAT, false, stride, 6 * FLOAT);
    gl.vertexAttribDivisor(locs.a_texCoord, 1);

    gl.enableVertexAttribArray(locs.a_glyphSize);
    gl.vertexAttribPointer(locs.a_glyphSize, 2, gl.FLOAT, false, stride, 10 * FLOAT);
    gl.vertexAttribDivisor(locs.a_glyphSize, 1);

    gl.enableVertexAttribArray(locs.a_offset);
    gl.vertexAttribPointer(locs.a_offset, 2, gl.FLOAT, false, stride, 12 * FLOAT);
    gl.vertexAttribDivisor(locs.a_offset, 1);
  }

  // -----------------------------------------------------------------------
  // Color resolution
  // -----------------------------------------------------------------------

  setTheme(theme: Partial<Theme>): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.palette = build256Palette(this.theme);
    this.buildPaletteFloat();
    // Mark all terminals for full re-render with new colors
    this.terminalFullyRendered.clear();
    this.terminalBgData.clear();
    this.terminalGlyphData.clear();
  }

  private buildPaletteFloat(): void {
    this.paletteFloat = this.palette.map((c) => hexToFloat4(c));
    this.themeFgFloat = hexToFloat4(this.theme.foreground);
    this.themeBgFloat = hexToFloat4(this.theme.background);
    this.themeCursorFloat = hexToFloat4(this.theme.cursor);
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

    const font = `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
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
