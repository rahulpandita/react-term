/**
 * ParserPool — manages a pool of N parser Web Workers shared across many
 * terminal panes. Each pane gets a "channel" assigned to one of the workers.
 *
 * This avoids the thread oversubscription problem: 32 panes with 4 workers
 * means 4 postMessage streams instead of 32, dramatically reducing overhead
 * while still keeping all parsing off the main thread.
 *
 * Flow control is per-WORKER (not per-channel) so that the HIGH_WATERMARK
 * budget scales with worker capacity, not channel count. All channels on a
 * saturated worker pause together until that worker drains below
 * LOW_WATERMARK.
 *
 * IMPORTANT invariants:
 *   - Pending-bytes bookkeeping is always reconciled in the pool's message
 *     handler, not in ParserChannel. Flushes for disposed / mismatched /
 *     unknown channels still decrement worker-level pendingBytes so the
 *     worker never gets stuck in a permanent pause.
 *   - Released channels deposit their still-pending bytes into a per-worker
 *     "orphan" counter. The pool drains orphan bytes as flushes arrive so
 *     the pause threshold is reconciled without waiting for the channel
 *     (which no longer exists).
 *   - Worker crashes terminate the worker, reset its flow-control counters,
 *     and unpause all channels that were on it so they don't accumulate
 *     queued writes while the consumer is deciding how to recover.
 *   - Channel assignments carry a generation number that's included in
 *     every message. Stale flushes from a prior lifecycle (after channelId
 *     reuse) are dropped without polluting flow control.
 */

import type { CursorState } from "@next_term/core";
import { CELL_SIZE, type CellGrid, modPositive } from "@next_term/core";
import type { FlushMessage, OutboundMessage } from "./parser-worker.js";
import { HIGH_WATERMARK, LOW_WATERMARK, SAB_AVAILABLE } from "./worker-bridge.js";

/** Hard cap on per-channel writeQueue memory when the worker is stalled.
 *  Exceeding this invokes onError so the consumer can fall back to
 *  main-thread parsing rather than silently dropping bytes (which would
 *  corrupt the VT parser mid-escape-sequence). */
const MAX_QUEUE_BYTES = 16 * 1024 * 1024; // 16 MB

// ---- ParserChannel ----------------------------------------------------------

/**
 * A channel within a shared parser worker. Same public API as WorkerBridge
 * but routes messages through a shared Worker via channelId. Flow control
 * is owned by the pool — ParserChannel only tracks its own paused state.
 */
export class ParserChannel {
  private grid: CellGrid;
  private altGrid: CellGrid;
  private cursor: CursorState;
  private onFlush: (isAlternate: boolean, modes: FlushMessage["modes"]) => void;
  private onError: ((message: string) => void) | null;

  private poolPaused = false;
  private writeQueue: Uint8Array[] = [];
  private queuedBytes = 0;
  private skipFlushCellDataCount = 0;

  private disposed = false;

