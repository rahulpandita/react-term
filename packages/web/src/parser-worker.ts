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
  /** Monotonic per-channelId — echoed back on flushes so the pool can drop
   *  stale messages from a previous lifecycle. */
  generation?: number;
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
  generation?: number;
  data: ArrayBuffer; // Transferable
}

interface ResizeMessage {
  type: "resize";
  channelId?: string;
  generation?: number;
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
  generation?: number;
}

/**
 * Seeds the worker's parser/buffer state from a previously serialized
 * snapshot. Applied WITHOUT a flush so the hydrated cursor/modes/active-buffer
 * aren't clobbered when the next `write` produces the first real flush.
 *
 * Grid `cellData` and `wrapFlags` are OPTIONAL. Omit them when the main
 * thread has already applied cells directly to the SAB (constructor
 * initialState path, where the worker hasn't started yet and can't race).
 * Include them when applying post-construction in worker mode, so the grid
 * write is serialized in the worker's message queue behind any pending
 * `write`s — otherwise concurrent main-thread and worker writes would race
 * against the shared buffer.
 */
interface SeedMessage {
  type: "seed";
  channelId?: string;
  generation?: number;
  cursor: { row: number; col: number; visible: boolean; style: string };
  isAlternate: boolean;
  modes: {
    applicationCursorKeys: boolean;
    bracketedPasteMode: boolean;
    mouseProtocol: "none" | "x10" | "vt200" | "drag" | "any";
    mouseEncoding: "default" | "sgr";
    sendFocusEvents: boolean;
  };
  /** Full-format active-grid cell data (Transferable). */
  cellData?: ArrayBuffer;
  /** Per-row wrap flags as Int32 (Transferable). */
  wrapFlags?: ArrayBuffer;
}

type InboundMessage = InitMessage | WriteMessage | ResizeMessage | DisposeMessage | SeedMessage;

/** Messages the worker posts back to the main thread. */
export interface FlushMessage {
  type: "flush";
  channelId?: string;
  /** Echoed from the init that created the channel. Pool uses this to
   *  drop stale flushes after channelId reuse on the same worker. */
  generation?: number;
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
  generation?: number;
  message: string;
}

export type OutboundMessage = FlushMessage | ErrorMessage;

// ---- Worker state ----------------------------------------------------------

/** Per-channel state for multi-channel mode. */
interface ChannelState {
  bufferSet: BufferSet;
  parser: VTParser;
  usingSAB: boolean;
  /** Stored from init; echoed on every outbound flush/error for this channel. */
  generation: number | undefined;
}

/** Multi-channel state. */
const channels = new Map<string, ChannelState>();

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
  generation?: number,
): ChannelState {
  const bs = new BufferSet(cols, rows, scrollback, sharedBuffer, sharedAltBuffer);
  const p = new VTParser(bs);
  return {
    bufferSet: bs,
    parser: p,
    usingSAB: sharedBuffer !== undefined,
    generation,
  };
}

/**
 * Apply a hydrated snapshot to an existing channel without producing a flush.
 * Seeds cursor, parser modes, and active buffer — and, if supplied, the grid
 * cell data. Running in the worker's single-threaded message loop means any
 * pending `write` completes before this applies, so grid writes can't race.
 */
function applySeed(ch: ChannelState, msg: SeedMessage): void {
  const active = msg.isAlternate ? ch.bufferSet.alternate : ch.bufferSet.normal;
  ch.bufferSet.setActive(msg.isAlternate);

  // Grid payload (optional). Applied to the now-active grid.
  if (msg.cellData) {
    const grid = active.grid;
    const cellView = new Uint32Array(msg.cellData);
    if (cellView.length === grid.data.length) {
      grid.rowOffsetData[0] = 0;
      grid.data.set(cellView);
      if (msg.wrapFlags) {
        const wrapView = new Int32Array(msg.wrapFlags);
        if (wrapView.length === grid.wrapFlags.length) {
          grid.wrapFlags.set(wrapView);
        }
      }
      grid.markAllDirty();
    }
  }

  active.cursor.row = Math.max(0, Math.min(msg.cursor.row, ch.bufferSet.rows - 1));
  active.cursor.col = Math.max(0, Math.min(msg.cursor.col, ch.bufferSet.cols - 1));
  active.cursor.visible = msg.cursor.visible;
  active.cursor.style = msg.cursor.style as "block" | "underline" | "bar";
  active.cursor.wrapPending = false;
  active.grid.setCursor(
    active.cursor.row,
    active.cursor.col,
    active.cursor.visible,
    active.cursor.style,
  );
  ch.parser.applicationCursorKeys = msg.modes.applicationCursorKeys;
  ch.parser.bracketedPasteMode = msg.modes.bracketedPasteMode;
  ch.parser.mouseProtocol = msg.modes.mouseProtocol;
  ch.parser.mouseEncoding = msg.modes.mouseEncoding;
  ch.parser.sendFocusEvents = msg.modes.sendFocusEvents;
}

