// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { type ColorFloat4, resolveColorFloat } from "../webgl-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaletteFloat(): ColorFloat4[] {
  const palette: ColorFloat4[] = [];
  for (let i = 0; i < 256; i++) {
    // Each palette entry is a distinct color so we can verify lookups
    palette.push([i / 255, 0, 0, 1.0]);
  }
  return palette;
}

const THEME_FG: ColorFloat4 = [0.83, 0.83, 0.83, 1.0]; // ~#d4d4d4
const THEME_BG: ColorFloat4 = [0.1, 0.1, 0.1, 1.0]; // ~#1a1a1a

// ---------------------------------------------------------------------------
// resolveColorFloat
// ---------------------------------------------------------------------------

describe("resolveColorFloat", () => {
  it("returns theme foreground float for default fg (colorIdx=7, isForeground=true)", () => {
    const palette = makePaletteFloat();
    const result = resolveColorFloat(7, false, 0, true, palette, THEME_FG, THEME_BG);
    expect(result).toBe(THEME_FG);
  });

  it("returns theme background float for default bg (colorIdx=0, isForeground=false)", () => {
    const palette = makePaletteFloat();
    const result = resolveColorFloat(0, false, 0, false, palette, THEME_FG, THEME_BG);
    expect(result).toBe(THEME_BG);
  });

  it("returns palette color for indexed color (e.g., colorIdx=1)", () => {
    const palette = makePaletteFloat();
    const result = resolveColorFloat(1, false, 0, true, palette, THEME_FG, THEME_BG);
    expect(result).toBe(palette[1]);
    expect(result[0]).toBeCloseTo(1 / 255, 5);
  });

  it("returns palette color for non-default foreground index", () => {
    const palette = makePaletteFloat();
    const result = resolveColorFloat(196, false, 0, true, palette, THEME_FG, THEME_BG);
    expect(result).toBe(palette[196]);
  });

  it("returns palette color for non-default background index", () => {
    const palette = makePaletteFloat();
    const result = resolveColorFloat(4, false, 0, false, palette, THEME_FG, THEME_BG);
    expect(result).toBe(palette[4]);
  });

  it("returns theme fg for out-of-range foreground index (>=256)", () => {
    const palette = makePaletteFloat();
    const result = resolveColorFloat(256, false, 0, true, palette, THEME_FG, THEME_BG);
    expect(result).toBe(THEME_FG);
  });

  it("returns theme bg for out-of-range background index (>=256)", () => {
    const palette = makePaletteFloat();
    const result = resolveColorFloat(300, false, 0, false, palette, THEME_FG, THEME_BG);
    expect(result).toBe(THEME_BG);
  });

  it("returns RGB extracted color when isRGB=true for foreground", () => {
    const palette = makePaletteFloat();
    // Pack RGB: r=0xFF, g=0x00, b=0x00 (red)
    const result = resolveColorFloat(0, true, 0xff0000, true, palette, THEME_FG, THEME_BG);
    expect(result[0]).toBeCloseTo(1.0, 5);
    expect(result[1]).toBeCloseTo(0.0, 5);
    expect(result[2]).toBeCloseTo(0.0, 5);
    expect(result[3]).toBe(1.0);
  });

  it("returns RGB extracted color when isRGB=true for background", () => {
    const palette = makePaletteFloat();
    // Pack RGB: r=0x00, g=0xFF, b=0x00 (green)
    const result = resolveColorFloat(0, true, 0x00ff00, false, palette, THEME_FG, THEME_BG);
    expect(result[0]).toBeCloseTo(0.0, 5);
    expect(result[1]).toBeCloseTo(1.0, 5);
    expect(result[2]).toBeCloseTo(0.0, 5);
    expect(result[3]).toBe(1.0);
  });

  it("RGB extraction correctly handles packed RGB (0xFF8000)", () => {
    const palette = makePaletteFloat();
    // Pack RGB: r=0xFF, g=0x80, b=0x00
    const result = resolveColorFloat(0, true, 0xff8000, true, palette, THEME_FG, THEME_BG);
    expect(result[0]).toBeCloseTo(1.0, 5); // 0xFF / 255
    expect(result[1]).toBeCloseTo(0x80 / 255, 5); // ~0.502
    expect(result[2]).toBeCloseTo(0.0, 5); // 0x00 / 255
    expect(result[3]).toBe(1.0);
  });
});
