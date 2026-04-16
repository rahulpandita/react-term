/**
 * WebTerminal — main entry point for the @next_term/web package.
 *
 * Orchestrates the core BufferSet/VTParser, Canvas2DRenderer, InputHandler,
 * and the requestAnimationFrame render loop.
 *
 * When `useWorker` is enabled (default: true when SAB is available) the VT
 * parser runs in a Web Worker via WorkerBridge; otherwise it runs on the main
 * thread as before.
 *
 * When `renderMode` is `'offscreen'` or `'auto'` (with SAB + OffscreenCanvas
 * available), the WebGL2 render loop runs in a separate Web Worker via
 * RenderBridge, leaving the main thread free for DOM event handling only.
 */

import type { CursorState, MouseEncoding, MouseProtocol, RowData, Theme } from "@next_term/core";
import {
  BufferSet,
  CELL_SIZE,
  CellGrid,
  DEFAULT_THEME,
  expandCompactRow,
  reflowRows,
  VTParser,
} from "@next_term/core";
import { AccessibilityManager } from "./accessibility.js";
import type { ITerminalAddon } from "./addon.js";
import { calculateFit } from "./fit.js";
import { InputHandler } from "./input-handler.js";
import type { ParserChannel, ParserPool } from "./parser-pool.js";
import type { FlushMessage } from "./parser-worker.js";
import { canUseOffscreenCanvas, RenderBridge } from "./render-bridge.js";
import type { HighlightRange, IRenderer, RendererOptions } from "./renderer.js";
import { Canvas2DRenderer } from "./renderer.js";
import type { SharedWebGLContext } from "./shared-context.js";
import { WebGLRenderer } from "./webgl-renderer.js";
import { WorkerBridge } from "./worker-bridge.js";

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

const SAB_AVAILABLE =
  typeof SharedArrayBuffer !== "undefined" &&
  (typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : true);

