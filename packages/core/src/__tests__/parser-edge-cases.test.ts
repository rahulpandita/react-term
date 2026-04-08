import { beforeEach, describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";
import { cursor, readLineTrimmed, write } from "./helpers.js";

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
      // Combining characters attach to the base character — they don't
      // advance the cursor or occupy their own cell.
      parser.write(new Uint8Array([0x65, 0xcc, 0x81]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x65); // 'e' (base char)
      // Cursor stays at col 1 (after 'e'), combining mark was absorbed
      expect(bs.active.cursor.col).toBe(1);
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
      // 10000 / 80 = 125 full rows exactly. Scrolling leaves the last 24 rows
      // visible (all filled with 'A'). The final char fills col 79 of row 124,
      // leaving the cursor at (23, 79) with wrapPending set.
      expect(parser.cursor.row).toBe(23);
      expect(parser.cursor.col).toBe(79);
      expect(parser.cursor.wrapPending).toBe(true);
      for (let r = 0; r < 24; r++) {
        expect(readLineTrimmed(bs, r)).toBe("A".repeat(80));
      }
    });

    it("writes 1 byte at a time for a complex escape sequence", () => {
      // CSI 1;31m (bold red) split byte by byte
      const sequence = "\x1b[1;31mHello";
      for (let i = 0; i < sequence.length; i++) {
        write(parser, sequence[i]);
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
      // 500 X chars in 80-col terminal → 6 full rows + 20 chars on row 6.
      expect(parser.cursor.row).toBe(6);
      expect(parser.cursor.col).toBe(20);
      // Every written cell contains 'X' (0x58).
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x58); // first 'X'
      expect(grid.getCodepoint(6, 19)).toBe(0x58); // last 'X'
      // Colors cycle through SGR 31-37 (fg 1-7) and repeat every 7 chars.
      // i=0 → SGR 31 (fg 1), i=1 → SGR 32 (fg 2), …, i=6 → SGR 37 (fg 7), i=7 → SGR 31 (fg 1) again.
      expect(grid.getFgIndex(0, 0)).toBe(1);
      expect(grid.getFgIndex(0, 1)).toBe(2);
      expect(grid.getFgIndex(0, 6)).toBe(7);
      expect(grid.getFgIndex(0, 7)).toBe(1); // cycle restarts
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
      const decoded = new TextDecoder().decode(response as Uint8Array);
      expect(decoded).toBe("\x1b[5;10R");
    });

    it("reports (1,1) for cursor at home position", () => {
      write(parser, "\x1b[H"); // home
      write(parser, "\x1b[6n");
      const response = parser.readResponse();
      expect(response).not.toBeNull();
      const decoded = new TextDecoder().decode(response as Uint8Array);
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
      expect(response).not.toBeNull();
      const decoded = new TextDecoder().decode(response as Uint8Array);
      expect(decoded).toBe("\x1b[?1;2c");
    });

    it("responds to CSI 0 c", () => {
      write(parser, "\x1b[0c");
      expect(parser.hasResponse()).toBe(true);
      const response = parser.readResponse();
      expect(response).not.toBeNull();
      const decoded = new TextDecoder().decode(response as Uint8Array);
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

  // ============================================================
  // Read-ahead & fast-path edge cases
  // ============================================================
  describe("Read-ahead and fast-path edge cases", () => {
    it("handles CSI split across two write() calls mid-param", () => {
      // ESC [ 3 arrives in first write, 8;5;208m in second
      write(parser, "\x1b[3");
      write(parser, "8;5;208m");
      write(parser, "A");
      const grid = bs.active.grid;
      expect(readLineTrimmed(bs, 0)).toBe("A");
      // 38;5;208 = 256-color foreground index 208
      expect(grid.getFgIndex(0, 0)).toBe(208);
    });

    it("handles ESC at the very end of a write() buffer", () => {
      // ESC is last byte — should transition to ESCAPE state, not crash
      write(parser, "Hello\x1b");
      // Next write completes the CSI sequence
      write(parser, "[0mWorld");
      expect(readLineTrimmed(bs, 0)).toBe("HelloWorld");
    });

    it("handles ESC [ at the very end of a write() buffer", () => {
      // ESC [ consumed by fast-path, next write has params + final byte
      write(parser, "Hi\x1b[");
      write(parser, "1mBold");
      const grid = bs.active.grid;
      expect(readLineTrimmed(bs, 0)).toBe("HiBold");
      expect(grid.getAttrs(0, 2) & 0x01).toBe(0x01); // bold
    });

    it("handles ESC ] at the very end of a write() buffer", () => {
      // ESC ] consumed by fast-path, OSC content arrives in next write
      let title = "";
      parser.setTitleChangeCallback((t) => {
        title = t;
      });
      write(parser, "\x1b]");
      write(parser, "0;MyTitle\x07");
      expect(title).toBe("MyTitle");
    });

    it("handles >16 CSI params with graceful truncation", () => {
      // 20 params: first 16 stored, rest silently dropped, no crash
      const params = Array.from({ length: 20 }, (_, i) => String(i + 1)).join(";");
      write(parser, `\x1b[${params}m`);
      write(parser, "A");
      expect(readLineTrimmed(bs, 0)).toBe("A");
    });

    it("handles PARAM read-ahead across semicolons correctly", () => {
      // Verify multi-param SGR parsed correctly via read-ahead
      write(parser, "\x1b[1;31;42mX");
      const grid = bs.active.grid;
      expect(readLineTrimmed(bs, 0)).toBe("X");
      // bold (attr bit 0)
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01);
      // fg = 1 (red, from 31-30)
      expect(grid.getFgIndex(0, 0)).toBe(1);
      // bg = 2 (green, from 42-40)
      expect(grid.getBgIndex(0, 0)).toBe(2);
    });

    it("handles OSC with content exceeding MAX_OSC_LENGTH", () => {
      // Very long OSC should be capped without crashing
      const longStr = "A".repeat(5000);
      write(parser, `\x1b]0;${longStr}\x07`);
      // Should not crash, title may be truncated
      write(parser, "OK");
      expect(readLineTrimmed(bs, 0)).toBe("OK");
    });

    it("handles DCS passthrough content correctly", () => {
      // DCS p <content> ST — content should be skipped without crash
      write(parser, "\x1bPpHello World\x1b\\");
      write(parser, "After");
      expect(readLineTrimmed(bs, 0)).toBe("After");
    });

    it("handles ESC fast-path from non-GROUND state", () => {
      // Start an OSC, then interrupt with ESC [ (CSI)
      // \x1b] starts OSC, then \x1b[ should abort OSC and start CSI
      write(parser, "\x1b]0;partial");
      write(parser, "\x1b[1mBold");
      const grid = bs.active.grid;
      expect(readLineTrimmed(bs, 0)).toBe("Bold");
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // bold
    });

    it("parameterless CSI fast-path produces correct result (ESC[A)", () => {
      // Move cursor down then use ESC[A (cursor up) via parameterless fast-path
      write(parser, "\x1b[2;1H"); // row 2, col 1
      write(parser, "\x1b[A"); // cursor up — should go to row 1
      write(parser, "X");
      expect(readLineTrimmed(bs, 0)).toBe("X");
    });

    it("CSI private prefix fast-path matches table path (ESC[?25l/h)", () => {
      // ESC[?25l hides cursor, ESC[?25h shows it — exercises prefix fast-path
      write(parser, "\x1b[?25l");
      write(parser, "\x1b[?25h");
      // Should not crash; cursor visibility is mode state, just verify no error
      write(parser, "OK");
      expect(readLineTrimmed(bs, 0)).toBe("OK");
    });

    it("ESC\\ clears state from aborted CSI sequence", () => {
      // Start a CSI, abort with ESC\, then start a new sequence
      // The clear() in ESC\ should prevent param leakage
      write(parser, "\x1b[31"); // partial CSI (fg red, no final byte yet)
      write(parser, "\x1b\\"); // ST aborts the CSI
      write(parser, "\x1b[mA"); // SGR reset + print A — should have default attrs
      const grid = bs.active.grid;
      expect(readLineTrimmed(bs, 0)).toBe("A");
      expect(grid.getFgIndex(0, 0)).toBe(7); // default fg (white)
    });

    it("OSC terminated by ESC\\ dispatches correctly", () => {
      // ESC\\ should dispatch OSC (bug fix: previously ESC\\ did not call oscDispatch)
      let title = "";
      parser.setTitleChangeCallback((t) => {
        title = t;
      });
      write(parser, "\x1b]0;ST-Title\x1b\\");
      expect(title).toBe("ST-Title");
    });
  });

  // ============================================================
  // DECSET 47 / 1047 — Alternate screen (no cursor save/restore)
  // ============================================================

  describe("DECSET 47/1047 — Alternate screen without cursor save/restore", () => {
    it("DECSET 47 switches to alternate buffer and resets alt cursor to home", () => {
      // Move cursor to an arbitrary position in normal buffer
      write(parser, "\x1b[6;10H"); // CUP to row 6, col 10 (1-indexed → 5,9 zero-based)
      write(parser, "normal");

      write(parser, "\x1b[?47h"); // enter alternate screen
      // Alternate buffer cursor starts at (0, 0)
      expect(cursor(bs)).toEqual({ row: 0, col: 0 });
    });

    it("DECSET 47 clears the alternate buffer on each entry", () => {
      // Write content in the alt buffer, return to normal, then re-enter alt.
      // The alt buffer must be cleared on every entry — old content must not persist.
      write(parser, "\x1b[?47h"); // enter alt
      write(parser, "old-alt-content"); // write to alt
      write(parser, "\x1b[?47l"); // exit to normal
      write(parser, "\x1b[?47h"); // re-enter alt — must clear
      expect(readLineTrimmed(bs, 0)).toBe("");
    });

    it("DECRST 47 returns to normal buffer preserving normal cursor position", () => {
      // Park the normal buffer cursor at row 3, col 5
      write(parser, "\x1b[4;6H"); // CUP (1-indexed) → row=3, col=5
      write(parser, "\x1b[?47h"); // switch to alternate
      write(parser, "alt-text"); // write something in alt
      write(parser, "\x1b[?47l"); // switch back to normal

      // Cursor must be back to where it was in the normal buffer (row 3, col 5)
      expect(cursor(bs)).toEqual({ row: 3, col: 5 });
    });

    it("DECRST 47 hides alternate buffer content, shows normal buffer content", () => {
      write(parser, "normal-line");
      write(parser, "\x1b[?47h"); // to alt buffer
      write(parser, "alt-line");
      write(parser, "\x1b[?47l"); // back to normal

      expect(readLineTrimmed(bs, 0)).toBe("normal-line");
    });

    it("DECSET 1047 is equivalent to 47 — resets alt cursor to home", () => {
      write(parser, "\x1b[5;3H"); // position normal cursor at row 4, col 2
      write(parser, "\x1b[?1047h"); // alternate via 1047
      expect(cursor(bs)).toEqual({ row: 0, col: 0 });
    });

    it("DECRST 1047 returns to normal buffer preserving normal cursor", () => {
      write(parser, "\x1b[4;6H"); // CUP row=3, col=5
      write(parser, "\x1b[?1047h");
      write(parser, "\x1b[?1047l");
      expect(cursor(bs)).toEqual({ row: 3, col: 5 });
    });

    it("DECSET 47 does not save normal cursor — re-entering alt after returning resets cursor again", () => {
      // Enter alt, write something, return, then enter alt again.
      // Unlike 1049, there is no saved cursor to restore on re-entry; alt always starts at home.
      write(parser, "\x1b[?47h"); // first enter
      write(parser, "\x1b[5;5H"); // move to row 4, col 4 inside alt
      write(parser, "\x1b[?47l"); // exit alt
      write(parser, "\x1b[?47h"); // enter alt again — cursor must reset to home
      expect(cursor(bs)).toEqual({ row: 0, col: 0 });
    });
  });

  // ============================================================
  // DECSET 1048 — Save/restore cursor without buffer switch
  // ============================================================

  describe("DECSET 1048 — Save/restore cursor (no buffer switch)", () => {
    it("DECSET 1048 saves the current cursor position", () => {
      write(parser, "\x1b[8;12H"); // CUP row=7, col=11
      write(parser, "\x1b[?1048h"); // save cursor
      write(parser, "\x1b[H"); // move to home
      expect(cursor(bs)).toEqual({ row: 0, col: 0 });

      write(parser, "\x1b[?1048l"); // restore cursor
      expect(cursor(bs)).toEqual({ row: 7, col: 11 });
    });

    it("DECRST 1048 does not switch buffer — still on normal buffer", () => {
      write(parser, "on-normal");
      write(parser, "\x1b[?1048h"); // save cursor
      write(parser, "\x1b[?1048l"); // restore cursor
      // Normal buffer text must still be visible (no buffer switch)
      expect(readLineTrimmed(bs, 0)).toBe("on-normal");
    });

    it("DECRST 1048 with no prior save is a no-op (does not crash)", () => {
      write(parser, "\x1b[5;5H"); // park cursor at row=4, col=4
      // No 1048h first — restoring an unsaved cursor should be safe
      expect(() => write(parser, "\x1b[?1048l")).not.toThrow();
      // Cursor must remain at (4, 4) since there was nothing to restore
      expect(cursor(bs)).toEqual({ row: 4, col: 4 });
    });

    it("DECSET 1048 and DECSC (ESC 7) share the same cursor save slot", () => {
      // Both DECSET 1048 and DECSC write to buf.savedCursor.
      // Save via 1048h, then restore via DECRC (ESC 8) — must return the position
      // that was saved by 1048h, proving the two mechanisms share one slot.
      write(parser, "\x1b[3;3H"); // row=2, col=2
      write(parser, "\x1b[?1048h"); // save via 1048
      write(parser, "\x1b[H"); // move to home
      write(parser, "\x1b8"); // DECRC — restore cursor (should use the 1048-saved position)
      expect(cursor(bs)).toEqual({ row: 2, col: 2 });
    });
  });

  // ============================================================
  // DECKPAM / DECKPNM — Application keypad mode
  // ============================================================

  describe("DECKPAM / DECKPNM — Application keypad mode", () => {
    it("applicationKeypad is false by default", () => {
      expect(parser.applicationKeypad).toBe(false);
    });

    it("ESC= (DECKPAM) enables application keypad mode", () => {
      write(parser, "\x1b=");
      expect(parser.applicationKeypad).toBe(true);
    });

    it("ESC> (DECKPNM) disables application keypad mode", () => {
      write(parser, "\x1b="); // enable first
      write(parser, "\x1b>"); // then disable
      expect(parser.applicationKeypad).toBe(false);
    });

    it("DECKPAM does not affect cursor position or screen content", () => {
      write(parser, "Hello");
      write(parser, "\x1b=");
      expect(readLineTrimmed(bs, 0)).toBe("Hello");
      expect(cursor(bs)).toEqual({ row: 0, col: 5 });
    });

    it("DECKPNM is safe to call without prior DECKPAM", () => {
      // Already false; sending DECKPNM should be a no-op
      write(parser, "\x1b>");
      expect(parser.applicationKeypad).toBe(false);
    });

    it("RIS (ESC c) resets applicationKeypad to false", () => {
      write(parser, "\x1b="); // enable
      write(parser, "\x1bc"); // full reset
      expect(parser.applicationKeypad).toBe(false);
    });
  });
});
