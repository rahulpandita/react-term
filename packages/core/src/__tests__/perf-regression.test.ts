import { describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";

/**
 * Performance regression tests.
 *
 * These tests ensure parser throughput doesn't drop below minimum thresholds.
 * Thresholds are set conservatively (well below typical throughput) to avoid
 * flaky failures on slow CI machines while still catching major regressions
 * like the copyRow-per-scroll issue (~5 MB/s before fix, ~35 MB/s after).
 *
 * Typical throughput on modern hardware:
 *   ascii:      ~35 MB/s
 *   scrolling:  ~23 MB/s
 *   real-world: ~21 MB/s
 *
 * Thresholds are set at ~30-50% of typical to allow for CI variability.
 */

const PAYLOAD_SIZE = 1 * 1024 * 1024; // 1 MB (smaller than bench to keep tests fast)

function makeAsciiPayload(): Uint8Array {
  const data = new Uint8Array(PAYLOAD_SIZE);
  data.fill(0x61); // 'a'
  return data;
}

function makeScrollingPayload(): Uint8Array {
  const lineLen = 80;
  const line = new Uint8Array(lineLen);
  line.fill(0x61);
  line[lineLen - 1] = 0x0a; // newline
  const count = Math.floor(PAYLOAD_SIZE / lineLen);
  const data = new Uint8Array(count * lineLen);
  for (let i = 0; i < count; i++) data.set(line, i * lineLen);
  return data;
}

function makeRealWorldPayload(): Uint8Array {
  const encoder = new TextEncoder();
  const lines = [
    "\x1b[0m\x1b[01;34mdrwxr-xr-x\x1b[0m  5 user staff  160 Mar 10 14:30 \x1b[01;34msrc\x1b[0m\n",
    "\x1b[0m-rw-r--r--  1 user staff 4096 Mar 10 14:30 \x1b[00mpackage.json\x1b[0m\n",
    "\x1b[38;5;208m-rw-r--r--\x1b[0m  1 user staff 2048 Mar 10 14:30 \x1b[38;5;208mREADME.md\x1b[0m\n",
  ];
  const sample = encoder.encode(lines.join(""));
  const count = Math.floor(PAYLOAD_SIZE / sample.length);
  const data = new Uint8Array(count * sample.length);
  for (let i = 0; i < count; i++) data.set(sample, i * sample.length);
  return data;
}

function measureThroughput(data: Uint8Array): number {
  const bufferSet = new BufferSet(80, 24, 0);
  const parser = new VTParser(bufferSet);

  const start = performance.now();
  parser.write(data);
  const elapsed = performance.now() - start;

  return data.length / 1024 / 1024 / (elapsed / 1000); // MB/s
}

describe("parser throughput regression", () => {
  // Warm up JIT before measuring
  const warmup = new Uint8Array(1024);
  warmup.fill(0x61);
  const warmupBuf = new BufferSet(80, 24, 0);
  const warmupParser = new VTParser(warmupBuf);
  warmupParser.write(warmup);

  it("ascii throughput >= 10 MB/s", () => {
    const data = makeAsciiPayload();
    const mbps = measureThroughput(data);
    expect(mbps).toBeGreaterThan(10);
  });

  it("scrolling throughput >= 5 MB/s", () => {
    const data = makeScrollingPayload();
    const mbps = measureThroughput(data);
    expect(mbps).toBeGreaterThan(5);
  });

  it("real-world (ANSI color output) throughput >= 5 MB/s", () => {
    const data = makeRealWorldPayload();
    const mbps = measureThroughput(data);
    expect(mbps).toBeGreaterThan(5);
  });
});
