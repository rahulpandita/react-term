import { describe, expect, it } from "vitest";
import { CellGrid, extractText, normalizeSelection } from "../index.js";

describe("normalizeSelection", () => {
  it("returns same order when start is before end", () => {
    const sel = normalizeSelection({ startRow: 0, startCol: 2, endRow: 1, endCol: 5 });
    expect(sel).toEqual({ startRow: 0, startCol: 2, endRow: 1, endCol: 5 });
  });

  it("swaps when end is before start (backwards selection)", () => {
    const sel = normalizeSelection({ startRow: 3, startCol: 10, endRow: 1, endCol: 5 });
    expect(sel).toEqual({ startRow: 1, startCol: 5, endRow: 3, endCol: 10 });
  });

  it("swaps columns on same row when startCol > endCol", () => {
    const sel = normalizeSelection({ startRow: 2, startCol: 8, endRow: 2, endCol: 3 });
    expect(sel).toEqual({ startRow: 2, startCol: 3, endRow: 2, endCol: 8 });
  });

  it("does not swap when start equals end", () => {
    const sel = normalizeSelection({ startRow: 1, startCol: 4, endRow: 1, endCol: 4 });
    expect(sel).toEqual({ startRow: 1, startCol: 4, endRow: 1, endCol: 4 });
  });
});

describe("extractText", () => {
  function makeGrid(rows: number, cols: number, lines: string[]): CellGrid {
    const grid = new CellGrid(cols, rows);
    for (let r = 0; r < lines.length && r < rows; r++) {
      for (let c = 0; c < lines[r].length && c < cols; c++) {
        grid.setCell(r, c, lines[r].charCodeAt(c), 7, 0, 0);
      }
    }
    return grid;
  }

  it("extracts a single-row selection", () => {
    const grid = makeGrid(3, 20, ["Hello, World!", "Second line", "Third line"]);
    const text = extractText(grid, 0, 0, 0, 12);
    expect(text).toBe("Hello, World!");
  });

  it("extracts a partial single-row selection", () => {
    const grid = makeGrid(3, 20, ["Hello, World!", "Second line", "Third line"]);
    const text = extractText(grid, 0, 7, 0, 11);
    expect(text).toBe("World");
  });

  it("extracts a multi-row selection", () => {
    const grid = makeGrid(3, 20, ["Hello, World!", "Second line", "Third line"]);
    const text = extractText(grid, 0, 7, 2, 4);
    expect(text).toBe("World!\nSecond line\nThird");
  });

  it("trims trailing spaces from each line", () => {
    const grid = makeGrid(2, 20, ["Hello", "World"]);
    // Cells beyond the text are spaces (default)
    const text = extractText(grid, 0, 0, 1, 19);
    expect(text).toBe("Hello\nWorld");
  });

  it("handles backwards selection (end before start)", () => {
    const grid = makeGrid(3, 20, ["Hello, World!", "Second line", "Third line"]);
    // Backwards: from row 1 col 5 to row 0 col 0
    const text = extractText(grid, 1, 5, 0, 0);
    expect(text).toBe("Hello, World!\nSecond");
  });

  it("returns empty string for empty cells", () => {
    const grid = new CellGrid(10, 5); // all spaces
    const text = extractText(grid, 0, 0, 0, 9);
    expect(text).toBe("");
  });

  it("clamps to grid bounds", () => {
    const grid = makeGrid(3, 10, ["Hello", "World"]);
    // endRow beyond grid
    const text = extractText(grid, 0, 0, 10, 5);
    expect(text).toContain("Hello");
    expect(text).toContain("World");
  });

  // ---- Wide character selection (#142) ------------------------------------

  describe("wide characters", () => {
    const ATTR_WIDE = 0x80;

    /** Helper: write a wide character (e.g. CJK) at (row, col) spanning 2 cells. */
    function setWide(grid: CellGrid, row: number, col: number, cp: number): void {
      grid.setCell(row, col, cp, 7, 0, ATTR_WIDE);
      grid.setCell(row, col + 1, 0, 7, 0, 0); // spacer
    }

    it("skips spacer cells for wide characters", () => {
      const grid = new CellGrid(10, 1);
      // Write "中文" — two CJK chars, each occupying 2 cells
      setWide(grid, 0, 0, 0x4e2d); // 中
      setWide(grid, 0, 2, 0x6587); // 文
      const text = extractText(grid, 0, 0, 0, 3);
      expect(text).toBe("中文");
    });

    it("handles mixed ASCII and wide characters", () => {
      const grid = new CellGrid(10, 1);
      grid.setCell(0, 0, 0x41, 7, 0, 0); // A
      setWide(grid, 0, 1, 0x4e2d); // 中 at cols 1-2
      grid.setCell(0, 3, 0x42, 7, 0, 0); // B
      const text = extractText(grid, 0, 0, 0, 3);
      expect(text).toBe("A中B");
    });

    it("selection starting on spacer snaps to leading cell of wide char", () => {
      const grid = new CellGrid(10, 1);
      setWide(grid, 0, 0, 0x4e2d); // 中 at cols 0-1
      grid.setCell(0, 2, 0x41, 7, 0, 0); // A
      // Selection starts at col 1 (spacer) — should snap back to include 中
      const text = extractText(grid, 0, 1, 0, 2);
      expect(text).toBe("中A");
    });

    it("handles selection ending on spacer cell", () => {
      const grid = new CellGrid(10, 1);
      grid.setCell(0, 0, 0x41, 7, 0, 0); // A
      setWide(grid, 0, 1, 0x4e2d); // 中 at cols 1-2
      // Selection from A to spacer at col 2
      const text = extractText(grid, 0, 0, 0, 2);
      expect(text).toBe("A中");
    });

    it("handles row of wide characters", () => {
      const grid = new CellGrid(10, 1);
      setWide(grid, 0, 0, 0x4e2d); // 中
      setWide(grid, 0, 2, 0x6587); // 文
      setWide(grid, 0, 4, 0x5b57); // 字
      const text = extractText(grid, 0, 0, 0, 5);
      expect(text).toBe("中文字");
    });

    it("handles multi-row selection with wide characters", () => {
      const grid = new CellGrid(10, 2);
      setWide(grid, 0, 0, 0x4e2d); // 中
      grid.setCell(0, 2, 0x41, 7, 0, 0); // A
      setWide(grid, 1, 0, 0x6587); // 文
      grid.setCell(1, 2, 0x42, 7, 0, 0); // B
      const text = extractText(grid, 0, 0, 1, 2);
      expect(text).toBe("中A\n文B");
    });
  });
});
