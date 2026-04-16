/**
 * Parser Web Worker entry point.
 *
 * Runs the VTParser off the main thread.  When SharedArrayBuffer is available
 * the worker writes directly into the SAB that the main-thread renderer reads.
 * Otherwise it owns the buffer and transfers cell data back via Transferable
 * ArrayBuffers in the flush message.
 *
 * Supports multi-channel mode: when messages include a `channelId`, the worker
 * maintains independent parser/grid state per channel. This allows a pool of N
 * workers to serve many more terminal panes without thread oversubscription.
 * Messages without `channelId` use the legacy singleton path for backward compat.
 */

import { BufferSet, VTParser } from "@next_term/core";

// Type declaration for Web Worker global scope (not included in DOM lib)
declare type DedicatedWorkerGlobalScope = typeof globalThis & {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
};

// ---- Message types (worker ↔ main) ----------------------------------------

/** Messages the worker can receive from the main thread. */
interface InitMessage {
  type: "init";
  channelId?: string;
  cols: number;
  rows: number;
  scrollback: number;
  /** When SAB is available the main thread sends its normal buffer. */
  sharedBuffer?: SharedArrayBuffer;
  /** When SAB is available the main thread sends its alternate buffer. */
  sharedAltBuffer?: SharedArrayBuffer;
}

interface WriteMessage {
  type: "write";
  channelId?: string;
  data: ArrayBuffer; // Transferable
}

interface ResizeMessage {
  type: "resize";
  channelId?: string;
  cols: number;
  rows: number;
  scrollback: number;
  sharedBuffer?: SharedArrayBuffer;
  sharedAltBuffer?: SharedArrayBuffer;
  /** Cursor position after reflow (so parser continues at the right spot). */
  cursorRow?: number;
  cursorCol?: number;
  /** Reflowed grid data for non-SAB mode (so worker grid matches main thread). */
  reflowedCellData?: ArrayBuffer;
  reflowedWrapFlags?: ArrayBuffer;
}

interface DisposeMessage {
  type: "dispose";
  channelId?: string;
}

type InboundMessage = InitMessage | WriteMessage | ResizeMessage | DisposeMessage;

/** Messages the worker posts back to the main thread. */
export interface FlushMessage {
  type: "flush";
  channelId?: string;
  cursor: { row: number; col: number; visible: boolean; style: string };
  /** true when the parser switched to or from the alternate buffer. */
  isAlternate: boolean;
  /** Number of bytes that were processed in the write that triggered this flush. */
  bytesProcessed: number;
  /** Parser mode state — synced to main thread so getParserModes() works. */
  modes: {
    applicationCursorKeys: boolean;
    bracketedPasteMode: boolean;
    mouseProtocol: "none" | "x10" | "vt200" | "drag" | "any";
    mouseEncoding: "default" | "sgr";
    sendFocusEvents: boolean;
    kittyFlags: number;
    syncedOutput: boolean;
  };
  // ---- non-SAB fallback only ----
  /** Full cell data (Transferable). Only present in non-SAB mode. */
  cellData?: ArrayBuffer;
  /** Dirty-row flags (Transferable). Only present in non-SAB mode. */
  dirtyRows?: ArrayBuffer;
  /** Wrap flags per row (Transferable). Only present in non-SAB mode. */
  wrapFlags?: ArrayBuffer;
  /** Circular buffer row offset. Only present in non-SAB mode. */
  rowOffset?: number;
}

export interface ErrorMessage {
  type: "error";
  channelId?: string;
  message: string;
}

export type OutboundMessage = FlushMessage | ErrorMessage;

// ---- Worker state ----------------------------------------------------------

/** Per-channel state for multi-channel mode. */
interface ChannelState {
  bufferSet: BufferSet;
  parser: VTParser;
  usingSAB: boolean;
  /** Pending write buffers queued for round-robin draining. */
  writeQueue: ArrayBuffer[];
}

/** Multi-channel state. */
const channels = new Map<string, ChannelState>();

/** Set to true when a round-robin drain is already scheduled. */
let drainScheduled = false;

/** Legacy singleton state (messages without channelId). */
let bufferSet: BufferSet | null = null;
let parser: VTParser | null = null;
let usingSAB = false;

// ---- Helpers ---------------------------------------------------------------

