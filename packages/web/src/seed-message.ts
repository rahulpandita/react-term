/**
 * SeedMessage type + helper, split out of `parser-worker.ts` so the
 * main-thread bridges (`worker-bridge.ts`, `parser-pool.ts`) can import the
 * builder without dragging the worker's `self`-referencing bootstrap into
 * non-worker contexts (tests / Node / SSR).
 */

import type { ParserModeState } from "@next_term/core";

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
export interface SeedMessage {
  type: "seed";
  channelId?: string;
  generation?: number;
  cursor: {
    row: number;
    col: number;
    visible: boolean;
    style: "block" | "underline" | "bar";
  };
  isAlternate: boolean;
  modes: ParserModeState;
  /** Full-format active-grid cell data (Transferable). */
  cellData?: ArrayBuffer;
  /** Per-row wrap flags as Int32 (Transferable). */
  wrapFlags?: ArrayBuffer;
}

/** Cursor fragment carried in seed messages. Same shape on both sides. */
export type SeedCursor = SeedMessage["cursor"];

/**
 * Build a `SeedMessage` plus its transferable list. Shared between
 * `WorkerBridge.seed` and `ParserChannel.seed` so the two bridges produce
 * byte-identical messages and the transferable bookkeeping lives in one place.
 *
 * `channelId` is included only when supplied (pool path); the single-bridge
 * path omits the field so the message shape matches the legacy expectation.
 */
export function buildSeedMessage(
  cursor: SeedCursor,
  isAlternate: boolean,
  modes: ParserModeState,
  cellData?: ArrayBuffer,
  wrapFlags?: ArrayBuffer,
  channelId?: string,
): { msg: SeedMessage; transferables: ArrayBuffer[] } {
  const msg: SeedMessage = { type: "seed", cursor, isAlternate, modes };
  if (channelId !== undefined) msg.channelId = channelId;
  const transferables: ArrayBuffer[] = [];
  if (cellData) {
    msg.cellData = cellData;
    transferables.push(cellData);
  }
  if (wrapFlags) {
    msg.wrapFlags = wrapFlags;
    transferables.push(wrapFlags);
  }
  return { msg, transferables };
}
