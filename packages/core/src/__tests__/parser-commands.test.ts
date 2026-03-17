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

function cursor(bs: BufferSet): { row: number; col: number } {
  const c = bs.active.cursor;
  return { row: c.row, col: c.col };
}

describe("VTParser — cursor & editing commands", () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
    parser = new VTParser(bs);
  });

  // -------------------------------------------------------------------------
  // CNL / CPL — Cursor Next/Previous Line (resets column to 0)
  // -------------------------------------------------------------------------

  describe("CNL — Cursor Next Line (CSI E)", () => {
    it("moves down and resets column to 0", () => {
      write(parser, "\x1b[5;10H"); // cursor to row 5, col 10
      write(parser, "\x1b[2E"); // CNL 2
      expect(cursor(bs)).toEqual({ row: 6, col: 0 }); // row = 5-1+2=6 (0-based), col=0
    });

    it("defaults to 1 line when no param", () => {
      write(parser, "\x1b[3;5H"); // CUP: row=3(1-based)=2(0-based), col=5(1-based)=4(0-based)
      write(parser, "\x1b[E"); // CNL 1 (default) — row 2+1=3 (0-based), col=0
      expect(cursor(bs)).toEqual({ row: 3, col: 0 });
    });

    it("clamps at bottom of screen", () => {
      write(parser, "\x1b[23;10H"); // near bottom (row 23, 1-based = row 22, 0-based)
      write(parser, "\x1b[5E"); // CNL 5 — should clamp at row 23 (0-based)
      expect(cursor(bs).col).toBe(0);
      expect(cursor(bs).row).toBe(23);
    });
  });

  describe("CPL — Cursor Previous Line (CSI F)", () => {
    it("moves up and resets column to 0", () => {
      write(parser, "\x1b[10;20H"); // row 10, col 20 (1-based)
      write(parser, "\x1b[3F"); // CPL 3
      expect(cursor(bs)).toEqual({ row: 6, col: 0 }); // 10-1-3=6 (0-based)
    });

    it("clamps at top of screen", () => {
      write(parser, "\x1b[2;5H");
      write(parser, "\x1b[10F"); // CPL 10 — clamps at row 0
      expect(cursor(bs)).toEqual({ row: 0, col: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // CHA — Cursor Horizontal Absolute (CSI G)
  // -------------------------------------------------------------------------

  describe("CHA — Cursor Horizontal Absolute (CSI G)", () => {
    it("moves cursor to given column (1-based)", () => {
      write(parser, "\x1b[5;1H");
      write(parser, "\x1b[40G"); // CHA 40
      expect(cursor(bs)).toEqual({ row: 4, col: 39 }); // 0-based
    });

    it("defaults to column 1 when no param", () => {
      write(parser, "\x1b[5;20H");
      write(parser, "\x1b[G"); // CHA default = 1
      expect(cursor(bs).col).toBe(0);
    });

    it("clamps to last column", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "\x1b[9999G");
      expect(cursor(bs).col).toBe(79); // 0-based index of last col
    });
  });

  // -------------------------------------------------------------------------
  // CHT / CBT — Cursor Forward/Backward Tab
  // -------------------------------------------------------------------------

  describe("CHT — Cursor Forward Tab (CSI I)", () => {
    it("advances to next tab stop", () => {
      write(parser, "\x1b[1;1H"); // col 0
      write(parser, "\x1b[I"); // CHT 1 — should jump to col 8 (default tab stop)
      expect(cursor(bs).col).toBe(8);
    });

    it("advances N tab stops", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "\x1b[2I"); // CHT 2 — col 0 -> col 8 -> col 16
      expect(cursor(bs).col).toBe(16);
    });
  });

  describe("CBT — Cursor Backward Tab (CSI Z)", () => {
    it("moves back to previous tab stop", () => {
      write(parser, "\x1b[1;20H"); // col 19
      write(parser, "\x1b[Z"); // CBT 1 — should jump back to col 16
      expect(cursor(bs).col).toBe(16);
    });

    it("moves back N tab stops", () => {
      write(parser, "\x1b[1;25H"); // col 24
      write(parser, "\x1b[2Z"); // CBT 2 — col 24 -> col 16 -> col 8
      expect(cursor(bs).col).toBe(8);
    });

    it("clamps at column 0", () => {
      write(parser, "\x1b[1;4H"); // col 3 — before first tab stop
      write(parser, "\x1b[Z");
      expect(cursor(bs).col).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // HTS — Horizontal Tab Set (ESC H)
  // -------------------------------------------------------------------------

  describe("HTS — Horizontal Tab Set (ESC H)", () => {
    it("sets a tab stop at the current column", () => {
      write(parser, "\x1b[1;5H"); // col 4
      write(parser, "\x1bH"); // HTS: set tab stop at col 4
      // Now tab from col 0 should reach col 4
      write(parser, "\x1b[1;1H"); // back to col 0
      write(parser, "\x09"); // HT
      expect(cursor(bs).col).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // VPA / VPR — Vertical Position Absolute / Relative
  // -------------------------------------------------------------------------

  describe("VPA — Line Position Absolute (CSI d)", () => {
    it("moves cursor to given row (1-based)", () => {
      write(parser, "\x1b[1;10H");
      write(parser, "\x1b[15d"); // VPA 15
      expect(cursor(bs)).toEqual({ row: 14, col: 9 }); // 0-based
    });

    it("defaults to row 1 when no param", () => {
      write(parser, "\x1b[10;5H");
      write(parser, "\x1b[d");
      expect(cursor(bs).row).toBe(0);
    });

    it("clamps to last row", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "\x1b[9999d");
      expect(cursor(bs).row).toBe(23);
    });
  });

  describe("VPR — Vertical Position Relative (CSI e)", () => {
    it("moves cursor down by N rows", () => {
      write(parser, "\x1b[5;5H");
      write(parser, "\x1b[3e"); // VPR 3
      expect(cursor(bs)).toEqual({ row: 7, col: 4 }); // 0-based
    });
  });

  // -------------------------------------------------------------------------
  // HPA / HPR — Horizontal Position Absolute / Relative
  // -------------------------------------------------------------------------

  describe("HPA — Horizontal Position Absolute (CSI `)", () => {
    it("moves cursor to given column (1-based)", () => {
      write(parser, "\x1b[5;5H");
      write(parser, "\x1b[20`"); // HPA 20
      expect(cursor(bs).col).toBe(19); // 0-based
    });
  });

  describe("HPR — Horizontal Position Relative (CSI a)", () => {
    it("moves cursor right by N columns", () => {
      write(parser, "\x1b[5;5H");
      write(parser, "\x1b[3a"); // HPR 3
      expect(cursor(bs)).toEqual({ row: 4, col: 7 }); // 0-based
    });
  });

  // -------------------------------------------------------------------------
  // SU / SD — Scroll Up / Down (CSI S / T)
  // -------------------------------------------------------------------------

  describe("SU — Scroll Up (CSI S)", () => {
    it("scrolls content up by N lines, clearing bottom rows", () => {
      write(parser, "\x1b[H"); // home
      write(parser, "Line1\r\nLine2\r\nLine3");
      write(parser, "\x1b[H"); // back to home
      write(parser, "\x1b[2S"); // scroll up 2 lines
      // "Line3" should now be at row 0
      expect(readLineTrimmed(bs, 0)).toBe("Line3");
      // rows 1 and 2 should be blank
      expect(readLineTrimmed(bs, 1)).toBe("");
      expect(readLineTrimmed(bs, 2)).toBe("");
    });

    it("defaults to 1 line", () => {
      write(parser, "\x1b[H");
      write(parser, "Line1\r\nLine2");
      write(parser, "\x1b[H");
      write(parser, "\x1b[S"); // SU default = 1
      expect(readLineTrimmed(bs, 0)).toBe("Line2");
    });
  });

  describe("SD — Scroll Down (CSI T)", () => {
    it("scrolls content down by N lines, clearing top rows", () => {
      write(parser, "\x1b[H");
      write(parser, "Line1\r\nLine2\r\nLine3");
      write(parser, "\x1b[H");
      write(parser, "\x1b[2T"); // scroll down 2 lines
      // "Line1" should now be at row 2
      expect(readLineTrimmed(bs, 2)).toBe("Line1");
      // rows 0 and 1 should be blank
      expect(readLineTrimmed(bs, 0)).toBe("");
      expect(readLineTrimmed(bs, 1)).toBe("");
    });

    it("defaults to 1 line", () => {
      write(parser, "\x1b[H");
      write(parser, "Line1\r\nLine2");
      write(parser, "\x1b[H");
      write(parser, "\x1b[T"); // SD default = 1
      expect(readLineTrimmed(bs, 0)).toBe("");
      expect(readLineTrimmed(bs, 1)).toBe("Line1");
    });
  });

  // -------------------------------------------------------------------------
  // ICH — Insert Characters (CSI @)
  // -------------------------------------------------------------------------

  describe("ICH — Insert Characters (CSI @)", () => {
    it("inserts blank cells at cursor, shifting text right", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "ABCDE");
      write(parser, "\x1b[1;3H"); // cursor to col 2 (0-based)
      write(parser, "\x1b[2@"); // insert 2 chars
      // "AB  CDE" but cells pushed past end of row are lost
      expect(readLineTrimmed(bs, 0)).toBe("AB  CDE");
    });

    it("inserts 1 char by default", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "ABC");
      write(parser, "\x1b[1;2H"); // col 1
      write(parser, "\x1b[@"); // ICH 1
      expect(readLineTrimmed(bs, 0)).toBe("A BC");
    });

    it("clamps to remaining columns (no data corruption beyond right margin)", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "ABCDE");
      write(parser, "\x1b[1;4H"); // col 3 (0-based)
      write(parser, "\x1b[100@"); // insert 100 chars — should clamp to cols - col = 77
      // Only blanks after col 3; the line starts with "ABC" + spaces (DE shifted off edge)
      expect(readLineTrimmed(bs, 0)).toBe("ABC");
    });
  });

  // -------------------------------------------------------------------------
  // DCH — Delete Characters (CSI P)
  // -------------------------------------------------------------------------

  describe("DCH — Delete Characters (CSI P)", () => {
    it("deletes N chars at cursor, shifting text left", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "ABCDE");
      write(parser, "\x1b[1;2H"); // col 1
      write(parser, "\x1b[2P"); // delete 2 chars
      expect(readLineTrimmed(bs, 0)).toBe("ADE");
    });

    it("deletes 1 char by default", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "ABCDE");
      write(parser, "\x1b[1;3H"); // col 2
      write(parser, "\x1b[P"); // DCH 1
      expect(readLineTrimmed(bs, 0)).toBe("ABDE");
    });
  });

  // -------------------------------------------------------------------------
  // ECH — Erase Characters (CSI X)
  // -------------------------------------------------------------------------

  describe("ECH — Erase Characters (CSI X)", () => {
    it("erases N chars at cursor without moving cursor", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "ABCDE"); // A=col0, B=col1, C=col2, D=col3, E=col4
      write(parser, "\x1b[1;2H"); // col 1
      write(parser, "\x1b[3X"); // erase 3 chars: B(col1), C(col2), D(col3) → spaces
      // Result: A + 3 spaces + E = "A   E"
      expect(readLineTrimmed(bs, 0)).toBe("A   E");
      expect(cursor(bs).col).toBe(1); // cursor did not move
    });

    it("erases 1 char by default", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "ABC");
      write(parser, "\x1b[1;2H");
      write(parser, "\x1b[X");
      expect(readLineTrimmed(bs, 0)).toBe("A C");
      expect(cursor(bs).col).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // IL / DL — Insert / Delete Lines (CSI L / M)
  // -------------------------------------------------------------------------

  describe("IL — Insert Lines (CSI L)", () => {
    it("inserts blank lines at cursor row, shifting content down", () => {
      write(parser, "\x1b[H");
      write(parser, "Line1\r\nLine2\r\nLine3");
      write(parser, "\x1b[2;1H"); // row 1 (0-based), col 0
      write(parser, "\x1b[L"); // insert 1 line
      expect(readLineTrimmed(bs, 0)).toBe("Line1");
      expect(readLineTrimmed(bs, 1)).toBe(""); // blank inserted
      expect(readLineTrimmed(bs, 2)).toBe("Line2"); // shifted down
      expect(readLineTrimmed(bs, 3)).toBe("Line3");
    });

    it("inserts N blank lines", () => {
      write(parser, "\x1b[H");
      write(parser, "AAA\r\nBBB\r\nCCC");
      write(parser, "\x1b[2;1H");
      write(parser, "\x1b[2L"); // insert 2 lines
      expect(readLineTrimmed(bs, 0)).toBe("AAA");
      expect(readLineTrimmed(bs, 1)).toBe("");
      expect(readLineTrimmed(bs, 2)).toBe("");
      expect(readLineTrimmed(bs, 3)).toBe("BBB");
    });

    it("does nothing when cursor is outside scroll region", () => {
      // Default scroll region is 0..rows-1, so always inside by default.
      // Set a restricted scroll region and test cursor outside it.
      write(parser, "\x1b[5;20r"); // scroll region rows 5-20 (1-based)
      write(parser, "\x1b[H"); // row 0 — outside scroll region (below top)
      write(parser, "OUTSIDE");
      write(parser, "\x1b[1;1H");
      write(parser, "\x1b[L"); // IL outside scroll region — no-op
      expect(readLineTrimmed(bs, 0)).toBe("OUTSIDE");
    });
  });

  describe("DL — Delete Lines (CSI M)", () => {
    it("deletes lines at cursor row, shifting content up", () => {
      write(parser, "\x1b[H");
      write(parser, "Line1\r\nLine2\r\nLine3\r\nLine4");
      write(parser, "\x1b[2;1H"); // row 1 (0-based)
      write(parser, "\x1b[M"); // DL 1
      expect(readLineTrimmed(bs, 0)).toBe("Line1");
      expect(readLineTrimmed(bs, 1)).toBe("Line3"); // Line2 deleted
      expect(readLineTrimmed(bs, 2)).toBe("Line4");
      expect(readLineTrimmed(bs, 3)).toBe(""); // blank at bottom
    });

    it("deletes N lines", () => {
      write(parser, "\x1b[H");
      write(parser, "AAA\r\nBBB\r\nCCC\r\nDDD");
      write(parser, "\x1b[2;1H"); // cursor to row 1 (0-based)
      write(parser, "\x1b[2M"); // DL 2: delete rows 1 (BBB) and 2 (CCC), shift DDD up
      expect(readLineTrimmed(bs, 0)).toBe("AAA");
      expect(readLineTrimmed(bs, 1)).toBe("DDD"); // shifted up
      expect(readLineTrimmed(bs, 2)).toBe(""); // blank
    });
  });

  // -------------------------------------------------------------------------
  // REP — Repeat Preceding Character (CSI b)
  // -------------------------------------------------------------------------

  describe("REP — Repeat Preceding Character (CSI b)", () => {
    it("repeats the last printed character N times", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "A");
      write(parser, "\x1b[4b"); // REP 4 — should print AAAA
      // Row 0 should now be "AAAAA" (A + 4 repeated A's)
      const line = readLineTrimmed(bs, 0);
      expect(line.startsWith("AAAAA")).toBe(true);
    });

    it("does nothing when no preceding character has been printed", () => {
      // Fresh parser — no lastPrintedCodepoint
      write(parser, "\x1b[1;1H");
      write(parser, "\x1b[5b"); // REP with nothing printed
      expect(readLineTrimmed(bs, 0)).toBe(""); // nothing written
    });

    it("clamps repeat count to cols*rows to prevent DoS", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "X");
      // cols*rows = 80*24 = 1920; the large value is clamped to 1920 repetitions
      // 1 (original) + 1920 (repeated) = 1921 chars fills all 24 rows and triggers one scroll
      write(parser, "\x1b[9999999b");
      // The last row must contain X's — only possible if at least 80*23=1840 chars were written,
      // which confirms the clamp allowed the full cols*rows repetitions (not a trivially-small fallback)
      expect(readLineTrimmed(bs, 23)).not.toBe("");
    });

    it("repeats the last printed codepoint, not a previous one", () => {
      write(parser, "\x1b[1;1H");
      write(parser, "AB"); // A at col 0, B at col 1; last printed = 'B', cursor now at col 2
      write(parser, "\x1b[3b"); // REP 3 — writes B at cols 2, 3, 4
      expect(readLineTrimmed(bs, 0).slice(0, 5)).toBe("ABBBB");
    });
  });

  // -------------------------------------------------------------------------
  // ESC D / E / M — IND, NEL, Reverse Index
  // -------------------------------------------------------------------------

  describe("IND — Index (ESC D)", () => {
    it("moves cursor down one line (like LF), preserving column", () => {
      write(parser, "\x1b[5;10H"); // row 4 (0-based), col 9
      write(parser, "\x1bD"); // IND
      expect(cursor(bs)).toEqual({ row: 5, col: 9 });
    });

    it("scrolls up when cursor is at scroll bottom", () => {
      write(parser, "\x1b[H");
      write(parser, "ScrollMe");
      write(parser, "\x1b[2;1H"); // row 1, write a marker to confirm scroll direction
      write(parser, "RowTwo");
      // Move to last row
      write(parser, "\x1b[24;1H"); // row 23 (0-based), scroll bottom
      write(parser, "\x1bD"); // IND — should scroll up, pushing row 0 into scrollback
      // Cursor stays at the scroll bottom after the scroll
      expect(cursor(bs).row).toBe(23);
      // "ScrollMe" was on row 0 — after one scroll-up it moves to scrollback (or off screen)
      // "RowTwo" was on row 1 — after scroll-up it should now be on row 0
      expect(readLineTrimmed(bs, 0)).toBe("RowTwo");
    });
  });

  describe("NEL — Next Line (ESC E)", () => {
    it("moves cursor to start of next line", () => {
      write(parser, "\x1b[5;10H"); // row 4, col 9
      write(parser, "\x1bE"); // NEL
      expect(cursor(bs)).toEqual({ row: 5, col: 0 });
    });
  });

  describe("RI — Reverse Index (ESC M)", () => {
    it("moves cursor up one line when not at scroll top", () => {
      write(parser, "\x1b[10;5H"); // row 9 (0-based), col 4
      write(parser, "\x1bM"); // RI
      expect(cursor(bs)).toEqual({ row: 8, col: 4 });
    });

    it("scrolls down when cursor is at scroll top", () => {
      write(parser, "\x1b[H");
      write(parser, "TopLine\r\nSecondLine");
      write(parser, "\x1b[1;1H"); // back to row 0 (scroll top)
      write(parser, "\x1bM"); // RI — scroll down, blank inserted at top
      expect(readLineTrimmed(bs, 0)).toBe(""); // blank row inserted
      expect(readLineTrimmed(bs, 1)).toBe("TopLine"); // shifted down
    });

    it("clamps at row 0 when scroll region top > 0 and cursor is above it", () => {
      write(parser, "\x1b[5;20r"); // scroll region rows 5-20
      write(parser, "\x1b[3;1H"); // row 2 (above scroll region)
      write(parser, "\x1bM"); // RI — should just move up (not scroll)
      expect(cursor(bs).row).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // RIS — Full Reset (ESC c)
  // -------------------------------------------------------------------------

  describe("RIS — Full Reset (ESC c)", () => {
    it("clears the screen and resets cursor to home", () => {
      write(parser, "\x1b[10;20H");
      write(parser, "SomeText");
      write(parser, "\x1bc"); // RIS
      expect(cursor(bs)).toEqual({ row: 0, col: 0 });
      expect(readLineTrimmed(bs, 9)).toBe(""); // row 9 should be cleared
    });

    it("resets SGR attributes", () => {
      write(parser, "\x1b[1;31m"); // bold + fg red (index 1)
      write(parser, "\x1bc"); // RIS
      // Write a character: should use default fg=7 (white)
      write(parser, "A");
      const grid = bs.active.grid;
      expect(grid.getFgIndex(0, 0)).toBe(7); // default fg index after reset
    });

    it("resets scroll region to full screen", () => {
      write(parser, "\x1b[5;20r"); // set scroll region
      write(parser, "\x1bc"); // RIS
      expect(bs.active.scrollTop).toBe(0);
      expect(bs.active.scrollBottom).toBe(23);
    });

    it("switches back to normal buffer if in alternate", () => {
      write(parser, "\x1b[?1049h"); // switch to alternate
      expect(bs.active).toBe(bs.alternate);
      write(parser, "\x1bc"); // RIS
      expect(bs.active).toBe(bs.normal);
    });
  });
});
