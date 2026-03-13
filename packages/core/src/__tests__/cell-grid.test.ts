import { describe, expect, it } from "vitest";
import { CELL_SIZE, CellGrid } from "../cell-grid.js";

describe("CellGrid", () => {
  it("creates a grid with correct dimensions", () => {
    const grid = new CellGrid(80, 24);
    expect(grid.cols).toBe(80);
    expect(grid.rows).toBe(24);
    expect(grid.data.length).toBe(80 * 24 * CELL_SIZE);
  });

  it("initializes all cells to space (0x20)", () => {
    const grid = new CellGrid(10, 5);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 10; c++) {
        expect(grid.getCodepoint(r, c)).toBe(0x20);
      }
    }
  });

  it("sets and reads back codepoint and attributes", () => {
    const grid = new CellGrid(80, 24);
    grid.setCell(0, 0, 0x41, 7, 0, 0); // 'A', fg=7, bg=0, no attrs
    expect(grid.getCodepoint(0, 0)).toBe(0x41);
    expect(grid.getFgIndex(0, 0)).toBe(7);
    expect(grid.getBgIndex(0, 0)).toBe(0);
  });

  it("stores bold attribute", () => {
    const grid = new CellGrid(80, 24);
    const ATTR_BOLD = 0x01;
    grid.setCell(0, 0, 0x42, 1, 0, ATTR_BOLD);
    expect(grid.getCodepoint(0, 0)).toBe(0x42);
    expect(grid.getAttrs(0, 0) & ATTR_BOLD).toBe(ATTR_BOLD);
  });

  it("stores foreground and background color indices", () => {
    const grid = new CellGrid(80, 24);
    grid.setCell(5, 10, 0x43, 196, 21, 0); // 256-color indices
    expect(grid.getCodepoint(5, 10)).toBe(0x43);
    expect(grid.getFgIndex(5, 10)).toBe(196);
    expect(grid.getBgIndex(5, 10)).toBe(21);
  });

  it("tracks dirty rows", () => {
    const grid = new CellGrid(80, 24);
    // After construction, all rows are dirty
    expect(grid.isDirty(0)).toBe(true);

    grid.clearDirty(0);
    expect(grid.isDirty(0)).toBe(false);

    grid.markDirty(0);
    expect(grid.isDirty(0)).toBe(true);
  });

  it("clearDirty / markAllDirty works", () => {
    const grid = new CellGrid(10, 5);
    for (let r = 0; r < 5; r++) {
      grid.clearDirty(r);
    }
    for (let r = 0; r < 5; r++) {
      expect(grid.isDirty(r)).toBe(false);
    }
    grid.markAllDirty();
    for (let r = 0; r < 5; r++) {
      expect(grid.isDirty(r)).toBe(true);
    }
  });

  it("clear() resets all cells to space", () => {
    const grid = new CellGrid(10, 5);
    grid.setCell(2, 3, 0x41, 1, 2, 0);
    grid.clear();
    expect(grid.getCodepoint(2, 3)).toBe(0x20);
  });

  it("copyRow and pasteRow round-trip", () => {
    const grid = new CellGrid(10, 5);
    grid.setCell(0, 0, 0x41, 7, 0, 0);
    grid.setCell(0, 1, 0x42, 7, 0, 0);
    const row = grid.copyRow(0);
    grid.clearRow(0);
    expect(grid.getCodepoint(0, 0)).toBe(0x20);
    grid.pasteRow(0, row);
    expect(grid.getCodepoint(0, 0)).toBe(0x41);
    expect(grid.getCodepoint(0, 1)).toBe(0x42);
  });

  it("reports whether SharedArrayBuffer is used", () => {
    const grid = new CellGrid(10, 5);
    // In Node/vitest SAB may or may not be available
    expect(typeof grid.isShared).toBe("boolean");
  });

  it("getBuffer returns the underlying buffer", () => {
    const grid = new CellGrid(10, 5);
    const buf = grid.getBuffer();
    expect(buf instanceof ArrayBuffer || buf instanceof SharedArrayBuffer).toBe(true);
  });
});
