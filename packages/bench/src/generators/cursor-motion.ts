import type { Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

/** Grid cursor addressing: \x1b[r;cH + char, cycling through 24x80 grid. */
export function cursorMotion(): Scenario {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;

  let row = 1;
  let col = 1;
  while (total < SIZE) {
    const seq = encoder.encode(`\x1b[${row};${col}HX`);
    chunks.push(seq);
    total += seq.length;
    col++;
    if (col > 80) {
      col = 1;
      row++;
      if (row > 24) row = 1;
    }
  }

  // Use exact accumulated size (no truncation mid-sequence)
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return { name: "cursor-motion", data };
}
