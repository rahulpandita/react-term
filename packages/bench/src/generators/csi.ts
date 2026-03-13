import { fillAligned, type Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

/** CSI A (cursor up) — matches xterm's "CSI - CSI A". */
export function csiSimple(): Scenario {
  const seq = new Uint8Array([0x1b, 0x5b, 0x41]); // \x1b[A
  return { name: "csi-simple", data: fillAligned(seq, SIZE) };
}

/** CSI ? p — CSI with private prefix. Matches xterm's "CSI with collect". */
export function csiCollect(): Scenario {
  const seq = new TextEncoder().encode("\x1b[?p");
  return { name: "csi-collect", data: fillAligned(seq, SIZE) };
}

/** CSI 1;2 m — matches xterm's "CSI with params (short)". */
export function csiParams(): Scenario {
  const seq = new TextEncoder().encode("\x1b[1;2m");
  return { name: "csi-params", data: fillAligned(seq, SIZE) };
}

/** CSI 1;2;3;4;5;6;7;8;9;0 m — matches xterm's "CSI with params (long)". */
export function csiLongParams(): Scenario {
  const seq = new TextEncoder().encode("\x1b[1;2;3;4;5;6;7;8;9;0m");
  return { name: "csi-long-params", data: fillAligned(seq, SIZE) };
}
