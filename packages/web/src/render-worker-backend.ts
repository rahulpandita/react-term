/**
 * Render-worker backend interface.
 *
 * The render worker owns a single backend that turns the SAB-backed CellGrid
 * into pixels on an OffscreenCanvas. Two implementations exist:
 *   - WebGL2Backend  — GPU instanced rendering via a glyph atlas
 *   - Canvas2DBackend — CPU text drawing via the 2D context
 *
 * The worker entry coordinates the render loop, SAB reads, cursor/selection
 * messaging, and dirty tracking; the backend handles only pixel output.
 */

import type { CellGrid, Theme } from "@next_term/core";

export type RendererKind = "webgl2" | "canvas2d";

export interface BackendInitOptions {
  canvas: OffscreenCanvas;
  theme: Theme;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  fontWeightBold: number;
  dpr: number;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  /** Baseline offset for text placement (Canvas2D); ignored by WebGL. */
  baselineOffset: number;
}

export interface SelectionRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface RenderFrame {
  grid: CellGrid;
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  cursorVisible: boolean;
  cursorStyle: string;
  selection: SelectionRect | null;
}

export interface RenderBackend {
  /**
   * Acquire the rendering context and upload any one-time resources.
   * Throws on unrecoverable failure (e.g. WebGL2 unavailable).
   */
  init(opts: BackendInitOptions): void;
  /** Resize the canvas backing store. */
  syncCanvasSize(
    cols: number,
    rows: number,
    cellWidth: number,
    cellHeight: number,
    dpr: number,
  ): void;
  /** Paint one frame. The backend iterates dirty rows and clears them itself. */
  render(frame: RenderFrame): void;
  /** Apply a new theme. */
  setTheme(theme: Theme): void;
  /**
   * Apply new font settings. `cellWidth`/`cellHeight` already reflect the new
   * font metrics measured by the worker.
   */
  setFont(
    fontSize: number,
    fontFamily: string,
    fontWeight: number,
    fontWeightBold: number,
    dpr: number,
    cellWidth: number,
    cellHeight: number,
    baselineOffset: number,
  ): void;
  /** Release any GPU/canvas resources. */
  dispose(): void;
}
