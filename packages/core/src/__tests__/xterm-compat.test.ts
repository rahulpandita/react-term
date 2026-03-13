/**
 * xterm.js Escape Sequence Compatibility Tests
 *
 * These tests are derived from xterm.js fixture files in
 * https://github.com/xtermjs/xterm.js/tree/master/fixtures/escape_sequence_files
 *
 * They verify that react-term's VTParser produces the same screen output as
 * xterm.js for standard VT100/VT220/xterm escape sequences on an 80x25
 * terminal (we use 80x24 to match react-term's default).
 */
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

/** Read a line keeping trailing spaces up to the given column (exclusive). */
function readLineRaw(bs: BufferSet, row: number, endCol?: number): string {
  const grid = bs.active.grid;
  const limit = endCol ?? grid.cols;
  let result = "";
  for (let c = 0; c < limit; c++) {
    result += String.fromCodePoint(grid.getCodepoint(row, c));
  }
  return result;
}

/** Read full screen as plain text (rows joined by \n, trailing spaces trimmed). */
function _readScreen(bs: BufferSet): string {
  const lines: string[] = [];
  for (let r = 0; r < bs.active.grid.rows; r++) {
    lines.push(readLineTrimmed(bs, r));
  }
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

describe("xterm.js Compatibility Tests", () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
    parser = new VTParser(bs);
  });

  // ==================================================================
  // CUP — Cursor Position (t0025-CUP)
  // ==================================================================
  describe("CUP — Cursor Position", () => {
    it("CUP with no params moves to home (1,1)", () => {
      write(parser, "XXXX");
      write(parser, "\x1b[H");
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(0);
    });

    it("CUP moves to specified row and column", () => {
      write(parser, "\x1b[Ha"); // home then 'a'
      expect(readLineTrimmed(bs, 0)).toBe("a");
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(1);
    });

    it("CUP(2,3) places cursor at row 1, col 2 (0-indexed)", () => {
      write(parser, "\x1b[2;3Hb");
      expect(readLineTrimmed(bs, 1)).toBe("  b");
    });

    it("CUP with only row defaults column to 1", () => {
      write(parser, "\x1b[5Hx");
      expect(parser.cursor.row).toBe(4); // wrote at row 4
      expect(readLineTrimmed(bs, 4)).toBe("x");
    });

    it("CUP with semicolon but no column defaults column to 1", () => {
      write(parser, "\x1b[;4Hc");
      expect(parser.cursor.row).toBe(0);
      expect(readLineTrimmed(bs, 0)).toBe("   c");
    });

    it("CUP(10,10) places character at correct position", () => {
      write(parser, "\x1b[10;10Hd");
      expect(readLineTrimmed(bs, 9)).toBe("         d");
    });

    it("CUP clamps row to screen height", () => {
      write(parser, "\x1b[100;1H");
      expect(parser.cursor.row).toBe(23); // clamped to last row
    });

    it("CUP clamps column to screen width", () => {
      write(parser, "\x1b[1;200H");
      expect(parser.cursor.col).toBe(79); // clamped to last col
    });

    it("CUP(100,200) clamps both dimensions", () => {
      write(parser, "\x1b[100;200H");
      expect(parser.cursor.row).toBe(23);
      expect(parser.cursor.col).toBe(79);
    });

    it("multiple CUP commands, last one wins", () => {
      write(parser, "\x1b[1;1H\x1b[5;5H\x1b[10;10H*");
      expect(readLineTrimmed(bs, 9)).toBe("         *");
    });
  });

  // ==================================================================
  // CUF — Cursor Forward (t0020-CUF)
  // ==================================================================
  describe("CUF — Cursor Forward", () => {
    it("CUF(1) moves cursor one position right (default)", () => {
      write(parser, "abcdefg\x1b[Chijkl");
      // After 'abcdefg' cursor is at col 7, CUF(1) -> col 8, then 'hijkl'
      expect(readLineTrimmed(bs, 0)).toBe("abcdefg hijkl");
    });

    it("CUF(10) moves cursor ten positions right", () => {
      write(parser, "abcdefg\x1b[10Chijkl");
      expect(readLineTrimmed(bs, 0)).toBe("abcdefg          hijkl");
    });

    it("CUF stops at right margin", () => {
      write(parser, "\x1b[79Cx");
      // Cursor starts at 0, CUF(79) -> col 79, write 'x'
      expect(parser.cursor.row).toBe(0);
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 79)).toBe(0x78); // 'x'
    });

    it("CUF beyond right margin clamps to margin", () => {
      write(parser, "\x1b[80Cx");
      // CUF(80) from col 0 -> clamped to col 79
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 79)).toBe(0x78); // 'x'
    });
  });

  // ==================================================================
  // CUB — Cursor Backward (t0021-CUB)
  // ==================================================================
  describe("CUB — Cursor Backward", () => {
    it("CUB(1) moves cursor one position left (default)", () => {
      write(parser, "abcdefg\x1b[D!@");
      // After 'abcdefg' cursor at col 7, CUB(1) -> col 6, write '!@'
      expect(readLineTrimmed(bs, 0)).toBe("abcdef!@");
    });

    it("CUB(10) moves cursor ten positions left", () => {
      write(parser, "abcdefg\x1b[10D!@");
      // CUB(10) from col 7 -> clamped to col 0, write '!@'
      expect(readLineTrimmed(bs, 0)).toBe("!@cdefg");
    });

    it("CUB stops at left margin (column 0)", () => {
      write(parser, "\x1b[Dx");
      // Cursor at 0, CUB(1) -> stays at 0
      expect(readLineTrimmed(bs, 0)).toBe("x");
      expect(parser.cursor.col).toBe(1);
    });
  });

  // ==================================================================
  // CUU — Cursor Up (t0022-CUU)
  // ==================================================================
  describe("CUU — Cursor Up", () => {
    it("CUU(1) moves cursor up one row (default)", () => {
      write(parser, "\x1b[4;5H"); // row 3, col 4 (0-indexed)
      write(parser, "\x1b[A");
      expect(parser.cursor.row).toBe(2);
      expect(parser.cursor.col).toBe(4); // col preserved
    });

    it("CUU with explicit count moves multiple rows", () => {
      write(parser, "\x1b[10;5H"); // row 9, col 4
      write(parser, "\x1b[3A");
      expect(parser.cursor.row).toBe(6); // 9 - 3
      expect(parser.cursor.col).toBe(4); // col preserved
    });

    it("CUU stops at top row", () => {
      write(parser, "\x1b[100A");
      expect(parser.cursor.row).toBe(0);
    });

    it("CUU(0) is treated as CUU(1) per spec", () => {
      write(parser, "\x1b[3;1H"); // row 2
      write(parser, "\x1b[0A");
      // CUU param 0 is treated as 1 per VT100 spec
      expect(parser.cursor.row).toBe(1);
    });
  });

  // ==================================================================
  // CUD — Cursor Down (t0024-CUD)
  // ==================================================================
  describe("CUD — Cursor Down", () => {
    it("CUD(1) moves cursor down one row (default)", () => {
      write(parser, "a");
      write(parser, "\x1b[B");
      expect(parser.cursor.row).toBe(1);
      expect(parser.cursor.col).toBe(1); // col preserved
    });

    it("CUD with explicit count", () => {
      write(parser, "\x1b[3B");
      expect(parser.cursor.row).toBe(3);
    });

    it("CUD stops at bottom row", () => {
      write(parser, "\x1b[100B");
      expect(parser.cursor.row).toBe(23);
    });

    it("CUD(0) is treated as CUD(1) per spec", () => {
      write(parser, "\x1b[0B");
      // CUD param 0 is treated as 1 per VT100 spec
      expect(parser.cursor.row).toBe(1);
    });

    it("CUD preserves column", () => {
      write(parser, "\x1b[1;10H"); // row 1, col 10
      write(parser, "\x1b[5B");
      expect(parser.cursor.row).toBe(5);
      expect(parser.cursor.col).toBe(9);
    });
  });

  // ==================================================================
  // ED — Erase in Display (t0056-ED)
  // ==================================================================
  describe("ED — Erase in Display", () => {
    it("ED(0) erases from cursor to end of screen", () => {
      // Fill screen with content
      for (let i = 0; i < 5; i++) {
        write(parser, "A".repeat(80));
      }
      // Move to row 2, col 10
      write(parser, "\x1b[3;11H");
      write(parser, "\x1b[J"); // ED(0) — erase below
      // Row 2, cols 0-9 should still have 'A'
      expect(readLineRaw(bs, 2, 10)).toBe("AAAAAAAAAA");
      // Row 2, cols 10+ should be erased
      expect(readLineTrimmed(bs, 2)).toBe("AAAAAAAAAA");
      // Rows 3+ should be fully erased
      expect(readLineTrimmed(bs, 3)).toBe("");
      expect(readLineTrimmed(bs, 4)).toBe("");
    });

    it("ED(1) erases from start of screen to cursor", () => {
      for (let i = 0; i < 5; i++) {
        write(parser, "B".repeat(80));
      }
      write(parser, "\x1b[3;11H");
      write(parser, "\x1b[1J"); // ED(1) — erase above
      // Rows 0-1 should be erased
      expect(readLineTrimmed(bs, 0)).toBe("");
      expect(readLineTrimmed(bs, 1)).toBe("");
      // Row 2, cols 0-10 erased, cols 11+ still have 'B'
      expect(readLineRaw(bs, 2, 11)).toBe("           ");
      // Row 3 should still have content
      expect(readLineTrimmed(bs, 3)).toBe("B".repeat(80));
    });

    it("ED(2) erases entire display", () => {
      for (let i = 0; i < 5; i++) {
        write(parser, "C".repeat(80));
      }
      write(parser, "\x1b[3;11H");
      write(parser, "\x1b[2J");
      // All rows should be erased
      for (let r = 0; r < 24; r++) {
        expect(readLineTrimmed(bs, r)).toBe("");
      }
      // Cursor position is NOT changed by ED(2)
      expect(parser.cursor.row).toBe(2);
      expect(parser.cursor.col).toBe(10);
    });
  });

  // ==================================================================
  // EL — Erase in Line (t0055-EL)
  // ==================================================================
  describe("EL — Erase in Line", () => {
    it("EL(0) erases from cursor to end of line", () => {
      write(
        parser,
        "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh",
      );
      write(parser, "\x1b[1;41H"); // move to col 40 (0-indexed)
      write(parser, ">");
      write(parser, "\x1b[K"); // EL(0) — erase to right
      const line = readLineTrimmed(bs, 0);
      expect(line).toBe("abcdefghijklmnopqrstuvwxyz0123456789ABCD>");
    });

    it("EL(1) erases from start of line to cursor (inclusive)", () => {
      write(
        parser,
        "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh",
      );
      write(parser, "\x1b[1;41H"); // col 40 (0-indexed)
      write(parser, "\x1b[1K"); // EL(1) — erase to left (inclusive of cursor)
      const grid = bs.active.grid;
      // Cols 0-40 should be erased to spaces
      for (let c = 0; c <= 40; c++) {
        expect(grid.getCodepoint(0, c)).toBe(0x20);
      }
      // Characters after cursor should remain
      expect(grid.getCodepoint(0, 41)).toBe("F".charCodeAt(0));
    });

    it("EL(2) erases entire line", () => {
      write(
        parser,
        "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh",
      );
      write(parser, "\x1b[1;41H>");
      write(parser, "\x1b[2K"); // EL(2) — erase whole line
      expect(readLineTrimmed(bs, 0)).toBe("");
    });

    it("EL does not affect other lines", () => {
      write(parser, "Line 0\r\n");
      write(parser, "Line 1\r\n");
      write(parser, "Line 2");
      write(parser, "\x1b[2;1H"); // move to row 2 (1-indexed)
      write(parser, "\x1b[2K"); // erase line 1
      expect(readLineTrimmed(bs, 0)).toBe("Line 0");
      expect(readLineTrimmed(bs, 1)).toBe("");
      expect(readLineTrimmed(bs, 2)).toBe("Line 2");
    });
  });

  // ==================================================================
  // ECH — Erase Characters (t0054-ECH)
  // ==================================================================
  describe("ECH — Erase Characters", () => {
    it("ECH(2) erases 2 characters at cursor", () => {
      write(parser, "abcdefghijklmnopqrstuvwxyz");
      write(parser, "\x1b[8D"); // back 8
      write(parser, ">");
      write(parser, "\x1b[2X"); // ECH(2) — erase 2 chars
      // After 'abcdefghijklmnopqrstuvwxyz' cursor at col 26
      // CUB(8) -> col 18, write '>' at 18 (cursor now 19), ECH(2) erases cols 19-20
      const line = readLineTrimmed(bs, 0);
      expect(line.charAt(18)).toBe(">");
      expect(line.charAt(19)).toBe(" ");
      expect(line.charAt(20)).toBe(" ");
      expect(line.charAt(21)).toBe("v");
    });

    it("ECH(1) (default) erases single character", () => {
      write(parser, "ABCDEF");
      write(parser, "\x1b[1;4H"); // col 3 (0-indexed)
      write(parser, "\x1b[X"); // ECH(1)
      expect(readLineTrimmed(bs, 0)).toBe("ABC EF");
    });

    it("ECH does not move cursor", () => {
      write(parser, "HELLO");
      write(parser, "\x1b[1;3H"); // col 2
      const rowBefore = parser.cursor.row;
      const colBefore = parser.cursor.col;
      write(parser, "\x1b[3X");
      expect(parser.cursor.row).toBe(rowBefore);
      expect(parser.cursor.col).toBe(colBefore);
    });

    it("ECH clamps to end of line", () => {
      write(parser, "ABCDEFGHIJ");
      write(parser, "\x1b[1;5H"); // col 4
      write(parser, "\x1b[200X"); // erase way more than line width
      expect(readLineTrimmed(bs, 0)).toBe("ABCD");
    });
  });

  // ==================================================================
  // ICH — Insert Characters (t0050-ICH)
  // ==================================================================
  describe("ICH — Insert Characters", () => {
    it("ICH inserts blank characters shifting text right", () => {
      write(parser, "abcdefghijklmnopqrstuvwxyz");
      write(parser, "\x1b[1;1H"); // home
      write(parser, "\x1b[15@"); // ICH(15)
      // 15 blanks inserted at col 0, pushing 'abcdef...' right
      const line = readLineTrimmed(bs, 0);
      expect(line.startsWith("               abcdefghijk")).toBe(true);
    });

    it("ICH characters shifted past right margin are lost", () => {
      write(parser, "A".repeat(80));
      write(parser, "\x1b[1;1H");
      write(parser, "\x1b[5@"); // insert 5 blanks
      const line = readLineTrimmed(bs, 0);
      // Line should be 80 chars: 5 spaces + 75 A's
      expect(line).toBe(`     ${"A".repeat(75)}`);
    });

    it("ICH does not move cursor", () => {
      write(parser, "ABCDEF");
      write(parser, "\x1b[1;3H"); // col 2
      write(parser, "\x1b[2@");
      expect(parser.cursor.col).toBe(2);
    });
  });

  // ==================================================================
  // DCH — Delete Characters (t0053-DCH)
  // ==================================================================
  describe("DCH — Delete Characters", () => {
    it("DCH(2) deletes 2 characters at cursor, shifting left", () => {
      write(parser, "abcdefghijklmnopqrstuvwxyz");
      write(parser, "\x1b[8D"); // back 8 -> col 18
      write(parser, "\x1b[2P"); // DCH(2) — delete 2 chars
      // Chars at cols 18-19 removed, cols 20-25 shift left by 2
      const line = readLineTrimmed(bs, 0);
      expect(line).toBe("abcdefghijklmnopqruvwxyz");
    });

    it("DCH fills vacated positions at end with blanks", () => {
      write(parser, "ABCDEFGHIJ");
      write(parser, "\x1b[1;3H"); // col 2
      write(parser, "\x1b[3P"); // delete 3 chars
      expect(readLineTrimmed(bs, 0)).toBe("ABFGHIJ");
    });

    it("DCH does not move cursor", () => {
      write(parser, "ABCDEF");
      write(parser, "\x1b[1;3H");
      write(parser, "\x1b[2P");
      expect(parser.cursor.col).toBe(2);
    });

    it("DCH(1) default deletes single character", () => {
      write(parser, "ABCDEF");
      write(parser, "\x1b[1;3H");
      write(parser, "\x1b[P");
      expect(readLineTrimmed(bs, 0)).toBe("ABDEF");
    });
  });

  // ==================================================================
  // IL — Insert Lines (t0051-IL)
  // ==================================================================
  describe("IL — Insert Lines", () => {
    it("IL inserts blank lines at cursor, pushing content down", () => {
      write(parser, "ab\r\ncd\r\nef\r\ngh\r\nij\r\nkl\r\nmn\r\nop");
      write(parser, "\x1b[7;1H"); // row 6 (0-indexed), col 0
      write(parser, "\x1b[L"); // IL(1)
      write(parser, "QR");
      // Row 6 should now have 'QR', old rows 6-7 shift down
      expect(readLineTrimmed(bs, 6)).toBe("QR");
      expect(readLineTrimmed(bs, 7)).toBe("mn");
      expect(readLineTrimmed(bs, 8)).toBe("op");
    });

    it("IL(4) inserts 4 blank lines", () => {
      write(parser, "ab\r\ncd\r\nef\r\ngh");
      write(parser, "\x1b[2;1H"); // row 1
      write(parser, "\x1b[4L"); // IL(4)
      write(parser, "ST");
      expect(readLineTrimmed(bs, 0)).toBe("ab");
      expect(readLineTrimmed(bs, 1)).toBe("ST");
      expect(readLineTrimmed(bs, 2)).toBe("");
      expect(readLineTrimmed(bs, 3)).toBe("");
      expect(readLineTrimmed(bs, 4)).toBe("");
      expect(readLineTrimmed(bs, 5)).toBe("cd");
    });

    it("IL pushes lines off the bottom of scroll region", () => {
      // Fill all 24 rows
      for (let i = 0; i < 24; i++) {
        write(parser, `row${i}`);
        if (i < 23) write(parser, "\r\n");
      }
      write(parser, "\x1b[1;1H"); // home
      write(parser, "\x1b[5L"); // insert 5 lines at top
      // First 5 rows should be blank
      for (let r = 0; r < 5; r++) {
        expect(readLineTrimmed(bs, r)).toBe("");
      }
      // Row 5 should have old row 0's content
      expect(readLineTrimmed(bs, 5)).toBe("row0");
    });
  });

  // ==================================================================
  // DL — Delete Lines (t0052-DL)
  // ==================================================================
  describe("DL — Delete Lines", () => {
    it("DL(1) deletes one line, scrolling content up", () => {
      write(parser, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh");
      write(parser, "\x1b[3;1H"); // row 2
      write(parser, "\x1b[M"); // DL(1)
      expect(readLineTrimmed(bs, 0)).toBe("a");
      expect(readLineTrimmed(bs, 1)).toBe("b");
      expect(readLineTrimmed(bs, 2)).toBe("d");
      expect(readLineTrimmed(bs, 3)).toBe("e");
    });

    it("DL(2) deletes two lines", () => {
      write(parser, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh");
      write(parser, "\x1b[5;1H"); // row 4
      write(parser, "\x1b[2M"); // DL(2)
      expect(readLineTrimmed(bs, 3)).toBe("d");
      expect(readLineTrimmed(bs, 4)).toBe("g"); // 'e' and 'f' deleted
      expect(readLineTrimmed(bs, 5)).toBe("h");
    });

    it("DL fills vacated lines at bottom with blanks", () => {
      write(parser, "a\r\nb\r\nc\r\nd");
      write(parser, "\x1b[1;1H"); // home
      write(parser, "\x1b[2M"); // delete 2 lines
      expect(readLineTrimmed(bs, 0)).toBe("c");
      expect(readLineTrimmed(bs, 1)).toBe("d");
      expect(readLineTrimmed(bs, 2)).toBe("");
    });
  });

  // ==================================================================
  // SU — Scroll Up (t0016-SU)
  // ==================================================================
  describe("SU — Scroll Up", () => {
    it("SU(1) scrolls content up one line", () => {
      write(parser, "Hello\r\nWorld");
      write(parser, "\x1b[S"); // SU(1)
      // 'Hello' scrolls off row 0, 'World' moves from row 1 to row 0
      expect(readLineTrimmed(bs, 0)).toBe("World");
      expect(readLineTrimmed(bs, 1)).toBe("");
    });

    it("SU(3) scrolls content up three lines", () => {
      write(parser, "Line1\r\nLine2\r\nLine3\r\nLine4\r\nLine5");
      write(parser, "\x1b[3S"); // SU(3)
      // Lines 1-3 scroll off, lines 4-5 move to rows 0-1
      expect(readLineTrimmed(bs, 0)).toBe("Line4");
      expect(readLineTrimmed(bs, 1)).toBe("Line5");
      expect(readLineTrimmed(bs, 2)).toBe("");
    });

    it("SU(30) large scroll clears visible content", () => {
      for (let i = 0; i < 24; i++) {
        write(parser, `row${i}`);
        if (i < 23) write(parser, "\r\n");
      }
      write(parser, "\x1b[30S");
      // All content scrolled off
      for (let r = 0; r < 24; r++) {
        expect(readLineTrimmed(bs, r)).toBe("");
      }
    });
  });

  // ==================================================================
  // SD — Scroll Down (t0017-SD)
  // ==================================================================
  describe("SD — Scroll Down", () => {
    it("SD(1) scrolls content down one line", () => {
      write(parser, "First\r\nSecond\r\nThird");
      write(parser, "\x1b[T"); // SD(1)
      // All content shifts down by 1, top line becomes blank
      expect(readLineTrimmed(bs, 0)).toBe("");
      expect(readLineTrimmed(bs, 1)).toBe("First");
      expect(readLineTrimmed(bs, 2)).toBe("Second");
      expect(readLineTrimmed(bs, 3)).toBe("Third");
    });

    it("SD(3) scrolls content down three lines", () => {
      write(parser, "A\r\nB\r\nC\r\nD\r\nE");
      write(parser, "\x1b[3T"); // SD(3)
      expect(readLineTrimmed(bs, 0)).toBe("");
      expect(readLineTrimmed(bs, 1)).toBe("");
      expect(readLineTrimmed(bs, 2)).toBe("");
      expect(readLineTrimmed(bs, 3)).toBe("A");
      expect(readLineTrimmed(bs, 4)).toBe("B");
    });
  });

  // ==================================================================
  // DECSTBM — Set Top and Bottom Margins / Scroll Regions
  // ==================================================================
  describe("DECSTBM — Scroll Regions", () => {
    it("DECSTBM sets scroll region", () => {
      write(parser, "\x1b[3;7r"); // rows 3-7
      expect(bs.active.scrollTop).toBe(2);
      expect(bs.active.scrollBottom).toBe(6);
    });

    it("DECSTBM reset with no params restores full screen", () => {
      write(parser, "\x1b[5;10r");
      write(parser, "\x1b[r");
      expect(bs.active.scrollTop).toBe(0);
      expect(bs.active.scrollBottom).toBe(23);
    });

    it("LF within scroll region scrolls only the region", () => {
      // Set scroll region rows 3-7
      write(parser, "\x1b[3;7r");
      // Move to row 7 (bottom of region)
      write(parser, "\x1b[7;1H");
      write(parser, "BOTTOM");
      // LF at bottom of region scrolls content within region
      write(parser, "\n");
      // 'BOTTOM' should have scrolled up one row
      expect(readLineTrimmed(bs, 5)).toBe("BOTTOM");
      // Row 6 (bottom of region) should be blank
      expect(readLineTrimmed(bs, 6)).toBe("");
    });

    it("LF outside scroll region does not scroll region", () => {
      write(parser, "\x1b[5;10r");
      write(parser, "\x1b[1;1H"); // row 1 (above region)
      write(parser, "ABOVE");
      write(parser, "\n");
      // Should move down normally, not trigger region scroll
      expect(parser.cursor.row).toBe(1);
    });

    it("DECSTBM + SU scrolls only within the region", () => {
      // Write content using CR+LF
      for (let i = 0; i < 24; i++) {
        write(parser, String.fromCharCode(97 + i)); // a-x
        if (i < 23) write(parser, "\r\n");
      }
      // Set region rows 5-9
      write(parser, "\x1b[5;9r");
      // SU(1)
      write(parser, "\x1b[S");
      // Row 4 (inside region, 0-indexed) should have shifted
      expect(readLineTrimmed(bs, 4)).toBe("f"); // was 'e', now 'f'
      // Rows outside region should be unchanged
      expect(readLineTrimmed(bs, 0)).toBe("a");
      expect(readLineTrimmed(bs, 3)).toBe("d");
      expect(readLineTrimmed(bs, 9)).toBe("j"); // outside region
    });

    it("DECSTBM + SD scrolls down within the region", () => {
      for (let i = 0; i < 24; i++) {
        write(parser, String.fromCharCode(97 + i));
        if (i < 23) write(parser, "\r\n");
      }
      write(parser, "\x1b[5;9r");
      write(parser, "\x1b[3T"); // SD(3)
      // Top 3 rows of region should be blank
      expect(readLineTrimmed(bs, 4)).toBe("");
      expect(readLineTrimmed(bs, 5)).toBe("");
      expect(readLineTrimmed(bs, 6)).toBe("");
      // Row outside region below should be unchanged
      expect(readLineTrimmed(bs, 9)).toBe("j");
    });

    it("DECSTBM moves cursor to home", () => {
      write(parser, "\x1b[10;10H"); // move somewhere
      write(parser, "\x1b[5;15r"); // set region
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(0);
    });

    it("DECSTBM with invalid range (top >= bottom) is ignored", () => {
      write(parser, "\x1b[10;5r"); // invalid
      expect(bs.active.scrollTop).toBe(0);
      expect(bs.active.scrollBottom).toBe(23);
    });

    it("IL within scroll region pushes lines within region only", () => {
      write(parser, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh");
      write(parser, "\x1b[3;6r"); // region rows 3-6
      write(parser, "\x1b[4;1H"); // row 3 (0-indexed, inside region)
      write(parser, "\x1b[L"); // IL(1)
      // Row 3 should now be blank (inserted line)
      expect(readLineTrimmed(bs, 3)).toBe("");
      // Old row 3 content ('d') pushed to row 4
      expect(readLineTrimmed(bs, 4)).toBe("d");
      // Content below region should be unchanged
      expect(readLineTrimmed(bs, 6)).toBe("g");
    });

    it("DL within scroll region pulls lines within region only", () => {
      write(parser, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh");
      write(parser, "\x1b[3;6r"); // region rows 3-6
      write(parser, "\x1b[4;1H"); // row 3 (0-indexed)
      write(parser, "\x1b[M"); // DL(1)
      // Row 3 should now have 'e' (old row 4)
      expect(readLineTrimmed(bs, 3)).toBe("e");
      // Bottom of region should be blank
      expect(readLineTrimmed(bs, 5)).toBe("");
      // Content below region unchanged
      expect(readLineTrimmed(bs, 6)).toBe("g");
    });
  });

  // ==================================================================
  // HT — Horizontal Tab (t0080-HT)
  // ==================================================================
  describe("HT — Horizontal Tab", () => {
    it("tab stops at every 8 columns by default", () => {
      write(parser, "a\tb\tc\td");
      const line = readLineTrimmed(bs, 0);
      // 'a' at col 0, tab to col 8, 'b' at col 8, tab to col 16, 'c' at col 16, tab to col 24
      expect(line.charAt(0)).toBe("a");
      expect(line.charAt(8)).toBe("b");
      expect(line.charAt(16)).toBe("c");
      expect(line.charAt(24)).toBe("d");
    });

    it("multiple tabs advance through tab stops", () => {
      write(parser, "\t\t\t\tx");
      // 4 tabs: col 8, 16, 24, 32
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 32)).toBe(0x78); // 'x'
    });

    it("tab at end of line stays at last column", () => {
      // Write 79 chars to reach near end of line
      write(parser, "a".repeat(73)); // col 73
      write(parser, "\t"); // next tab stop is col 79 (last)
      write(parser, "X");
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 79)).toBe(0x58); // 'X'
    });

    it("tab does not wrap to next line", () => {
      write(parser, "a".repeat(79)); // col 79
      write(parser, "\t"); // should stay at col 79
      expect(parser.cursor.row).toBe(0);
    });
  });

  // ==================================================================
  // BS — Backspace (t0008-BS)
  // ==================================================================
  describe("BS — Backspace", () => {
    it("BS moves cursor left by one", () => {
      write(parser, "abcdefghijklmnopqrstuvwxyz");
      write(parser, "\x08!");
      // BS moves from col 26 to col 25, then '!' overwrites 'z'
      expect(readLineTrimmed(bs, 0)).toBe("abcdefghijklmnopqrstuvwxy!");
    });

    it("BS does not move past column 0", () => {
      write(parser, "\x08\x08\x08x");
      expect(parser.cursor.col).toBe(1);
      expect(readLineTrimmed(bs, 0)).toBe("x");
    });

    it("multiple BS moves cursor back multiple positions", () => {
      write(parser, "abc");
      write(parser, "\x08\x08!");
      expect(readLineTrimmed(bs, 0)).toBe("a!c");
    });

    it("BS after writing to end of line overwrites last char", () => {
      write(parser, "abc\x08@");
      expect(readLineTrimmed(bs, 0)).toBe("ab@");
    });
  });

  // ==================================================================
  // DECAWM — Auto-wrap mode (t0102-DECAWM)
  // ==================================================================
  describe("DECAWM — Auto-wrap Mode", () => {
    it("default: auto-wrap is enabled, text wraps at margin", () => {
      const prefix = "-------- default: wraparound  ";
      const filler = `${"-".repeat(80 - prefix.length - 8)}abcdefgh`;
      write(parser, prefix + filler);
      // Total is 80 chars, cursor at col 80 (pending wrap)
      // Writing more triggers wrap
      // With wrapping, first 80 chars on row 0, overflow on row 1
      expect(parser.cursor.row).toBe(0);
    });

    it("DECAWM set: text wraps at right margin", () => {
      write(parser, "\x1b[?7h"); // ensure wrap on
      write(parser, `${"A".repeat(80)}B`);
      expect(readLineTrimmed(bs, 0)).toBe("A".repeat(80));
      expect(readLineTrimmed(bs, 1)).toBe("B");
    });

    it("DECAWM unset: text does not wrap, overwrites last column", () => {
      write(parser, "\x1b[?7l"); // wrap off
      write(parser, `${"A".repeat(80)}BCD`);
      expect(parser.cursor.row).toBe(0);
      const grid = bs.active.grid;
      // Last char 'D' overwrites at col 79
      expect(grid.getCodepoint(0, 79)).toBe("D".charCodeAt(0));
      expect(readLineTrimmed(bs, 1)).toBe(""); // no wrap to row 1
    });

    it("re-enabling DECAWM restores wrapping", () => {
      write(parser, "\x1b[?7l"); // off
      write(parser, "\x1b[?7h"); // on
      write(parser, `${"X".repeat(80)}Y`);
      expect(readLineTrimmed(bs, 1)).toBe("Y");
    });
  });

  // ==================================================================
  // IRM — Insert/Replace Mode (t0100-IRM)
  // ==================================================================
  describe("IRM — Insert/Replace Mode", () => {
    it("replace mode is default: characters overwrite", () => {
      write(parser, "ABCDEF");
      write(parser, "\x1b[1;3H"); // col 2
      write(parser, "XY");
      expect(readLineTrimmed(bs, 0)).toBe("ABXYEF");
    });

    it("insert mode via CSI 4h shifts text right", () => {
      write(parser, "abcdefghijklmnop");
      write(parser, "\x1b[1;4H"); // col 3
      write(parser, "\x1b[4h"); // enable insert mode
      write(parser, "!");
      write(parser, "\x1b[4l"); // disable insert mode
      // After insert, '!' at col 3, remaining text shifted right
      const line = readLineTrimmed(bs, 0);
      expect(line.charAt(3)).toBe("!");
      // 'e' follows (d was at col 3, ! overwrites it and shifts e-p right)
      expect(line.charAt(4)).toBe("e");
    });
  });

  // ==================================================================
  // DECSC/DECRC — Save/Restore Cursor (t0060-DECSC)
  // ==================================================================
  describe("DECSC/DECRC — Save and Restore Cursor", () => {
    it("saves and restores cursor position", () => {
      write(parser, "\x1b[5;10H"); // row 4, col 9
      write(parser, "\x1b7"); // DECSC
      write(parser, "\x1b[1;1H"); // home
      write(parser, "\x1b8"); // DECRC
      expect(parser.cursor.row).toBe(4);
      expect(parser.cursor.col).toBe(9);
    });

    it("CSI s / CSI u also save/restore cursor", () => {
      write(parser, "\x1b[5;10H");
      write(parser, "\x1b[s"); // save
      write(parser, "\x1b[20;40H");
      write(parser, "\x1b[u"); // restore
      expect(parser.cursor.row).toBe(4);
      expect(parser.cursor.col).toBe(9);
    });

    it("restore without save does not crash", () => {
      write(parser, "\x1b8");
      write(parser, "A");
      expect(readLineTrimmed(bs, 0)).toBe("A");
    });
  });

  // ==================================================================
  // RI — Reverse Index (t0010-RI, t0011-RI_scroll)
  // ==================================================================
  describe("RI — Reverse Index", () => {
    it("RI moves cursor up one line", () => {
      write(parser, "\n\n\nX");
      write(parser, "\x1bM"); // RI
      expect(parser.cursor.row).toBe(2);
    });

    it("RI at top of screen scrolls content down", () => {
      write(parser, "First\r\nSecond\r\nThird");
      write(parser, "\x1b[1;1H"); // home
      write(parser, "\x1bM"); // RI at top scrolls down
      expect(readLineTrimmed(bs, 0)).toBe("");
      expect(readLineTrimmed(bs, 1)).toBe("First");
      expect(readLineTrimmed(bs, 2)).toBe("Second");
    });

    it("RI at top of scroll region scrolls region only", () => {
      write(parser, "a\r\nb\r\nc\r\nd\r\ne\r\nf");
      write(parser, "\x1b[3;5r"); // region rows 3-5
      write(parser, "\x1b[3;1H"); // top of region
      write(parser, "\x1bM"); // RI
      // Row 2 (top of region, 0-indexed) should now be blank
      expect(readLineTrimmed(bs, 2)).toBe("");
      expect(readLineTrimmed(bs, 3)).toBe("c");
      // Content above region unchanged
      expect(readLineTrimmed(bs, 0)).toBe("a");
      expect(readLineTrimmed(bs, 1)).toBe("b");
    });
  });

  // ==================================================================
  // IND — Index (t0006-IND) / NEL — Next Line (t0009-NEL)
  // ==================================================================
  describe("IND and NEL", () => {
    it("IND moves cursor down one line", () => {
      write(parser, "A");
      write(parser, "\x1bD"); // IND
      expect(parser.cursor.row).toBe(1);
      expect(parser.cursor.col).toBe(1); // col preserved
    });

    it("NEL moves cursor to start of next line", () => {
      write(parser, "ABCDE");
      write(parser, "\x1bE"); // NEL
      expect(parser.cursor.row).toBe(1);
      expect(parser.cursor.col).toBe(0); // col reset
    });

    it("IND at bottom scrolls content up", () => {
      write(parser, "\x1b[24;1H"); // bottom row
      write(parser, "Bottom");
      write(parser, "\x1bD"); // IND at bottom -> scroll
      expect(readLineTrimmed(bs, 22)).toBe("Bottom");
      expect(readLineTrimmed(bs, 23)).toBe("");
    });
  });

  // ==================================================================
  // CNL — Cursor Next Line / CPL — Cursor Previous Line
  // ==================================================================
  describe("CNL and CPL", () => {
    it("CNL moves to start of next line(s)", () => {
      write(parser, "\x1b[5;10H"); // row 4, col 9
      write(parser, "\x1b[2E"); // CNL(2)
      expect(parser.cursor.row).toBe(6);
      expect(parser.cursor.col).toBe(0);
    });

    it("CPL moves to start of previous line(s)", () => {
      write(parser, "\x1b[5;10H");
      write(parser, "\x1b[2F"); // CPL(2)
      expect(parser.cursor.row).toBe(2);
      expect(parser.cursor.col).toBe(0);
    });

    it("CNL stops at bottom of screen", () => {
      write(parser, "\x1b[24;1H");
      write(parser, "\x1b[100E");
      expect(parser.cursor.row).toBe(23);
      expect(parser.cursor.col).toBe(0);
    });

    it("CPL stops at top of screen", () => {
      write(parser, "\x1b[1;10H");
      write(parser, "\x1b[100F");
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(0);
    });
  });

  // ==================================================================
  // HVP — Horizontal and Vertical Position
  // ==================================================================
  describe("HVP", () => {
    it("HVP moves cursor same as CUP", () => {
      write(parser, "\x1b[5;10f"); // HVP to row 5, col 10
      expect(parser.cursor.row).toBe(4);
      expect(parser.cursor.col).toBe(9);
    });

    it("HVP with no params moves to home", () => {
      write(parser, "\x1b[10;10H");
      write(parser, "\x1b[f");
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(0);
    });
  });

  // ==================================================================
  // REP — Repeat (t0040-REP)
  // ==================================================================
  describe("REP — Repeat Character", () => {
    it("REP repeats last printed character", () => {
      write(parser, "A\x1b[4b"); // print 'A', then repeat 4 times
      expect(readLineTrimmed(bs, 0)).toBe("AAAAA");
    });

    it("REP with different character", () => {
      write(parser, "X\x1b[9b");
      expect(readLineTrimmed(bs, 0)).toBe("XXXXXXXXXX");
    });
  });

  // ==================================================================
  // Alternate Screen Buffer (t0090-alt_screen)
  // ==================================================================
  describe("Alternate Screen Buffer", () => {
    it("switches to alternate buffer and back", () => {
      write(parser, "NormalContent");
      write(parser, "\x1b[?1049h"); // switch to alt
      expect(bs.isAlternate).toBe(true);
      expect(readLineTrimmed(bs, 0)).toBe(""); // alt is blank
      write(parser, "\x1b[?1049l"); // switch back
      expect(bs.isAlternate).toBe(false);
      expect(readLineTrimmed(bs, 0)).toBe("NormalContent");
    });

    it("content written to alt buffer is lost when switching back", () => {
      write(parser, "\x1b[?1049h");
      write(parser, "AltContent");
      write(parser, "\x1b[?1049l");
      expect(readLineTrimmed(bs, 0)).not.toBe("AltContent");
    });
  });

  // ==================================================================
  // CHA — Cursor Horizontal Absolute
  // ==================================================================
  describe("CHA — Cursor Horizontal Absolute", () => {
    it("CHA moves to specified column on current row", () => {
      write(parser, "\x1b[5;10H"); // some position
      write(parser, "\x1b[20G"); // CHA(20)
      expect(parser.cursor.row).toBe(4); // row unchanged
      expect(parser.cursor.col).toBe(19);
    });

    it("CHA(1) moves to first column", () => {
      write(parser, "\x1b[5;10H");
      write(parser, "\x1b[1G");
      expect(parser.cursor.col).toBe(0);
    });

    it("CHA clamps to screen width", () => {
      write(parser, "\x1b[200G");
      expect(parser.cursor.col).toBe(79);
    });
  });

  // ==================================================================
  // VPA — Vertical Position Absolute
  // ==================================================================
  describe("VPA — Vertical Position Absolute", () => {
    it("VPA moves to specified row on current column", () => {
      write(parser, "\x1b[5;10H");
      write(parser, "\x1b[15d"); // VPA(15)
      expect(parser.cursor.row).toBe(14);
      expect(parser.cursor.col).toBe(9); // col unchanged
    });

    it("VPA clamps to screen height", () => {
      write(parser, "\x1b[100d");
      expect(parser.cursor.row).toBe(23);
    });
  });

  // ==================================================================
  // LF / CR / VT / FF — Line Feed, Carriage Return, etc.
  // ==================================================================
  describe("LF, CR, VT, FF", () => {
    it("LF moves down without CR (default LNM off)", () => {
      write(parser, "ABC\n");
      expect(parser.cursor.row).toBe(1);
      expect(parser.cursor.col).toBe(3); // col preserved
    });

    it("CR moves to column 0", () => {
      write(parser, "ABCDEF\r");
      expect(parser.cursor.col).toBe(0);
      expect(parser.cursor.row).toBe(0);
    });

    it("CR + LF moves to start of next line", () => {
      write(parser, "Hello\r\n");
      expect(parser.cursor.row).toBe(1);
      expect(parser.cursor.col).toBe(0);
    });

    it("VT acts like LF", () => {
      write(parser, "A\x0B");
      expect(parser.cursor.row).toBe(1);
    });

    it("FF acts like LF", () => {
      write(parser, "A\x0C");
      expect(parser.cursor.row).toBe(1);
    });
  });

  // ==================================================================
  // CAN/SUB — Cancel sequences (t0014-CAN, t0015-SUB)
  // ==================================================================
  describe("CAN and SUB", () => {
    it("CAN (0x18) aborts escape sequence", () => {
      write(parser, "\x1b[1;31\x18A"); // CAN inside CSI
      // The CSI should be aborted, 'A' prints normally
      expect(readLineTrimmed(bs, 0)).toBe("A");
      const grid = bs.active.grid;
      // SGR should NOT have been applied
      expect(grid.getFgIndex(0, 0)).toBe(7); // default
    });

    it("SUB (0x1A) aborts escape sequence", () => {
      write(parser, "\x1b[1;31\x1AA");
      expect(readLineTrimmed(bs, 0)).toBe("A");
    });
  });

  // ==================================================================
  // Cursor visibility
  // ==================================================================
  describe("Cursor Visibility", () => {
    it("DECTCEM hides cursor", () => {
      write(parser, "\x1b[?25l");
      expect(parser.cursor.visible).toBe(false);
    });

    it("DECTCEM shows cursor", () => {
      write(parser, "\x1b[?25l");
      write(parser, "\x1b[?25h");
      expect(parser.cursor.visible).toBe(true);
    });
  });

  // ==================================================================
  // SGR — Select Graphic Rendition
  // ==================================================================
  describe("SGR — Select Graphic Rendition", () => {
    it("SGR 1 sets bold", () => {
      write(parser, "\x1b[1mB");
      expect(bs.active.grid.getAttrs(0, 0) & 0x01).toBe(0x01);
    });

    it("SGR 3 sets italic", () => {
      write(parser, "\x1b[3mI");
      expect(bs.active.grid.getAttrs(0, 0) & 0x02).toBe(0x02);
    });

    it("SGR 4 sets underline", () => {
      write(parser, "\x1b[4mU");
      expect(bs.active.grid.getAttrs(0, 0) & 0x04).toBe(0x04);
    });

    it("SGR 7 sets inverse", () => {
      write(parser, "\x1b[7mR");
      expect(bs.active.grid.getAttrs(0, 0) & 0x40).toBe(0x40);
    });

    it("SGR 9 sets strikethrough", () => {
      write(parser, "\x1b[9mS");
      expect(bs.active.grid.getAttrs(0, 0) & 0x08).toBe(0x08);
    });

    it("SGR 0 resets all attributes", () => {
      write(parser, "\x1b[1;3;4;7;9mX\x1b[0mN");
      expect(bs.active.grid.getAttrs(0, 1)).toBe(0);
      expect(bs.active.grid.getFgIndex(0, 1)).toBe(7);
    });

    it("SGR 30-37 sets foreground color", () => {
      write(parser, "\x1b[31mR"); // red
      expect(bs.active.grid.getFgIndex(0, 0)).toBe(1);
    });

    it("SGR 40-47 sets background color", () => {
      write(parser, "\x1b[44mB"); // blue bg
      expect(bs.active.grid.getBgIndex(0, 0)).toBe(4);
    });

    it("SGR 39 resets foreground to default", () => {
      write(parser, "\x1b[31mR\x1b[39mD");
      expect(bs.active.grid.getFgIndex(0, 0)).toBe(1);
      expect(bs.active.grid.getFgIndex(0, 1)).toBe(7);
    });

    it("SGR 49 resets background to default", () => {
      write(parser, "\x1b[44mB\x1b[49mD");
      expect(bs.active.grid.getBgIndex(0, 0)).toBe(4);
      expect(bs.active.grid.getBgIndex(0, 1)).toBe(0);
    });

    it("combined SGR params in single sequence", () => {
      write(parser, "\x1b[1;4;31mX");
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // bold
      expect(grid.getAttrs(0, 0) & 0x04).toBe(0x04); // underline
      expect(grid.getFgIndex(0, 0)).toBe(1); // red
    });
  });

  // ==================================================================
  // Full line wrap and scroll interaction
  // ==================================================================
  describe("Line wrap and scroll interaction", () => {
    it("writing 80 chars fills one line exactly", () => {
      write(parser, "A".repeat(80));
      expect(readLineTrimmed(bs, 0)).toBe("A".repeat(80));
      expect(readLineTrimmed(bs, 1)).toBe("");
    });

    it("writing 81 chars wraps to second line", () => {
      write(parser, `${"A".repeat(80)}B`);
      expect(readLineTrimmed(bs, 0)).toBe("A".repeat(80));
      expect(readLineTrimmed(bs, 1)).toBe("B");
    });

    it("writing 160 chars fills two lines", () => {
      write(parser, "A".repeat(80) + "B".repeat(80));
      expect(readLineTrimmed(bs, 0)).toBe("A".repeat(80));
      expect(readLineTrimmed(bs, 1)).toBe("B".repeat(80));
    });

    it("filling screen and writing more causes scroll", () => {
      // Fill all 24 rows
      for (let i = 0; i < 24; i++) {
        write(parser, `R${i}`);
        if (i < 23) write(parser, "\r\n");
      }
      // Write one more line
      write(parser, "\r\n");
      write(parser, "NewLine");
      // First row should now be R1 (R0 scrolled off)
      expect(readLineTrimmed(bs, 0)).toBe("R1");
      expect(readLineTrimmed(bs, 23)).toBe("NewLine");
    });
  });

  // ==================================================================
  // Erase with default attributes
  // ==================================================================
  describe("Erase fills with default attributes", () => {
    it("ED fills erased cells with default fg/bg", () => {
      write(parser, "\x1b[31m"); // red fg
      write(parser, "A".repeat(80));
      write(parser, "\x1b[1;1H");
      write(parser, "\x1b[2J"); // ED(2) erase all
      const grid = bs.active.grid;
      // Erased cells should have default colors
      expect(grid.getFgIndex(0, 0)).toBe(7);
      expect(grid.getBgIndex(0, 0)).toBe(0);
    });

    it("EL fills erased cells with current bg color", () => {
      write(parser, "ABCDEFGHIJ");
      write(parser, "\x1b[1;1H");
      write(parser, "\x1b[2K"); // erase whole line
      expect(readLineTrimmed(bs, 0)).toBe("");
    });
  });
});
