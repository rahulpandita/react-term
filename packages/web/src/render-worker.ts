/**
 * Render Worker entry point.
 *
 * Receives an OffscreenCanvas (transferred from the main thread) and a
 * SharedArrayBuffer reference for the CellGrid. Runs its own render loop
 * at display refresh rate via requestAnimationFrame.
 *
 * The actual pixel output is delegated to a RenderBackend (WebGL2 or
 * Canvas2D). This file owns the loop, SAB setup, cursor/selection state,
 * FPS tracking, and message dispatch.
 */

import type { Theme } from "@next_term/core";
import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import type {
  HighlightRect,
  RenderBackend,
  RendererKind,
  SelectionRect,
} from "./render-worker-backend.js";
import { Canvas2DBackend } from "./render-worker-canvas2d.js";
import { WebGL2Backend } from "./render-worker-webgl2.js";

declare type DedicatedWorkerGlobalScope = typeof globalThis & {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
};

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
  /** Which backend to use. Defaults to `webgl2` for backwards compatibility. */
  renderer?: RendererKind;
}

/**
 * Cursor-only update. Selection is NOT touched — earlier revisions combined
 * both into a single "update" message, which meant updateCursor() would
 * silently clear any active selection and vice versa. See n7 in PR #181.
 */
export interface RenderWorkerCursorMessage {
  type: "cursor";
  cursor: { row: number; col: number; visible: boolean; style: string };
}

export interface RenderWorkerSelectionMessage {
  type: "selection";
  selection: SelectionRect | null;
}

export interface RenderWorkerHighlightsMessage {
  type: "highlights";
  highlights: HighlightRect[];
}

/**
 * @deprecated Kept so older code (including tests that predate the split) can
 * still read the type name. New code should send `cursor`/`selection` messages
 * separately. The worker still handles this for one release cycle.
 */
export interface RenderWorkerUpdateMessage {
  type: "update";
  cursor: { row: number; col: number; visible: boolean; style: string };
  selection: SelectionRect | null;
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
  | RenderWorkerCursorMessage
  | RenderWorkerSelectionMessage
  | RenderWorkerHighlightsMessage
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
// Worker state
// ---------------------------------------------------------------------------

let backend: RenderBackend | null = null;
let grid: CellGrid | null = null;

let cols = 0;
let rows = 0;
let dpr = 1;
let fontSize = 14;
let fontFamily = "monospace";
let fontWeight = 400;
let fontWeightBold = 700;
let theme: Theme = DEFAULT_THEME;

let cellWidth = 0;
let cellHeight = 0;
let baselineOffset = 0;

let cursorRow = 0;
let cursorCol = 0;
let cursorVisible = true;
let cursorStyle = "block";
let prevCursorRow = -1;
let prevCursorCol = -1;
let selection: SelectionRect | null = null;
let highlights: HighlightRect[] = [];

let rafId: number | null = null;
let disposed = false;

// FPS tracking
let frameCount = 0;
let lastFpsTime = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function measureCellSize(): void {
  const measureCanvas = new OffscreenCanvas(100, 100);
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) {
    cellWidth = Math.ceil(fontSize * 0.6);
    cellHeight = Math.ceil(fontSize * 1.2);
    baselineOffset = Math.ceil(fontSize);
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
    baselineOffset = Math.ceil(metrics.fontBoundingBoxAscent);
  } else {
    cellHeight = Math.ceil(fontSize * 1.2);
    baselineOffset = Math.ceil(fontSize);
  }

  if (cellWidth <= 0) cellWidth = Math.ceil(fontSize * 0.6);
  if (cellHeight <= 0) cellHeight = Math.ceil(fontSize * 1.2);
}

function postError(message: string): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "error", message });
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function render(): void {
  if (disposed || !backend || !grid) return;

  // Poll cursor from SAB — the main thread writes via Atomics.
  const cursor = grid.getCursor();
  cursorRow = cursor.row;
  cursorCol = cursor.col;
  cursorVisible = cursor.visible;
  cursorStyle = cursor.style;

  // Mark the old + new cursor rows dirty only when the cursor actually moved.
  // Unconditionally marking the current row every frame would defeat the
  // "skip idle frame" early-out below — the cursor row would always look
  // dirty and the worker would spin full render passes even with no input.
  // Matches the same optimization applied to SharedCanvas2DContext (n8).
  const cursorMoved = prevCursorRow !== cursorRow || prevCursorCol !== cursorCol;
  if (cursorMoved) {
    if (prevCursorRow >= 0 && prevCursorRow < rows) {
      grid.markDirty(prevCursorRow);
    }
    if (cursorRow >= 0 && cursorRow < rows) {
      grid.markDirty(cursorRow);
    }
    prevCursorRow = cursorRow;
    prevCursorCol = cursorCol;
  }

  // Skip the frame entirely if nothing is dirty — both backends rely on
  // this to keep selection/cursor overlays stable across idle frames.
  let anyDirty = false;
  for (let r = 0; r < rows; r++) {
    if (grid.isDirty(r)) {
      anyDirty = true;
      break;
    }
  }
  if (!anyDirty) return;

  backend.render({
    grid,
    cols,
    rows,
    cursorRow,
    cursorCol,
    cursorVisible,
    cursorStyle,
    selection,
    highlights,
  });
}

