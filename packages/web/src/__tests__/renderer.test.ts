import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import { describe, expect, it } from "vitest";
import { build256Palette, Canvas2DRenderer } from "../renderer.js";

// ---------------------------------------------------------------------------
// 256-color palette generation
// ---------------------------------------------------------------------------

describe("build256Palette", () => {
  const palette = build256Palette(DEFAULT_THEME);

  it("returns exactly 256 entries", () => {
    expect(palette).toHaveLength(256);
  });

  it("first 16 entries match theme ANSI colors", () => {
    const themeColors = [
      DEFAULT_THEME.black,
      DEFAULT_THEME.red,
      DEFAULT_THEME.green,
      DEFAULT_THEME.yellow,
      DEFAULT_THEME.blue,
      DEFAULT_THEME.magenta,
      DEFAULT_THEME.cyan,
      DEFAULT_THEME.white,
      DEFAULT_THEME.brightBlack,
      DEFAULT_THEME.brightRed,
      DEFAULT_THEME.brightGreen,
      DEFAULT_THEME.brightYellow,
      DEFAULT_THEME.brightBlue,
      DEFAULT_THEME.brightMagenta,
      DEFAULT_THEME.brightCyan,
      DEFAULT_THEME.brightWhite,
    ];
    for (let i = 0; i < 16; i++) {
      expect(palette[i]).toBe(themeColors[i]);
    }
  });

  it("color 16 is rgb(0,0,0) — start of 6x6x6 cube", () => {
    expect(palette[16]).toBe("rgb(0,0,0)");
  });

  it("color 21 is rgb(0,0,255) — blue end of first row", () => {
    expect(palette[21]).toBe("rgb(0,0,255)");
  });

  it("color 196 is rgb(255,0,0) — bright red in cube", () => {
    // r=5, g=0, b=0 → 16 + 5*36 + 0*6 + 0 = 196
    expect(palette[196]).toBe("rgb(255,0,0)");
  });

  it("color 231 is rgb(255,255,255) — end of cube", () => {
    expect(palette[231]).toBe("rgb(255,255,255)");
  });

  it("color 232 is rgb(8,8,8) — start of grayscale ramp", () => {
    expect(palette[232]).toBe("rgb(8,8,8)");
  });

  it("color 255 is rgb(238,238,238) — end of grayscale ramp", () => {
    expect(palette[255]).toBe("rgb(238,238,238)");
  });

  it("no palette entry is undefined", () => {
    for (let i = 0; i < 256; i++) {
      expect(palette[i]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Cell size measurement (unit-test-safe: no real canvas)
// ---------------------------------------------------------------------------

describe("Canvas2DRenderer", () => {
  it("getCellSize returns positive dimensions even without real canvas", () => {
    const renderer = new Canvas2DRenderer({
      fontSize: 14,
      fontFamily: "monospace",
      theme: DEFAULT_THEME,
    });
    const { width, height } = renderer.getCellSize();
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    renderer.dispose();
  });

  it("cell height is at least as large as font size", () => {
    const renderer = new Canvas2DRenderer({
      fontSize: 16,
      fontFamily: "monospace",
      theme: DEFAULT_THEME,
    });
    const { height } = renderer.getCellSize();
    expect(height).toBeGreaterThanOrEqual(16);
    renderer.dispose();
  });
});

// ---------------------------------------------------------------------------
// Core CellGrid dirty row tracking
// ---------------------------------------------------------------------------

describe("CellGrid dirty tracking", () => {
  it("marks all rows dirty after construction", () => {
    const grid = new CellGrid(80, 24);
    for (let r = 0; r < 24; r++) {
      expect(grid.isDirty(r)).toBe(true);
    }
  });

  it("clearDirty removes dirty flag for a specific row", () => {
    const grid = new CellGrid(80, 24);
    grid.clearDirty(5);
    expect(grid.isDirty(5)).toBe(false);
    expect(grid.isDirty(4)).toBe(true);
  });

  it("setCell marks the row as dirty", () => {
    const grid = new CellGrid(80, 24);
    // Clear all dirty flags
    for (let r = 0; r < 24; r++) grid.clearDirty(r);
    grid.setCell(10, 5, 0x41, 7, 0, 0); // 'A'
    expect(grid.isDirty(10)).toBe(true);
    expect(grid.isDirty(9)).toBe(false);
  });

  it("markAllDirty marks every row", () => {
    const grid = new CellGrid(80, 24);
    for (let r = 0; r < 24; r++) grid.clearDirty(r);
    grid.markAllDirty();
    for (let r = 0; r < 24; r++) {
      expect(grid.isDirty(r)).toBe(true);
    }
  });
});
