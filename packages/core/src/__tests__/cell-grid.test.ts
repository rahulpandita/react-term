import { describe, expect, it } from "vitest";
import { CELL_SIZE, CellGrid, expandCompactRow } from "../cell-grid.js";

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

  it("copyRow preserves cell data including RGB flag bits", () => {
    const grid = new CellGrid(10, 5);
    // Write a cell with RGB flags set
    grid.setCell(0, 3, 0x41, 0, 0, 0, true, true);

    const row = grid.copyRow(0);
    grid.clearRow(2);
    grid.pasteRow(2, row);

    // Cell data including RGB flag bits should be preserved
    expect(grid.getCodepoint(2, 3)).toBe(0x41);
    expect(grid.isFgRGB(2, 3)).toBe(true);
    expect(grid.isBgRGB(2, 3)).toBe(true);
  });

  it("copyRow preserves inline RGB values (#146)", () => {
    const grid = new CellGrid(10, 5);
    grid.setCell(0, 3, 0x41, 0, 0, 0, true, true, 0xff8040, 0x00cc55);

    const row = grid.copyRow(0);
    grid.clearRow(2);
    grid.pasteRow(2, row);

    // RGB flags AND actual color values are preserved through copy/paste
    expect(grid.isFgRGB(2, 3)).toBe(true);
    expect(grid.isBgRGB(2, 3)).toBe(true);
    expect(grid.getFgRGB(2, 3)).toBe(0xff8040);
    expect(grid.getBgRGB(2, 3)).toBe(0x00cc55);
  });

  it("cross-row RGB: different rows preserve independent RGB values (#146)", () => {
    const grid = new CellGrid(10, 5);
    grid.setCell(0, 2, 0x41, 0, 0, 0, true, false, 0xff0000);
    grid.setCell(1, 2, 0x42, 0, 0, 0, true, false, 0x00ff00);

    // Each row stores its own RGB value inline — no cross-row clobbering
    expect(grid.getFgRGB(0, 2)).toBe(0xff0000);
    expect(grid.getFgRGB(1, 2)).toBe(0x00ff00);

    // Copy row 0 to row 3, row 1 to row 4
    const row0 = grid.copyRow(0);
    const row1 = grid.copyRow(1);
    grid.pasteRow(3, row0);
    grid.pasteRow(4, row1);

    // Both rows preserve their own RGB values
    expect(grid.getFgRGB(3, 2)).toBe(0xff0000);
    expect(grid.getFgRGB(4, 2)).toBe(0x00ff00);
  });

  it("copyRowCompact returns 2 words/cell for non-RGB rows", () => {
    const grid = new CellGrid(10, 5);
    grid.setCell(0, 0, 0x41, 7, 0, 0);
    grid.setCell(0, 1, 0x42, 1, 2, 0);
    const compact = grid.copyRowCompact(0);
    // 10 cols × 2 words/cell = 20 words
    expect(compact.length).toBe(10 * 2);
    expect(compact[0] & 0x1fffff).toBe(0x41);
    expect(compact[2] & 0x1fffff).toBe(0x42);
  });

  it("copyRowCompact returns 4 words/cell for RGB rows", () => {
    const grid = new CellGrid(10, 5);
    grid.setCell(0, 3, 0x41, 0, 0, 0, true, false, 0xff0000);
    const full = grid.copyRowCompact(0);
    expect(full.length).toBe(10 * CELL_SIZE);
    // RGB value at word 2
    expect(full[3 * CELL_SIZE + 2]).toBe(0xff0000);
  });

  it("compact round-trip through expandCompactRow preserves cell data", () => {
    const grid = new CellGrid(10, 5);
    grid.setCell(0, 0, 0x41, 3, 5, 0x01); // 'A', fg=3, bg=5, bold
    grid.setCell(0, 9, 0x5a, 7, 0, 0); // 'Z' at last col
    const compact = grid.copyRowCompact(0);
    expect(compact.length).toBe(10 * 2); // non-RGB → compact
    const expanded = expandCompactRow(compact, 10);
    expect(expanded.length).toBe(10 * CELL_SIZE);
    grid.pasteRow(2, expanded);
    expect(grid.getCodepoint(2, 0)).toBe(0x41);
    expect(grid.getFgIndex(2, 0)).toBe(3);
    expect(grid.getBgIndex(2, 0)).toBe(5);
    expect(grid.isBold(2, 0)).toBe(true);
    expect(grid.getCodepoint(2, 9)).toBe(0x5a);
  });

  it("pasteCompactRow expands inline without allocation", () => {
    const grid = new CellGrid(10, 5);
    grid.setCell(0, 0, 0x41, 3, 5, 0x01);
    grid.setCell(0, 9, 0x5a, 7, 0, 0);
    const compact = grid.copyRowCompact(0);
    expect(compact.length).toBe(10 * 2);
    grid.pasteCompactRow(2, compact);
    expect(grid.getCodepoint(2, 0)).toBe(0x41);
    expect(grid.getFgIndex(2, 0)).toBe(3);
    expect(grid.getBgIndex(2, 0)).toBe(5);
    expect(grid.isBold(2, 0)).toBe(true);
    expect(grid.getCodepoint(2, 9)).toBe(0x5a);
    // RGB words should be zeroed
    expect(grid.getFgRGB(2, 0)).toBe(0);
    expect(grid.getBgRGB(2, 0)).toBe(0);
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

  // -------------------------------------------------------------------------
  // Ring-buffer rotation (rotateUp / rotateDown)
  // -------------------------------------------------------------------------

  describe("ring-buffer rotation", () => {
    it("rotateUp(1) shifts logical rows up: row[n] gets old row[n+1] content", () => {
      // 3-row grid; write distinct codepoints in each row
      const grid = new CellGrid(5, 3);
      grid.setCell(0, 0, 0x41, 7, 0, 0); // 'A'
      grid.setCell(1, 0, 0x42, 7, 0, 0); // 'B'
      grid.setCell(2, 0, 0x43, 7, 0, 0); // 'C'

      grid.rotateUp(1);

      // After scrolling up by 1: logical row 0 → old row 1, row 1 → old row 2,
      // row 2 wraps to the physical slot that held old row 0 (available for new content).
      expect(grid.getCodepoint(0, 0)).toBe(0x42); // was row 1
      expect(grid.getCodepoint(1, 0)).toBe(0x43); // was row 2
      expect(grid.getCodepoint(2, 0)).toBe(0x41); // physical slot reused (old row 0)
    });

    it("rotateDown(1) shifts logical rows down: row[n] gets old row[n-1] content", () => {
      const grid = new CellGrid(5, 3);
      grid.setCell(0, 0, 0x41, 7, 0, 0); // 'A'
      grid.setCell(1, 0, 0x42, 7, 0, 0); // 'B'
      grid.setCell(2, 0, 0x43, 7, 0, 0); // 'C'

      grid.rotateDown(1);

      // row 0 wraps to old row 2 slot; row 1 → old row 0; row 2 → old row 1
      expect(grid.getCodepoint(0, 0)).toBe(0x43); // physical slot reused (old row 2)
      expect(grid.getCodepoint(1, 0)).toBe(0x41); // was row 0
      expect(grid.getCodepoint(2, 0)).toBe(0x42); // was row 1
    });

    it("full rotation (rows == grid height) returns to original layout", () => {
      const rows = 5;
      const grid = new CellGrid(3, rows);
      for (let r = 0; r < rows; r++) {
        grid.setCell(r, 0, 0x41 + r, 7, 0, 0);
      }

      // Rotating up by the full height should wrap all the way around
      for (let i = 0; i < rows; i++) {
        grid.rotateUp(1);
      }

      // Every logical row should have the same codepoint as before
      for (let r = 0; r < rows; r++) {
        expect(grid.getCodepoint(r, 0)).toBe(0x41 + r);
      }
    });

    it("rotateUp then rotateDown cancels out", () => {
      const grid = new CellGrid(4, 4);
      for (let r = 0; r < 4; r++) {
        grid.setCell(r, 0, 0x41 + r, 7, 0, 0);
      }
      grid.rotateUp(2);
      grid.rotateDown(2);
      for (let r = 0; r < 4; r++) {
        expect(grid.getCodepoint(r, 0)).toBe(0x41 + r);
      }
    });

    it("cell attributes survive ring-buffer rotation", () => {
      const ATTR_ITALIC = 0x02;
      const grid = new CellGrid(5, 3);
      grid.setCell(1, 0, 0x58, 3, 5, ATTR_ITALIC); // 'X' in row 1

      grid.rotateUp(1); // row 1 content moves to logical row 0

      expect(grid.getCodepoint(0, 0)).toBe(0x58);
      expect(grid.getFgIndex(0, 0)).toBe(3);
      expect(grid.getBgIndex(0, 0)).toBe(5);
      expect(grid.getAttrs(0, 0) & ATTR_ITALIC).toBe(ATTR_ITALIC);
    });
  });

  // -------------------------------------------------------------------------
  // Cursor state
  // -------------------------------------------------------------------------

  describe("setCursor / getCursor", () => {
    it("round-trips row, col, visibility, and style", () => {
      const grid = new CellGrid(80, 24);
      grid.setCursor(5, 12, true, "bar");
      const c = grid.getCursor();
      expect(c.row).toBe(5);
      expect(c.col).toBe(12);
      expect(c.visible).toBe(true);
      expect(c.style).toBe("bar");
    });

    it("handles all three cursor styles", () => {
      const grid = new CellGrid(80, 24);
      for (const style of ["block", "underline", "bar"] as const) {
        grid.setCursor(0, 0, true, style);
        expect(grid.getCursor().style).toBe(style);
      }
    });

    it("hidden cursor", () => {
      const grid = new CellGrid(80, 24);
      grid.setCursor(0, 0, false, "block");
      expect(grid.getCursor().visible).toBe(false);
    });

    it("unknown style falls back to block", () => {
      const grid = new CellGrid(80, 24);
      grid.setCursor(0, 0, true, "unknown-style");
      expect(grid.getCursor().style).toBe("block");
    });
  });

  // -------------------------------------------------------------------------
  // markDirtyRange
  // -------------------------------------------------------------------------

  describe("markDirtyRange", () => {
    it("marks a contiguous range of rows dirty", () => {
      const grid = new CellGrid(10, 5);
      for (let r = 0; r < 5; r++) grid.clearDirty(r);

      grid.markDirtyRange(1, 3);

      expect(grid.isDirty(0)).toBe(false);
      expect(grid.isDirty(1)).toBe(true);
      expect(grid.isDirty(2)).toBe(true);
      expect(grid.isDirty(3)).toBe(true);
      expect(grid.isDirty(4)).toBe(false);
    });

    it("single-row range marks just that row", () => {
      const grid = new CellGrid(10, 5);
      for (let r = 0; r < 5; r++) grid.clearDirty(r);
      grid.markDirtyRange(2, 2);
      expect(grid.isDirty(2)).toBe(true);
      expect(grid.isDirty(1)).toBe(false);
      expect(grid.isDirty(3)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Wrap flags
  // -------------------------------------------------------------------------

  describe("wrapFlags", () => {
    it("defaults to false for all rows", () => {
      const grid = new CellGrid(10, 5);
      for (let r = 0; r < 5; r++) {
        expect(grid.isWrapped(r)).toBe(false);
      }
    });

    it("setWrapped / isWrapped round-trip", () => {
      const grid = new CellGrid(10, 5);
      grid.setWrapped(2, true);
      expect(grid.isWrapped(2)).toBe(true);
      expect(grid.isWrapped(1)).toBe(false);
      expect(grid.isWrapped(3)).toBe(false);
    });

    it("clearRow resets wrap flag", () => {
      const grid = new CellGrid(10, 5);
      grid.setWrapped(2, true);
      grid.clearRow(2);
      expect(grid.isWrapped(2)).toBe(false);
    });

    it("clearRowRaw resets wrap flag", () => {
      const grid = new CellGrid(10, 5);
      grid.setWrapped(3, true);
      grid.clearRowRaw(3);
      expect(grid.isWrapped(3)).toBe(false);
    });

    it("clear() resets all wrap flags", () => {
      const grid = new CellGrid(10, 5);
      grid.setWrapped(0, true);
      grid.setWrapped(2, true);
      grid.setWrapped(4, true);
      grid.clear();
      for (let r = 0; r < 5; r++) {
        expect(grid.isWrapped(r)).toBe(false);
      }
    });

    it("wrap flags survive rotateUp", () => {
      const grid = new CellGrid(10, 5);
      grid.setWrapped(1, true); // logical row 1
      grid.setWrapped(3, true); // logical row 3
      grid.rotateUp();
      // After rotateUp: old logical 1 is now logical 0, old logical 3 is now logical 2
      expect(grid.isWrapped(0)).toBe(true);
      expect(grid.isWrapped(2)).toBe(true);
      // Old logical 0 rotated to logical 4 (the new bottom), but its flag is the old row 0's flag
      expect(grid.isWrapped(1)).toBe(false);
      expect(grid.isWrapped(3)).toBe(false);
    });

    it("wrap flags survive rotateDown", () => {
      const grid = new CellGrid(10, 5);
      grid.setWrapped(1, true);
      grid.setWrapped(3, true);
      grid.rotateDown();
      // After rotateDown: old logical 1 is now logical 2, old logical 3 is now logical 4
      expect(grid.isWrapped(2)).toBe(true);
      expect(grid.isWrapped(4)).toBe(true);
      expect(grid.isWrapped(0)).toBe(false);
      expect(grid.isWrapped(1)).toBe(false);
      expect(grid.isWrapped(3)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Wide character flag
  // -------------------------------------------------------------------------

  describe("wide character flag", () => {
    it("isWide returns false when wide bit is not set", () => {
      const grid = new CellGrid(10, 5);
      grid.setCell(0, 0, 0x41, 7, 0, 0);
      expect(grid.isWide(0, 0)).toBe(false);
    });

    it("isWide returns true when ATTR_WIDE (0x80) is set in attrs", () => {
      const ATTR_WIDE = 0x80;
      const grid = new CellGrid(10, 5);
      grid.setCell(0, 0, 0x4e2d, 7, 0, ATTR_WIDE); // U+4E2D '中'
      expect(grid.isWide(0, 0)).toBe(true);
    });

    it("wide flag does not interfere with other attribute bits", () => {
      const ATTR_BOLD = 0x01;
      const ATTR_WIDE = 0x80;
      const grid = new CellGrid(10, 5);
      grid.setCell(0, 0, 0x4e2d, 7, 0, ATTR_BOLD | ATTR_WIDE);
      expect(grid.isWide(0, 0)).toBe(true);
      expect(grid.getAttrs(0, 0) & ATTR_BOLD).toBe(ATTR_BOLD);
    });
  });
});
