import { fillAligned, type Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

/** Short OSC: OSC 0;hi ST — matches xterm's "OSC string interface (short seq)". */
export function oscShort(): Scenario {
  const seq = new TextEncoder().encode("\x1b]0;hi\x1b\\");
  return { name: "osc-short", data: fillAligned(seq, SIZE) };
}

/** Long OSC: OSC 0;<text> ST — matches xterm's "OSC string interface (long seq)". */
export function oscLong(): Scenario {
  const seq = new TextEncoder().encode(
    "\x1b]0;Lorem ipsum dolor sit amet, consetetur sadipscing elitr.\x1b\\",
  );
  return { name: "osc-long", data: fillAligned(seq, SIZE) };
}