  constructor(
    readonly channelId: string,
    /** @internal — pool callback used by ParserChannel to send writes */
    private readonly poolSendWrite: (
      channelId: string,
      buf: ArrayBuffer,
      byteLength: number,
    ) => void,
    /** @internal — pool callback used by ParserChannel to post non-write messages */
    private readonly poolPost: (msg: unknown, transfer?: Transferable[]) => void,
    /** @internal — pool callback invoked when channel is disposed with still-pending bytes */
    private readonly poolOnChannelDispose: (channelId: string) => void,
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
    this.poolPost({
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

    if (this.poolPaused) {
      // Never silently drop bytes mid-stream — dropping inside an escape
      // sequence corrupts the parser for the remainder of the session.
      // Instead, surface the overflow so the consumer (WebTerminal) can
      // fall back to main-thread parsing.
      if (this.queuedBytes + data.byteLength > MAX_QUEUE_BYTES) {
        const errMessage = `ParserChannel "${this.channelId}" queue exceeded ${MAX_QUEUE_BYTES} bytes — worker stalled, falling back`;
        // Tear down via the full dispose path FIRST so the worker is told
        // the channel is gone and the pool removes the entry from its map.
        // Otherwise the consumer's onError → releaseChannel → dispose()
        // early-returns on `disposed`, leaving the pool + worker state
        // leaked and preventing re-acquiring this paneId.
        this.dispose();
        this.onError?.(errMessage);
        return;
      }
      this.writeQueue.push(data);
      this.queuedBytes += data.byteLength;
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

    this.writeQueue.length = 0;
    this.queuedBytes = 0;

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

    this.poolPost(msg, transferables);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.poolPost({ type: "dispose", channelId: this.channelId });
    // Pool needs to know the channel is gone so it can track any
    // in-flight bytes as "orphan" (decremented when flushes arrive).
    this.poolOnChannelDispose(this.channelId);
    this.writeQueue.length = 0;
    this.queuedBytes = 0;
  }

  get isPaused(): boolean {
    return this.poolPaused;
  }

  updateGrid(grid: CellGrid, altGrid: CellGrid, cursor: CursorState): void {
    this.grid = grid;
    this.altGrid = altGrid;
    this.cursor = cursor;
  }

  // ---- Called by ParserPool's demux / flow control -------------------------

  /** @internal */
  setPoolPaused(paused: boolean): void {
    if (this.disposed) return;
    this.poolPaused = paused;
  }

  /** @internal */
  drainQueue(): void {
    if (this.disposed) return;
    while (this.writeQueue.length > 0 && !this.poolPaused) {
      const next = this.writeQueue.shift();
      if (!next) break;
      this.queuedBytes -= next.byteLength;
      this.sendWrite(next);
    }
  }

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
      return;
    }
    if (!msg.cellData || !msg.dirtyRows) return;

    const targetGrid = msg.isAlternate ? this.altGrid : this.grid;
    const cellView = new Uint32Array(msg.cellData);
    const dirtyView = new Int32Array(msg.dirtyRows);
    const cols = targetGrid.cols;
    const rows = targetGrid.rows;

    const expectedCells = cols * rows * CELL_SIZE;
    if (cellView.length !== expectedCells || dirtyView.length !== rows) {
      // Stale flush for a different grid size — flow control is already
      // reconciled by the pool before this is called.
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

  /** @internal */
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

    this.poolSendWrite(this.channelId, buf, data.byteLength);
  }
}

// ---- ParserPool -------------------------------------------------------------

export const DEFAULT_PARSER_WORKER_COUNT = Math.min(
  typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4,
  4,
);

interface ChannelEntry {
  workerIndex: number;
  /** Monotonic generation for this channelId. Incremented on each acquire so
   *  stale flushes from a prior lifecycle can be dropped in the demux. */
  generation: number;
  channel: ParserChannel;
}

export class ParserPool {
  private workers: Worker[] = [];
  private channels = new Map<string, ChannelEntry>();
  private workerChannelCounts: number[];
  /** Total bytes currently in-flight per worker (sum across all channels). */
  private workerPendingBytes: number[];
  /** Per-worker paused state — saturated or not. */
  private workerPaused: boolean[];
  /** Monotonic generation counter per channelId (defends against reuse races). */
  private channelGenerations = new Map<string, number>();
  /** Workers that have crashed and should not receive new channel assignments. */
  private deadWorkers = new Set<number>();
  private disposed = false;

  constructor(workerCount: number = DEFAULT_PARSER_WORKER_COUNT) {
    const count = Math.max(1, workerCount);
    this.workerChannelCounts = new Array(count).fill(0);
    this.workerPendingBytes = new Array(count).fill(0);
    this.workerPaused = new Array(count).fill(false);

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
      for (const w of this.workers) {
        try {
          w.terminate();
        } catch {}
      }
      this.workers.length = 0;
      throw err;
    }
  }

  get workerCount(): number {
    return this.workers.length;
  }

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
    if (this.channels.has(channelId)) {
      throw new Error(`ParserPool: channelId "${channelId}" is already in use`);
    }

    const workerIndex = this.pickWorker();
    const worker = this.workers[workerIndex];
    const generation = (this.channelGenerations.get(channelId) ?? 0) + 1;
    this.channelGenerations.set(channelId, generation);

    const channel = new ParserChannel(
      channelId,
      (cid, buf, byteLength) =>
        this.sendWriteFromChannel(workerIndex, generation, cid, buf, byteLength),
      (msg, transfer) => {
        // Tag with generation so stale flushes can be rejected in demux.
        const tagged =
          typeof msg === "object" && msg !== null
            ? { ...(msg as Record<string, unknown>), generation }
            : msg;
        if (transfer) worker.postMessage(tagged, transfer);
        else worker.postMessage(tagged);
      },
      (cid) => this.onChannelDisposed(cid),
      grid,
      altGrid,
      cursor,
      onFlush,
      onError,
    );

    this.channels.set(channelId, { workerIndex, generation, channel });
    this.workerChannelCounts[workerIndex]++;

    if (this.workerPaused[workerIndex]) {
      channel.setPoolPaused(true);
    }

    return channel;
  }

