import { describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";
import { cursor, enc, readLineTrimmed, readScreen, write } from "./helpers.js";

/** Create a fresh 80×24 BufferSet + VTParser pair. */
function setup(cols = 80, rows = 24) {
  const bs = new BufferSet(cols, rows);
  const parser = new VTParser(bs);
  return { bs, parser, grid: bs.active.grid };
}

// ---------------------------------------------------------------------------
// 1. Text rendering — OSC 133 sequences must leave the grid clean
// ---------------------------------------------------------------------------
describe("OSC 133 integration — text rendering in cell grid", () => {
  it("text before and after OSC 133;A is undisturbed in the grid", () => {
    const { bs, parser } = setup();
    write(parser, "pre\x1b]133;A\x07post");
    expect(readLineTrimmed(bs, 0)).toBe("prepost");
  });

  it("prompt-line pattern: text written after OSC 133;B appears at correct column", () => {
    const { bs, parser } = setup();
    write(parser, "\x1b]133;A\x07$ \x1b]133;B\x07ls");
    expect(readLineTrimmed(bs, 0)).toBe("$ ls");
    expect(cursor(bs).col).toBe(4);
  });

  it("OSC 133;D with ST terminator leaves no garbage in the grid", () => {
    const { bs, parser } = setup();
    write(parser, "out\x1b]133;D;0\x1b\\more");
    expect(readLineTrimmed(bs, 0)).toBe("outmore");
  });

  it("multiple OSC 133 sequences in a row leave no garbage between them", () => {
    const { bs, parser } = setup();
    write(parser, "\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07text");
    expect(readLineTrimmed(bs, 0)).toBe("text");
  });

  it("OSC 133 does not advance the cursor on its own", () => {
    const { bs, parser } = setup();
    write(parser, "XX");
    const before = cursor(bs);
    write(parser, "\x1b]133;A\x07");
    const after = cursor(bs);
    expect(after).toStrictEqual(before);
  });

  it("OSC 133;E with command text does not print the payload to the grid", () => {
    const { bs, parser } = setup();
    parser.setOsc133Callback(() => {});
    write(parser, "before\x1b]133;E;ls -la\x07after");
    expect(readLineTrimmed(bs, 0)).toBe("beforeafter");
  });

  it("output spanning a newline between OSC 133 sequences renders correctly", () => {
    const { bs, parser } = setup();
    write(parser, "\x1b]133;C\x07line1\r\nline2\x1b]133;D;0\x07");
    expect(readLineTrimmed(bs, 0)).toBe("line1");
    expect(readLineTrimmed(bs, 1)).toBe("line2");
  });
});

// ---------------------------------------------------------------------------
// 2. Callback / grid interaction
// ---------------------------------------------------------------------------
describe("OSC 133 integration — callback interaction with grid writes", () => {
  it("callback fires while surrounding text is still written correctly", () => {
    const { bs, parser } = setup();
    const fired: string[] = [];
    parser.setOsc133Callback((type) => fired.push(type));
    write(parser, "Hello\x1b]133;A\x07World");
    expect(fired).toEqual(["A"]);
    expect(readLineTrimmed(bs, 0)).toBe("HelloWorld");
  });

  it("all six type codes A/B/C/D/E/P fire callback in sequence", () => {
    const { parser } = setup();
    const events: Array<{ type: string; payload: string }> = [];
    parser.setOsc133Callback((type, payload) => events.push({ type, payload }));
    write(parser, "\x1b]133;A\x07");
    write(parser, "\x1b]133;B\x07");
    write(parser, "\x1b]133;C\x07");
    write(parser, "\x1b]133;D;0\x07");
    write(parser, "\x1b]133;E;ls\x07");
    write(parser, "\x1b]133;P;k=cwd;v=/home\x07");
    expect(events).toHaveLength(6);
    expect(events[0]).toStrictEqual({ type: "A", payload: "" });
    expect(events[1]).toStrictEqual({ type: "B", payload: "" });
    expect(events[2]).toStrictEqual({ type: "C", payload: "" });
    expect(events[3]).toStrictEqual({ type: "D", payload: "0" });
    expect(events[4]).toStrictEqual({ type: "E", payload: "ls" });
    expect(events[5]).toStrictEqual({ type: "P", payload: "k=cwd;v=/home" });
  });

  it("full A→B→C→D shell-prompt sequence fires 4 callbacks and grid is correct", () => {
    const { bs, parser } = setup();
    const types: string[] = [];
    parser.setOsc133Callback((type) => types.push(type));
    // Shell emits: prompt, user types command, output arrives, command ends
    write(parser, "\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07file.txt\r\n\x1b]133;D;0\x07");
    expect(types).toEqual(["A", "B", "C", "D"]);
    expect(readLineTrimmed(bs, 0)).toBe("$ ls");
    expect(readLineTrimmed(bs, 1)).toBe("file.txt");
  });
});

// ---------------------------------------------------------------------------
// 3. SGR attributes preserved through OSC 133 sequences
// ---------------------------------------------------------------------------
describe("OSC 133 integration — SGR attributes preserved", () => {
  it("bold attribute set before OSC 133;A is preserved after the sequence", () => {
    const { parser, grid } = setup();
    write(parser, "\x1b[1mA\x1b]133;A\x07B");
    // Both 'A' and 'B' should carry the bold attribute bit
    expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01);
    expect(grid.getAttrs(0, 1) & 0x01).toBe(0x01);
  });

  it("foreground colour set before OSC 133 is preserved after the sequence", () => {
    const { parser, grid } = setup();
    write(parser, "\x1b[31mX\x1b]133;B\x07Y");
    expect(grid.getFgIndex(0, 0)).toBe(1); // red
    expect(grid.getFgIndex(0, 1)).toBe(1); // still red after OSC 133
  });

  it("SGR reset after OSC 133 removes previously set attributes", () => {
    const { parser, grid } = setup();
    write(parser, "\x1b[1mA\x1b]133;A\x07\x1b[0mB");
    expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // 'A' bold
    expect(grid.getAttrs(0, 1) & 0x01).toBe(0x00); // 'B' not bold after reset
  });
});

