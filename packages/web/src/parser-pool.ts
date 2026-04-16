/**
 * ParserPool — manages a pool of N parser Web Workers shared across many
 * terminal panes. Each pane gets a "channel" assigned to one of the workers.
 *
 * This avoids the thread oversubscription problem: 32 panes with 4 workers
 * means 4 postMessage streams instead of 32, dramatically reducing overhead
 * while still keeping all parsing off the main thread.
 *
 * API mirrors SharedWebGLContext: created once at the container level,
 * channels are acquired/released per pane.
 */

import type { CursorState } from "@next_term/core";
import { CELL_SIZE, type CellGrid, modPositive } from "@next_term/core";
import type { FlushMessage, OutboundMessage } from "./parser-worker.js";
import { HIGH_WATERMARK, LOW_WATERMARK, SAB_AVAILABLE } from "./worker-bridge.js";

// ---- ParserChannel ----------------------------------------------------------

/**
 * A channel within a shared parser worker. Same public API as WorkerBridge
 * but routes messages through a shared Worker via channelId.
 */
export class ParserChannel {
  private grid: CellGrid;
  private altGrid: CellGrid;
  private cursor: CursorState;
  private onFlush: (isAlternate: boolean, modes: FlushMessage["modes"]) => void;
  private onError: ((message: string) => void) | null;

  // Flow control (per-channel, not per-worker) — same shape as WorkerBridge
  private pendingBytes = 0;
  private paused = false;
  private writeQueue: Uint8Array[] = [];
  private skipFlushCellDataCount = 0;

  private disposed = false;