  releaseChannel(channelId: string): void {
    const entry = this.channels.get(channelId);
    if (!entry) return;

    // channel.dispose() calls onChannelDisposed which clears the entry.
    entry.channel.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const [, entry] of this.channels) {
      entry.channel.dispose();
    }
    this.channels.clear();
    this.channelGenerations.clear();

    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch {}
    }
    this.workers.length = 0;
    this.workerChannelCounts.length = 0;
    this.workerPendingBytes.length = 0;
    this.workerPaused.length = 0;
    this.deadWorkers.clear();
  }

  // ---- Internals ------------------------------------------------------------

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

  private sendWriteFromChannel(
    workerIndex: number,
    generation: number,
    channelId: string,
    buf: ArrayBuffer,
    byteLength: number,
  ): void {
    if (this.disposed || this.deadWorkers.has(workerIndex)) return;
    const worker = this.workers[workerIndex];
    if (!worker) return;
    worker.postMessage({ type: "write", channelId, generation, data: buf }, [buf]);

    this.workerPendingBytes[workerIndex] += byteLength;
    if (!this.workerPaused[workerIndex] && this.workerPendingBytes[workerIndex] >= HIGH_WATERMARK) {
      this.workerPaused[workerIndex] = true;
      for (const [, entry] of this.channels) {
        if (entry.workerIndex === workerIndex) entry.channel.setPoolPaused(true);
      }
    }
  }

  /** Called when a channel disposes itself — tracks any still-pending bytes
   *  so worker-level flow control stays correct as flushes arrive later. */
  private onChannelDisposed(channelId: string): void {
    const entry = this.channels.get(channelId);
    if (!entry) return;
    this.workerChannelCounts[entry.workerIndex]--;
    this.channels.delete(channelId);
    // Note: bytes in flight to the worker for this channel will still come
    // back as flushes. decrementWorkerPending handles that path for
    // channel-less flushes.
  }

  /** Decrement worker-level pendingBytes, unpausing if we cross LOW_WATERMARK.
   *  Called for EVERY flush, including stale / unknown / disposed channels,
   *  so the pause state never gets stuck. */
  private decrementWorkerPending(workerIndex: number, bytesProcessed: number): void {
    this.workerPendingBytes[workerIndex] = Math.max(
      0,
      this.workerPendingBytes[workerIndex] - bytesProcessed,
    );
    if (this.workerPaused[workerIndex] && this.workerPendingBytes[workerIndex] < LOW_WATERMARK) {
      this.workerPaused[workerIndex] = false;
      for (const [, entry] of this.channels) {
        if (entry.workerIndex === workerIndex) {
          entry.channel.setPoolPaused(false);
          entry.channel.drainQueue();
        }
      }
    }
  }

  private handleWorkerMessage(workerIndex: number, event: MessageEvent<OutboundMessage>): void {
    if (this.disposed) return;
    const msg = event.data;

    // Always reconcile flow control for flushes first, regardless of whether
    // the channel is still live. This is the invariant that prevents the
    // worker from getting stuck in a permanent pause when channels are
    // released with bytes in flight.
    if (msg.type === "flush" && typeof msg.bytesProcessed === "number") {
      this.decrementWorkerPending(workerIndex, msg.bytesProcessed);
    }

    const channelId = msg.channelId;
    if (!channelId) return;
    const entry = this.channels.get(channelId);
    if (!entry) return;

    // Drop stale messages from a prior lifecycle of this channelId.
    const gen = (msg as unknown as { generation?: number }).generation;
    if (typeof gen === "number" && gen !== entry.generation) return;
    // Also drop if somehow the entry was reassigned to a different worker.
    if (entry.workerIndex !== workerIndex) return;

    if (msg.type === "error") {
      entry.channel.handleError(msg.message);
    } else if (msg.type === "flush") {
      entry.channel.handleFlush(msg);
    }
  }

  private handleWorkerError(workerIndex: number, event: ErrorEvent): void {
    // Mark dead BEFORE forwarding errors so synchronous release callbacks
    // that read pool state see the correct worker as unavailable.
    this.deadWorkers.add(workerIndex);

    // Reset flow-control state for this worker — nothing more is coming
    // back from it, and channels that remain should not keep queueing.
    this.workerPendingBytes[workerIndex] = 0;
    this.workerPaused[workerIndex] = false;

    // Terminate the dead worker so it doesn't keep holding resources.
    try {
      this.workers[workerIndex]?.terminate();
    } catch {}

    for (const [, entry] of this.channels) {
      if (entry.workerIndex === workerIndex) {
        entry.channel.setPoolPaused(false);
        entry.channel.handleError(`Worker error: ${event.message}`);
      }
    }
  }
}