const OFFSCREEN_CANVAS_AVAILABLE = canUseOffscreenCanvas();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebTerminalOptions {
  cols?: number;
  rows?: number;
  fontSize?: number;
  fontFamily?: string;
  /** CSS font-weight for normal text (default: 400). */
  fontWeight?: number;
  /** CSS font-weight for bold text (default: 700). */
  fontWeightBold?: number;
  theme?: Partial<Theme>;
  scrollback?: number;
  devicePixelRatio?: number;
  /**
   * When true the VT parser runs in a Web Worker.
   * Defaults to `true` when SharedArrayBuffer is available.
   * Falls back to main-thread parsing when set to `false` or when the
   * Worker fails to start.
   */
  useWorker?: boolean;
  /**
   * Renderer backend selection.
   * - `'auto'` (default): try WebGL2 first, fall back to Canvas 2D.
   * - `'webgl'`: force WebGL2 (throws if unavailable).
   * - `'canvas2d'`: force Canvas 2D.
   */
  renderer?: "auto" | "webgl" | "canvas2d";
  /**
   * When provided, the terminal registers with a SharedWebGLContext instead
   * of creating its own renderer. Must be used together with `paneId`.
   */
  sharedContext?: SharedWebGLContext;
  /**
   * Unique identifier for this pane within a SharedWebGLContext.
   * Required when `sharedContext` is provided.
   */
  paneId?: string;
  /**
   * Render mode selection.
   * - `'auto'` (default): use OffscreenCanvas render worker when SAB +
   *   OffscreenCanvas are available; otherwise render on main thread.
   * - `'offscreen'`: force OffscreenCanvas render worker (throws if unavailable).
   * - `'main'`: always render on the main thread.
   */
  renderMode?: "auto" | "offscreen" | "main";
  /**
   * When provided, the terminal acquires a channel from this shared parser
   * worker pool instead of spawning its own Worker. Requires `paneId`.
   * Ignored when `useWorker` is `false`.
   */
  parserPool?: ParserPool;
  onData?: (data: Uint8Array) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  onTitleChange?: (title: string) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_FONT_FAMILY = "'Menlo', 'DejaVu Sans Mono', 'Consolas', monospace";
const DEFAULT_SCROLLBACK = 1000;

// ---------------------------------------------------------------------------
// WebTerminal
// ---------------------------------------------------------------------------

function mergeTheme(partial?: Partial<Theme>): Theme {
  if (!partial) return { ...DEFAULT_THEME };
  return { ...DEFAULT_THEME, ...partial };
}

export class WebTerminal {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private bufferSet: BufferSet;
  private parser: VTParser | null = null;
  private renderer: IRenderer & {
    startRenderLoop(): void;
    stopRenderLoop(): void;
    setFont?(
      fontSize: number,
      fontFamily: string,
      fontWeight?: number,
      fontWeightBold?: number,
    ): void;
  };
  private inputHandler: InputHandler;
  private disposed = false;
  private addons: ITerminalAddon[] = [];
  private accessibilityManager: AccessibilityManager | null = null;

  /** SharedWebGLContext when using shared multi-pane rendering, null otherwise. */
  private sharedContext: SharedWebGLContext | null = null;
  /** Pane ID within the SharedWebGLContext. */
  private paneId: string | null = null;
  /** WorkerBridge when using off-thread parsing (single-terminal mode), null otherwise. */
  private workerBridge: WorkerBridge | null = null;
  /** ParserChannel when using a shared parser pool, null otherwise. */
  private parserChannel: ParserChannel | null = null;
  /** Reference to the shared parser pool (so releaseChannel can be called on dispose). */
  private parserPool: ParserPool | null = null;
  /** RenderBridge when using off-thread rendering, null otherwise. */
  private renderBridge: RenderBridge | null = null;
  /** Whether the worker mode is active. */
  private readonly useWorkerMode: boolean;
  /** Whether the offscreen render mode is active. */
  private readonly useOffscreenRender: boolean;
  /** Track whether alternate buffer is active so we can detect switches. */
  private wasAlternate = false;
  /** Track sync output mode to detect transitions. */
  private _syncedOutput = false;

  /**
   * Cursor position to restore after the worker's resize flush.
   * The worker creates a fresh BufferSet on resize (cursor 0,0) and
   * sends it back, overwriting our adjusted cursor. We save it here
   * and re-apply in onFlush.
   */
  private pendingResizeCursor: { row: number; col: number } | null = null;
  private resizeCursorQueued = false;

  // Scrollback viewport: 0 = live (bottom), positive = lines scrolled back
  private viewportOffset = 0;
  /** Temporary display grid used when scrolled into scrollback. */
  private displayGrid: CellGrid | null = null;
  /** Scrollbar overlay element. */
  private scrollbarEl: HTMLElement | null = null;
  /** Scrollbar thumb element. */
  private scrollbarThumb: HTMLElement | null = null;
  /** Timer to auto-hide scrollbar. */
  private scrollbarHideTimer: ReturnType<typeof setTimeout> | null = null;

  // Text encoder for string -> Uint8Array
  private encoder = new TextEncoder();

  // Callbacks
  private onDataCallback: ((data: Uint8Array) => void) | null;
  private onResizeCallback: ((size: { cols: number; rows: number }) => void) | null;
  private onTitleChangeCallback: ((title: string) => void) | null;

  constructor(container: HTMLElement, options?: WebTerminalOptions) {
    this.container = container;

    const MAX_COLS = 500;
    const MAX_ROWS = 500;
    const cols = Math.min(options?.cols ?? DEFAULT_COLS, MAX_COLS);
    const rows = Math.min(options?.rows ?? DEFAULT_ROWS, MAX_ROWS);
    const fontSize = options?.fontSize ?? DEFAULT_FONT_SIZE;
    const fontFamily = options?.fontFamily ?? DEFAULT_FONT_FAMILY;
    const theme = mergeTheme(options?.theme);
    const scrollback = options?.scrollback ?? DEFAULT_SCROLLBACK;

    this.onDataCallback = options?.onData ?? null;
    this.onResizeCallback = options?.onResize ?? null;
    this.onTitleChangeCallback = options?.onTitleChange ?? null;

    // Determine whether to use the worker.
    this.useWorkerMode = options?.useWorker ?? SAB_AVAILABLE;

    // Store parser pool reference (used in startWorkerMode).
    this.parserPool = options?.parserPool ?? null;

    // Determine render mode.
    const renderMode = options?.renderMode ?? "auto";
    if (renderMode === "offscreen") {
      this.useOffscreenRender = true;
    } else if (renderMode === "main") {
      this.useOffscreenRender = false;
    } else {
      // 'auto': use offscreen if SAB + OffscreenCanvas both available
      this.useOffscreenRender = SAB_AVAILABLE && OFFSCREEN_CANVAS_AVAILABLE;
    }

    // Create core buffer set
    this.bufferSet = new BufferSet(cols, rows, scrollback);

    // Create canvas element
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    container.style.position = container.style.position || "relative";
    container.style.overflow = "hidden";

    // Create renderer based on selected backend
    const rendererType = options?.renderer ?? "auto";
    const fontWeight = options?.fontWeight;
    const fontWeightBold = options?.fontWeightBold;
    const rendererOpts: RendererOptions = {
      fontSize,
      fontFamily,
      theme,
      devicePixelRatio: options?.devicePixelRatio,
      fontWeight,
      fontWeightBold,
    };

    // paneId is used by both SharedWebGLContext AND ParserPool as the channel
    // identifier. Set it whenever it's provided, not just when shared rendering
    // is also in play — otherwise the parser pool is silently bypassed.
    if (options?.paneId) {
      this.paneId = options.paneId;
    }

    if (options?.sharedContext && options?.paneId) {
      // Shared WebGL context mode: register with the shared context
      // instead of creating our own renderer.
      this.sharedContext = options.sharedContext;

      const grid = this.bufferSet.active.grid;
      const cursor = this.bufferSet.active.cursor;
      this.sharedContext.addTerminal(options.paneId, grid, cursor);

      // The canvas is not appended to the DOM — shared context owns the canvas.
      // But we still need a container div for input handling.
      container.appendChild(this.canvas);
      // Hide the per-pane canvas since the shared context canvas is the overlay.
      this.canvas.style.display = "none";

      // Create a no-op renderer that delegates getCellSize() to the shared context.
      const sharedCtx = this.sharedContext;
      this.renderer = {
        getCellSize: () => sharedCtx.getCellSize(),
        attach: () => {},
        render: () => {},
        resize: () => {},
        startRenderLoop: () => {},
        stopRenderLoop: () => {},
        dispose: () => {},
        setTheme: () => {},
        setFont: () => {},
        setSelection: () => {},
        setHighlights: () => {},
      };
    } else if (this.useOffscreenRender && this.bufferSet.active.grid.isShared) {
      container.appendChild(this.canvas);

      // Full worker mode: rendering happens in a Web Worker via RenderBridge.
      // We still need a main-thread renderer for getCellSize() measurements.
      this.renderer = new Canvas2DRenderer(rendererOpts);

      this.renderBridge = new RenderBridge(this.canvas, {
        fontSize,
        fontFamily,
        theme,
        devicePixelRatio: options?.devicePixelRatio,
        onError: (message: string) => {
          console.warn("[WebTerminal] Render worker error, falling back:", message);
          this.fallbackToMainThreadRenderer(rendererOpts);
        },
      });
      this.renderBridge.start(
        this.bufferSet.active.grid.getBuffer() as SharedArrayBuffer,
        cols,
        rows,
      );

      // Sync cursor into SAB so the render worker can read it
      this.syncCursorToSAB();
    } else {
      container.appendChild(this.canvas);

      if (rendererType === "webgl") {
        this.renderer = new WebGLRenderer(rendererOpts);
      } else if (rendererType === "canvas2d") {
        this.renderer = new Canvas2DRenderer(rendererOpts);
      } else {
        // 'auto': try WebGL2 first, fall back to Canvas 2D.
        // Exclude software renderers (SwiftShader/llvmpipe) — Canvas2D
        // is significantly faster than WebGL2 on software rasterizers.
        let useWebGL = false;
        try {
          const testCanvas = document.createElement("canvas");
          const testGl = testCanvas.getContext("webgl2");
          if (testGl) {
            useWebGL = true;
            const debugInfo = testGl.getExtension("WEBGL_debug_renderer_info");
            if (debugInfo) {
              const renderer = testGl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string;
              if (/swiftshader|llvmpipe|software/i.test(renderer)) {
                useWebGL = false;
              }
            }
            // Lose the test context so it doesn't count against Chrome's limit
            testGl.getExtension("WEBGL_lose_context")?.loseContext();
          }
        } catch {
          // WebGL2 not available
        }
        this.renderer = useWebGL
          ? new WebGLRenderer(rendererOpts)
          : new Canvas2DRenderer(rendererOpts);
      }
      this.renderer.attach(this.canvas, this.bufferSet.active.grid, this.bufferSet.active.cursor);
    }

    // Ensure web fonts are available to the canvas/atlas before first render.
    // Fires asynchronously — if the font loads after first paint, the atlas
    // is cleared and glyphs are re-rasterized with the correct font (FOUT).
    this.ensureFont(fontFamily, fontSize, fontWeight, fontWeightBold);

    // Create scrollbar overlay
    this.createScrollbar(container);

    // Create input handler
    this.inputHandler = new InputHandler({
      onData: (data) => {
        // User typed something — snap back to live view
        this.snapToBottom();
        this.onDataCallback?.(data);
      },
      onSelectionChange: (sel) => {
        if (this.renderBridge) {
          this.renderBridge.updateSelection(sel);
        } else {
          this.renderer.setSelection(sel);
        }
      },
      onScroll: (deltaRows) => {
        // GestureHandler already negates: positive = scroll back (older content).
        this.scrollViewport(deltaRows);
      },
      onFontSizeChange: (newFontSize) => {
        this.setFont(newFontSize, fontFamily);
      },
    });
    this.inputHandler.setGrid(this.bufferSet.active.grid);
    this.inputHandler.setFontSize(fontSize);

    const { width, height } = this.renderer.getCellSize();
    this.inputHandler.attach(container, width, height);

    // Set up parsing: worker mode or direct mode.
    if (this.useWorkerMode) {
      this.startWorkerMode(cols, rows, scrollback);
    } else {
      this.parser = new VTParser(this.bufferSet);
      // Wire up title change callback
      this.parser.setTitleChangeCallback((title: string) => {
        this.onTitleChangeCallback?.(title);
      });
    }

    // Start render loop (only when NOT using offscreen — the worker has its own loop)
    if (!this.renderBridge) {
      this.renderer.startRenderLoop();
    }

    // Initialize accessibility manager
    this.accessibilityManager = new AccessibilityManager(
      container,
      this.bufferSet.active.grid,
      rows,
      cols,
    );
  }

  // -----------------------------------------------------------------------
  // Worker management
  // -----------------------------------------------------------------------

  /** Shared onFlush callback for both WorkerBridge and ParserChannel modes. */
  private makeWorkerFlushHandler(): (isAlternate: boolean, modes: FlushMessage["modes"]) => void {
    return (isAlternate, modes) => {
      if (modes) {
        this.inputHandler.setApplicationCursorKeys(modes.applicationCursorKeys);
        this.inputHandler.setBracketedPasteMode(modes.bracketedPasteMode);
        this.inputHandler.setMouseProtocol(modes.mouseProtocol);
        this.inputHandler.setMouseEncoding(modes.mouseEncoding);
        this.inputHandler.setSendFocusEvents(modes.sendFocusEvents);
        this.inputHandler.setKittyFlags(modes.kittyFlags ?? 0);
        this.applySyncedOutput(modes.syncedOutput ?? false);
      }

      if (this.pendingResizeCursor && !this.resizeCursorQueued) {
        this.resizeCursorQueued = true;
        const saved = this.pendingResizeCursor;
        queueMicrotask(() => {
          this.resizeCursorQueued = false;
          if (this.pendingResizeCursor === saved) {
            const cursor = this.bufferSet.active.cursor;
            cursor.row = saved.row;
            cursor.col = saved.col;
          }
        });
      }

      const altChanged = isAlternate !== this.bufferSet.isAlternate;
      if (altChanged) {
        this.bufferSet.setActive(isAlternate);

        const backend = this.workerBridge ?? this.parserChannel;
        if (backend) {
          backend.updateGrid(
            this.bufferSet.normal.grid,
            this.bufferSet.alternate.grid,
            this.bufferSet.active.cursor,
          );
        }

        this.viewportOffset = 0;
        this.displayGrid = null;

        this.inputHandler.setGrid(this.bufferSet.active.grid);
        this.accessibilityManager?.setGrid(
          this.bufferSet.active.grid,
          this.bufferSet.active.grid.rows,
          this.bufferSet.active.grid.cols,
        );
      }

      // Schedule a11y update after cell data application. The onFlush
      // callback runs before the grid is updated, so defer via microtask
      // so the accessibility tree reads the fresh grid state.
      queueMicrotask(() => this.accessibilityManager?.update());

      if (this.viewportOffset > 0 && !altChanged) return;

      const { grid, cursor } = this.bufferSet.active;
      if (this.sharedContext && this.paneId) {
        this.sharedContext.updateTerminal(this.paneId, grid, cursor);
      } else if (this.renderBridge) {
        this.renderBridge.resize(grid.cols, grid.rows, grid.getBuffer() as SharedArrayBuffer);
      } else {
        this.renderer.attach(this.canvas, grid, cursor);
      }
    };
  }

  private startWorkerMode(cols: number, rows: number, scrollback: number): void {
    const onFlush = this.makeWorkerFlushHandler();
    const onError = (message: string) => {
      console.warn("[WebTerminal] Worker error, falling back to main thread:", message);
      this.fallbackToMainThread();
    };

    try {
      // Pool mode: acquire a channel from the shared parser pool.
      if (this.parserPool && this.paneId) {
        this.parserChannel = this.parserPool.acquireChannel(
          this.paneId,
          this.bufferSet.normal.grid,
          this.bufferSet.alternate.grid,
          this.bufferSet.active.cursor,
          onFlush,
          onError,
        );
        this.parserChannel.start(cols, rows, scrollback);
        return;
      }

      // Single-terminal mode: create a dedicated WorkerBridge.
      this.workerBridge = new WorkerBridge(
        this.bufferSet.normal.grid,
        this.bufferSet.alternate.grid,
        this.bufferSet.active.cursor,
        onFlush,
        onError,
      );
      this.workerBridge.start(cols, rows, scrollback);
    } catch {
      this.fallbackToMainThread();
    }
  }

  private fallbackToMainThread(): void {
    if (this.parserChannel && this.parserPool && this.paneId) {
      this.parserPool.releaseChannel(this.paneId);
      this.parserChannel = null;
    }
    if (this.workerBridge) {
      this.workerBridge.dispose();
      this.workerBridge = null;
    }
    if (!this.parser) {
      this.parser = new VTParser(this.bufferSet);
      this.parser.setTitleChangeCallback((title: string) => {
        this.onTitleChangeCallback?.(title);
      });
    }
  }

  /**
   * Fall back from offscreen rendering to main-thread rendering.
   */
  private fallbackToMainThreadRenderer(rendererOpts: RendererOptions): void {
    if (this.renderBridge) {
      this.renderBridge.dispose();
      this.renderBridge = null;
    }
    // The canvas was transferred; we need a new one.
    const newCanvas = document.createElement("canvas");
    newCanvas.style.display = "block";
    if (this.canvas.parentElement) {
      this.canvas.parentElement.replaceChild(newCanvas, this.canvas);
    }
    this.canvas = newCanvas;

    this.renderer = new Canvas2DRenderer(rendererOpts);
    this.renderer.attach(this.canvas, this.bufferSet.active.grid, this.bufferSet.active.cursor);
    // Don't start the render loop if DECSET 2026 synchronized output is active.
    if (!this._syncedOutput) {
      this.renderer.startRenderLoop();
    }
  }

  /**
   * Write cursor state into the SAB so the render worker can read it.
   */
  private syncCursorToSAB(): void {
    const cursor = this.bufferSet.active.cursor;
    const grid = this.bufferSet.active.grid;
    grid.setCursor(cursor.row, cursor.col, cursor.visible, cursor.style);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  get cols(): number {
    return this.bufferSet.cols;
  }

  get rows(): number {
    return this.bufferSet.rows;
  }

  /** The active grid (for addons to read cell data). */
  get activeGrid(): import("@next_term/core").CellGrid {
    return this.bufferSet.active.grid;
  }

  /** The active cursor state (for addons). */
  get activeCursor(): CursorState {
    return this.bufferSet.active.cursor;
  }

  /** Current scroll offset (0 = live/bottom, positive = lines scrolled back). */
  get scrollOffset(): number {
    return this.viewportOffset;
  }

  /** The container element. */
  get element(): HTMLElement {
    return this.container;
  }

  /**
   * Write data to the terminal. When worker mode is active the data is
   * forwarded to the Web Worker; otherwise it is parsed on the main thread.
   */
  write(data: string | Uint8Array): void {
    if (this.disposed) return;

    // New data will produce a flush with the correct cursor position,
    // so the resize cursor override is no longer needed.
    this.pendingResizeCursor = null;

    // New data arrived — snap back to live view
    this.snapToBottom();

    const bytes = typeof data === "string" ? this.encoder.encode(data) : data;

    if (this.parserChannel) {
      this.parserChannel.write(bytes);
    } else if (this.workerBridge) {
      this.workerBridge.write(bytes);
    } else if (this.parser) {
      this.parser.write(bytes);
      // Sync mode flags from parser to input handler
      this.syncParserModes();
    }

    // Update accessibility tree (throttled internally to 10 Hz)
    this.accessibilityManager?.update();
  }

  /** Gate the render loop for synchronized output (DECSET ?2026). */
  private applySyncedOutput(synced: boolean): void {
    if (synced === this._syncedOutput) return;
    this._syncedOutput = synced;
    if (this.renderBridge) {
      this.renderBridge.setSyncedOutput(synced);
    } else if (synced) {
      this.renderer.stopRenderLoop();
    } else {
      this.renderer.startRenderLoop();
    }
  }

  /** Sync parser mode flags to the input handler, and detect buffer switches. */
  private syncParserModes(): void {
    if (!this.parser) return;
    this.inputHandler.setApplicationCursorKeys(this.parser.applicationCursorKeys);
    this.inputHandler.setBracketedPasteMode(this.parser.bracketedPasteMode);
    this.inputHandler.setMouseProtocol(this.parser.mouseProtocol);
    this.inputHandler.setMouseEncoding(this.parser.mouseEncoding);
    this.inputHandler.setSendFocusEvents(this.parser.sendFocusEvents);
    this.inputHandler.setKittyFlags(this.parser.kittyFlags);

    this.applySyncedOutput(this.parser.syncedOutput);

    // Detect alternate buffer switch and re-attach renderer
    const isAlt = this.bufferSet.isAlternate;
    if (isAlt !== this.wasAlternate) {
      this.wasAlternate = isAlt;
      const activeGrid = this.bufferSet.active.grid;
      const activeCursor = this.bufferSet.active.cursor;

      if (this.sharedContext && this.paneId) {
        this.sharedContext.updateTerminal(this.paneId, activeGrid, activeCursor);
      } else if (this.renderBridge) {
        this.renderBridge.resize(
          activeGrid.cols,
          activeGrid.rows,
          activeGrid.getBuffer() as SharedArrayBuffer,
        );
      } else {
        this.renderer.attach(this.canvas, activeGrid, activeCursor);
      }

      this.inputHandler.setGrid(activeGrid);
      this.accessibilityManager?.setGrid(activeGrid, activeGrid.rows, activeGrid.cols);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    // Guard against bad values
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 1) return;
    // No-op when dimensions haven't changed — avoids destroying wrap flags
    if (cols === this.bufferSet.cols && rows === this.bufferSet.rows) return;

    // Clear the stale display grid (wrong dimensions), but preserve
    // viewportOffset — we'll clamp it to the new scrollback length below.
    const wasScrolledBack = this.viewportOffset > 0;
    this.displayGrid = null;
    const MAX_COLS = 500;
    const MAX_ROWS = 500;
    cols = Math.min(cols, MAX_COLS);
    rows = Math.min(rows, MAX_ROWS);

    const scrollback = this.bufferSet.maxScrollback;
    const oldBufferSet = this.bufferSet;
    const oldGrid = oldBufferSet.active.grid;
    const oldCursor = oldBufferSet.active.cursor;
    const oldRows = oldBufferSet.rows;

    const isAlt = oldBufferSet.isAlternate;
    const colsChanged = cols !== oldBufferSet.cols;

    if (colsChanged && !isAlt) {
      // ---- REFLOW PATH ----
      // 1. Collect all rows: scrollback + viewport
      const allRows: RowData[] = [];

      // Scrollback rows (expand compact rows to full format for reflow)
      for (let i = 0; i < oldBufferSet.scrollback.length; i++) {
        const raw = oldBufferSet.scrollback[i];
        const cells = oldBufferSet.scrollbackCompact[i]
          ? expandCompactRow(raw, raw.length >>> 1)
          : raw;
        allRows.push({
          cells,
          wrapped: oldBufferSet.scrollbackWrap[i] ?? false,
        });
      }

      // Viewport rows
      for (let r = 0; r < oldRows; r++) {
        allRows.push({
          cells: oldGrid.copyRow(r),
          wrapped: oldGrid.isWrapped(r),
        });
      }

      // 2. Compute cursor absolute position
      const cursorAbsRow = oldBufferSet.scrollback.length + oldCursor.row;

      // 3. Run reflow
      const { reflowed, newCursorRow, newCursorCol } = reflowRows(
        allRows,
        oldBufferSet.cols,
        cols,
        cursorAbsRow,
        oldCursor.col,
      );

      // 4. Create new BufferSet
      this.bufferSet = new BufferSet(cols, rows, scrollback);
      const newGrid = this.bufferSet.active.grid;

      // 5. Split reflowed rows into scrollback vs screen
      const totalReflowed = reflowed.length;
      // Keep cursor at the same screen-relative position when possible.
      // If cursor is near the top (newCursorRow < rows), keep it at that
      // row on screen (screenStart = 0 in most cases). If cursor is below
      // the visible area, place it at the bottom row of the screen.
      const desiredScreenRow = Math.min(newCursorRow, rows - 1);
      const screenStart = Math.max(
        0,
        Math.min(newCursorRow - desiredScreenRow, totalReflowed - rows),
      );

      // Scrollback: everything before screenStart.
      // Reflowed rows are full-format; re-compact non-RGB rows to save memory.
      for (let i = 0; i < screenStart; i++) {
        const cells = reflowed[i].cells;
        let hasRgb = false;
        const rowCols = cells.length / CELL_SIZE;
        for (let c = 0; c < rowCols; c++) {
          if (cells[c * CELL_SIZE] & ((1 << 21) | (1 << 22))) {
            hasRgb = true;
            break;
          }
        }
        if (hasRgb) {
          this.bufferSet.pushScrollback(cells, reflowed[i].wrapped);
        } else {
          const compact = new Uint32Array(rowCols * 2);
          for (let c = 0; c < rowCols; c++) {
            compact[c * 2] = cells[c * CELL_SIZE];
            compact[c * 2 + 1] = cells[c * CELL_SIZE + 1];
          }
          this.bufferSet.pushScrollback(compact, reflowed[i].wrapped, true);
        }
      }

      // Screen rows
      for (let r = 0; r < rows; r++) {
        const srcIdx = screenStart + r;
        if (srcIdx < totalReflowed) {
          const row = reflowed[srcIdx];
          newGrid.pasteRow(r, row.cells, row.wrapped);
        }
      }

      // Set cursor row/col (path-specific calculation)
      const newCursor = this.bufferSet.active.cursor;
      newCursor.row = Math.max(0, Math.min(newCursorRow - screenStart, rows - 1));
      newCursor.col = Math.min(newCursorCol, cols - 1);
      newCursor.wrapPending = false;
    } else {
      // ---- EXISTING TRUNCATION PATH (for alt screen or same-cols resize) ----
      // Create new buffer set
      this.bufferSet = new BufferSet(cols, rows, scrollback);

      // Copy content from old grid to new grid.
      // When rows shrink, keep the bottom portion (where the cursor is).
      // When rows grow, content stays at the top.
      const newGrid = this.bufferSet.active.grid;
      const copyRows = Math.min(oldRows, rows);

      // Determine source start row: if cursor was below the new row count,
      // shift content up so cursor remains visible.
      let srcStartRow = 0;
      if (oldCursor.row >= rows) {
        srcStartRow = oldCursor.row - rows + 1;
      }

      // Transfer existing scrollback first, then push overflow rows.
      this.bufferSet.scrollback = oldBufferSet.scrollback;
      this.bufferSet.scrollbackWrap = oldBufferSet.scrollbackWrap;
      this.bufferSet.scrollbackCompact = oldBufferSet.scrollbackCompact;

      // Push overflow rows (above the viewport) into scrollback so the
      // user can scroll up to see them (#162). Only for the normal buffer
      // — alt screen doesn't have scrollback. Skip when scrollback is
      // disabled (maxScrollback === 0) to avoid wasteful copying.
      if (srcStartRow > 0 && !oldBufferSet.isAlternate && scrollback > 0) {
        for (let r = 0; r < srcStartRow; r++) {
          const compact = oldGrid.copyRowCompact(r);
          this.bufferSet.pushScrollback(
            compact,
            oldGrid.isWrapped(r),
            compact.length < oldGrid.cols * CELL_SIZE,
          );
        }
      }

      for (let r = 0; r < copyRows; r++) {
        const srcRow = srcStartRow + r;
        if (srcRow >= oldRows) break;
        const rowData = oldGrid.copyRow(srcRow);
        newGrid.pasteRow(r, rowData, oldGrid.isWrapped(srcRow));
      }

      // When in alt-screen, also preserve the inactive normal buffer's
      // grid content so it's not blank when the user exits alt mode.
      if (isAlt) {
        const oldNormalGrid = oldBufferSet.normal.grid;
        const newNormalGrid = this.bufferSet.normal.grid;
        const normalCopyRows = Math.min(oldBufferSet.rows, rows);
        for (let r = 0; r < normalCopyRows; r++) {
          const rowData = oldNormalGrid.copyRow(r);
          newNormalGrid.pasteRow(r, rowData, oldNormalGrid.isWrapped(r));
        }
        // Preserve normal buffer's cursor
        const oldNormalCursor = oldBufferSet.normal.cursor;
        const newNormalCursor = this.bufferSet.normal.cursor;
        newNormalCursor.row = Math.min(oldNormalCursor.row, rows - 1);
        newNormalCursor.col = Math.min(oldNormalCursor.col, cols - 1);
        newNormalCursor.visible = oldNormalCursor.visible;
        newNormalCursor.style = oldNormalCursor.style;
      }

      // Adjust cursor position for the new dimensions
      const newCursor = this.bufferSet.active.cursor;
      newCursor.row = Math.max(0, Math.min(oldCursor.row - srcStartRow, rows - 1));
      newCursor.col = Math.min(oldCursor.col, cols - 1);
    }

    // Common post-resize: preserve cursor appearance, clamp scroll, mark dirty.
    const finalCursor = this.bufferSet.active.cursor;
    finalCursor.visible = oldCursor.visible;
    finalCursor.style = oldCursor.style;

    if (wasScrolledBack) {
      const maxOffset = this.bufferSet.scrollback.length;
      this.viewportOffset = Math.min(this.viewportOffset, maxOffset);
      if (this.viewportOffset > 0) {
        this.buildDisplayGrid();
      }
    } else {
      this.viewportOffset = 0;
    }

    this.bufferSet.active.grid.markAllDirty();
    const backend = this.parserChannel ?? this.workerBridge;
    if (backend) {
      // Save adjusted cursor — the worker's resize flush will send
      // cursor (0,0) from its fresh BufferSet, overwriting ours.
      this.pendingResizeCursor = { row: finalCursor.row, col: finalCursor.col };
      // Update the backend's grid reference and notify the worker.
      backend.updateGrid(
        this.bufferSet.normal.grid,
        this.bufferSet.alternate.grid,
        this.bufferSet.active.cursor,
      );
      backend.resize(cols, rows, scrollback, finalCursor.row, finalCursor.col);
    } else {
      this.parser = new VTParser(this.bufferSet);
      this.parser.setTitleChangeCallback((title: string) => {
        this.onTitleChangeCallback?.(title);
      });
    }

    if (this.sharedContext && this.paneId) {
      // Update the shared context with the appropriate grid after resize.
      // If scrolled back, buildDisplayGrid already called updateTerminal above.
      if (this.viewportOffset === 0) {
        this.sharedContext.updateTerminal(
          this.paneId,
          this.bufferSet.active.grid,
          this.bufferSet.active.cursor,
        );
      }
    } else if (this.renderBridge) {
      // Notify render worker of resize with new SAB.
      // If scrolled back, send the display grid's buffer instead.
      const resizeGrid =
        this.viewportOffset > 0 && this.displayGrid ? this.displayGrid : this.bufferSet.active.grid;
      this.renderBridge.resize(cols, rows, resizeGrid.getBuffer() as SharedArrayBuffer);
    } else {
      // Re-attach renderer with the appropriate grid.
      // If scrolled back, buildDisplayGrid already attached the display grid above.
      if (this.viewportOffset === 0) {
        this.renderer.attach(this.canvas, this.bufferSet.active.grid, this.bufferSet.active.cursor);
      }
      this.renderer.resize(cols, rows);
    }

    // Update input handler's grid reference
    this.inputHandler.setGrid(this.bufferSet.active.grid);

    // Update accessibility manager with new grid
    if (this.accessibilityManager) {
      this.accessibilityManager.setGrid(this.bufferSet.active.grid, rows, cols);
    }

    this.onResizeCallback?.({ cols, rows });
  }

  /** Fit the terminal to its container. */
  fit(): void {
    if (this.disposed) return;
    const { width, height } = this.renderer.getCellSize();
    if (width <= 0 || height <= 0) return;

    const { cols, rows } = calculateFit(this.container, width, height);
    if (cols !== this.bufferSet.cols || rows !== this.bufferSet.rows) {
      this.resize(cols, rows);
    }
  }

  focus(): void {
    this.inputHandler.focus();
  }

  blur(): void {
    this.inputHandler.blur();
  }

  setTheme(theme: Partial<Theme>): void {
    const merged = mergeTheme(theme);
    if (this.renderBridge) {
      this.renderBridge.setTheme(merged);
    }
    this.renderer.setTheme(merged);
  }

  setFont(
    fontSize: number,
    fontFamily: string,
    fontWeight?: number,
    fontWeightBold?: number,
  ): void {
    if (this.renderBridge) {
      this.renderBridge.setFont(fontSize, fontFamily, fontWeight, fontWeightBold);
    }
    if (this.renderer.setFont) {
      this.renderer.setFont(fontSize, fontFamily, fontWeight, fontWeightBold);
    }
    const { width, height } = this.renderer.getCellSize();
    this.inputHandler.updateCellSize(width, height);
    this.inputHandler.setFontSize(fontSize);

    // If the new font is a web font that hasn't loaded yet, load it
    // and re-apply once available. The fonts.check() guard in ensureFont
    // prevents infinite recursion (ensureFont → setFont → ensureFont stops).
    this.ensureFont(fontFamily, fontSize, fontWeight, fontWeightBold);
  }

  /**
   * Load the specified font via the CSS Font Loading API so canvas/OffscreenCanvas
   * can use it. If the font loads after the atlas has already rasterized glyphs
   * with the fallback font, clear the atlas and re-measure cells.
   */
  private ensureFont(
    fontFamily: string,
    fontSize: number,
    fontWeight?: number,
    fontWeightBold?: number,
  ): void {
    if (typeof document === "undefined" || !document.fonts) return;

    const weight = fontWeight ?? 400;

    // Extract individual font names from the CSS font-family list.
    // "' Fira Code ', 'JetBrains Mono', monospace" → ["Fira Code", "JetBrains Mono", "monospace"]
    const families = fontFamily.split(",").map((f) => f.trim().replace(/^['"]|['"]$/g, ""));

    // Try loading each non-generic font. Generic families (monospace, serif, etc.)
    // are always available and don't need loading.
    const generics = new Set([
      "serif",
      "sans-serif",
      "monospace",
      "cursive",
      "fantasy",
      "system-ui",
      "ui-monospace",
      "ui-serif",
      "ui-sans-serif",
      "ui-rounded",
    ]);

    const toLoad = families.filter((f) => !generics.has(f));
    if (toLoad.length === 0) return;

    // Check if the primary (first non-generic) font is already available
    const primarySpec = `${weight} ${fontSize}px '${toLoad[0]}'`;
    if (document.fonts.check(primarySpec)) return;

    // Load all non-generic fonts in the list
    const loads = toLoad.map((f) =>
      document.fonts.load(`${weight} ${fontSize}px '${f}'`).catch(() => {
        // Individual font failed — continue with others
      }),
    );

    Promise.all(loads).then(() => {
      if (this.disposed) return;
      // At least one font may now be available — re-measure and re-rasterize.
      this.setFont(fontSize, fontFamily, fontWeight, fontWeightBold);
    });
  }

  getCellSize(): { width: number; height: number } {
    return this.renderer.getCellSize();
  }

  /** Read all visible grid rows as plain text (includes scrollback when scrolled). */
  getRowTexts(): string[] {
    const grid = this.displayGrid ?? this.bufferSet.active.grid;
    const rows: string[] = [];
    for (let r = 0; r < grid.rows; r++) {
      let line = "";
      for (let c = 0; c < grid.cols; c++) {
        // Skip spacer cells (right half of wide characters)
        if (grid.isSpacerCell(r, c)) continue;
        const cp = grid.getCodepoint(r, c);
        if (cp > 0x20) line += String.fromCodePoint(cp);
        else line += " "; // 0x00 (empty) and 0x20 (space) both render as space
      }
      rows.push(line.trimEnd());
    }
    return rows;
  }

  /** Get current cursor position. */
  getCursorPosition(): { row: number; col: number } {
    const c = this.bufferSet.active.cursor;
    return { row: c.row, col: c.col };
  }

  /** Query whether the alternate buffer is currently active. */
  get isAlternateBuffer(): boolean {
    return this.bufferSet.isAlternate;
  }

  /**
   * Get current parser/input mode state for save/restore scenarios.
   * Useful when moving a terminal between DOM containers.
   *
   * In worker mode, parser modes are synced from the worker via flush
   * messages. Values reflect the most recent flush.
   */
  getParserModes(): {
    applicationCursorKeys: boolean;
    bracketedPasteMode: boolean;
    mouseProtocol: MouseProtocol;
    mouseEncoding: MouseEncoding;
    sendFocusEvents: boolean;
  } {
    return this.inputHandler.getModes();
  }

  onData(callback: (data: Uint8Array) => void): void {
    this.onDataCallback = callback;
  }

  onResize(callback: (size: { cols: number; rows: number }) => void): void {
    this.onResizeCallback = callback;
  }

  /** Load an addon into this terminal. */
  loadAddon(addon: ITerminalAddon): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  /** Set highlight ranges on the renderer (used by SearchAddon). */
  setHighlights(highlights: HighlightRange[]): void {
    this.renderer.setHighlights(highlights);
  }

  // -----------------------------------------------------------------------
  // Scrollback viewport
  // -----------------------------------------------------------------------

  private createScrollbar(container: HTMLElement): void {
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      position: "absolute",
      right: "0",
      top: "0",
      bottom: "0",
      width: "6px",
      zIndex: "10",
      opacity: "0",
      transition: "opacity 0.3s",
      pointerEvents: "none",
    });

    const thumb = document.createElement("div");
    Object.assign(thumb.style, {
      position: "absolute",
      right: "1px",
      width: "4px",
      borderRadius: "2px",
      backgroundColor: "rgba(255, 255, 255, 0.4)",
      minHeight: "20px",
    });

    bar.appendChild(thumb);
    container.appendChild(bar);
    this.scrollbarEl = bar;
    this.scrollbarThumb = thumb;
  }

  private updateScrollbar(): void {
    if (!this.scrollbarEl || !this.scrollbarThumb) return;
    const totalLines = this.bufferSet.scrollback.length + this.bufferSet.rows;
    const visibleRows = this.bufferSet.rows;

    if (totalLines <= visibleRows || this.viewportOffset === 0) {
      // At bottom or no scrollback — hide
      this.scrollbarEl.style.opacity = "0";
      return;
    }

    // Show scrollbar
    this.scrollbarEl.style.opacity = "1";

    // Calculate thumb size and position
    const containerHeight =
      this.scrollbarEl.clientHeight || visibleRows * this.renderer.getCellSize().height;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * containerHeight);
    const maxScroll = this.bufferSet.scrollback.length;
    const scrollFraction = (maxScroll - this.viewportOffset) / maxScroll;
    const thumbTop = scrollFraction * (containerHeight - thumbHeight);

    this.scrollbarThumb.style.height = `${thumbHeight}px`;
    this.scrollbarThumb.style.top = `${thumbTop}px`;

    // Auto-hide after 1.5s
    if (this.scrollbarHideTimer) clearTimeout(this.scrollbarHideTimer);
    this.scrollbarHideTimer = setTimeout(() => {
      if (this.scrollbarEl) this.scrollbarEl.style.opacity = "0";
    }, 1500);
  }

  /**
   * Scroll the viewport into scrollback. deltaLines > 0 scrolls back (older),
   * deltaLines < 0 scrolls forward (newer).
   */
  private scrollViewport(deltaLines: number): void {
    const maxOffset = this.bufferSet.scrollback.length;
    const newOffset = Math.max(0, Math.min(maxOffset, this.viewportOffset + deltaLines));

    if (newOffset === this.viewportOffset) return;
    this.viewportOffset = newOffset;

    if (newOffset === 0) {
      // Back to live view — re-attach live grid
      if (this.displayGrid) {
        this.displayGrid = null;
        if (this.sharedContext && this.paneId) {
          this.sharedContext.updateTerminal(
            this.paneId,
            this.bufferSet.active.grid,
            this.bufferSet.active.cursor,
          );
        } else if (!this.renderBridge) {
          this.renderer.attach(
            this.canvas,
            this.bufferSet.active.grid,
            this.bufferSet.active.cursor,
          );
        }
      }
    } else {
      // Scrolled back — build display grid from scrollback + buffer
      this.buildDisplayGrid();
    }

    this.updateScrollbar();
  }

  /**
   * Build a display grid showing the correct mix of scrollback and buffer
   * lines for the current viewportOffset.
   */
  private buildDisplayGrid(): void {
    const cols = this.bufferSet.cols;
    const rows = this.bufferSet.rows;
    const scrollback = this.bufferSet.scrollback;

    // Reuse display grid if dimensions match, otherwise create new.
    // Only call renderer.attach() when the grid is first created —
    // subsequent updates just populate data and mark dirty.
    let needsAttach = false;
    if (!this.displayGrid || this.displayGrid.cols !== cols || this.displayGrid.rows !== rows) {
      this.displayGrid = new CellGrid(cols, rows);
      needsAttach = true;
    }

    // Virtual line numbering:
    // [0 .. scrollback.length-1] = scrollback lines
    // [scrollback.length .. scrollback.length+rows-1] = live buffer rows
    // viewportTop = scrollback.length - viewportOffset
    const viewportTop = scrollback.length - this.viewportOffset;

    for (let r = 0; r < rows; r++) {
      const virtualLine = viewportTop + r;
      if (virtualLine < 0) {
        // Before scrollback — show empty
        this.displayGrid.clearRow(r);
      } else if (virtualLine < scrollback.length) {
        // From scrollback — use pasteCompactRow for compact rows (no allocation)
        const sbWrapped = this.bufferSet.scrollbackWrap[virtualLine] ?? false;
        if (this.bufferSet.scrollbackCompact[virtualLine]) {
          this.displayGrid.pasteCompactRow(r, scrollback[virtualLine], sbWrapped);
        } else {
          this.displayGrid.pasteRow(r, scrollback[virtualLine], sbWrapped);
        }
      } else {
        // From live buffer
        const bufRow = virtualLine - scrollback.length;
        if (bufRow < rows) {
          const rowData = this.bufferSet.active.grid.copyRow(bufRow);
          this.displayGrid.pasteRow(r, rowData, this.bufferSet.active.grid.isWrapped(bufRow));
        } else {
          this.displayGrid.clearRow(r);
        }
      }
    }

    if (this.sharedContext && this.paneId) {
      // Shared context mode: update the shared context with the display grid
      const fakeCursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      this.displayGrid.markAllDirty();
      this.sharedContext.updateTerminal(this.paneId, this.displayGrid, fakeCursor);
    } else if (!this.renderBridge) {
      if (needsAttach) {
        const fakeCursor: CursorState = {
          row: 0,
          col: 0,
          visible: false,
          style: "block",
          wrapPending: false,
        };
        this.renderer.attach(this.canvas, this.displayGrid, fakeCursor);
      }
      this.displayGrid.markAllDirty();
    }
  }

  /** Snap viewport to live (bottom) — called when new data arrives or user types. */
  private snapToBottom(): void {
    if (this.viewportOffset === 0) return;
    this.viewportOffset = 0;
    this.displayGrid = null;
    if (this.sharedContext && this.paneId) {
      this.sharedContext.updateTerminal(
        this.paneId,
        this.bufferSet.active.grid,
        this.bufferSet.active.cursor,
      );
    } else if (!this.renderBridge) {
      this.renderer.attach(this.canvas, this.bufferSet.active.grid, this.bufferSet.active.cursor);
    }
    this.updateScrollbar();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.scrollbarHideTimer) clearTimeout(this.scrollbarHideTimer);

    for (const addon of this.addons) addon.dispose();
    this.addons = [];

    // Release parser channel BEFORE clearing paneId — the pool keys
    // channels by paneId so it must still be set here.
    if (this.parserChannel && this.parserPool && this.paneId) {
      this.parserPool.releaseChannel(this.paneId);
      this.parserChannel = null;
    }

    if (this.sharedContext && this.paneId) {
      this.sharedContext.removeTerminal(this.paneId);
      this.sharedContext = null;
      this.paneId = null;
    }
    if (this.workerBridge) {
      this.workerBridge.dispose();
      this.workerBridge = null;
    }

    if (this.renderBridge) {
      this.renderBridge.dispose();
      this.renderBridge = null;
    }

    if (this.accessibilityManager) {
      this.accessibilityManager.dispose();
      this.accessibilityManager = null;
    }

    this.renderer.dispose();
    this.inputHandler.dispose();
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    if (this.scrollbarEl?.parentElement) {
      this.scrollbarEl.parentElement.removeChild(this.scrollbarEl);
    }
    this.scrollbarEl = null;
    this.scrollbarThumb = null;
    this.displayGrid = null;
    this.onDataCallback = null;
    this.onResizeCallback = null;
    this.onTitleChangeCallback = null;
  }
}
