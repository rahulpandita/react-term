import type { CellGrid } from "../index.js";

export const ATTR_WIDE = 0x80;

/** Write a wide character (e.g. CJK) at (row, col) spanning 2 cells. */
export function setWide(grid: CellGrid, row: number, col: number, cp: number): void {
  grid.setCell(row, col, cp, 7, 0, ATTR_WIDE);
  grid.setCell(row, col + 1, 0, 7, 0, 0); // spacer
}
