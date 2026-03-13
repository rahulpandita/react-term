/**
 * CPU profiling script for react-term parser throughput.
 *
 * Run from the packages/bench/ directory:
 *   pnpm profile
 *
 * Or from the repo root:
 *   pnpm --filter @react-term/bench profile
 *
 * This generates .cpuprofile files in packages/bench/profiles/ that
 * can be opened in Chrome DevTools (Performance tab) or VS Code.
 */
import { BufferSet, VTParser } from "@react-term/core";

const SIZE = 5 * 1024 * 1024;

// Scenario generators (inline to avoid import resolution issues)
function makeAscii(): Uint8Array {
  const data = new Uint8Array(SIZE);
  data.fill(0x61);
  return data;
}

function makeScrolling(): Uint8Array {
  const line = new Uint8Array(80);
  line.fill(0x61);
  line[79] = 0x0a;
  const count = Math.floor(SIZE / 80);
  const data = new Uint8Array(count * 80);
  for (let i = 0; i < count; i++) data.set(line, i * 80);
  return data;
}

function makeRealWorld(): Uint8Array {
  const encoder = new TextEncoder();
  const lines = [
    "\x1b[0m\x1b[01;34mdrwxr-xr-x\x1b[0m  5 user staff  160 Mar 10 14:30 \x1b[01;34msrc\x1b[0m\n",
    "\x1b[0m-rw-r--r--  1 user staff 4096 Mar 10 14:30 \x1b[00mpackage.json\x1b[0m\n",
    "\x1b[38;5;208m-rw-r--r--\x1b[0m  1 user staff 2048 Mar 10 14:30 \x1b[38;5;208mREADME.md\x1b[0m\n",
    "\x1b[0mtotal 42\n",
    "\n",
  ];
  const combined = encoder.encode(lines.join(""));
  const count = Math.floor(SIZE / combined.length);
  const data = new Uint8Array(count * combined.length);
  for (let i = 0; i < count; i++) data.set(combined, i * combined.length);
  return data;
}

const scenarios = [
  { name: "ascii", data: makeAscii() },
  { name: "scrolling", data: makeScrolling() },
  { name: "real-world", data: makeRealWorld() },
];

for (const { name, data } of scenarios) {
  const bufferSet = new BufferSet(80, 24, 0);
  const parser = new VTParser(bufferSet);

  const start = performance.now();
  parser.write(data);
  const elapsed = performance.now() - start;

  const mbps = (data.length / 1024 / 1024 / (elapsed / 1000)).toFixed(2);
  console.log(`${name}: ${elapsed.toFixed(1)}ms (${mbps} MB/s)`);
}
