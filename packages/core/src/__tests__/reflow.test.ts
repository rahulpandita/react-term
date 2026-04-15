import { describe, expect, it } from "vitest";
import { CELL_SIZE, DEFAULT_CELL_W0, DEFAULT_CELL_W1 } from "../cell-grid.js";
import { MAX_LOGICAL_LINE_LEN, type RowData, reflowRows } from "../reflow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a RowData from an ASCII string, padded with default cells to `cols`. */
function makeRow(text: string, cols: number, wrapped = false): RowData {
  const cells = new Uint32Array(cols * CELL_SIZE);
  for (let i = 0; i < cols; i++) {
    const cp = i < text.length ? text.charCodeAt(i) : 0x20;
    cells[i * CELL_SIZE] = (cp & 0x1fffff) | (7 << 23);
    cells[i * CELL_SIZE + 1] = 0;
  }
  return { cells, wrapped };
}

/** Create an empty row of `cols` default cells. */
function emptyRow(cols: number, wrapped = false): RowData {
  const cells = new Uint32Array(cols * CELL_SIZE);
  for (let i = 0; i < cols; i++) {
    cells[i * CELL_SIZE] = DEFAULT_CELL_W0;
    cells[i * CELL_SIZE + 1] = DEFAULT_CELL_W1;
  }
  return { cells, wrapped };
}

/** Read trimmed text from a RowData. */
function rowText(row: RowData): string {
  const cols = row.cells.length / CELL_SIZE;
  let text = "";
  for (let c = 0; c < cols; c++) {
    const cp = row.cells[c * CELL_SIZE] & 0x1fffff;
    if (cp === 0) continue; // skip spacer cells
    text += String.fromCodePoint(cp);
  }
  return text.replace(/\s+$/, "");
}

/** Set a wide character at the given column (occupies col and col+1). */
function setWideChar(cells: Uint32Array, col: number, codepoint: number): void {
  cells[col * CELL_SIZE] = (codepoint & 0x1fffff) | (7 << 23);
  cells[col * CELL_SIZE + 1] = 1 << 15; // WIDE bit
  // Spacer cell
  cells[(col + 1) * CELL_SIZE] = 0 | (7 << 23); // codepoint 0 = spacer
  cells[(col + 1) * CELL_SIZE + 1] = 0;
}

