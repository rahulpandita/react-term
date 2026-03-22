/**
 * OSC 8 Hyperlink Integration Tests
 *
 * Tests the full pipeline: VTParser + BufferSet.
 * Verifies that OSC 8 sequences fire the callback correctly AND that
 * text surrounding the hyperlink renders correctly in the cell grid.
 *
 * Complements parser.test.ts (callback unit tests) with pipeline-level
 * integration coverage.
 */
import { describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";
import { readLineTrimmed, readScreen, write } from "./helpers.js";

function setup(cols = 80, rows = 24) {
  const bs = new BufferSet(cols, rows);
  const parser = new VTParser(bs);
  return { bs, parser };
}

/** OSC 8 open: ESC ] 8 ; <params> ; <uri> BEL */
function osc8Open(uri: string, params = ""): string {
  return `\x1b]8;${params};${uri}\x07`;
}

/** OSC 8 close: ESC ] 8 ; ; BEL (empty URI signals link end) */
const osc8Close = "\x1b]8;;\x07";

// ---------------------------------------------------------------------------
// 1. Text rendering around hyperlinks
// ---------------------------------------------------------------------------
describe("OSC 8 — text rendering in the cell grid", () => {
  it("hyperlink text renders at correct grid positions", () => {
    const { bs, parser } = setup();
    write(parser, `${osc8Open("https://example.com")}Click here${osc8Close}`);
    expect(readLineTrimmed(bs, 0)).toBe("Click here");
    expect(bs.active.cursor.col).toBe(10);
  });

  it("OSC 8 sequences leave no garbage characters in the grid", () => {
    const { bs, parser } = setup();
    write(parser, `before ${osc8Open("https://example.com")}link${osc8Close} after`);
    const line = readLineTrimmed(bs, 0);
    expect(line).toBe("before link after");
    expect(bs.active.cursor.col).toBe(17);
  });

  it("text after link close is at correct column", () => {
    const { bs, parser } = setup();
    write(parser, `${osc8Open("https://a.com")}ABC${osc8Close}XYZ`);
    expect(readLineTrimmed(bs, 0)).toBe("ABCXYZ");
    expect(bs.active.cursor.col).toBe(6);
  });

  it("ST-terminated hyperlink also renders text correctly", () => {
    const { bs, parser } = setup();
    const stOpen = "\x1b]8;;https://example.com\x1b\\";
    const stClose = "\x1b]8;;\x1b\\";
    write(parser, `${stOpen}link text${stClose}`);
    expect(readLineTrimmed(bs, 0)).toBe("link text");
  });

  it("multiple hyperlinks on the same line render all text correctly", () => {
    const { bs, parser } = setup();
    write(
      parser,
      `${osc8Open("https://a.com")}first${osc8Close} and ${osc8Open("https://b.com")}second${osc8Close}`,
    );
    expect(readLineTrimmed(bs, 0)).toBe("first and second");
  });

  it("hyperlink text spanning a line wrap renders on two rows", () => {
    const { bs, parser } = setup(10, 5);
    // 10-column terminal; link text is 12 chars → wraps at col 10
    write(parser, `${osc8Open("https://example.com")}Hello World!${osc8Close}`);
    expect(readLineTrimmed(bs, 0)).toBe("Hello Worl");
    expect(readLineTrimmed(bs, 1)).toBe("d!");
  });

  it("normal text before and after does not disturb existing content", () => {
    const { bs, parser } = setup();
    write(parser, "start ");
    write(parser, `${osc8Open("https://example.com")}link${osc8Close}`);
    write(parser, " end");
    expect(readLineTrimmed(bs, 0)).toBe("start link end");
  });
});

// ---------------------------------------------------------------------------
// 2. Callback / grid interaction
// ---------------------------------------------------------------------------
describe("OSC 8 — callback fires during normal output", () => {
  it("callback fires while other text is being written", () => {
    const { parser } = setup();
    const calls: Array<{ params: string; uri: string }> = [];
    parser.setOsc8Callback((params, uri) => calls.push({ params, uri }));

    write(parser, "before");
    write(parser, osc8Open("https://example.com", "id=1"));
    write(parser, "link text");
    write(parser, osc8Close);
    write(parser, "after");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ params: "id=1", uri: "https://example.com" });
    expect(calls[1]).toEqual({ params: "", uri: "" }); // close
  });

  it("multiple callbacks fire in sequence for multiple links", () => {
    const { parser } = setup();
    const uris: string[] = [];
    parser.setOsc8Callback((_params, uri) => {
      if (uri) uris.push(uri);
    });

    write(parser, `${osc8Open("https://first.com")}A${osc8Close}`);
    write(parser, `${osc8Open("https://second.com")}B${osc8Close}`);
    write(parser, `${osc8Open("https://third.com")}C${osc8Close}`);

    expect(uris).toEqual(["https://first.com", "https://second.com", "https://third.com"]);
  });

  it("consecutive links without gap text: both callbacks fire", () => {
    const { parser } = setup();
    const uris: string[] = [];
    parser.setOsc8Callback((_params, uri) => {
      if (uri) uris.push(uri);
    });
    // Directly open second link without an explicit close
    // (each new OSC 8 open implicitly ends the previous link at parser level)
    write(parser, `${osc8Open("https://a.com")}A`);
    write(parser, `${osc8Open("https://b.com")}B${osc8Close}`);

    expect(uris).toEqual(["https://a.com", "https://b.com"]);
  });
});

