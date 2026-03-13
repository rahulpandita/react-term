import type { Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

/** Dense 256-color SGR: \x1b[38;5;Nm + one char per cell. */
export function sgrColor(): Scenario {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (total < SIZE) {
    const colorIdx = total % 256;
    const seq = encoder.encode(`\x1b[38;5;${colorIdx}mX`);
    chunks.push(seq);
    total += seq.length;
  }

  // Use exact accumulated size (no truncation mid-sequence)
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return { name: "sgr-color", data };
}
