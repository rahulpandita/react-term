/**
 * Parser Web Worker entry point.
 *
 * Runs the VTParser off the main thread.  When SharedArrayBuffer is available
 * the worker writes directly into the SAB that the main-thread renderer reads.
 * Otherwise it owns the buffer and transfers cell data back via Transferable
 * ArrayBuffers in the flush message.
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
  data: ArrayBuffer; // Transferable
}

interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
  scrollback: number;
  sharedBuffer?: SharedArrayBuffer;
  sharedAltBuffer?: SharedArrayBuffer;
}

interface DisposeMessage {
  type: "dispose";
}

type InboundMessage = InitMessage | WriteMessage | ResizeMessage | DisposeMessage;

/** Messages the worker posts back to the main thread. */
export interface FlushMessage {
  type: "flush";
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
  };
  // ---- non-SAB fallback only ----
  /** Full cell data (Transferable). Only present in non-SAB mode. */
  cellData?: ArrayBuffer;
  /** Dirty-row flags (Transferable). Only present in non-SAB mode. */
  dirtyRows?: ArrayBuffer;
  /** Circular buffer row offset. Only present in non-SAB mode. */
  rowOffset?: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type OutboundMessage = FlushMessage | ErrorMessage;

// ---- Worker state ----------------------------------------------------------

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
): void {
  bufferSet = new BufferSet(cols, rows, scrollback, sharedBuffer, sharedAltBuffer);
  parser = new VTParser(bufferSet);
}

function buildFlush(bytesProcessed: number): FlushMessage {
  if (!bufferSet || !parser) {
    throw new Error("Worker not initialised");
  }

  const cursor = parser.cursor;

  const msg: FlushMessage = {
    type: "flush",
    cursor: {
      row: cursor.row,
      col: cursor.col,
      visible: cursor.visible,
      style: cursor.style,
    },
    isAlternate: bufferSet.isAlternate,
    bytesProcessed,
    modes: {
      applicationCursorKeys: parser.applicationCursorKeys,
      bracketedPasteMode: parser.bracketedPasteMode,
      mouseProtocol: parser.mouseProtocol,
      mouseEncoding: parser.mouseEncoding,
      sendFocusEvents: parser.sendFocusEvents,
    },
  };

  if (!usingSAB) {
    // Transfer cell data and dirty flags to the main thread.
    const grid = bufferSet.active.grid;
    const cellCopy = grid.data.slice().buffer;
    const dirtyCopy = grid.dirtyRows.slice().buffer;
    msg.cellData = cellCopy;
    msg.dirtyRows = dirtyCopy;
    msg.rowOffset = grid.rowOffsetData[0];
  }

  return msg;
}

// ---- Message handler -------------------------------------------------------

function handleMessage(msg: InboundMessage): void {
  switch (msg.type) {
    case "init": {
      usingSAB = msg.sharedBuffer !== undefined;
      createBufferAndParser(
        msg.cols,
        msg.rows,
        msg.scrollback,
        msg.sharedBuffer,
        msg.sharedAltBuffer,
      );
      break;
    }

    case "write": {
      if (!parser) {
        postError("Worker not initialised — ignoring write");
        return;
      }
      const bytes = new Uint8Array(msg.data);
      parser.write(bytes);
      const flush = buildFlush(bytes.length);

      if (usingSAB) {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage(flush);
      } else {
        // Transfer the ArrayBuffers so they are zero-copy.
        const transferables: ArrayBuffer[] = [];
        if (flush.cellData) transferables.push(flush.cellData);
        if (flush.dirtyRows) transferables.push(flush.dirtyRows);
        (self as unknown as DedicatedWorkerGlobalScope).postMessage(flush, transferables);
      }
      break;
    }

    case "resize": {
      createBufferAndParser(
        msg.cols,
        msg.rows,
        msg.scrollback,
        msg.sharedBuffer,
        msg.sharedAltBuffer,
      );
      // Send a full flush so the main thread gets initial state.
      const flush = buildFlush(0);
      if (!usingSAB) {
        const transferables: ArrayBuffer[] = [];
        if (flush.cellData) transferables.push(flush.cellData);
        if (flush.dirtyRows) transferables.push(flush.dirtyRows);
        (self as unknown as DedicatedWorkerGlobalScope).postMessage(flush, transferables);
      } else {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage(flush);
      }
      break;
    }

    case "dispose": {
      bufferSet = null;
      parser = null;
      // Close the worker — it cannot be reused.
      (self as unknown as DedicatedWorkerGlobalScope).close();
      break;
    }
  }
}

function postError(message: string): void {
  const err: ErrorMessage = { type: "error", message };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(err);
}

// ---- Bootstrap -------------------------------------------------------------

(self as unknown as DedicatedWorkerGlobalScope).addEventListener(
  "message",
  (event: MessageEvent<InboundMessage>) => {
    try {
      handleMessage(event.data);
    } catch (e: unknown) {
      postError(e instanceof Error ? e.message : "Internal parser error");
    }
  },
);