// ---------------------------------------------------------------------------
// 3. SGR attributes with hyperlinks
// ---------------------------------------------------------------------------
describe("OSC 8 — SGR attributes preserved through hyperlink sequences", () => {
  it("bold attribute on hyperlink text is preserved in grid", () => {
    const { bs, parser } = setup();
    write(parser, `\x1b[1m${osc8Open("https://example.com")}Bold link${osc8Close}\x1b[0m`);

    const grid = bs.active.grid;
    // "Bold link" should have bold attr bit set (bit 0 of attrs)
    for (let c = 0; c < 9; c++) {
      expect(grid.getAttrs(0, c) & 0x01).toBe(1); // bold
    }
    expect(readLineTrimmed(bs, 0)).toBe("Bold link");
  });

  it("foreground color on hyperlink text is preserved", () => {
    const { bs, parser } = setup();
    write(parser, `\x1b[31m${osc8Open("https://example.com")}Red link${osc8Close}\x1b[0m`);

    const grid = bs.active.grid;
    // "Red link" should have fgIndex = 1 (red)
    for (let c = 0; c < 8; c++) {
      expect(grid.getFgIndex(0, c)).toBe(1);
    }
    expect(readLineTrimmed(bs, 0)).toBe("Red link");
  });

  it("SGR reset after link close removes color", () => {
    const { bs, parser } = setup();
    write(parser, `\x1b[31m${osc8Open("https://example.com")}Red${osc8Close}\x1b[0mNormal`);

    const grid = bs.active.grid;
    expect(grid.getFgIndex(0, 0)).toBe(1); // "Red" — fg = red
    expect(grid.getFgIndex(0, 3)).toBe(7); // "Normal" — fg = default
    expect(readLineTrimmed(bs, 0)).toBe("RedNormal");
  });
});

// ---------------------------------------------------------------------------
// 4. Split writes across OSC 8 sequence boundary
// ---------------------------------------------------------------------------
describe("OSC 8 — split writes across sequence boundary", () => {
  it("callback fires correctly when OSC 8 is split across two write calls", () => {
    const { parser } = setup();
    let receivedUri = "";
    parser.setOsc8Callback((_params, uri) => {
      receivedUri = uri;
    });

    const seq = osc8Open("https://split.example.com");
    const mid = Math.floor(seq.length / 2);
    write(parser, seq.slice(0, mid));
    write(parser, seq.slice(mid));

    expect(receivedUri).toBe("https://split.example.com");
  });

  it("text written after a split-write OSC 8 renders at correct column", () => {
    const { bs, parser } = setup();
    const seq = osc8Open("https://example.com");
    const mid = Math.floor(seq.length / 2);
    write(parser, `pre ${seq.slice(0, mid)}`);
    write(parser, `${seq.slice(mid)}link${osc8Close}`);

    expect(readLineTrimmed(bs, 0)).toBe("pre link");
    expect(bs.active.cursor.col).toBe(8);
  });

  it("byte-by-byte write of OSC 8 still fires callback exactly once", () => {
    const { parser } = setup();
    let callCount = 0;
    let lastUri = "";
    parser.setOsc8Callback((_params, uri) => {
      callCount++;
      lastUri = uri;
    });

    const seq = osc8Open("https://byte.example.com");
    const enc = new TextEncoder();
    const bytes = enc.encode(seq);
    for (const b of bytes) {
      parser.write(new Uint8Array([b]));
    }

    expect(callCount).toBe(1);
    expect(lastUri).toBe("https://byte.example.com");
  });
});

// ---------------------------------------------------------------------------
// 5. Hyperlinks in alternate buffer
// ---------------------------------------------------------------------------
describe("OSC 8 — alternate buffer", () => {
  it("hyperlink text renders correctly in alternate buffer", () => {
    const { bs, parser } = setup();
    write(parser, "\x1b[?1049h"); // DECSET 1049: enter alternate buffer
    expect(bs.isAlternate).toBe(true);

    write(parser, `${osc8Open("https://alt.example.com")}Alt link${osc8Close}`);
    expect(readLineTrimmed(bs, 0)).toBe("Alt link");
  });

  it("callback fires in alternate buffer context", () => {
    const { parser } = setup();
    let uri = "";
    parser.setOsc8Callback((_params, u) => {
      if (u) uri = u;
    });

    write(parser, "\x1b[?1049h"); // enter alt buffer
    write(parser, `${osc8Open("https://alt.example.com")}text${osc8Close}`);

    expect(uri).toBe("https://alt.example.com");
  });

  it("link in alt buffer does not persist after returning to normal buffer", () => {
    const { bs, parser } = setup();
    write(parser, "\x1b[?1049h"); // enter alt
    write(parser, `${osc8Open("https://alt.example.com")}alt text${osc8Close}`);
    write(parser, "\x1b[?1049l"); // exit alt — normal buffer restored

    expect(readScreen(bs)).toBe("");
  });
});
