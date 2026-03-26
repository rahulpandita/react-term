import { beforeEach, describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";
import { readLineTrimmed, write } from "./helpers.js";

describe("DCS tmux passthrough", () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
    parser = new VTParser(bs);
  });

  it("setDcsTmuxCallback method exists", () => {
    expect(typeof (parser as VTParser & { setDcsTmuxCallback: unknown }).setDcsTmuxCallback).toBe(
      "function",
    );
  });

  it("fires setDcsTmuxCallback with inner sequence string", () => {
    let gotInner = "";
    (
      parser as VTParser & { setDcsTmuxCallback: (cb: (s: string) => void) => void }
    ).setDcsTmuxCallback((s) => {
      gotInner = s;
    });
    // \x1bPtmux;\x1b\x1b[1m\x1b\\ — wrap ESC[1m in tmux DCS
    write(parser, "\x1bPtmux;\x1b\x1b[1m\x1b\\");
    // Inner sequence should be the decoded \x1b[1m
    expect(gotInner).toBe("\x1b[1m");
  });

  it("processes inner OSC window title through tmux passthrough", () => {
    let title = "";
    parser.setTitleChangeCallback((t) => {
      title = t;
    });
    // Inner: ESC]0;My Title ESC\ → title "My Title"
    // Wrapped: \x1bPtmux;\x1b\x1b]0;My Title\x1b\x1b\\\x1b\\
    write(parser, "\x1bPtmux;\x1b\x1b]0;My Title\x1b\x1b\\\x1b\\");
    expect(title).toBe("My Title");
  });

  it("processes inner SGR through tmux passthrough", () => {
    // Apply bold via tmux passthrough, then write text
    write(parser, "\x1bPtmux;\x1b\x1b[1m\x1b\\");
    write(parser, "A");
    // Cell 0 should have bold attribute
    expect(bs.active.grid.isBold(0, 0)).toBe(true);
  });

  it("non-tmux DCS still dispatches via setDcsCallback (regression)", () => {
    let gotFinal = -1;
    let gotData = "";
    parser.setDcsCallback((finalByte, _params, _inter, data) => {
      gotFinal = finalByte;
      gotData = data;
    });
    write(parser, "\x1bPpHello\x1b\\");
    expect(gotFinal).toBe(0x70); // 'p'
    expect(gotData).toBe("Hello");
  });

  it("text renders normally after tmux DCS passthrough (no state leak)", () => {
    write(parser, "\x1bPtmux;\x1b\x1b[0m\x1b\\"); // reset attrs
    write(parser, "Hello");
    expect(readLineTrimmed(bs, 0)).toBe("Hello");
  });

  it("back-to-back tmux DCS passthrough sequences both processed", () => {
    const titles: string[] = [];
    parser.setTitleChangeCallback((t) => {
      titles.push(t);
    });
    write(parser, "\x1bPtmux;\x1b\x1b]0;First\x1b\x1b\\\x1b\\");
    write(parser, "\x1bPtmux;\x1b\x1b]0;Second\x1b\x1b\\\x1b\\");
    expect(titles).toEqual(["First", "Second"]);
  });

  it("tmux DCS with empty inner sequence does not crash", () => {
    expect(() => write(parser, "\x1bPtmux;\x1b\\")).not.toThrow();
  });

  it("DCS with final byte 't' but non-tmux data dispatches via setDcsCallback", () => {
    let gotFinal = -1;
    let gotData = "";
    parser.setDcsCallback((fb, _p, _i, data) => {
      gotFinal = fb;
      gotData = data;
    });
    // Final byte 't' but data is NOT "mux;" prefix
    write(parser, "\x1bPtXYZ\x1b\\");
    expect(gotFinal).toBe(0x74); // 't'
    expect(gotData).toBe("XYZ");
  });

  it("tmux DCS passthrough inner OSC 52 triggers clipboard callback", () => {
    let clipSel = "";
    let clipData: string | null = undefined as unknown as string | null;
    parser.setOsc52Callback((sel, data) => {
      clipSel = sel;
      clipData = data;
    });
    // Inner: ESC]52;c;aGVsbG8=ESC\ (OSC 52 write 'hello' base64)
    // Wrapped in tmux DCS
    write(parser, "\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x1b\x1b\\\x1b\\");
    expect(clipSel).toBe("c");
    expect(clipData).toBe("aGVsbG8=");
  });

  it("normal DCS and tmux DCS interleaved work correctly", () => {
    let dcsData = "";
    let title = "";
    parser.setDcsCallback((_fb, _p, _i, data) => {
      dcsData = data;
    });
    parser.setTitleChangeCallback((t) => {
      title = t;
    });
    // Regular DCS first
    write(parser, "\x1bPpRegular\x1b\\");
    // Then tmux DCS
    write(parser, "\x1bPtmux;\x1b\x1b]0;Interleaved\x1b\x1b\\\x1b\\");
    expect(dcsData).toBe("Regular");
    expect(title).toBe("Interleaved");
  });
});