// ---------------------------------------------------------------------------
// 4. Split writes — sequences split across write() calls
// ---------------------------------------------------------------------------
describe("OSC 133 integration — split writes", () => {
  it("callback fires when sequence is split across two write() calls", () => {
    const { parser } = setup();
    const fired: string[] = [];
    parser.setOsc133Callback((type) => fired.push(type));
    write(parser, "\x1b]133;");
    expect(fired).toHaveLength(0); // not yet dispatched
    write(parser, "D;0\x07");
    expect(fired).toEqual(["D"]);
  });

  it("cursor is correct after OSC 133 sequence split mid-escape", () => {
    const { bs, parser } = setup();
    write(parser, "AB");
    write(parser, "\x1b]133;A\x07");
    write(parser, "CD");
    expect(cursor(bs).col).toBe(4);
    expect(readLineTrimmed(bs, 0)).toBe("ABCD");
  });

  it("byte-by-byte write of OSC 133 fires the callback exactly once", () => {
    const { parser } = setup();
    const fired: string[] = [];
    parser.setOsc133Callback((type) => fired.push(type));
    const seq = "\x1b]133;C\x07";
    const bytes = enc.encode(seq);
    for (const byte of bytes) {
      parser.write(new Uint8Array([byte]));
    }
    expect(fired).toEqual(["C"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Alternate buffer
// ---------------------------------------------------------------------------
describe("OSC 133 integration — alternate buffer", () => {
  it("text renders in alternate buffer when OSC 133 sequences are interspersed", () => {
    const { bs, parser } = setup();
    write(parser, "\x1b[?1049h"); // enter alt buffer
    write(parser, "\x1b]133;A\x07prompt\x1b]133;B\x07");
    expect(readLineTrimmed(bs, 0)).toBe("prompt");
  });

  it("callback fires in alternate buffer mode", () => {
    const { parser } = setup();
    const fired: string[] = [];
    parser.setOsc133Callback((type) => fired.push(type));
    write(parser, "\x1b[?1049h");
    write(parser, "\x1b]133;A\x07\x1b]133;B\x07");
    expect(fired).toEqual(["A", "B"]);
  });

  it("content written in alternate buffer is absent after DECSET 1049 restore", () => {
    const { bs, parser } = setup();
    write(parser, "normal-line\r\n");
    write(parser, "\x1b[?1049h"); // alt buffer
    write(parser, "\x1b]133;C\x07alt-content\x1b]133;D;0\x07");
    write(parser, "\x1b[?1049l"); // restore normal buffer
    const screen = readScreen(bs);
    expect(screen).toContain("normal-line");
    expect(screen).not.toContain("alt-content");
  });
});
