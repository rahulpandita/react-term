import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import { describe, expect, it } from "vitest";
import { build256Palette } from "../renderer.js";

// ---------------------------------------------------------------------------
// 1. 256-color palette consistency
// ---------------------------------------------------------------------------
describe("256-color palette consistency", () => {
  const palette = build256Palette(DEFAULT_THEME);

  it("palette[0] = theme.black", () => {
    expect(palette[0]).toBe(DEFAULT_THEME.black);
  });

  it("palette[1] = theme.red", () => {
    expect(palette[1]).toBe(DEFAULT_THEME.red);
  });

  it("palette[2] = theme.green", () => {
    expect(palette[2]).toBe(DEFAULT_THEME.green);
  });

  it("palette[3] = theme.yellow", () => {
    expect(palette[3]).toBe(DEFAULT_THEME.yellow);
  });

  it("palette[4] = theme.blue", () => {
    expect(palette[4]).toBe(DEFAULT_THEME.blue);
  });

  it("palette[5] = theme.magenta", () => {
    expect(palette[5]).toBe(DEFAULT_THEME.magenta);
  });

  it("palette[6] = theme.cyan", () => {
    expect(palette[6]).toBe(DEFAULT_THEME.cyan);
  });

  it("palette[7] = theme.white", () => {
    expect(palette[7]).toBe(DEFAULT_THEME.white);
  });

  it("palette[8] = theme.brightBlack", () => {
    expect(palette[8]).toBe(DEFAULT_THEME.brightBlack);
  });

  it("palette[9] = theme.brightRed", () => {
    expect(palette[9]).toBe(DEFAULT_THEME.brightRed);
  });

  it("palette[10] = theme.brightGreen", () => {
    expect(palette[10]).toBe(DEFAULT_THEME.brightGreen);
  });

  it("palette[11] = theme.brightYellow", () => {
    expect(palette[11]).toBe(DEFAULT_THEME.brightYellow);
  });

  it("palette[12] = theme.brightBlue", () => {
    expect(palette[12]).toBe(DEFAULT_THEME.brightBlue);
  });

  it("palette[13] = theme.brightMagenta", () => {
    expect(palette[13]).toBe(DEFAULT_THEME.brightMagenta);
  });

  it("palette[14] = theme.brightCyan", () => {
    expect(palette[14]).toBe(DEFAULT_THEME.brightCyan);
  });

  it("palette[15] = theme.brightWhite", () => {
    expect(palette[15]).toBe(DEFAULT_THEME.brightWhite);
  });
});

// ---------------------------------------------------------------------------
// 2. Color resolution
// ---------------------------------------------------------------------------
describe("Color resolution", () => {
  const palette = build256Palette(DEFAULT_THEME);

  // Replicate the renderer's resolveCellColor logic for testing without canvas
  function resolveCellColor(
    colorIdx: number,
    isRGB: boolean,
    grid: CellGrid,
    col: number,
    isForeground: boolean,
  ): string {
    if (isRGB) {
      const offset = isForeground ? col : 256 + col;
      const rgb = grid.rgbColors[offset];
      const r = (rgb >> 16) & 0xff;
      const g = (rgb >> 8) & 0xff;
      const b = rgb & 0xff;
      return `rgb(${r},${g},${b})`;
    }

    if (isForeground && colorIdx === 7) return DEFAULT_THEME.foreground;
    if (!isForeground && colorIdx === 0) return DEFAULT_THEME.background;

    if (colorIdx >= 0 && colorIdx < 256) {
      return palette[colorIdx];
    }

    return isForeground ? DEFAULT_THEME.foreground : DEFAULT_THEME.background;
  }

  const grid = new CellGrid(80, 24);

  it("fgIndex=7 resolves to theme.foreground", () => {
    expect(resolveCellColor(7, false, grid, 0, true)).toBe(DEFAULT_THEME.foreground);
  });

  it("bgIndex=0 resolves to theme.background", () => {
    expect(resolveCellColor(0, false, grid, 0, false)).toBe(DEFAULT_THEME.background);
  });

  it("fgIndex=1 resolves to palette[1] (red)", () => {
    expect(resolveCellColor(1, false, grid, 0, true)).toBe(palette[1]);
    expect(resolveCellColor(1, false, grid, 0, true)).toBe(DEFAULT_THEME.red);
  });

  it("bgIndex=2 resolves to palette[2] (green)", () => {
    expect(resolveCellColor(2, false, grid, 0, false)).toBe(palette[2]);
    expect(resolveCellColor(2, false, grid, 0, false)).toBe(DEFAULT_THEME.green);
  });

  it("fgIndex=8 resolves to palette[8] (brightBlack)", () => {
    expect(resolveCellColor(8, false, grid, 0, true)).toBe(DEFAULT_THEME.brightBlack);
  });

  it("256-color index resolves to correct palette entry", () => {
    expect(resolveCellColor(123, false, grid, 0, true)).toBe(palette[123]);
  });

  it("RGB foreground resolves from rgbColors", () => {
    const testGrid = new CellGrid(80, 24);
    const packedRGB = (255 << 16) | (128 << 8) | 64;
    testGrid.rgbColors[5] = packedRGB; // col=5, foreground
    expect(resolveCellColor(0, true, testGrid, 5, true)).toBe("rgb(255,128,64)");
  });

  it("RGB background resolves from rgbColors[256 + col]", () => {
    const testGrid = new CellGrid(80, 24);
    const packedRGB = (10 << 16) | (20 << 8) | 30;
    testGrid.rgbColors[256 + 3] = packedRGB; // col=3, background
    expect(resolveCellColor(0, true, testGrid, 3, false)).toBe("rgb(10,20,30)");
  });
});
