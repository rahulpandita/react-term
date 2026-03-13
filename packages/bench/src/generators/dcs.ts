import { fillAligned, type Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

/** Short DCS: DCS p hi ST — matches xterm's "DCS string interface (short seq)". */
export function dcsShort(): Scenario {
  const seq = new TextEncoder().encode("\x1bPphi\x1b\\");
  return { name: "dcs-short", data: fillAligned(seq, SIZE) };
}

/** Long DCS: DCS p <text> ST — matches xterm's "DCS string interface (long seq)". */
export function dcsLong(): Scenario {
  const seq = new TextEncoder().encode(
    "\x1bPpLorem ipsum dolor sit amet, consetetur sadipscing elitr.\x1b\\",
  );
  return { name: "dcs-long", data: fillAligned(seq, SIZE) };
}
