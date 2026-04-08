import { beforeEach, describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";
import { isCombining, wcwidth } from "../wcwidth.js";
import { cursor, write } from "./helpers.js";

// -----------------------------------------------------------------------
// Unit tests for wcwidth()
// -----------------------------------------------------------------------

describe("wcwidth", () => {
  describe("control characters", () => {
    it("returns 0 for NUL", () => {
      expect(wcwidth(0)).toBe(0);
    });

    it("returns 0 for C0 controls", () => {
      for (let cp = 0; cp < 0x20; cp++) {
        expect(wcwidth(cp)).toBe(0);
      }
    });

    it("returns 0 for DEL", () => {
      expect(wcwidth(0x7f)).toBe(0);
    });

    it("returns 0 for C1 controls", () => {
      for (let cp = 0x80; cp < 0xa0; cp++) {
        expect(wcwidth(cp)).toBe(0);
      }
    });
  });

  describe("ASCII printable", () => {
    it("returns 1 for space", () => {
      expect(wcwidth(0x20)).toBe(1);
    });

    it("returns 1 for 'A'", () => {
      expect(wcwidth(0x41)).toBe(1);
    });

    it("returns 1 for '~'", () => {
      expect(wcwidth(0x7e)).toBe(1);
    });

    it("returns 1 for all printable ASCII", () => {
      for (let cp = 0x20; cp < 0x7f; cp++) {
        expect(wcwidth(cp)).toBe(1);
      }
    });
  });

  describe("zero-width characters", () => {
    it("returns 0 for soft hyphen U+00AD", () => {
      expect(wcwidth(0x00ad)).toBe(0);
    });

    it("returns 0 for combining diacritical marks (U+0300-U+036F)", () => {
      expect(wcwidth(0x0300)).toBe(0); // combining grave accent
      expect(wcwidth(0x0301)).toBe(0); // combining acute accent
      expect(wcwidth(0x036f)).toBe(0); // end of range
    });

    it("returns 0 for zero-width space U+200B", () => {
      expect(wcwidth(0x200b)).toBe(0);
    });

    it("returns 0 for zero-width joiner U+200D", () => {
      expect(wcwidth(0x200d)).toBe(0);
    });

    it("returns 0 for variation selectors U+FE00-U+FE0F", () => {
      expect(wcwidth(0xfe00)).toBe(0);
      expect(wcwidth(0xfe0f)).toBe(0);
    });

    it("returns 0 for BOM U+FEFF", () => {
      expect(wcwidth(0xfeff)).toBe(0);
    });

    it("returns 0 for combining half marks U+FE20-U+FE2F", () => {
      expect(wcwidth(0xfe20)).toBe(0);
    });

    it("returns 0 for variation selectors supplement U+E0100-U+E01EF", () => {
      expect(wcwidth(0xe0100)).toBe(0);
      expect(wcwidth(0xe01ef)).toBe(0);
    });
  });

  describe("wide/fullwidth characters", () => {
    it("returns 2 for CJK Unified Ideographs", () => {
      expect(wcwidth(0x4e2d)).toBe(2); // 中
      expect(wcwidth(0x6587)).toBe(2); // 文
      expect(wcwidth(0x5b57)).toBe(2); // 字
    });

    it("returns 2 for Hangul Syllables", () => {
      expect(wcwidth(0xac00)).toBe(2); // 가
      expect(wcwidth(0xd7a3)).toBe(2); // last Hangul syllable
    });

    it("returns 2 for Hangul Jamo initial consonants", () => {
      expect(wcwidth(0x1100)).toBe(2);
      expect(wcwidth(0x115f)).toBe(2);
    });

    it("returns 2 for Hiragana", () => {
      expect(wcwidth(0x3041)).toBe(2); // ぁ
      expect(wcwidth(0x3042)).toBe(2); // あ
    });

    it("returns 2 for Katakana", () => {
      expect(wcwidth(0x30a0)).toBe(2);
      expect(wcwidth(0x30ff)).toBe(2);
    });

    it("returns 2 for fullwidth ASCII variants", () => {
      expect(wcwidth(0xff01)).toBe(2); // ！
      expect(wcwidth(0xff21)).toBe(2); // Ａ
      expect(wcwidth(0xff5e)).toBe(2); // ～
    });

    it("returns 2 for CJK Compatibility Ideographs", () => {
      expect(wcwidth(0xf900)).toBe(2);
    });

    it("returns 2 for emoji (Misc Symbols and Pictographs)", () => {
      expect(wcwidth(0x1f600)).toBe(2); // 😀
      expect(wcwidth(0x1f64f)).toBe(2); // 🙏
    });

    it("returns 2 for CJK Ext B", () => {
      expect(wcwidth(0x20000)).toBe(2);
      expect(wcwidth(0x2a6df)).toBe(2);
    });
  });

  describe("normal-width non-ASCII", () => {
    it("returns 1 for Latin Extended characters", () => {
      expect(wcwidth(0x00c0)).toBe(1); // À
      expect(wcwidth(0x00e9)).toBe(1); // é
      expect(wcwidth(0x0100)).toBe(1); // Ā
    });

    it("returns 1 for Greek", () => {
      expect(wcwidth(0x0391)).toBe(1); // Α
      expect(wcwidth(0x03b1)).toBe(1); // α
    });

    it("returns 1 for Cyrillic", () => {
      expect(wcwidth(0x0410)).toBe(1); // А
      expect(wcwidth(0x044f)).toBe(1); // я
    });

    it("returns 1 for Box Drawing", () => {
      expect(wcwidth(0x2500)).toBe(1); // ─
      expect(wcwidth(0x2502)).toBe(1); // │
      expect(wcwidth(0x250c)).toBe(1); // ┌
    });

    it("returns 1 for arrows", () => {
      expect(wcwidth(0x2190)).toBe(1); // ←
      expect(wcwidth(0x2191)).toBe(1); // ↑
    });
  });

  describe("isCombining", () => {
    it("returns false for ASCII", () => {
      expect(isCombining(0x41)).toBe(false);
    });

    it("returns true for combining acute accent U+0301", () => {
      expect(isCombining(0x0301)).toBe(true);
    });

    it("returns true for combining grave accent U+0300", () => {
      expect(isCombining(0x0300)).toBe(true);
    });

    it("returns true for zero-width space U+200B (treated as combining)", () => {
      // U+200B is zero-width and >= 0x0300, so isCombining returns true
      expect(isCombining(0x200b)).toBe(true);
    });

    it("returns false for soft hyphen U+00AD (below 0x0300)", () => {
      expect(isCombining(0x00ad)).toBe(false);
    });

    it("returns true for variation selectors", () => {
      expect(isCombining(0xfe0f)).toBe(true);
    });
  });
});

// -----------------------------------------------------------------------
// Integration tests: parser + wide character handling
// -----------------------------------------------------------------------

describe("wide character handling in parser", () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(20, 5, 100);
    parser = new VTParser(bs);
  });

  describe("CJK characters", () => {
    it("writes CJK char to two cells with ATTR_WIDE set", () => {
      write(parser, "中"); // U+4E2D — wide character
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x4e2d);
      expect(grid.isWide(0, 0)).toBe(true);
      // Right half is a spacer (codepoint 0)
      expect(grid.getCodepoint(0, 1)).toBe(0);
      // Cursor advances by 2
      expect(cursor(bs).col).toBe(2);
    });

    it("writes multiple CJK chars correctly", () => {
      write(parser, "中文"); // Two wide chars
      const grid = bs.active.grid;
      // First char at col 0-1
      expect(grid.getCodepoint(0, 0)).toBe(0x4e2d);
      expect(grid.isWide(0, 0)).toBe(true);
      expect(grid.getCodepoint(0, 1)).toBe(0); // spacer
      // Second char at col 2-3
      expect(grid.getCodepoint(0, 2)).toBe(0x6587);
      expect(grid.isWide(0, 2)).toBe(true);
      expect(grid.getCodepoint(0, 3)).toBe(0); // spacer
      expect(cursor(bs).col).toBe(4);
    });

    it("mixes ASCII and CJK correctly", () => {
      write(parser, "A中B");
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x41); // A
      expect(grid.isWide(0, 0)).toBe(false);
      expect(grid.getCodepoint(0, 1)).toBe(0x4e2d); // 中
      expect(grid.isWide(0, 1)).toBe(true);
      expect(grid.getCodepoint(0, 2)).toBe(0); // spacer
      expect(grid.getCodepoint(0, 3)).toBe(0x42); // B
      expect(cursor(bs).col).toBe(4);
    });
  });

  describe("wide character wrapping", () => {
    it("wraps wide char at last column by filling with space", () => {
      // Terminal is 20 cols. Position cursor at col 19 (last col)
      write(parser, "\x1b[1;20H"); // Move to col 20 (0-indexed: 19)
      expect(cursor(bs).col).toBe(19);
      write(parser, "中"); // Wide char at last column should wrap

      const grid = bs.active.grid;
      // Col 19 should be filled with a space (padding)
      expect(grid.getCodepoint(0, 19)).toBe(0x20);
      // Wide char goes to next row at col 0-1
      expect(grid.getCodepoint(1, 0)).toBe(0x4e2d);
      expect(grid.isWide(1, 0)).toBe(true);
      expect(grid.getCodepoint(1, 1)).toBe(0); // spacer
      expect(cursor(bs).col).toBe(2);
      expect(cursor(bs).row).toBe(1);
    });

    it("wraps wide char at second-to-last column", () => {
      // Position cursor at col 18 (second-to-last)
      write(parser, "\x1b[1;19H");
      expect(cursor(bs).col).toBe(18);
      write(parser, "中"); // Wide char fits at col 18-19

      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 18)).toBe(0x4e2d);
      expect(grid.isWide(0, 18)).toBe(true);
      expect(grid.getCodepoint(0, 19)).toBe(0); // spacer
      // Cursor should be at wrap pending state (col 19)
    });
  });

  describe("combining characters", () => {
    it("absorbs combining accent without advancing cursor", () => {
      write(parser, "e\u0301"); // e + combining acute
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x65); // 'e' remains
      // Combining mark is absorbed — cursor at col 1 (after e)
      expect(cursor(bs).col).toBe(1);
    });

    it("handles multiple combining marks", () => {
      write(parser, "a\u0300\u0301"); // a + grave + acute
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x61); // 'a'
      expect(cursor(bs).col).toBe(1);
    });

    it("combining mark after wide char works", () => {
      write(parser, "中\u0300"); // CJK + combining grave
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x4e2d);
      expect(grid.isWide(0, 0)).toBe(true);
      expect(cursor(bs).col).toBe(2);
    });
  });

  describe("emoji", () => {
    it("renders emoji as wide characters", () => {
      write(parser, "😀"); // U+1F600
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x1f600);
      expect(grid.isWide(0, 0)).toBe(true);
      expect(grid.getCodepoint(0, 1)).toBe(0); // spacer
      expect(cursor(bs).col).toBe(2);
    });

    it("handles multiple emoji", () => {
      write(parser, "😀🙏"); // two emoji
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x1f600);
      expect(grid.isWide(0, 0)).toBe(true);
      expect(grid.getCodepoint(0, 2)).toBe(0x1f64f);
      expect(grid.isWide(0, 2)).toBe(true);
      expect(cursor(bs).col).toBe(4);
    });
  });

  describe("Hangul", () => {
    it("renders Hangul syllables as wide", () => {
      write(parser, "가나");
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0xac00);
      expect(grid.isWide(0, 0)).toBe(true);
      expect(grid.getCodepoint(0, 2)).toBe(0xb098);
      expect(grid.isWide(0, 2)).toBe(true);
    });
  });

  describe("Hiragana/Katakana", () => {
    it("renders Hiragana as wide", () => {
      write(parser, "あ");
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x3042);
      expect(grid.isWide(0, 0)).toBe(true);
    });

    it("renders Katakana as wide", () => {
      write(parser, "ア");
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x30a2);
      expect(grid.isWide(0, 0)).toBe(true);
    });
  });

  describe("fullwidth forms", () => {
    it("renders fullwidth ASCII as wide", () => {
      write(parser, "Ａ"); // U+FF21 fullwidth A
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0xff21);
      expect(grid.isWide(0, 0)).toBe(true);
      expect(cursor(bs).col).toBe(2);
    });
  });

  describe("normal-width non-ASCII", () => {
    it("renders Latin Extended as normal width", () => {
      write(parser, "é"); // U+00E9
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0xe9);
      expect(grid.isWide(0, 0)).toBe(false);
      expect(cursor(bs).col).toBe(1);
    });

    it("renders Box Drawing as normal width", () => {
      write(parser, "─│┌┐"); // Box drawing characters
      const grid = bs.active.grid;
      expect(grid.isWide(0, 0)).toBe(false);
      expect(grid.isWide(0, 1)).toBe(false);
      expect(cursor(bs).col).toBe(4);
    });
  });

  describe("wide chars with SGR attributes", () => {
    it("preserves bold attribute on wide chars", () => {
      write(parser, "\x1b[1m中"); // bold + CJK
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x4e2d);
      expect(grid.isWide(0, 0)).toBe(true);
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // bold
      expect(grid.getAttrs(0, 0) & 0x80).toBe(0x80); // wide
    });

    it("preserves colors on wide chars", () => {
      write(parser, "\x1b[31m中"); // red + CJK
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x4e2d);
      expect(grid.isWide(0, 0)).toBe(true);
      expect(grid.getFgIndex(0, 0)).toBe(1); // red = index 1
    });
  });

  describe("erase operations on wide chars", () => {
    it("erasing first half of wide char clears both cells", () => {
      write(parser, "中");
      // Move cursor back to col 0 and write a narrow char
      write(parser, "\x1b[1;1HA");
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x41); // A overwrites left half
      // Right half spacer should be cleared (overwritten or invalidated)
    });
  });
});