function buildFlush(ch: ChannelState, bytesProcessed: number, channelId?: string): FlushMessage {
  const cursor = ch.parser.cursor;

  const msg: FlushMessage = {
    type: "flush",
    channelId,
    generation: ch.generation,
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
      const flush = buildFlush(
        { bufferSet, parser, usingSAB, generation: undefined },
        bytes.length,
      );
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
      const flush = buildFlush({ bufferSet, parser, usingSAB, generation: undefined }, 0);
      postFlush(flush, usingSAB);
      break;
    }

    case "seed": {
      if (!parser || !bufferSet) {
        postError("Worker not initialised — ignoring seed");
        return;
      }
      const ch = { bufferSet, parser, usingSAB, generation: undefined };
      applySeed(ch, msg);
      // Post a flush so:
      //   - non-SAB mode: worker-owned cell data reaches the main-thread grid
      //   - any pre-seed write flushes are naturally superseded (this flush
      //     arrives after them in FIFO order and carries post-seed state)
      const flush = buildFlush(ch, 0);
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
        msg.generation,
      );
      channels.set(channelId, ch);
      break;
    }

    case "write": {
      const ch = channels.get(channelId);
      if (!ch) {
        postError(
          `Channel "${channelId}" not initialised — ignoring write`,
          channelId,
          msg.generation,
        );
        return;
      }
      // Drop writes whose generation doesn't match the channel's current
      // lifecycle — these are from a prior acquire that was disposed.
      if (msg.generation !== undefined && msg.generation !== ch.generation) return;
      const bytes = new Uint8Array(msg.data);
      ch.parser.write(bytes);
      const flush = buildFlush(ch, bytes.length, channelId);
      postFlush(flush, ch.usingSAB);
      break;
    }

    case "resize": {
      const existing = channels.get(channelId);
      // Drop stale resize from a prior lifecycle.
      if (existing && msg.generation !== undefined && msg.generation !== existing.generation) {
        return;
      }
      const newCh = createBufferAndParser(
        msg.cols,
        msg.rows,
        msg.scrollback,
        msg.sharedBuffer,
        msg.sharedAltBuffer,
        msg.generation ?? existing?.generation,
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

    case "seed": {
      const ch = channels.get(channelId);
      if (!ch) {
        postError(
          `Channel "${channelId}" not initialised — ignoring seed`,
          channelId,
          msg.generation,
        );
        return;
      }
      if (msg.generation !== undefined && msg.generation !== ch.generation) return;
      applySeed(ch, msg);
      // Flush so non-SAB cell data reaches main and any in-flight pre-seed
      // write flushes get naturally superseded (FIFO convergence).
      const flush = buildFlush(ch, 0, channelId);
      postFlush(flush, ch.usingSAB);
      break;
    }

    case "dispose": {
      const existing = channels.get(channelId);
      // Drop stale dispose from a prior lifecycle — the newer init has
      // already taken over this channelId. (This can happen if the main
      // thread re-acquires while the prior dispose is still in flight.)
      if (existing && msg.generation !== undefined && msg.generation !== existing.generation) {
        return;
      }
      channels.delete(channelId);
      // Do NOT close the worker — other channels may still be active.
      break;
    }
  }
}

function postError(message: string, channelId?: string, generation?: number): void {
  const err: ErrorMessage = { type: "error", channelId, generation, message };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(err);
}

// ---- Bootstrap -------------------------------------------------------------

(self as unknown as DedicatedWorkerGlobalScope).addEventListener(
  "message",
  (event: MessageEvent<InboundMessage>) => {
    try {
      handleMessage(event.data);
    } catch (e: unknown) {
      postError(
        e instanceof Error ? e.message : "Internal parser error",
        event.data?.channelId,
        event.data?.generation,
      );
    }
  },
);
