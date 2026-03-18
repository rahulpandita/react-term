/**
 * Shared test helpers for core package VTParser / BufferSet tests.
 *
 * Import from individual test files instead of duplicating these definitions.
 */
import type { BufferSet } from "../buffer.js";
import type { VTParser } from "../parser/index.js";

const enc = new TextEncoder();

/** Shared TextEncoder instance for tests that need raw byte access. */
export { enc };

/** Write a string into a VTParser (UTF-8 encoded). */
export function write(parser: VTParser, str: string): void {
  parser.write(enc.encode(str));
}

/** Read row text with trailing spaces trimmed. */
export function readLineTrimmed(bs: BufferSet, row: number): string {
  const grid = bs.active.grid;
  let end = grid.cols - 1;
  while (end >= 0 && grid.getCodepoint(row, end) === 0x20) end--;
  let result = "";
  for (let c = 0; c <= end; c++) {
    result += String.fromCodePoint(grid.getCodepoint(row, c));
  }
  return result;
}

/** Read row text without trimming trailing spaces (up to optional endCol). */
export function readLineRaw(bs: BufferSet, row: number, endCol?: number): string {
  const grid = bs.active.grid;
  const limit = endCol ?? grid.cols;
  let result = "";
  for (let c = 0; c < limit; c++) {
    result += String.fromCodePoint(grid.getCodepoint(row, c));
  }
  return result;
}

/** Read the full visible screen as plain text (rows joined by \n, trailing empty rows stripped). */
export function readScreen(bs: BufferSet): string {
  const lines: string[] = [];
  for (let r = 0; r < bs.active.grid.rows; r++) {
    lines.push(readLineTrimmed(bs, r));
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Return the active cursor position (0-based row and col). */
export function cursor(bs: BufferSet): { row: number; col: number } {
  const c = bs.active.cursor;
  return { row: c.row, col: c.col };
}
