import type { Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

export function ascii(): Scenario {
  const data = new Uint8Array(SIZE);
  data.fill(0x61); // 'a'
  return { name: "ascii", data };
}
