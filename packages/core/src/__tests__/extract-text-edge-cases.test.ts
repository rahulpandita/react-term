import { describe, expect, it } from "vitest";
import { CellGrid, extractText } from "../index.js";
import { ATTR_WIDE, setWide } from "./test-utils.js";

describe("extractText edge cases", () => {
  describe("isSpacerCell edge cases", () => {
    it("returns false for orphaned codepoint=0 at column 0", () => {
      const grid = new CellGrid(10, 1);
      grid.setCell(0, 0, 0, 7, 0, 0); // codepoint=0 at col 0
      expect(grid.isSpacerCell(0, 0)).toBe(false);
    });

    it("returns false for codepoint=0 when previous cell is not wide", () => {
      const grid = new CellGrid(10, 1);
      grid.setCell(0, 0, 0x41, 7, 0, 0); // A (not wide)
      grid.setCell(0, 1, 0, 7, 0, 0); // codepoint=0 at col 1
      expect(grid.isSpacerCell(0, 1)).toBe(false);
    });

    it("correctly identifies spacer when wide char and codepoint=0 match", () => {
      const grid = new CellGrid(10, 1);
      setWide(grid, 0, 0, 0x4e2d); // 中 at cols 0-1
      expect(grid.isSpacerCell(0, 0)).toBe(false); // col 0 is the wide char
      expect(grid.isSpacerCell(0, 1)).toBe(true); // col 1 is the spacer
    });
  });

  describe("extractText with orphaned null codepoints", () => {
    it("treats orphaned null as space in extraction", () => {
      const grid = new CellGrid(10, 1);
      grid.setCell(0, 0, 0x41, 7, 0, 0); // A
      grid.setCell(0, 1, 0, 7, 0, 0); // null (not a spacer)
      grid.setCell(0, 2, 0x42, 7, 0, 0); // B
      const text = extractText(grid, 0, 0, 0, 2);
      // null should be treated as space (cp > 0x20 check fails, becomes " ")
      expect(text).toBe("A B");
    });
  });

  describe("selection boundary behavior with spacers", () => {
    it("includes wide char when selection starts on its spacer (snaps to leading cell)", () => {
      const grid = new CellGrid(10, 1);
      setWide(grid, 0, 0, 0x4e2d); // 中 at cols 0-1
      grid.setCell(0, 2, 0x41, 7, 0, 0); // A
      // Selection starts at col 1 (spacer) — snaps back to include 中
      const text = extractText(grid, 0, 1, 0, 2);
      expect(text).toBe("中A");
    });

    it("includes wide char when selection ends on its spacer", () => {
      const grid = new CellGrid(10, 1);
      grid.setCell(0, 0, 0x41, 7, 0, 0); // A
      setWide(grid, 0, 1, 0x4e2d); // 中 at cols 1-2
      const text = extractText(grid, 0, 0, 0, 2);
      // Spacer at col 2 is visited; wide char at col 1 is included
      expect(text).toBe("A中");
    });

    it("includes wide char when selection starts on its first cell", () => {
      const grid = new CellGrid(10, 1);
      setWide(grid, 0, 0, 0x4e2d); // 中 at cols 0-1
      grid.setCell(0, 2, 0x41, 7, 0, 0); // A
      const text = extractText(grid, 0, 0, 0, 2);
      expect(text).toBe("中A");
    });
  });

  describe("wide character at grid boundaries", () => {
    it("handles wide char at last two columns", () => {
      const grid = new CellGrid(10, 1);
      grid.setCell(0, 7, 0x41, 7, 0, 0); // A at col 7
      setWide(grid, 0, 8, 0x4e2d); // 中 at cols 8-9 (last two)
      const text = extractText(grid, 0, 7, 0, 9);
      expect(text).toBe("A中");
    });

    it("wide char cannot extend beyond grid columns", () => {
      // This tests what happens if you try to set a wide char at the last col
      const grid = new CellGrid(10, 1);
      // setWide at col 9 would try to write spacer at col 10 (out of bounds)
      // The setCell will either fail or create corrupt state
      grid.setCell(0, 9, 0x4e2d, 7, 0, ATTR_WIDE);
      // Cannot set col 10 (out of bounds) - spacer is missing

      // What does isWide report?
      expect(grid.isWide(0, 9)).toBe(true);

      // What does extractText do?
      const text = extractText(grid, 0, 9, 0, 9);
      expect(text).toBe("中"); // Should extract the wide char even without spacer
    });
  });

  describe("multiple consecutive wide characters", () => {
    it("handles three consecutive wide chars correctly", () => {
      const grid = new CellGrid(10, 1);
      setWide(grid, 0, 0, 0x4e2d); // 中 at 0-1
      setWide(grid, 0, 2, 0x6587); // 文 at 2-3
      setWide(grid, 0, 4, 0x5b57); // 字 at 4-5
      const text = extractText(grid, 0, 0, 0, 5);
      expect(text).toBe("中文字");
    });

    it("handles mixed ASCII and wide in complex pattern", () => {
      const grid = new CellGrid(10, 1);
      grid.setCell(0, 0, 0x41, 7, 0, 0); // A
      setWide(grid, 0, 1, 0x4e2d); // 中 at 1-2
      grid.setCell(0, 3, 0x42, 7, 0, 0); // B
      setWide(grid, 0, 4, 0x6587); // 文 at 4-5
      grid.setCell(0, 6, 0x43, 7, 0, 0); // C
      const text = extractText(grid, 0, 0, 0, 6);
      expect(text).toBe("A中B文C");
    });
  });
});
