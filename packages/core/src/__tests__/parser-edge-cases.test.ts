import { beforeEach, describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";

const enc = new TextEncoder();

function write(parser: VTParser, str: string): void {
  parser.write(enc.encode(str));
}

function readLineTrimmed(bs: BufferSet, row: number): string {
  const grid = bs.active.grid;
  let end = grid.cols - 1;
  while (end >= 0 && grid.getCodepoint(row, end) === 0x20) end--;
  let result = "";
  for (let c = 0; c <= end; c++) {
    result += String.fromCodePoint(grid.getCodepoint(row, c));
  }
  return result;
}

describe("VTParser Edge Cases", () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
    parser = new VTParser(bs);
  });

  // ============================================================
  // Malformed sequences
  // ============================================================
  describe("Malformed sequences", () => {
    it("handles incomplete CSI (ESC [ without final byte, then normal text)", () => {
      // ESC [ starts CSI, but 'Z' is not a digit/param, it is a final byte.
      // Actually let's test ESC [ then text arrives later
      write(parser, "\x1b[");
      // Now send normal text - should recover
      write(parser, "Hello");
      // The 'H' is a CSI dispatch (CUP) since H is 0x48 which is a CSI final byte
      // Then 'ello' prints normally
      // After CSI H dispatches (with no params -> CUP 1;1 -> cursor at 0,0)
      // Then 'e' prints at 0,0, 'l' at 0,1, etc.
      expect(readLineTrimmed(bs, 0)).toBe("ello");
    });

    it("handles CSI with too many parameters (>16 params)", () => {
      // SGR with many params should not crash
      const manyParams = Array.from({ length: 20 }, () => "0").join(";");
      write(parser, `\x1b[${manyParams}m`);
      write(parser, "A");
      expect(readLineTrimmed(bs, 0)).toBe("A");
    });

    it("handles CSI with parameter overflow (999999999)", () => {
      // Large parameter value should be clamped
      write(parser, "\x1b[999999999H");
      // Should clamp to valid range
      expect(parser.cursor.row).toBeLessThan(24);
      expect(parser.cursor.col).toBeLessThan(80);
    });

    it("handles nested ESC sequences (ESC in middle of CSI)", () => {
      // ESC in the middle of a CSI should abort the CSI and start new ESC
      write(parser, "\x1b[1\x1b[0mA");
      // The first ESC[ starts CSI, then 1 is param, then ESC aborts and starts new escape
      // Then [0m is a new CSI SGR reset
      // Then 'A' prints
      expect(readLineTrimmed(bs, 0)).toBe("A");
    });

    it("handles CSI with no params dispatching correctly (ESC [ m -> SGR reset)", () => {
      write(parser, "\x1b[1mBold");
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // bold
      write(parser, "\x1b[m"); // SGR reset with no params
      write(parser, "Normal");
      expect(grid.getAttrs(0, 10)).toBe(0); // reset
    });
  });

  // ============================================================
  // UTF-8 edge cases
  // ============================================================
  describe("UTF-8 edge cases", () => {
    it("handles invalid continuation bytes", () => {
      // Start a 2-byte sequence but follow with non-continuation byte
      parser.write(new Uint8Array([0xc3, 0x41])); // 0xc3 starts 2-byte, but 0x41 is 'A'
      const grid = bs.active.grid;
      // The invalid continuation should be handled gracefully
      // 0x41 ('A') should be printed after the UTF-8 state is reset
      expect(grid.getCodepoint(0, 0)).toBe(0x41);
    });

    it("handles BMP boundary (U+FFFF)", () => {
      // U+FFFF = 0xEF 0xBF 0xBF
      parser.write(new Uint8Array([0xef, 0xbf, 0xbf]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0xffff);
    });

    it("handles supplementary plane (U+10000)", () => {
      // U+10000 = 0xF0 0x90 0x80 0x80
      parser.write(new Uint8Array([0xf0, 0x90, 0x80, 0x80]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x10000);
    });

    it("handles emoji U+1F600", () => {
      // U+1F600 = 0xF0 0x9F 0x98 0x80
      parser.write(new Uint8Array([0xf0, 0x9f, 0x98, 0x80]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x1f600);
    });

    it("handles combining characters (e + combining acute)", () => {
      // 'e' (0x65) + combining acute accent U+0301 (0xCC 0x81)
      parser.write(new Uint8Array([0x65, 0xcc, 0x81]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x65); // 'e'
      expect(grid.getCodepoint(0, 1)).toBe(0x0301); // combining accent in next cell
    });

    it("handles split UTF-8 across multiple writes", () => {
      // Euro sign U+20AC = 0xE2 0x82 0xAC, split across writes
      parser.write(new Uint8Array([0xe2]));
      parser.write(new Uint8Array([0x82]));
      parser.write(new Uint8Array([0xac]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x20ac);
    });
  });

  // ============================================================
  // Boundary conditions
  // ============================================================
  describe("Boundary conditions", () => {
    it("cursor at (0,0) then cursor up stays at 0", () => {
      write(parser, "\x1b[1;1H"); // home
      write(parser, "\x1b[5A"); // cursor up 5
      expect(parser.cursor.row).toBe(0);
    });

    it("cursor at (0,0) then cursor left stays at 0", () => {
      write(parser, "\x1b[1;1H"); // home
      write(parser, "\x1b[5D"); // cursor left 5
      expect(parser.cursor.col).toBe(0);
    });

    it("cursor at bottom-right then cursor down stays at bottom", () => {
      write(parser, "\x1b[24;80H"); // bottom-right (1-based)
      write(parser, "\x1b[5B"); // cursor down 5
      expect(parser.cursor.row).toBe(23); // 0-based bottom
    });

    it("cursor at bottom-right then cursor right stays at right margin", () => {
      write(parser, "\x1b[24;80H"); // bottom-right (1-based)
      write(parser, "\x1b[5C"); // cursor right 5
      expect(parser.cursor.col).toBe(79); // 0-based right margin
    });

    it("writing exactly cols characters wraps to next line", () => {
      const line = "A".repeat(80);
      write(parser, line);
      // After writing 80 chars, cursor stays at col 79 with wrapPending
      expect(parser.cursor.col).toBe(79);
      expect(parser.cursor.wrapPending).toBe(true);
      // Write one more char to trigger wrap
      write(parser, "B");
      expect(parser.cursor.row).toBe(1);
      expect(parser.cursor.col).toBe(1);
      expect(readLineTrimmed(bs, 1)).toBe("B");
    });

    it("writing cols-1 characters then one more does not wrap", () => {
      const line = "A".repeat(79);
      write(parser, line);
      expect(parser.cursor.col).toBe(79);
      write(parser, "B");
      // 'B' written at col 79, cursor stays at 79 with wrapPending
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(79);
      expect(parser.cursor.wrapPending).toBe(true);
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 79)).toBe(0x42); // 'B'
    });

    it("empty CSI (ESC [ m) acts as SGR reset", () => {
      write(parser, "\x1b[1m"); // bold
      write(parser, "\x1b[m"); // empty params -> SGR 0
      write(parser, "A");
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0)).toBe(0);
    });
  });

  // ============================================================
  // Rapid sequence switching
  // ============================================================
  describe("Rapid sequence switching", () => {
    it("SGR then immediate SGR reset", () => {
      write(parser, "\x1b[1;3;4;31m\x1b[0mA");
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0)).toBe(0);
      expect(grid.getFgIndex(0, 0)).toBe(7);
    });

    it("alternate buffer switch then immediate switch back", () => {
      write(parser, "Normal");
      write(parser, "\x1b[?1049h\x1b[?1049l");
      expect(bs.isAlternate).toBe(false);
      expect(readLineTrimmed(bs, 0)).toBe("Normal");
    });

    it("set scroll region then immediately reset it", () => {
      write(parser, "\x1b[5;10r"); // set region
      expect(bs.active.scrollTop).toBe(4);
      expect(bs.active.scrollBottom).toBe(9);
      write(parser, "\x1b[r"); // reset region (defaults to full screen)
      expect(bs.active.scrollTop).toBe(0);
      expect(bs.active.scrollBottom).toBe(23);
    });

    it("multiple consecutive cursor position commands", () => {
      write(parser, "\x1b[5;5H\x1b[10;10H\x1b[3;7H");
      expect(parser.cursor.row).toBe(2);
      expect(parser.cursor.col).toBe(6);
    });
  });

  // ============================================================
  // Large data
  // ============================================================
  describe("Large data", () => {
    it("writes 10000 characters in a single write() call", () => {
      const data = "A".repeat(10000);
      write(parser, data);
      // Should not crash. After 10000 chars on 80-col terminal:
      // 10000/80 = 125 rows, which exceeds 24 rows, so scrolling happened
      // Just verify the parser is in a consistent state
      expect(parser.cursor.row).toBeLessThanOrEqual(23);
      expect(parser.cursor.col).toBeLessThan(80);
    });

    it("writes 1 byte at a time for a complex escape sequence", () => {
      // CSI 1;31m (bold red) split byte by byte
      const sequence = "\x1b[1;31mHello";
      for (let i = 0; i < sequence.length; i++) {
        parser.write(enc.encode(sequence[i]));
      }
      const grid = bs.active.grid;
      expect(readLineTrimmed(bs, 0)).toBe("Hello");
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // bold
      expect(grid.getFgIndex(0, 0)).toBe(1); // red
    });

    it("handles interleaved text and escape sequences at high volume", () => {
      let data = "";
      for (let i = 0; i < 500; i++) {
        data += `\x1b[${(i % 7) + 31}mX`;
      }
      write(parser, data);
      // Should not crash, cursor should be in valid range
      expect(parser.cursor.row).toBeLessThanOrEqual(23);
      expect(parser.cursor.col).toBeLessThan(80);
    });
  });

  // ============================================================
  // New feature tests
  // ============================================================
  describe("Auto-wrap mode (DECAWM)", () => {
    it("wraps by default (auto-wrap enabled)", () => {
      const line = `${"A".repeat(80)}B`;
      write(parser, line);
      expect(readLineTrimmed(bs, 0)).toBe("A".repeat(80));
      expect(readLineTrimmed(bs, 1)).toBe("B");
    });

    it("does not wrap when DECAWM is disabled", () => {
      write(parser, "\x1b[?7l"); // disable auto-wrap
      const line = `${"A".repeat(80)}B`;
      write(parser, line);
      // When auto-wrap is off, cursor stays at right margin and overwrites last char
      expect(parser.cursor.row).toBe(0);
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 79)).toBe(0x42); // 'B' overwrote the last 'A'
    });

    it("re-enables wrapping with DECAWM set", () => {
      write(parser, "\x1b[?7l"); // disable
      write(parser, "\x1b[?7h"); // re-enable
      const line = `${"A".repeat(80)}B`;
      write(parser, line);
      expect(readLineTrimmed(bs, 1)).toBe("B");
    });
  });

  describe("Cursor style (DECSCUSR)", () => {
    it("sets block cursor style (0)", () => {
      write(parser, "\x1b[0 q");
      expect(parser.cursor.style).toBe("block");
    });

    it("sets block cursor style (1)", () => {
      write(parser, "\x1b[1 q");
      expect(parser.cursor.style).toBe("block");
    });

    it("sets steady block cursor style (2)", () => {
      write(parser, "\x1b[2 q");
      expect(parser.cursor.style).toBe("block");
    });

    it("sets blinking underline cursor style (3)", () => {
      write(parser, "\x1b[3 q");
      expect(parser.cursor.style).toBe("underline");
    });

    it("sets steady underline cursor style (4)", () => {
      write(parser, "\x1b[4 q");
      expect(parser.cursor.style).toBe("underline");
    });

    it("sets blinking bar cursor style (5)", () => {
      write(parser, "\x1b[5 q");
      expect(parser.cursor.style).toBe("bar");
    });

    it("sets steady bar cursor style (6)", () => {
      write(parser, "\x1b[6 q");
      expect(parser.cursor.style).toBe("bar");
    });
  });

  describe("Device Status Report (DSR)", () => {
    it("generates cursor position response for CSI 6 n", () => {
      write(parser, "\x1b[5;10H"); // move to row 5, col 10
      write(parser, "\x1b[6n"); // request cursor position
      expect(parser.hasResponse()).toBe(true);
      const response = parser.readResponse();
      expect(response).not.toBeNull();
      const decoded = new TextDecoder().decode(response!);
      expect(decoded).toBe("\x1b[5;10R");
    });

    it("reports (1,1) for cursor at home position", () => {
      write(parser, "\x1b[H"); // home
      write(parser, "\x1b[6n");
      const response = parser.readResponse();
      const decoded = new TextDecoder().decode(response!);
      expect(decoded).toBe("\x1b[1;1R");
    });

    it("hasResponse returns false when no responses", () => {
      expect(parser.hasResponse()).toBe(false);
      expect(parser.readResponse()).toBeNull();
    });
  });

  describe("Primary Device Attributes (DA)", () => {
    it("responds to CSI c", () => {
      write(parser, "\x1b[c");
      expect(parser.hasResponse()).toBe(true);
      const response = parser.readResponse();
      const decoded = new TextDecoder().decode(response!);
      expect(decoded).toBe("\x1b[?1;2c");
    });

    it("responds to CSI 0 c", () => {
      write(parser, "\x1b[0c");
      expect(parser.hasResponse()).toBe(true);
      const response = parser.readResponse();
      const decoded = new TextDecoder().decode(response!);
      expect(decoded).toBe("\x1b[?1;2c");
    });
  });

  describe("SGR dim/faint (2)", () => {
    it("applies dim attribute", () => {
      write(parser, "\x1b[2mD");
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x10).toBe(0x10); // ATTR_DIM
    });

    it("resets dim with SGR 22", () => {
      write(parser, "\x1b[2mD\x1b[22mN");
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x10).toBe(0x10); // dim on 'D'
      expect(grid.getAttrs(0, 1) & 0x10).toBe(0); // dim off on 'N'
    });

    it("SGR 22 resets both bold and dim", () => {
      write(parser, "\x1b[1;2mBD\x1b[22mN");
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // bold on 'B'
      expect(grid.getAttrs(0, 0) & 0x10).toBe(0x10); // dim on 'B'
      expect(grid.getAttrs(0, 2) & 0x01).toBe(0); // bold off on 'N'
      expect(grid.getAttrs(0, 2) & 0x10).toBe(0); // dim off on 'N'
    });
  });

  describe("SGR hidden/invisible (8)", () => {
    it("applies hidden attribute", () => {
      write(parser, "\x1b[8mH");
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x20).toBe(0x20); // ATTR_HIDDEN
    });

    it("resets hidden with SGR 28", () => {
      write(parser, "\x1b[8mH\x1b[28mV");
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x20).toBe(0x20); // hidden on 'H'
      expect(grid.getAttrs(0, 1) & 0x20).toBe(0); // visible on 'V'
    });
  });

  describe("Line feed mode (LNM)", () => {
    it("LF does not CR when LNM is off (default)", () => {
      write(parser, "ABC");
      write(parser, "\n");
      expect(parser.cursor.col).toBe(3); // col stays at 3
      expect(parser.cursor.row).toBe(1);
    });

    it("LF also does CR when LNM is set", () => {
      write(parser, "\x1b[20h"); // set LNM
      write(parser, "ABC");
      write(parser, "\n");
      expect(parser.cursor.col).toBe(0); // col resets to 0
      expect(parser.cursor.row).toBe(1);
    });

    it("LNM can be reset", () => {
      write(parser, "\x1b[20h"); // set
      write(parser, "\x1b[20l"); // reset
      write(parser, "ABC\n");
      expect(parser.cursor.col).toBe(3); // col stays
    });
  });

  describe("Origin mode (DECOM)", () => {
    it("CUP is relative to scroll region when DECOM is set", () => {
      write(parser, "\x1b[5;20r"); // set scroll region rows 5-20
      write(parser, "\x1b[?6h"); // enable origin mode
      write(parser, "\x1b[1;1H"); // CUP to 1,1 (relative to scroll region)
      expect(parser.cursor.row).toBe(4); // row 5 (0-based = 4)
      expect(parser.cursor.col).toBe(0);
    });

    it("CUP uses absolute coordinates when DECOM is off", () => {
      write(parser, "\x1b[5;20r"); // set scroll region
      write(parser, "\x1b[?6l"); // disable origin mode (should be default)
      write(parser, "\x1b[1;1H");
      expect(parser.cursor.row).toBe(0); // absolute row 0
    });

    it("cursor goes to scroll top when DECOM is enabled", () => {
      write(parser, "\x1b[5;20r"); // set scroll region
      write(parser, "\x1b[?6h"); // enable origin mode -> cursor goes to scrollTop
      expect(parser.cursor.row).toBe(4);
      expect(parser.cursor.col).toBe(0);
    });
  });

  describe("Soft reset (DECSTR)", () => {
    it("resets attributes but preserves cursor position", () => {
      write(parser, "\x1b[5;10H"); // move cursor
      write(parser, "\x1b[1;31m"); // bold red
      write(parser, "\x1b[!p"); // soft reset
      write(parser, "A");
      const grid = bs.active.grid;
      // Cursor position should be preserved
      expect(parser.cursor.row).toBe(4);
      // Attributes should be reset (A should have no attrs)
      expect(grid.getAttrs(4, 9)).toBe(0);
      expect(grid.getFgIndex(4, 9)).toBe(7); // default fg
    });

    it("resets cursor visibility and style", () => {
      write(parser, "\x1b[?25l"); // hide cursor
      write(parser, "\x1b[5 q"); // bar style
      write(parser, "\x1b[!p"); // soft reset
      expect(parser.cursor.visible).toBe(true);
      expect(parser.cursor.style).toBe("block");
    });

    it("resets scroll region", () => {
      write(parser, "\x1b[5;10r"); // set scroll region
      write(parser, "\x1b[!p"); // soft reset
      expect(bs.active.scrollTop).toBe(0);
      expect(bs.active.scrollBottom).toBe(23);
    });

    it("resets auto-wrap mode to default (on)", () => {
      write(parser, "\x1b[?7l"); // disable auto-wrap
      write(parser, "\x1b[!p"); // soft reset
      // Auto-wrap should be back to default (on)
      const line = `${"A".repeat(80)}B`;
      write(parser, line);
      expect(readLineTrimmed(bs, 1)).toBe("B");
    });
  });

  describe("Window manipulation (CSI t)", () => {
    it("handles title stack push/pop without crashing", () => {
      write(parser, "\x1b[22t"); // push title
      write(parser, "\x1b[23t"); // pop title
      // Should not crash
      write(parser, "A");
      expect(readLineTrimmed(bs, 0)).toBe("A");
    });
  });
});