/** Create a row with a wide char at a specific position. */
function _makeRowWithWide(
  text: string,
  wideCol: number,
  wideCp: number,
  cols: number,
  wrapped = false,
): RowData {
  const row = makeRow(text, cols, wrapped);
  setWideChar(row.cells, wideCol, wideCp);
  return row;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reflowRows", () => {
  // ---- Basic shrink ----

  describe("shrink", () => {
    it("splits a full row into two when shrinking", () => {
      const rows = [makeRow("ABCDEFGH", 8)];
      const { reflowed } = reflowRows(rows, 8, 4, 0, 0);
      expect(reflowed).toHaveLength(2);
      expect(rowText(reflowed[0])).toBe("ABCD");
      expect(reflowed[0].wrapped).toBe(true);
      expect(rowText(reflowed[1])).toBe("EFGH");
      expect(reflowed[1].wrapped).toBe(false);
    });

    it("splits into three rows when needed", () => {
      const rows = [makeRow("ABCDEFGHIJKL", 12)];
      const { reflowed } = reflowRows(rows, 12, 4, 0, 0);
      expect(reflowed).toHaveLength(3);
      expect(rowText(reflowed[0])).toBe("ABCD");
      expect(reflowed[0].wrapped).toBe(true);
      expect(rowText(reflowed[1])).toBe("EFGH");
      expect(reflowed[1].wrapped).toBe(true);
      expect(rowText(reflowed[2])).toBe("IJKL");
      expect(reflowed[2].wrapped).toBe(false);
    });

    it("does not split a short row", () => {
      const rows = [makeRow("AB", 8)];
      const { reflowed } = reflowRows(rows, 8, 4, 0, 0);
      expect(reflowed).toHaveLength(1);
      expect(rowText(reflowed[0])).toBe("AB");
      expect(reflowed[0].wrapped).toBe(false);
    });
  });

  // ---- Basic expand ----

  describe("expand", () => {
    it("merges two wrapped rows into one", () => {
      const rows = [makeRow("ABCD", 4, true), makeRow("EFGH", 4)];
      const { reflowed } = reflowRows(rows, 4, 8, 0, 0);
      expect(reflowed).toHaveLength(1);
      expect(rowText(reflowed[0])).toBe("ABCDEFGH");
      expect(reflowed[0].wrapped).toBe(false);
    });

    it("merges three wrapped rows into fewer rows", () => {
      const rows = [makeRow("ABCD", 4, true), makeRow("EFGH", 4, true), makeRow("IJKL", 4)];
      const { reflowed } = reflowRows(rows, 4, 8, 0, 0);
      expect(reflowed).toHaveLength(2);
      expect(rowText(reflowed[0])).toBe("ABCDEFGH");
      expect(reflowed[0].wrapped).toBe(true);
      expect(rowText(reflowed[1])).toBe("IJKL");
      expect(reflowed[1].wrapped).toBe(false);
    });

    it("merges three wrapped rows into one when wide enough", () => {
      const rows = [makeRow("ABCD", 4, true), makeRow("EFGH", 4, true), makeRow("IJKL", 4)];
      const { reflowed } = reflowRows(rows, 4, 12, 0, 0);
      expect(reflowed).toHaveLength(1);
      expect(rowText(reflowed[0])).toBe("ABCDEFGHIJKL");
    });
  });

  // ---- Round-trip ----

  describe("round-trip", () => {
    it("shrink then expand preserves text", () => {
      const original = [makeRow("ABCDEFGH", 8)];
      const shrunk = reflowRows(original, 8, 4, 0, 0);
      const expanded = reflowRows(shrunk.reflowed, 4, 8, 0, 0);
      expect(expanded.reflowed).toHaveLength(1);
      expect(rowText(expanded.reflowed[0])).toBe("ABCDEFGH");
    });

    it("80→40→80 round-trip preserves long text", () => {
      const text = "A".repeat(80);
      const original = [makeRow(text, 80)];
      const shrunk = reflowRows(original, 80, 40, 0, 0);
      expect(shrunk.reflowed).toHaveLength(2);
      const expanded = reflowRows(shrunk.reflowed, 40, 80, 0, 0);
      expect(expanded.reflowed).toHaveLength(1);
      expect(rowText(expanded.reflowed[0])).toBe(text);
    });
  });

  // ---- No change ----

  describe("no column change", () => {
    it("returns same rows when cols unchanged", () => {
      const rows = [makeRow("ABCD", 4, true), makeRow("EF", 4)];
      const { reflowed } = reflowRows(rows, 4, 4, 0, 0);
      expect(reflowed).toHaveLength(2);
      expect(rowText(reflowed[0])).toBe("ABCD");
      expect(reflowed[0].wrapped).toBe(true);
      expect(rowText(reflowed[1])).toBe("EF");
      expect(reflowed[1].wrapped).toBe(false);
    });
  });

  // ---- Hard breaks ----

  describe("hard breaks", () => {
    it("preserves hard breaks (unwrapped rows)", () => {
      const rows = [makeRow("ABCD", 8), makeRow("EFGH", 8)]; // both wrapped=false
      const { reflowed } = reflowRows(rows, 8, 4, 0, 0);
      // "ABCD" fits in 4 cols → 1 row. "EFGH" fits in 4 cols → 1 row.
      expect(reflowed).toHaveLength(2);
      expect(rowText(reflowed[0])).toBe("ABCD");
      expect(reflowed[0].wrapped).toBe(false);
      expect(rowText(reflowed[1])).toBe("EFGH");
      expect(reflowed[1].wrapped).toBe(false);
    });

    it("does not merge unwrapped rows on expand", () => {
      const rows = [makeRow("AB", 4), makeRow("CD", 4)]; // both wrapped=false
      const { reflowed } = reflowRows(rows, 4, 8, 0, 0);
      expect(reflowed).toHaveLength(2);
      expect(rowText(reflowed[0])).toBe("AB");
      expect(rowText(reflowed[1])).toBe("CD");
    });
  });

  // ---- Empty rows ----

  describe("empty rows", () => {
    it("passes through empty rows unchanged", () => {
      const rows = [emptyRow(8), emptyRow(8)];
      const { reflowed } = reflowRows(rows, 8, 4, 0, 0);
      expect(reflowed).toHaveLength(2);
      expect(rowText(reflowed[0])).toBe("");
      expect(rowText(reflowed[1])).toBe("");
    });

    it("does not merge empty row with adjacent content", () => {
      const rows = [makeRow("ABCD", 8), emptyRow(8), makeRow("EFGH", 8)];
      const { reflowed } = reflowRows(rows, 8, 4, 0, 0);
      expect(reflowed).toHaveLength(3);
      expect(rowText(reflowed[0])).toBe("ABCD");
      expect(rowText(reflowed[1])).toBe("");
      expect(rowText(reflowed[2])).toBe("EFGH");
    });
  });

  // ---- Empty input ----

  describe("empty input", () => {
    it("handles empty array", () => {
      const { reflowed } = reflowRows([], 80, 40, 0, 0);
      expect(reflowed).toHaveLength(0);
    });
  });

  // ---- Wide characters ----

  describe("wide characters", () => {
    it("does not split wide char pair at shrink boundary", () => {
      // Row: A B [WIDE+SPACER] E → 5 cells
      const row = makeRow("AB E", 5);
      setWideChar(row.cells, 2, 0x4e2d); // 中 at col 2-3
      // fill col 4 with 'E'
      row.cells[4 * CELL_SIZE] = (0x45 & 0x1fffff) | (7 << 23);
      row.cells[4 * CELL_SIZE + 1] = 0;

      const { reflowed } = reflowRows([row], 5, 3, 0, 0);
      // At width 3: "AB" fits, then wide char at col 2 would be split → push to next row
      expect(reflowed.length).toBeGreaterThanOrEqual(2);
      // First row should have "AB" (the wide char didn't fit at col 2 in 3-wide row)
      expect(reflowed[0].wrapped).toBe(true);
    });

    it("handles wide char at the end of a row during expand", () => {
      // Two 4-col rows: "AB[W]" (wrapped) + "CD"
      const row1 = makeRow("AB", 4, true);
      setWideChar(row1.cells, 2, 0x4e2d); // 中 at col 2-3
      const row2 = makeRow("CD", 4);

      const { reflowed } = reflowRows([row1, row2], 4, 8, 0, 0);
      expect(reflowed).toHaveLength(1);
      // Should have: A B 中 _ C D
      const text = rowText(reflowed[0]);
      expect(text).toContain("AB");
      expect(text).toContain("CD");
    });
  });

  // ---- MAX_LOGICAL_LINE_LEN ----

  describe("MAX_LOGICAL_LINE_LEN", () => {
    it("caps logical lines at MAX_LOGICAL_LINE_LEN", () => {
      // Create a very long wrapped sequence
      const longRows: RowData[] = [];
      const rowsNeeded = MAX_LOGICAL_LINE_LEN + 100;
      for (let i = 0; i < rowsNeeded; i++) {
        longRows.push(makeRow("X", 1, i < rowsNeeded - 1));
      }
      const { reflowed } = reflowRows(longRows, 1, 1, 0, 0);
      // Should produce at least 2 logical lines due to capping
      expect(reflowed.length).toBeLessThanOrEqual(rowsNeeded);
      // No crash is the main test
      expect(reflowed.length).toBeGreaterThan(0);
    });
  });

  // ---- Cursor tracking ----

  describe("cursor tracking", () => {
    it("tracks cursor through shrink", () => {
      // "ABCDEFGH" at 8 cols, cursor at col 5 (on 'F')
      const rows = [makeRow("ABCDEFGH", 8)];
      const { newCursorRow, newCursorCol } = reflowRows(rows, 8, 4, 0, 5);
      // After shrink to 4: "ABCD" (row 0), "EFGH" (row 1)
      // Cursor was at col 5 → now at row 1, col 1
      expect(newCursorRow).toBe(1);
      expect(newCursorCol).toBe(1);
    });

    it("tracks cursor through expand", () => {
      // "ABCD" (wrapped) + "EFGH" at 4 cols, cursor at row 1 col 2 (on 'G')
      const rows = [makeRow("ABCD", 4, true), makeRow("EFGH", 4)];
      const { newCursorRow, newCursorCol } = reflowRows(rows, 4, 8, 1, 2);
      // After expand to 8: "ABCDEFGH" (row 0)
      // Cursor was at row 1 col 2 → logical offset = 4 + 2 = 6 → row 0, col 6
      expect(newCursorRow).toBe(0);
      expect(newCursorCol).toBe(6);
    });

    it("clamps cursor past content to end of row", () => {
      const rows = [makeRow("AB", 8)];
      const { newCursorRow, newCursorCol } = reflowRows(rows, 8, 4, 0, 7);
      // Content is only "AB" (2 chars). Cursor at col 7.
      // After shrink: single row "AB". Cursor clamped to col 3 (max for 4-col row)
      expect(newCursorRow).toBe(0);
      expect(newCursorCol).toBeLessThan(4);
    });

    it("cursor at row 0 col 0 stays at 0,0", () => {
      const rows = [makeRow("ABCD", 4)];
      const { newCursorRow, newCursorCol } = reflowRows(rows, 4, 8, 0, 0);
      expect(newCursorRow).toBe(0);
      expect(newCursorCol).toBe(0);
    });

    it("cursor tracks through MAX_LOGICAL_LINE_LEN split", () => {
      // Create a logical line that exceeds MAX_LOGICAL_LINE_LEN
      const rowsData: RowData[] = [];
      const totalRows = MAX_LOGICAL_LINE_LEN + 10;
      for (let i = 0; i < totalRows; i++) {
        rowsData.push(makeRow("X", 1, i < totalRows - 1));
      }
      // Place cursor in the overflow portion (past the cap)
      const cursorRow = MAX_LOGICAL_LINE_LEN + 5;
      const { newCursorRow, newCursorCol } = reflowRows(rowsData, 1, 2, cursorRow, 0);
      // Cursor should be reachable (not lost)
      expect(newCursorRow).toBeGreaterThanOrEqual(0);
      expect(newCursorCol).toBeGreaterThanOrEqual(0);
    });
  });

  // ---- Variable-width scrollback ----

  describe("variable-width scrollback", () => {
    it("handles rows with different cell array lengths", () => {
      // Simulate scrollback from a prior resize: row at 6 cols + row at 4 cols
      const rows = [
        makeRow("ABCDEF", 6, true), // old width = 6
        makeRow("GH", 4), // current width = 4
      ];
      const { reflowed } = reflowRows(rows, 4, 8, 0, 0);
      // Logical line: "ABCDEF" + "GH" = "ABCDEFGH"
      expect(reflowed).toHaveLength(1);
      expect(rowText(reflowed[0])).toBe("ABCDEFGH");
    });
  });

  // ---- Single character ----

  describe("single character", () => {
    it("single char row survives shrink", () => {
      const rows = [makeRow("A", 80)];
      const { reflowed } = reflowRows(rows, 80, 40, 0, 0);
      expect(reflowed).toHaveLength(1);
      expect(rowText(reflowed[0])).toBe("A");
      expect(reflowed[0].wrapped).toBe(false);
    });
  });

  // ---- Mixed wrapped and unwrapped ----

  describe("mixed wrapped and unwrapped", () => {
    it("handles [wrap][wrap][no-wrap][wrap][no-wrap]", () => {
      const rows = [
        makeRow("AAAA", 4, true), // logical line 1 start
        makeRow("BBBB", 4, true), // logical line 1 cont
        makeRow("CCCC", 4, false), // logical line 1 end
        makeRow("DDDD", 4, true), // logical line 2 start
        makeRow("EEEE", 4, false), // logical line 2 end
      ];
      const { reflowed } = reflowRows(rows, 4, 8, 0, 0);
      // Logical line 1: AAAABBBBCCCC → 12 chars / 8 cols = 2 rows
      // Logical line 2: DDDDEEEE → 8 chars / 8 cols = 1 row
      expect(reflowed).toHaveLength(3);
      expect(rowText(reflowed[0])).toBe("AAAABBBB");
      expect(reflowed[0].wrapped).toBe(true);
      expect(rowText(reflowed[1])).toBe("CCCC");
      expect(reflowed[1].wrapped).toBe(false);
      expect(rowText(reflowed[2])).toBe("DDDDEEEE");
      expect(reflowed[2].wrapped).toBe(false);
    });
  });
});
