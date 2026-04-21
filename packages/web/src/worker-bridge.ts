/**
 * WorkerBridge — main-thread orchestrator for the parser Web Worker.
 *
 * Manages the lifecycle of the worker, routes write / resize calls to it, and
 * applies flush messages back to the main-thread CellGrid & cursor.  When
 * SharedArrayBuffer is available the worker writes directly into the shared
 * buffer; otherwise data is transferred back via Transferable ArrayBuffers.
 *
 * Flow control: a simple watermark scheme prevents unbounded memory growth
 * when the PTY produces data faster than the worker can parse it.
 */

import type { CursorState } from "@next_term/core";
import { CELL_SIZE, type CellGrid, modPositive } from "@next_term/core";
import type { FlushMessage, OutboundMessage } from "./parser-worker.js";

// ---- Flow-control constants ------------------------------------------------

/** Pause sending new writes when pending bytes exceed this threshold. */
export const HIGH_WATERMARK = 2 * 1024 * 1024; // 2 MB

/** Resume sending when pending bytes drop below this threshold. */
export const LOW_WATERMARK = 512 * 1024; // 512 KB

// ---- Feature detection -----------------------------------------------------

export const SAB_AVAILABLE =
  typeof SharedArrayBuffer !== "undefined" &&
  (typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : true);

// ---- WorkerBridge ----------------------------------------------------------

export class WorkerBridge {
  private worker: Worker | null = null;
  private grid: CellGrid;
  private altGrid: CellGrid;
  private cursor: CursorState;
  private onFlush: (isAlternate: boolean, modes: FlushMessage["modes"]) => void;
  private onError: ((message: string) => void) | null;

  // Flow control
  private pendingBytes = 0;
  private paused = false;
  /** Buffered writes waiting to be sent while paused. */
  private writeQueue: Uint8Array[] = [];
  /** Skip cell data in pending non-SAB flushes (main thread already has reflowed data). */
  private skipFlushCellDataCount = 0;

  private disposed = false;

  constructor(
    grid: CellGrid,
    altGrid: CellGrid,
    cursor: CursorState,
    onFlush: (isAlternate: boolean, modes: FlushMessage["modes"]) => void,
    onError?: (message: string) => void,
  ) {
    this.grid = grid;
    this.altGrid = altGrid;
    this.cursor = cursor;
    this.onFlush = onFlush;
    this.onError = onError ?? null;
  }

  // ---- Public API ----------------------------------------------------------

  /**
   * Spin up the worker and send the init message.
   */
  start(cols: number, rows: number, scrollback: number): void {
    if (this.disposed) return;

    this.worker = new Worker(new URL("./parser-worker.js", import.meta.url), { type: "module" });

    this.worker.addEventListener("message", this.handleWorkerMessage);
    this.worker.addEventListener("error", this.handleWorkerError);

    this.worker.postMessage({
      type: "init",
      cols,
      rows,
      scrollback,
      ...this.getSharedBuffers(),
    });
  }

  /**
   * Send raw bytes to the worker for parsing.
   *
   * The underlying ArrayBuffer may be transferred (detached) if the view
   * covers it entirely. Callers must not reuse `data` after this call.
   */
  write(data: Uint8Array): void {
    if (this.disposed || !this.worker) return;

    if (this.paused) {
      this.writeQueue.push(data);
      return;
    }

    this.sendWrite(data);
  }

  /**
   * Notify the worker that the terminal has been resized.
   */
  resize(
    cols: number,
    rows: number,
    scrollback: number,
    cursorRow?: number,
    cursorCol?: number,
  ): void {
    if (this.disposed || !this.worker) return;

    // Reset flow control on resize — old pending data is irrelevant.
    this.pendingBytes = 0;
    this.paused = false;
    this.writeQueue.length = 0;

    // In non-SAB mode, seed the worker with the main thread's reflowed
    // grid data so the worker's state matches. Also skip the immediate
    // post-resize flush's cell data (it would be the seeded content
    // echoed back — wasteful but harmless). Use a counter so rapid
    // resizes each get their flush skipped.
    const msg: {
      type: "resize";
      cols: number;
      rows: number;
      scrollback: number;
      cursorRow?: number;
      cursorCol?: number;
      sharedBuffer?: SharedArrayBuffer;
      sharedAltBuffer?: SharedArrayBuffer;
      reflowedCellData?: ArrayBuffer;
      reflowedWrapFlags?: ArrayBuffer;
    } = {
      type: "resize",
      cols,
      rows,
      scrollback,
      cursorRow,
      cursorCol,
      ...this.getSharedBuffers(),
    };
    const transferables: ArrayBuffer[] = [];

    if (!SAB_AVAILABLE) {
      this.skipFlushCellDataCount++;
      const cellCopy = this.grid.data.slice().buffer;
      const wrapCopy = this.grid.wrapFlags.slice().buffer;
      msg.reflowedCellData = cellCopy;
      msg.reflowedWrapFlags = wrapCopy;
      transferables.push(cellCopy, wrapCopy);
    }

    this.worker.postMessage(msg, transferables);
  }