function createBufferAndParser(
  cols: number,
  rows: number,
  scrollback: number,
  sharedBuffer?: SharedArrayBuffer,
  sharedAltBuffer?: SharedArrayBuffer,
): ChannelState {
  const bs = new BufferSet(cols, rows, scrollback, sharedBuffer, sharedAltBuffer);
  const p = new VTParser(bs);
  return {
    bufferSet: bs,
    parser: p,
    usingSAB: sharedBuffer !== undefined,
    writeQueue: [],
  };
}

function buildFlush(ch: ChannelState, bytesProcessed: number, channelId?: string): FlushMessage {
  const cursor = ch.parser.cursor;

  const msg: FlushMessage = {
    type: "flush",
    channelId,
    cursor: {
      row: cursor.row,
      col: cursor.col,
      visible: cursor.visible,
      style: cursor.style,
    },
    isAlternate: ch.bufferSet.isAlternate,
    bytesProcessed,
    modes: {
      applicationCursorKeys: ch.parser.applicationCursorKeys,
      bracketedPasteMode: ch.parser.bracketedPasteMode,
      mouseProtocol: ch.parser.mouseProtocol,
      mouseEncoding: ch.parser.mouseEncoding,
      sendFocusEvents: ch.parser.sendFocusEvents,
      kittyFlags: ch.parser.kittyFlags,
      syncedOutput: ch.parser.syncedOutput,
    },
  };

  if (!ch.usingSAB) {
    // Transfer cell data, dirty flags, and wrap flags to the main thread.
    const grid = ch.bufferSet.active.grid;
    const cellCopy = grid.data.slice().buffer;
    const dirtyCopy = grid.dirtyRows.slice().buffer;
    const wrapCopy = grid.wrapFlags.slice().buffer;
    msg.cellData = cellCopy;
    msg.dirtyRows = dirtyCopy;
    msg.wrapFlags = wrapCopy;
    msg.rowOffset = grid.rowOffsetData[0];
  }

  return msg;
}

function postFlush(flush: FlushMessage, usingSABMode: boolean): void {
  if (usingSABMode) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(flush);
  } else {
    const transferables: ArrayBuffer[] = [];
    if (flush.cellData) transferables.push(flush.cellData);
    if (flush.dirtyRows) transferables.push(flush.dirtyRows);
    if (flush.wrapFlags) transferables.push(flush.wrapFlags);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(flush, transferables);
  }
}

// ---- Message handler -------------------------------------------------------

function handleMessage(msg: InboundMessage): void {
  const channelId = msg.channelId;

  // Multi-channel path: route by channelId
  if (channelId !== undefined) {
    handleChannelMessage(msg, channelId);
    return;
  }

  // Legacy singleton path (backward compat)
  switch (msg.type) {
    case "init": {
      // Set usingSAB before creating buffers — if BufferSet throws (e.g.
      // undersized SAB), the flag must still reflect the intent so writes
      // against the previous bufferSet use the correct flush mode.
      usingSAB = msg.sharedBuffer !== undefined;
      const ch = createBufferAndParser(
        msg.cols,
        msg.rows,
        msg.scrollback,
        msg.sharedBuffer,
        msg.sharedAltBuffer,
      );
      bufferSet = ch.bufferSet;
      parser = ch.parser;
      break;
    }

    case "write": {
      if (!parser || !bufferSet) {
        postError("Worker not initialised — ignoring write");
        return;
      }
      const bytes = new Uint8Array(msg.data);
      parser.write(bytes);
      const flush = buildFlush({ bufferSet, parser, usingSAB }, bytes.length);
      postFlush(flush, usingSAB);
      break;
    }

    case "resize": {
      const ch = createBufferAndParser(
        msg.cols,
        msg.rows,
        msg.scrollback,
        msg.sharedBuffer,
        msg.sharedAltBuffer,
      );
      bufferSet = ch.bufferSet;
      parser = ch.parser;
      usingSAB = ch.usingSAB;
      if (parser && bufferSet && msg.cursorRow != null && msg.cursorCol != null) {
        parser.cursor.row = Math.max(0, Math.min(msg.cursorRow, msg.rows - 1));
        parser.cursor.col = Math.max(0, Math.min(msg.cursorCol, msg.cols - 1));
      }
      if (!usingSAB && bufferSet && msg.reflowedCellData && msg.reflowedWrapFlags) {
        const grid = bufferSet.active.grid;
        const cellView = new Uint32Array(msg.reflowedCellData);
        if (cellView.length === grid.data.length) {
          grid.data.set(cellView);
        }
        const wrapView = new Int32Array(msg.reflowedWrapFlags);
        if (wrapView.length === grid.wrapFlags.length) {
          grid.wrapFlags.set(wrapView);
        }
        grid.markAllDirty();
      }
      const flush = buildFlush({ bufferSet, parser, usingSAB }, 0);
      postFlush(flush, usingSAB);
      break;
    }

    case "dispose": {
      bufferSet = null;
      parser = null;
      // Close the worker — it cannot be reused (legacy single-channel mode).
      (self as unknown as DedicatedWorkerGlobalScope).close();
      break;
    }
  }
}

