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

import type { CursorState, Theme } from "@next_term/core";
import { BufferSet, CellGrid, DEFAULT_THEME, VTParser } from "@next_term/core";
import { AccessibilityManager } from "./accessibility.js";
import type { ITerminalAddon } from "./addon.js";
import { calculateFit } from "./fit.js";
import { InputHandler } from "./input-handler.js";
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
    setFont?(fontSize: number, fontFamily: string): void;
  };
  private inputHandler: InputHandler;
  private disposed = false;
  private addons: ITerminalAddon[] = [];
  private accessibilityManager: AccessibilityManager | null = null;

  /** SharedWebGLContext when using shared multi-pane rendering, null otherwise. */
  private sharedContext: SharedWebGLContext | null = null;
  /** Pane ID within the SharedWebGLContext. */
  private paneId: string | null = null;
  /** WorkerBridge when using off-thread parsing, null otherwise. */
  private workerBridge: WorkerBridge | null = null;
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
    const rendererOpts: RendererOptions = {
      fontSize,
      fontFamily,
      theme,
      devicePixelRatio: options?.devicePixelRatio,
    };

    if (options?.sharedContext && options?.paneId) {
      // Shared WebGL context mode: register with the shared context
      // instead of creating our own renderer.
      this.sharedContext = options.sharedContext;
      this.paneId = options.paneId;

      const grid = this.bufferSet.active.grid;
      const cursor = this.bufferSet.active.cursor;
      this.sharedContext.addTerminal(this.paneId, grid, cursor);

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

  private startWorkerMode(cols: number, rows: number, scrollback: number): void {
    try {
      this.workerBridge = new WorkerBridge(
        this.bufferSet.active.grid,
        this.bufferSet.active.cursor,
        (isAlternate: boolean) => {
          // When the alternate buffer is toggled the renderer needs to
          // know which grid to read from.
          const activeGrid = isAlternate
            ? this.bufferSet.alternate.grid
            : this.bufferSet.normal.grid;
          const activeCursor = isAlternate
            ? this.bufferSet.alternate.cursor
            : this.bufferSet.normal.cursor;

          if (this.sharedContext && this.paneId) {
            this.sharedContext.updateTerminal(this.paneId, activeGrid, activeCursor);
          } else if (this.renderBridge) {
            // In offscreen mode, update the render worker's SAB reference
            this.renderBridge.resize(
              activeGrid.cols,
              activeGrid.rows,
              activeGrid.getBuffer() as SharedArrayBuffer,
            );
          } else {
            this.renderer.attach(this.canvas, activeGrid, activeCursor);
          }
        },
        (message: string) => {
          // On worker error, fall back to main-thread parsing.
          console.warn("[WebTerminal] Worker error, falling back to main thread:", message);
          this.fallbackToMainThread();
        },
      );
      this.workerBridge.start(cols, rows, scrollback);
    } catch {
      // Worker could not be created — fall back silently.
      this.fallbackToMainThread();
    }
  }

  private fallbackToMainThread(): void {
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
    this.renderer.startRenderLoop();
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

    // New data arrived — snap back to live view
    this.snapToBottom();

    const bytes = typeof data === "string" ? this.encoder.encode(data) : data;

    if (this.workerBridge) {
      this.workerBridge.write(bytes);
    } else if (this.parser) {
      this.parser.write(bytes);
      // Sync mode flags from parser to input handler
      this.syncParserModes();
    }

    // Update accessibility tree (throttled internally to 10 Hz)
    this.accessibilityManager?.update();
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

    // Synchronized output mode 2026: gate the main-thread render loop.
    // The offscreen render worker has its own loop and is not gated here.
    const isSynced = this.parser.syncedOutput;
    if (isSynced !== this._syncedOutput) {
      this._syncedOutput = isSynced;
      if (!this.renderBridge) {
        if (isSynced) {
          this.renderer.stopRenderLoop();
        } else {
          this.renderer.startRenderLoop();
          this.renderer.render();
        }
      }
    }

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
    const MAX_COLS = 500;
    const MAX_ROWS = 500;
    cols = Math.min(cols, MAX_COLS);
    rows = Math.min(rows, MAX_ROWS);

    const scrollback = this.bufferSet.maxScrollback;
    const oldBufferSet = this.bufferSet;
    const oldGrid = oldBufferSet.active.grid;
    const oldCursor = oldBufferSet.active.cursor;
    const oldRows = oldBufferSet.rows;

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

    for (let r = 0; r < copyRows; r++) {
      const srcRow = srcStartRow + r;
      if (srcRow >= oldRows) break;
      const rowData = oldGrid.copyRow(srcRow);
      // If old cols > new cols, the row data is wider — pasteRow handles truncation
      // If old cols < new cols, extra cells remain at default
      newGrid.pasteRow(r, rowData);
    }

    // Adjust cursor position for the new dimensions
    const newCursor = this.bufferSet.active.cursor;
    newCursor.row = Math.max(0, Math.min(oldCursor.row - srcStartRow, rows - 1));
    newCursor.col = Math.min(oldCursor.col, cols - 1);
    newCursor.visible = oldCursor.visible;
    newCursor.style = oldCursor.style;

    // Copy scrollback
    this.bufferSet.scrollback = oldBufferSet.scrollback;

    newGrid.markAllDirty();

    if (this.workerBridge) {
      // Update the bridge's grid reference and notify the worker.
      this.workerBridge.updateGrid(this.bufferSet.active.grid, this.bufferSet.active.cursor);
      this.workerBridge.resize(cols, rows, scrollback);
    } else {
      this.parser = new VTParser(this.bufferSet);
      this.parser.setTitleChangeCallback((title: string) => {
        this.onTitleChangeCallback?.(title);
      });
    }

    if (this.sharedContext && this.paneId) {
      // Update the shared context with the new grid/cursor after resize
      this.sharedContext.updateTerminal(
        this.paneId,
        this.bufferSet.active.grid,
        this.bufferSet.active.cursor,
      );
    } else if (this.renderBridge) {
      // Notify render worker of resize with new SAB
      this.renderBridge.resize(
        cols,
        rows,
        this.bufferSet.active.grid.getBuffer() as SharedArrayBuffer,
      );
    } else {
      // Re-attach renderer with new grid
      this.renderer.attach(this.canvas, this.bufferSet.active.grid, this.bufferSet.active.cursor);
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

  setFont(fontSize: number, fontFamily: string): void {
    if (this.renderBridge) {
      this.renderBridge.setFont(fontSize, fontFamily);
    }
    if (this.renderer.setFont) {
      this.renderer.setFont(fontSize, fontFamily);
    }
    const { width, height } = this.renderer.getCellSize();
    this.inputHandler.updateCellSize(width, height);
    this.inputHandler.setFontSize(fontSize);
  }

  getCellSize(): { width: number; height: number } {
    return this.renderer.getCellSize();
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
        if (!this.renderBridge) {
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
        // From scrollback
        this.displayGrid.pasteRow(r, scrollback[virtualLine]);
      } else {
        // From live buffer
        const bufRow = virtualLine - scrollback.length;
        if (bufRow < rows) {
          const rowData = this.bufferSet.active.grid.copyRow(bufRow);
          this.displayGrid.pasteRow(r, rowData);
        } else {
          this.displayGrid.clearRow(r);
        }
      }
    }

    if (!this.renderBridge) {
      if (needsAttach) {
        // Create a fake cursor (hidden) when scrolled back
        const fakeCursor: CursorState = {
          row: 0,
          col: 0,
          visible: false,
          style: "block",
          wrapPending: false,
        };
        this.renderer.attach(this.canvas, this.displayGrid, fakeCursor);
      }
      // markAllDirty is called by pasteRow/clearRow, but ensure full redraw
      this.displayGrid.markAllDirty();
    }
  }

  /** Snap viewport to live (bottom) — called when new data arrives or user types. */
  private snapToBottom(): void {
    if (this.viewportOffset === 0) return;
    this.viewportOffset = 0;
    this.displayGrid = null;
    if (!this.renderBridge) {
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
