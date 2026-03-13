import type { Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

/** Pure execute throughput — matches xterm's EXECUTE benchmark. */
export function execute(): Scenario {
  const data = new Uint8Array(SIZE);
  data.fill(0x0a); // '\n'
  return { name: "execute-lf", data };
}

/** Scroll-heavy: 79 printable chars + LF per line. */
export function scrolling(): Scenario {
  const line = new Uint8Array(80);
  line.fill(0x61); // 'a'
  line[79] = 0x0a; // '\n'

  const count = Math.floor(SIZE / line.length);
  const data = new Uint8Array(count * line.length);
  for (let i = 0; i < count; i++) {
    data.set(line, i * line.length);
  }
  return { name: "scrolling", data };
}
