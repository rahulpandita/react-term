import { beforeEach, describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";
import { readLineTrimmed, write } from "./helpers.js";

describe("DCS framework", () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
    parser = new VTParser(bs);
  });

  it("setDcsCallback method exists", () => {
    expect(typeof (parser as VTParser & { setDcsCallback: unknown }).setDcsCallback).toBe(
      "function",
    );
  });

  it("fires callback for basic DCS with data and ESC-backslash terminator", () => {
    let gotFinal = -1;
    let gotData = "";
    parser.setDcsCallback((finalByte, _params, _inter, data) => {
      gotFinal = finalByte;
      gotData = data;
    });
    // ESC P p <data> ESC \ — final byte 'p' (0x70), data "hello"
    write(parser, "\x1bPphello\x1b\\");
    expect(gotFinal).toBe(0x70); // 'p'
    expect(gotData).toBe("hello");
  });

  it("fires callback with correct numeric params (1;2)", () => {
    let gotParams: readonly number[] = [];
    parser.setDcsCallback((_f, params) => {
      gotParams = params;
    });
    // ESC P 1 ; 2 q <data> ESC \
    write(parser, "\x1bP1;2qdata\x1b\\");
    expect(gotParams).toEqual([1, 2]);
  });

  it("fires callback with correct intermediate byte ($)", () => {
    let gotInter = -1;
    parser.setDcsCallback((_f, _p, inter) => {
      gotInter = inter;
    });
    // ESC P $ r <data> ESC \ — intermediate '$' (0x24)
    write(parser, "\x1bP$rdata\x1b\\");
    expect(gotInter).toBe(0x24); // '$'
  });

  it("fires callback with empty data when no passthrough bytes are present", () => {
    let called = false;
    let gotData = "x";
    parser.setDcsCallback((_f, _p, _i, data) => {
      called = true;
      gotData = data;
    });
    // ESC P q ESC \ — final 'q', no data bytes
    write(parser, "\x1bPq\x1b\\");
    expect(called).toBe(true);
    expect(gotData).toBe("");
  });

  it("fires callback for C1 ST (0x9c) terminator", () => {
    let gotData = "";
    parser.setDcsCallback((_f, _p, _i, data) => {
      gotData = data;
    });
    // ESC P p <data> 0x9c (C1 String Terminator)
    write(parser, "\x1bPphello\x9c");
    expect(gotData).toBe("hello");
  });

  it("does not throw when no handler is registered", () => {
    expect(() => write(parser, "\x1bPphello\x1b\\")).not.toThrow();
  });

  it("text after DCS sequence renders normally", () => {
    parser.setDcsCallback(() => {});
    write(parser, "\x1bPpsome data\x1b\\After");
    expect(readLineTrimmed(bs, 0)).toBe("After");
  });

  it("DCS passthrough data does not appear in terminal output", () => {
    parser.setDcsCallback(() => {});
    write(parser, "\x1bPpvisible data\x1b\\");
    expect(readLineTrimmed(bs, 0)).toBe("");
  });

  it("caps data collection at 4096 bytes without crash", () => {
    let gotData = "";
    parser.setDcsCallback((_f, _p, _i, data) => {
      gotData = data;
    });
    const longData = "A".repeat(8192); // 2× MAX_DCS_LENGTH
    write(parser, `\x1bPp${longData}\x1b\\`);
    expect(gotData.length).toBe(4096);
    expect(gotData).toBe("A".repeat(4096));
  });

  it("handles two consecutive DCS sequences", () => {
    const results: Array<[number, string]> = [];
    parser.setDcsCallback((finalByte, _p, _i, data) => {
      results.push([finalByte, data]);
    });
    write(parser, "\x1bPpabc\x1b\\\x1bPqdef\x1b\\");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([0x70, "abc"]); // 'p'
    expect(results[1]).toEqual([0x71, "def"]); // 'q'
  });

  it("DCS interleaved with normal text", () => {
    parser.setDcsCallback(() => {});
    write(parser, "Hi\x1bPpskip\x1b\\There");
    expect(readLineTrimmed(bs, 0)).toBe("HiThere");
  });
});
