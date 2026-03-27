import { beforeEach, describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";
import { write } from "./helpers.js";

describe("Kitty keyboard flags (kitty-flags)", () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
    parser = new VTParser(bs);
  });

  it("kittyFlags property starts at 0", () => {
    expect(parser.kittyFlags).toBe(0);
  });

  it("CSI = flags u sets keyboard flags (mode 1 = set)", () => {
    write(parser, "\x1b[=1u");
    expect(parser.kittyFlags).toBe(1);
  });

  it("CSI = flags u without mode param defaults to set (mode 1)", () => {
    write(parser, "\x1b[=3u");
    expect(parser.kittyFlags).toBe(3);
  });

  it("CSI = flags ; 2 u ORs keyboard flags", () => {
    write(parser, "\x1b[=1u");
    write(parser, "\x1b[=2;2u");
    expect(parser.kittyFlags).toBe(3); // 1 | 2 = 3
  });

  it("CSI = flags ; 3 u ANDs keyboard flags", () => {
    write(parser, "\x1b[=3u");
    write(parser, "\x1b[=1;3u");
    expect(parser.kittyFlags).toBe(1); // 3 & 1 = 1
  });

  it("CSI = flags ; 4 u XORs keyboard flags", () => {
    write(parser, "\x1b[=3u");
    write(parser, "\x1b[=1;4u");
    expect(parser.kittyFlags).toBe(2); // 3 ^ 1 = 2
  });

  it("CSI > flags u pushes current flags onto stack and sets new flags", () => {
    write(parser, "\x1b[=1u");
    write(parser, "\x1b[>2u");
    expect(parser.kittyFlags).toBe(2);
  });

  it("CSI > 0 u pushes current flags without changing them", () => {
    write(parser, "\x1b[=3u");
    write(parser, "\x1b[>u"); // push with param absent (defaults 0 = no change)
    expect(parser.kittyFlags).toBe(3);
  });

  it("CSI < u pops flags from stack (restores previous)", () => {
    write(parser, "\x1b[=1u");
    write(parser, "\x1b[>2u");
    write(parser, "\x1b[<u");
    expect(parser.kittyFlags).toBe(1);
  });

  it("CSI < n u pops n entries from stack", () => {
    write(parser, "\x1b[=1u");
    write(parser, "\x1b[>2u"); // stack: [1], flags=2
    write(parser, "\x1b[>3u"); // stack: [1, 2], flags=3
    write(parser, "\x1b[<2u"); // pop 2 → stack: [], flags=1
    expect(parser.kittyFlags).toBe(1);
  });

  it("CSI < u on empty stack is a no-op (does not throw)", () => {
    expect(() => write(parser, "\x1b[<u")).not.toThrow();
    expect(parser.kittyFlags).toBe(0);
  });

  it("CSI ? u responds with current flags via responseBuffer", () => {
    write(parser, "\x1b[=5u");
    write(parser, "\x1b[?u");
    const resp = parser.readResponse();
    expect(resp).not.toBeNull();
    const text = new TextDecoder().decode(resp ?? new Uint8Array());
    expect(text).toBe("\x1b[?5u");
  });

  it("CSI ? u with flags=0 responds with 0", () => {
    write(parser, "\x1b[?u");
    const resp = parser.readResponse();
    expect(resp).not.toBeNull();
    const text = new TextDecoder().decode(resp ?? new Uint8Array());
    expect(text).toBe("\x1b[?0u");
  });

  it("setKittyFlagsCallback fires when flags change via CSI = u", () => {
    let lastFlags = -1;
    parser.setKittyFlagsCallback((flags) => {
      lastFlags = flags;
    });
    write(parser, "\x1b[=7u");
    expect(lastFlags).toBe(7);
  });

  it("setKittyFlagsCallback fires on push (CSI > u)", () => {
    const changes: number[] = [];
    parser.setKittyFlagsCallback((flags) => changes.push(flags));
    write(parser, "\x1b[=1u"); // fires 1
    write(parser, "\x1b[>2u"); // fires 2
    expect(changes).toEqual([1, 2]);
  });

  it("setKittyFlagsCallback fires on pop (CSI < u)", () => {
    const changes: number[] = [];
    write(parser, "\x1b[=1u");
    write(parser, "\x1b[>2u");
    parser.setKittyFlagsCallback((flags) => changes.push(flags));
    write(parser, "\x1b[<u"); // fires 1
    expect(changes).toEqual([1]);
  });

  it("flags reset to 0 on full terminal reset (RIS)", () => {
    write(parser, "\x1b[=3u");
    write(parser, "\x1bc"); // RIS — full reset
    expect(parser.kittyFlags).toBe(0);
  });

  it("stack cleared on full terminal reset (RIS)", () => {
    write(parser, "\x1b[=1u");
    write(parser, "\x1b[>2u"); // stack: [1]
    write(parser, "\x1bc"); // RIS — full reset, stack cleared
    write(parser, "\x1b[<u"); // pop on empty stack — no-op
    expect(parser.kittyFlags).toBe(0);
  });
});