  /**
   * Tear down the worker.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.worker) {
      this.worker.postMessage({ type: "dispose" });
      this.worker.removeEventListener("message", this.handleWorkerMessage);
      this.worker.removeEventListener("error", this.handleWorkerError);
      this.worker.terminate();
      this.worker = null;
    }

    this.writeQueue.length = 0;
  }

  // ---- Getters for flow-control state (useful for testing) -----------------

  get isPaused(): boolean {
    return this.paused;
  }

  get pendingByteCount(): number {
    return this.pendingBytes;
  }

  // ---- Allow updating the grid / cursor reference after resize -------------

  updateGrid(grid: CellGrid, altGrid: CellGrid, cursor: CursorState): void {
    this.grid = grid;
    this.altGrid = altGrid;
    this.cursor = cursor;
  }

  // ---- Internals -----------------------------------------------------------

  private getSharedBuffers(): {
    sharedBuffer?: SharedArrayBuffer;
    sharedAltBuffer?: SharedArrayBuffer;
  } {
    if (SAB_AVAILABLE && this.grid.isShared) {
      return {
        sharedBuffer: this.grid.getBuffer() as SharedArrayBuffer,
        sharedAltBuffer: this.altGrid.getBuffer() as SharedArrayBuffer,
      };
    }
    return {};
  }

  private sendWrite(data: Uint8Array): void {
    if (!this.worker) return;

    // Transfer the underlying ArrayBuffer if the view covers it entirely
    // (common case: WebSocket ArrayBuffer or freshly-encoded data).
    // Otherwise copy into a new buffer to avoid detaching shared memory.
    let buf: ArrayBuffer;
    if (
      data.byteOffset === 0 &&
      data.byteLength === data.buffer.byteLength &&
      data.buffer instanceof ArrayBuffer
    ) {
      buf = data.buffer;
    } else {
      buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }

    this.pendingBytes += data.byteLength;
    if (this.pendingBytes >= HIGH_WATERMARK) {
      this.paused = true;
    }

    this.worker.postMessage({ type: "write", data: buf }, [buf]);
  }

  private drainQueue = (): void => {
    while (this.writeQueue.length > 0 && !this.paused) {
      const next = this.writeQueue.shift();
      if (!next) break;
      this.sendWrite(next);
    }
  };

  private handleWorkerMessage = (event: MessageEvent<OutboundMessage>): void => {
    if (this.disposed) return;
    const msg = event.data;

    if (msg.type === "error") {
      this.onError?.(msg.message);
      return;
    }

    if (msg.type === "flush") {
      this.applyFlush(msg);
    }
  };

  private handleWorkerError = (event: ErrorEvent): void => {
    this.onError?.(`Worker error: ${event.message}`);
  };

  private applyFlush(msg: FlushMessage): void {
    // Notify the caller FIRST so it can retarget grid/cursor references
    // when the active buffer changes (e.g., alt screen switch via
    // updateGrid). This ensures the cursor and cell-data writes below
    // land on the correct buffer.
    this.onFlush(msg.isAlternate, msg.modes);

    // Update cursor on main thread (targets the active buffer after
    // any retargeting by onFlush).
    this.cursor.row = msg.cursor.row;
    this.cursor.col = msg.cursor.col;
    this.cursor.visible = msg.cursor.visible;
    this.cursor.style = msg.cursor.style as CursorState["style"];

    // In non-SAB mode, apply transferred cell data to the correct
    // main-thread grid. The worker always sends the active buffer's data;
    // select the target grid based on isAlternate.
    // Skip post-resize flushes — main thread already has reflowed data.
    if (this.skipFlushCellDataCount > 0 && msg.cellData) {
      this.skipFlushCellDataCount--;
      // Skip cell data AND wrap flags — the worker echoes back the seeded
      // content, so applying it would be a no-op. Flow control still updates.
    } else if (msg.cellData && msg.dirtyRows) {
      const targetGrid = msg.isAlternate ? this.altGrid : this.grid;
      const cellView = new Uint32Array(msg.cellData);
      const dirtyView = new Int32Array(msg.dirtyRows);
      const cols = targetGrid.cols;
      const rows = targetGrid.rows;

      // Validate that transferred data matches the target grid dimensions.
      // A resize between the worker write and this flush can cause a
      // mismatch in either direction (grow or shrink). An oversized stale
      // flush would be read with the wrong row stride, causing garbled output.
      const expectedCells = cols * rows * CELL_SIZE;
      if (cellView.length !== expectedCells || dirtyView.length !== rows) {
        return; // stale flush for a different grid size — discard
      }

      const rowOffset = modPositive(msg.rowOffset ?? 0, rows);

      // Sync circular buffer row offset so physical layout matches the worker's.
      targetGrid.rowOffsetData[0] = rowOffset;

      // Only copy rows that were marked dirty by the worker.
      // Dirty flags are indexed by logical row; map to physical positions
      // in both source and destination (same offset, so same physical row).
      const rowLen = cols * CELL_SIZE;
      for (let r = 0; r < rows; r++) {
        if (dirtyView[r] !== 0) {
          const physRow = modPositive(r + rowOffset, rows);
          const start = physRow * rowLen;
          const end = start + rowLen;
          targetGrid.data.set(cellView.subarray(start, end), start);
          targetGrid.markDirty(r);
        }
      }

      // Sync wrap flags from the worker (non-SAB mode only).
      if (msg.wrapFlags) {
        const wrapView = new Int32Array(msg.wrapFlags);
        if (wrapView.length === rows) {
          targetGrid.wrapFlags.set(wrapView);
        }
      }
    }

    // Update flow control.
    this.pendingBytes = Math.max(0, this.pendingBytes - msg.bytesProcessed);
    if (this.paused && this.pendingBytes < LOW_WATERMARK) {
      this.paused = false;
      this.drainQueue();
    }
  }
}