  constructor(
    readonly channelId: string,
    private readonly postToWorker: (msg: unknown, transfer?: Transferable[]) => void,
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

  // ---- Public API (mirrors WorkerBridge) ------------------------------------

  start(cols: number, rows: number, scrollback: number): void {
    if (this.disposed) return;
    this.postToWorker({
      type: "init",
      channelId: this.channelId,
      cols,
      rows,
      scrollback,
      ...this.getSharedBuffers(),
    });
  }

  write(data: Uint8Array): void {
    if (this.disposed) return;

    if (this.paused) {
      this.writeQueue.push(data);
      return;
    }

    this.sendWrite(data);
  }

  resize(
    cols: number,
    rows: number,
    scrollback: number,
    cursorRow?: number,
    cursorCol?: number,
  ): void {
    if (this.disposed) return;

    this.pendingBytes = 0;
    this.paused = false;
    this.writeQueue.length = 0;

    const msg: Record<string, unknown> = {
      type: "resize",
      channelId: this.channelId,
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

    this.postToWorker(msg, transferables);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.postToWorker({ type: "dispose", channelId: this.channelId });
    this.writeQueue.length = 0;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get pendingByteCount(): number {
    return this.pendingBytes;
  }

  updateGrid(grid: CellGrid, altGrid: CellGrid, cursor: CursorState): void {
    this.grid = grid;
    this.altGrid = altGrid;
    this.cursor = cursor;
  }

  // ---- Called by ParserPool's demux -----------------------------------------

  /** @internal — called by the pool when a flush arrives for this channel. */
  handleFlush(msg: FlushMessage): void {
    if (this.disposed) return;

    this.onFlush(msg.isAlternate, msg.modes);

    this.cursor.row = msg.cursor.row;
    this.cursor.col = msg.cursor.col;
    this.cursor.visible = msg.cursor.visible;
    this.cursor.style = msg.cursor.style as CursorState["style"];

    if (this.skipFlushCellDataCount > 0 && msg.cellData) {
      this.skipFlushCellDataCount--;
    } else if (msg.cellData && msg.dirtyRows) {
      const targetGrid = msg.isAlternate ? this.altGrid : this.grid;
      const cellView = new Uint32Array(msg.cellData);
      const dirtyView = new Int32Array(msg.dirtyRows);
      const cols = targetGrid.cols;
      const rows = targetGrid.rows;

      const expectedCells = cols * rows * CELL_SIZE;
      if (cellView.length !== expectedCells || dirtyView.length !== rows) {
        // Stale flush for a different grid size — update flow control only.
        this.pendingBytes = Math.max(0, this.pendingBytes - msg.bytesProcessed);
        if (this.paused && this.pendingBytes < LOW_WATERMARK) {
          this.paused = false;
          this.drainQueue();
        }
        return;
      }

      const rowOffset = modPositive(msg.rowOffset ?? 0, rows);
      targetGrid.rowOffsetData[0] = rowOffset;

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

      if (msg.wrapFlags) {
        const wrapView = new Int32Array(msg.wrapFlags);
        if (wrapView.length === rows) {
          targetGrid.wrapFlags.set(wrapView);
        }
      }
    }

    this.pendingBytes = Math.max(0, this.pendingBytes - msg.bytesProcessed);
    if (this.paused && this.pendingBytes < LOW_WATERMARK) {
      this.paused = false;
      this.drainQueue();
    }
  }

  /** @internal — called by the pool when an error arrives for this channel. */
  handleError(message: string): void {
    if (this.disposed) return;
    this.onError?.(message);
  }

  // ---- Internals ------------------------------------------------------------

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

    this.postToWorker({ type: "write", channelId: this.channelId, data: buf }, [buf]);
  }

  private drainQueue = (): void => {
    while (this.writeQueue.length > 0 && !this.paused) {
      const next = this.writeQueue.shift();
      if (!next) break;
      this.sendWrite(next);
    }
  };
}

// ---- ParserPool -------------------------------------------------------------

export const DEFAULT_PARSER_WORKER_COUNT = Math.min(
  typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4,
  4,
);

/**
 * A pool of N parser Web Workers shared across many terminal panes.
 *
 * Usage:
 * ```ts
 * const pool = new ParserPool(4);
 * const channel = pool.acquireChannel("pane-0", grid, altGrid, cursor, onFlush);
 * channel.start(cols, rows, scrollback);
 * channel.write(data);
 * // ...
 * pool.releaseChannel("pane-0");
 * pool.dispose();
 * ```
 */
export class ParserPool {
  private workers: Worker[] = [];
  private channels = new Map<string, { workerIndex: number; channel: ParserChannel }>();
  private workerChannelCounts: number[];
  /** Workers that have crashed and should not receive new channel assignments. */
  private deadWorkers = new Set<number>();
  private disposed = false;

  constructor(workerCount: number = DEFAULT_PARSER_WORKER_COUNT) {
    const count = Math.max(1, workerCount);
    this.workerChannelCounts = new Array(count).fill(0);

    try {
      for (let i = 0; i < count; i++) {
        const worker = new Worker(new URL("./parser-worker.js", import.meta.url), {
          type: "module",
        });
        worker.addEventListener("message", (event: MessageEvent<OutboundMessage>) => {
          this.handleWorkerMessage(i, event);
        });
        worker.addEventListener("error", (event: ErrorEvent) => {
          this.handleWorkerError(i, event);
        });
        this.workers.push(worker);
      }
    } catch (err) {
      // If mid-loop construction fails, terminate any workers already created
      // so we don't leak them before throwing.
      for (const w of this.workers) {
        try {
          w.terminate();
        } catch {}
      }
      this.workers.length = 0;
      throw err;
    }
  }

  /** Number of workers in the pool. */
  get workerCount(): number {
    return this.workers.length;
  }

  /**
   * Acquire a channel for a terminal pane. The channel is assigned to the
   * worker with the fewest current channels (least-loaded at assignment time).
   */
  acquireChannel(
    channelId: string,
    grid: CellGrid,
    altGrid: CellGrid,
    cursor: CursorState,
    onFlush: (isAlternate: boolean, modes: FlushMessage["modes"]) => void,
    onError?: (message: string) => void,
  ): ParserChannel {
    if (this.disposed) {
      throw new Error("ParserPool is disposed");
    }

    const workerIndex = this.pickWorker();
    const worker = this.workers[workerIndex];

    const channel = new ParserChannel(
      channelId,
      (msg: unknown, transfer?: Transferable[]) => {
        if (transfer) {
          worker.postMessage(msg, transfer);
        } else {
          worker.postMessage(msg);
        }
      },
      grid,
      altGrid,
      cursor,
      onFlush,
      onError,
    );

    this.channels.set(channelId, { workerIndex, channel });
    this.workerChannelCounts[workerIndex]++;

    return channel;
  }

  /**
   * Release a channel. Sends dispose to the worker and cleans up.
   */
  releaseChannel(channelId: string): void {
    const entry = this.channels.get(channelId);
    if (!entry) return;

    entry.channel.dispose();
    this.workerChannelCounts[entry.workerIndex]--;
    this.channels.delete(channelId);
  }

  /**
   * Dispose the entire pool — releases all channels and terminates all workers.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const [, entry] of this.channels) {
      entry.channel.dispose();
    }
    this.channels.clear();

    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers.length = 0;
    this.workerChannelCounts.length = 0;
  }

  // ---- Internals ------------------------------------------------------------

  /** Pick the live worker with the fewest current channels. */
  private pickWorker(): number {
    let minIdx = -1;
    let minCount = Infinity;
    for (let i = 0; i < this.workerChannelCounts.length; i++) {
      if (this.deadWorkers.has(i)) continue;
      if (this.workerChannelCounts[i] < minCount) {
        minCount = this.workerChannelCounts[i];
        minIdx = i;
      }
    }
    if (minIdx === -1) {
      throw new Error("ParserPool: no live workers available");
    }
    return minIdx;
  }

  /** Demux incoming messages by channelId to the correct ParserChannel. */
  private handleWorkerMessage(workerIndex: number, event: MessageEvent<OutboundMessage>): void {
    if (this.disposed) return;
    const msg = event.data;
    const channelId = msg.channelId;
    if (!channelId) return; // no channelId = legacy message, shouldn't happen in pool

    const entry = this.channels.get(channelId);
    if (!entry) return; // channel already disposed

    // Guard against channelId reuse: if the channel was released and
    // re-acquired on a different worker, drop stale flushes from the old one.
    if (entry.workerIndex !== workerIndex) return;

    if (msg.type === "error") {
      entry.channel.handleError(msg.message);
    } else if (msg.type === "flush") {
      entry.channel.handleFlush(msg);
    }
  }

  /** Forward worker errors to all channels on that worker and mark it dead. */
  private handleWorkerError(workerIndex: number, event: ErrorEvent): void {
    // Mark the worker as dead BEFORE forwarding errors — the error callbacks
    // may synchronously call releaseChannel, which would otherwise see the
    // worker as live and leave workerChannelCounts in an inconsistent state.
    this.deadWorkers.add(workerIndex);
    for (const [, entry] of this.channels) {
      if (entry.workerIndex === workerIndex) {
        entry.channel.handleError(`Worker error: ${event.message}`);
      }
    }
  }
}