function handleChannelMessage(msg: InboundMessage, channelId: string): void {
  switch (msg.type) {
    case "init": {
      const ch = createBufferAndParser(
        msg.cols,
        msg.rows,
        msg.scrollback,
        msg.sharedBuffer,
        msg.sharedAltBuffer,
      );
      channels.set(channelId, ch);
      break;
    }

    case "write": {
      const ch = channels.get(channelId);
      if (!ch) {
        postError(`Channel "${channelId}" not initialised — ignoring write`, channelId);
        return;
      }
      // Enqueue for round-robin draining so one channel's burst doesn't
      // head-of-line block other channels sharing this worker.
      ch.writeQueue.push(msg.data);
      scheduleDrain();
      break;
    }

    case "resize": {
      const newCh = createBufferAndParser(
        msg.cols,
        msg.rows,
        msg.scrollback,
        msg.sharedBuffer,
        msg.sharedAltBuffer,
      );
      channels.set(channelId, newCh);
      if (msg.cursorRow != null && msg.cursorCol != null) {
        newCh.parser.cursor.row = Math.max(0, Math.min(msg.cursorRow, msg.rows - 1));
        newCh.parser.cursor.col = Math.max(0, Math.min(msg.cursorCol, msg.cols - 1));
      }
      if (!newCh.usingSAB && msg.reflowedCellData && msg.reflowedWrapFlags) {
        const grid = newCh.bufferSet.active.grid;
        const cellView = new Uint32Array(msg.reflowedCellData);
        if (cellView.length === grid.data.length) {
          grid.data.set(cellView);
        }
        const wrapView = new Int32Array(msg.reflowedWrapFlags);
        if (wrapView.length === grid.wrapFlags.length) {
          grid.wrapFlags.set(wrapView);
        }
        grid.markAllDirty();
      }
      const flush = buildFlush(newCh, 0, channelId);
      postFlush(flush, newCh.usingSAB);
      break;
    }

    case "dispose": {
      const existing = channels.get(channelId);
      if (existing) existing.writeQueue.length = 0;
      channels.delete(channelId);
      // Do NOT close the worker — other channels may still be active.
      break;
    }
  }
}

function postError(message: string, channelId?: string): void {
  const err: ErrorMessage = { type: "error", channelId, message };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(err);
}

/**
 * Schedule a round-robin drain of all channels' write queues. Fairness
 * (no head-of-line blocking across channels) requires processing one
 * chunk from each channel per cycle rather than FIFO across channels.
 *
 * The microtask defers draining until the current message event finishes,
 * which lets multiple writes from different channels accumulate so the
 * round-robin has something to fair-share.
 */
function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  queueMicrotask(drainChannelWrites);
}

function drainChannelWrites(): void {
  drainScheduled = false;
  // Round-robin: one chunk per channel per cycle, repeat until all empty.
  let hadWork = true;
  while (hadWork) {
    hadWork = false;
    for (const [channelId, ch] of channels) {
      const buf = ch.writeQueue.shift();
      if (!buf) continue;
      hadWork = true;
      try {
        const bytes = new Uint8Array(buf);
        ch.parser.write(bytes);
        const flush = buildFlush(ch, bytes.length, channelId);
        postFlush(flush, ch.usingSAB);
      } catch (e: unknown) {
        postError(e instanceof Error ? e.message : "Parser error", channelId);
      }
    }
  }
}

// ---- Bootstrap -------------------------------------------------------------

(self as unknown as DedicatedWorkerGlobalScope).addEventListener(
  "message",
  (event: MessageEvent<InboundMessage>) => {
    try {
      handleMessage(event.data);
    } catch (e: unknown) {
      postError(e instanceof Error ? e.message : "Internal parser error", event.data?.channelId);
    }
  },
);
