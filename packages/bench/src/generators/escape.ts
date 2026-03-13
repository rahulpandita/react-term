import { fillAligned, type Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

/** ESC E (NEL) — matches xterm's ESCAPE benchmark. */
export function escapeSimple(): Scenario {
  const seq = new Uint8Array([0x1b, 0x45]); // ESC E
  return { name: "esc-simple", data: fillAligned(seq, SIZE) };
}

/** ESC % G — ESC with intermediate collection. Matches xterm's "ESCAPE with collect". */
export function escapeCollect(): Scenario {
  const seq = new TextEncoder().encode("\x1b%G");
  return { name: "esc-collect", data: fillAligned(seq, SIZE) };
}
