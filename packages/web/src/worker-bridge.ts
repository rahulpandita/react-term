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

import { CellGrid, CELL_SIZE } from '@react-term/core';
import type { CursorState } from '@react-term/core';
import type { FlushMessage, ErrorMessage, OutboundMessage } from './parser-worker.js';

// ---- Flow-control constants ------------------------------------------------

/** Pause sending new writes when pending bytes exceed this threshold. */
const HIGH_WATERMARK = 500 * 1024; // 500 KB

/** Resume sending when pending bytes drop below this threshold. */
const LOW_WATERMARK = 100 * 1024; // 100 KB

// ---- Feature detection -----------------------------------------------------

const SAB_AVAILABLE =
  typeof SharedArrayBuffer !== 'undefined' &&
  (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : true);

// ---- WorkerBridge ----------------------------------------------------------

export class WorkerBridge {
  private worker: Worker | null = null;
  private grid: CellGrid;
  private cursor: CursorState;
  private onFlush: (isAlternate: boolean) => void;
  private onError: ((message: string) => void) | null;

  // Flow control
  private pendingBytes = 0;
  private paused = false;
  /** Buffered writes waiting to be sent while paused. */
  private writeQueue: Uint8Array[] = [];

  private disposed = false;

  constructor(
    grid: CellGrid,
    cursor: CursorState,
    onFlush: (isAlternate: boolean) => void,
    onError?: (message: string) => void,
  ) {
    this.grid = grid;
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

    this.worker = new Worker(
      new URL('./parser-worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.worker.addEventListener('message', this.handleWorkerMessage);
    this.worker.addEventListener('error', this.handleWorkerError);

    const init: {
      type: 'init';
      cols: number;
      rows: number;
      scrollback: number;
      sharedBuffer?: SharedArrayBuffer;
    } = {
      type: 'init',
      cols,
      rows,
      scrollback,
    };

    if (SAB_AVAILABLE && this.grid.isShared) {
      init.sharedBuffer = this.grid.getBuffer() as SharedArrayBuffer;
    }

    this.worker.postMessage(init);
  }

  /**
   * Send raw bytes to the worker for parsing.
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
  resize(cols: number, rows: number, scrollback: number): void {
    if (this.disposed || !this.worker) return;

    // Reset flow control on resize — old pending data is irrelevant.
    this.pendingBytes = 0;
    this.paused = false;
    this.writeQueue.length = 0;

    this.worker.postMessage({ type: 'resize', cols, rows, scrollback });
  }

  /**
   * Tear down the worker.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.worker) {
      this.worker.postMessage({ type: 'dispose' });
      this.worker.removeEventListener('message', this.handleWorkerMessage);
      this.worker.removeEventListener('error', this.handleWorkerError);
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

  updateGrid(grid: CellGrid, cursor: CursorState): void {
    this.grid = grid;
    this.cursor = cursor;
  }

  // ---- Internals -----------------------------------------------------------

  private sendWrite(data: Uint8Array): void {
    if (!this.worker) return;

    // Copy into a transferable ArrayBuffer.
    const buf = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );

    this.pendingBytes += data.byteLength;
    if (this.pendingBytes >= HIGH_WATERMARK) {
      this.paused = true;
    }

    this.worker.postMessage({ type: 'write', data: buf }, [buf]);
  }

  private drainQueue = (): void => {
    while (this.writeQueue.length > 0 && !this.paused) {
      const next = this.writeQueue.shift()!;
      this.sendWrite(next);
    }
  };

  private handleWorkerMessage = (event: MessageEvent<OutboundMessage>): void => {
    const msg = event.data;

    if (msg.type === 'error') {
      this.onError?.(msg.message);
      return;
    }

    if (msg.type === 'flush') {
      this.applyFlush(msg);
    }
  };

  private handleWorkerError = (event: ErrorEvent): void => {
    this.onError?.(`Worker error: ${event.message}`);
  };

  private applyFlush(msg: FlushMessage): void {
    // Update cursor on main thread.
    this.cursor.row = msg.cursor.row;
    this.cursor.col = msg.cursor.col;
    this.cursor.visible = msg.cursor.visible;
    this.cursor.style = msg.cursor.style as CursorState['style'];

    // In non-SAB mode, apply transferred cell data to the main-thread grid.
    if (msg.cellData && msg.dirtyRows) {
      const cellView = new Uint32Array(msg.cellData);
      const dirtyView = new Int32Array(msg.dirtyRows);

      // Only copy rows that were marked dirty by the worker.
      const cols = this.grid.cols;
      const rows = this.grid.rows;
      for (let r = 0; r < rows; r++) {
        if (dirtyView[r] !== 0) {
          const start = r * cols * CELL_SIZE;
          const end = start + cols * CELL_SIZE;
          this.grid.data.set(cellView.subarray(start, end), start);
          this.grid.markDirty(r);
        }
      }
    }

    // Update flow control.
    this.pendingBytes = Math.max(0, this.pendingBytes - msg.bytesProcessed);
    if (this.paused && this.pendingBytes < LOW_WATERMARK) {
      this.paused = false;
      this.drainQueue();
    }

    // Notify the caller so it can trigger a render.
    this.onFlush(msg.isAlternate);
  }
}
