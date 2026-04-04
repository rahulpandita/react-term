import type { CellGrid } from "@next_term/core";

export type ColorFloat4 = [number, number, number, number];

export function resolveColorFloat(
  colorIdx: number,
  isRGB: boolean,
  grid: CellGrid,
  col: number,
  isForeground: boolean,
  paletteFloat: ColorFloat4[],
  themeFgFloat: ColorFloat4,
  themeBgFloat: ColorFloat4,
): ColorFloat4 {
  if (isRGB) {
    const offset = isForeground ? col : 256 + col;
    const rgb = grid.rgbColors[offset];
    const r = ((rgb >> 16) & 0xff) / 255;
    const g = ((rgb >> 8) & 0xff) / 255;
    const b = (rgb & 0xff) / 255;
    return [r, g, b, 1.0];
  }

  if (isForeground && colorIdx === 7) return themeFgFloat;
  if (!isForeground && colorIdx === 0) return themeBgFloat;

  if (colorIdx >= 0 && colorIdx < 256) {
    return paletteFloat[colorIdx];
  }

  return isForeground ? themeFgFloat : themeBgFloat;
}