function startRenderLoop(): void {
  if (disposed) return;
  if (rafId !== null) return;
  lastFpsTime = performance.now();
  frameCount = 0;

  const loop = () => {
    if (disposed) return;
    render();

    frameCount++;
    const now = performance.now();
    const elapsed = now - lastFpsTime;
    if (elapsed >= 1000) {
      const fps = Math.round((frameCount * 1000) / elapsed);
      frameCount = 0;
      lastFpsTime = now;
      const msg: RenderWorkerFrameMessage = { type: "frame", fps };
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
  if (backend) backend.dispose();
  backend = null;
  grid = null;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

function handleMessage(msg: RenderWorkerInboundMessage): void {
  switch (msg.type) {
    case "init": {
      cols = msg.cols;
      rows = msg.rows;
      theme = msg.theme;
      fontSize = msg.fontSize;
      fontFamily = msg.fontFamily;
      fontWeight = msg.fontWeight;
      fontWeightBold = msg.fontWeightBold;
      dpr = msg.devicePixelRatio;

      measureCellSize();

      grid = new CellGrid(cols, rows, msg.sharedBuffer);

      const kind: RendererKind = msg.renderer ?? "webgl2";
      try {
        if (kind === "canvas2d") {
          backend = new Canvas2DBackend();
        } else {
          const webgl = new WebGL2Backend();
          webgl.setContextHandlers(
            () => stopRenderLoop(),
            () => {
              if (grid) grid.markAllDirty();
              startRenderLoop();
            },
          );
          backend = webgl;
        }
        backend.init({
          canvas: msg.canvas,
          theme,
          fontSize,
          fontFamily,
          fontWeight,
          fontWeightBold,
          dpr,
          cols,
          rows,
          cellWidth,
          cellHeight,
          baselineOffset,
        });
      } catch (e) {
        backend = null;
        postError(e instanceof Error ? e.message : "Backend init failed");
        return;
      }

      grid.markAllDirty();
      startRenderLoop();
      break;
    }

    case "cursor": {
      cursorRow = msg.cursor.row;
      cursorCol = msg.cursor.col;
      cursorVisible = msg.cursor.visible;
      cursorStyle = msg.cursor.style;
      if (grid) {
        grid.setCursor(cursorRow, cursorCol, cursorVisible, cursorStyle);
        grid.markAllDirty();
      }
      break;
    }

    case "selection": {
      selection = msg.selection;
      if (grid) grid.markAllDirty();
      break;
    }

    // Back-compat: the old combined update message is still accepted so any
    // out-of-tree caller building against the previous shape keeps working.
    // Prefer the split messages for new code — they let you change cursor
    // without clearing selection (and vice versa).
    case "update": {
      cursorRow = msg.cursor.row;
      cursorCol = msg.cursor.col;
      cursorVisible = msg.cursor.visible;
      cursorStyle = msg.cursor.style;
      selection = msg.selection;
      if (grid) {
        grid.setCursor(cursorRow, cursorCol, cursorVisible, cursorStyle);
        grid.markAllDirty();
      }
      break;
    }

    case "highlights": {
      highlights = msg.highlights;
      // Repaint everything once so old highlights get cleared and new ones
      // show up on their rows.
      if (grid) grid.markAllDirty();
      break;
    }

    case "resize": {
      cols = msg.cols;
      rows = msg.rows;
      grid = new CellGrid(cols, rows, msg.sharedBuffer);
      if (backend) {
        backend.syncCanvasSize(cols, rows, cellWidth, cellHeight, dpr);
      }
      grid.markAllDirty();
      break;
    }

    case "theme": {
      theme = msg.theme;
      if (backend) backend.setTheme(theme);
      if (grid) grid.markAllDirty();
      break;
    }

    case "font": {
      fontSize = msg.fontSize;
      fontFamily = msg.fontFamily;
      fontWeight = msg.fontWeight;
      fontWeightBold = msg.fontWeightBold;
      measureCellSize();
      if (backend) {
        backend.setFont(
          fontSize,
          fontFamily,
          fontWeight,
          fontWeightBold,
          dpr,
          cellWidth,
          cellHeight,
          baselineOffset,
        );
        backend.syncCanvasSize(cols, rows, cellWidth, cellHeight, dpr);
      }
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
      postError(e instanceof Error ? e.message : "Internal render error");
    }
  },
);
