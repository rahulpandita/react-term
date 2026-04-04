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

import type { CellGrid, CursorState, SelectionRange, Theme } from "@next_term/core";
import { DEFAULT_THEME } from "@next_term/core";
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
  // Bug 3: Double-buffered VBOs — two each for bg and glyph instance data
  private bgInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
  private glyphInstanceVBOs: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
  private bufferIndex = 0; // toggles 0/1 each frame
  private bgVAOs: [WebGLVertexArrayObject | null, WebGLVertexArrayObject | null] = [null, null];
  private glyphVAOs: [WebGLVertexArrayObject | null, WebGLVertexArrayObject | null] = [null, null];

  // Bug 1: Cached uniform locations
  private bgUniforms: {
    u_resolution: WebGLUniformLocation | null;
    u_cellSize: WebGLUniformLocation | null;
  } = { u_resolution: null, u_cellSize: null };
  private glyphUniforms: {
    u_resolution: WebGLUniformLocation | null;
    u_cellSize: WebGLUniformLocation | null;
    u_atlas: WebGLUniformLocation | null;
  } = { u_resolution: null, u_cellSize: null, u_atlas: null };

  // Instance data (CPU side) — persistent across frames for dirty-row optimization
  private bgInstances: Float32Array;
  private glyphInstances: Float32Array;

  // Bug 2: Per-terminal dirty tracking state
  private terminalBgCounts = new Map<string, number>();
  private terminalGlyphCounts = new Map<string, number>();
  private terminalRowBgOffsets = new Map<string, number[]>(); // bgCount at start of each row
  private terminalRowGlyphOffsets = new Map<string, number[]>(); // glyphCount at start of each row
  private terminalRowBgCounts = new Map<string, number[]>(); // bg instances per row
  private terminalRowGlyphCounts = new Map<string, number[]>(); // glyph instances per row
  private terminalFullyRendered = new Set<string>(); // tracks if terminal has had initial full render

  // Bug 5: Reusable cursor data buffer
  private cursorData = new Float32Array(6);

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
    // Clean up per-terminal dirty tracking state
    this.terminalBgCounts.delete(id);
    this.terminalGlyphCounts.delete(id);
    this.terminalRowBgOffsets.delete(id);
    this.terminalRowGlyphOffsets.delete(id);
    this.terminalRowBgCounts.delete(id);
    this.terminalRowGlyphCounts.delete(id);
    this.terminalFullyRendered.delete(id);
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

    // Bug 3: Toggle double-buffer index
    this.bufferIndex ^= 1;

    // Full-canvas clear
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Render backgrounds and glyphs for each terminal
    for (const [id, entry] of this.terminals) {
      this.renderTerminal(id, entry);
    }

    // Bug 6: Enable BLEND once for all cursor passes
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (const [_id, entry] of this.terminals) {
      this.drawCursor(entry);
    }
    gl.disable(gl.BLEND);

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
      // Bug 3: Clean up double-buffered resources
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
  // Per-terminal rendering
  // -----------------------------------------------------------------------

  private renderTerminal(id: string, entry: TerminalEntry): void {
    if (!this.gl) return;
    const gl = this.gl;
    const { grid, viewport } = entry;
    const cols = grid.cols;
    const rows = grid.rows;
    const bi = this.bufferIndex;
    const activeBgVBO = this.bgInstanceVBOs[bi];
    const activeGlyphVBO = this.glyphInstanceVBOs[bi];
    const activeBgVAO = this.bgVAOs[bi];
    const activeGlyphVAO = this.glyphVAOs[bi];

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
      // Force full re-render when buffers reallocated
      this.terminalFullyRendered.delete(id);
    }
    if (this.glyphInstances.length < totalCells * GLYPH_INSTANCE_FLOATS) {
      this.glyphInstances = new Float32Array(totalCells * GLYPH_INSTANCE_FLOATS);
      this.terminalFullyRendered.delete(id);
    }

    // Bug 2: Check if any rows are dirty; if not, use cached counts and skip cell iteration
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

    let bgCount: number;
    let glyphCount: number;

    if (!anyDirty) {
      // No dirty rows — reuse cached instance data and counts
      bgCount = this.terminalBgCounts.get(id) ?? 0;
      glyphCount = this.terminalGlyphCounts.get(id) ?? 0;
    } else {
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
        rowBgCounts = new Array(rows).fill(0);
        this.terminalRowBgCounts.set(id, rowBgCounts);
      }
      if (!rowGlyphCounts || rowGlyphCounts.length !== rows) {
        rowGlyphCounts = new Array(rows).fill(0);
        this.terminalRowGlyphCounts.set(id, rowGlyphCounts);
      }

      // On first render or if row counts changed, we must do a full rebuild
      // because row offsets in the flat array depend on previous rows' glyph counts.
      // For simplicity and correctness with the flat instance arrays, rebuild all rows
      // but skip cell-level work for clean rows by copying from the same offsets.
      bgCount = 0;
      glyphCount = 0;

      for (let row = 0; row < rows; row++) {
        const rowDirty = isFirstRender || grid.isDirty(row);

        if (!rowDirty) {
          // Row is clean — copy previous data to new offsets if they shifted
          const prevBgOffset = rowBgOffsets[row];
          const prevBgCount = rowBgCounts[row];
          const prevGlyphOffset = rowGlyphOffsets[row];
          const prevGlyphCount = rowGlyphCounts[row];

          if (bgCount !== prevBgOffset && prevBgCount > 0) {
            // Data shifted — copy from old position to new
            this.bgInstances.copyWithin(
              bgCount * BG_INSTANCE_FLOATS,
              prevBgOffset * BG_INSTANCE_FLOATS,
              (prevBgOffset + prevBgCount) * BG_INSTANCE_FLOATS,
            );
          }
          if (glyphCount !== prevGlyphOffset && prevGlyphCount > 0) {
            this.glyphInstances.copyWithin(
              glyphCount * GLYPH_INSTANCE_FLOATS,
              prevGlyphOffset * GLYPH_INSTANCE_FLOATS,
              (prevGlyphOffset + prevGlyphCount) * GLYPH_INSTANCE_FLOATS,
            );
          }

          rowBgOffsets[row] = bgCount;
          rowGlyphOffsets[row] = glyphCount;
          bgCount += prevBgCount;
          glyphCount += prevGlyphCount;
        } else {
          // Row is dirty — re-pack cell data
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
            rowBg++;

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
                rowGlyph++;
              }
            }
          }

          rowBgCounts[row] = rowBg;
          rowGlyphCounts[row] = rowGlyph;
          grid.clearDirty(row);
        }
      }

      this.terminalBgCounts.set(id, bgCount);
      this.terminalGlyphCounts.set(id, glyphCount);
      this.terminalFullyRendered.add(id);
    }

    // Upload atlas if dirty
    this.atlas.upload(gl);

    const cellW = this.cellWidth * this.dpr;
    const cellH = this.cellHeight * this.dpr;

    // --- Background pass --- (Bug 1: cached uniforms, Bug 3: double-buffered VBO, Bug 4: STREAM_DRAW)
    if (bgCount > 0 && this.bgProgram && activeBgVAO && activeBgVBO) {
      gl.useProgram(this.bgProgram);
      gl.uniform2f(this.bgUniforms.u_resolution, vpW, vpH);
      gl.uniform2f(this.bgUniforms.u_cellSize, cellW, cellH);

      gl.bindBuffer(gl.ARRAY_BUFFER, activeBgVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.bgInstances.subarray(0, bgCount * BG_INSTANCE_FLOATS),
        gl.STREAM_DRAW,
      );

      gl.bindVertexArray(activeBgVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, bgCount);
    }

    // --- Glyph pass ---
    if (glyphCount > 0 && this.glyphProgram && activeGlyphVAO && activeGlyphVBO) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.glyphProgram);
      gl.uniform2f(this.glyphUniforms.u_resolution, vpW, vpH);
      gl.uniform2f(this.glyphUniforms.u_cellSize, cellW, cellH);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.getTexture());
      gl.uniform1i(this.glyphUniforms.u_atlas, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, activeGlyphVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.glyphInstances.subarray(0, glyphCount * GLYPH_INSTANCE_FLOATS),
        gl.STREAM_DRAW,
      );

      gl.bindVertexArray(activeGlyphVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, glyphCount);

      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);
  }

  // Bug 6: Cursor drawing extracted to separate method for batched BLEND state
  private drawCursor(entry: TerminalEntry): void {
    if (!this.gl) return;
    const gl = this.gl;
    const { cursor, viewport } = entry;
    const bi = this.bufferIndex;
    const activeBgVBO = this.bgInstanceVBOs[bi];
    const activeBgVAO = this.bgVAOs[bi];

    if (!cursor.visible || !this.bgProgram || !activeBgVAO || !activeBgVBO) return;

    // Convert CSS viewport to device pixels
    const vpX = Math.round(viewport.x * this.dpr);
    const vpY = Math.round(viewport.y * this.dpr);
    const vpW = Math.round(viewport.width * this.dpr);
    const vpH = Math.round(viewport.height * this.dpr);
    const canvasHeight = this.canvas.height;
    const glY = canvasHeight - vpY - vpH;

    gl.viewport(vpX, glY, vpW, vpH);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vpX, glY, vpW, vpH);

    const cellW = this.cellWidth * this.dpr;
    const cellH = this.cellHeight * this.dpr;
    const cc = this.themeCursorFloat;

    gl.useProgram(this.bgProgram);
    gl.uniform2f(this.bgUniforms.u_resolution, vpW, vpH);
    gl.uniform2f(this.bgUniforms.u_cellSize, cellW, cellH);

    // Bug 5: Reuse pre-allocated cursorData buffer instead of allocating per frame
    this.cursorData[0] = cursor.col;
    this.cursorData[1] = cursor.row;
    this.cursorData[2] = cc[0];
    this.cursorData[3] = cc[1];
    this.cursorData[4] = cc[2];
    this.cursorData[5] = 0.5;

    gl.bindBuffer(gl.ARRAY_BUFFER, activeBgVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.cursorData, gl.STREAM_DRAW);

    gl.bindVertexArray(activeBgVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, 1);

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

    // Bug 1: Cache all uniform locations after program creation
    this.bgUniforms.u_resolution = gl.getUniformLocation(this.bgProgram, "u_resolution");
    this.bgUniforms.u_cellSize = gl.getUniformLocation(this.bgProgram, "u_cellSize");
    this.glyphUniforms.u_resolution = gl.getUniformLocation(this.glyphProgram, "u_resolution");
    this.glyphUniforms.u_cellSize = gl.getUniformLocation(this.glyphProgram, "u_cellSize");
    this.glyphUniforms.u_atlas = gl.getUniformLocation(this.glyphProgram, "u_atlas");

    const quadVerts = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);

    this.quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    this.quadEBO = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    // Bug 3: Create double-buffered VBOs and VAOs
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
    if (!this.bgProgram) return;
    const program = this.bgProgram;

    const aPos = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceVBO);
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

  private setupGlyphVAO(gl: WebGL2RenderingContext, instanceVBO: WebGLBuffer): void {
    const FLOAT = 4;
    if (!this.glyphProgram) return;
    const program = this.glyphProgram;

    const aPos = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadEBO);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceVBO);
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

  setTheme(theme: Partial<Theme>): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.palette = build256Palette(this.theme);
    this.buildPaletteFloat();
    // Mark all terminals fully dirty so they re-render with new colors
    for (const id of this.terminalFullyRendered.keys()) {
      this.terminalFullyRendered.set(id, false);
    }
  }

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
