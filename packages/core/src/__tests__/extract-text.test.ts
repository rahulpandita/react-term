import { describe, it, expect } from 'vitest';
import { CellGrid, extractText, normalizeSelection } from '../index.js';

describe('normalizeSelection', () => {
  it('returns same order when start is before end', () => {
    const sel = normalizeSelection({ startRow: 0, startCol: 2, endRow: 1, endCol: 5 });
    expect(sel).toEqual({ startRow: 0, startCol: 2, endRow: 1, endCol: 5 });
  });

  it('swaps when end is before start (backwards selection)', () => {
    const sel = normalizeSelection({ startRow: 3, startCol: 10, endRow: 1, endCol: 5 });
    expect(sel).toEqual({ startRow: 1, startCol: 5, endRow: 3, endCol: 10 });
  });

  it('swaps columns on same row when startCol > endCol', () => {
    const sel = normalizeSelection({ startRow: 2, startCol: 8, endRow: 2, endCol: 3 });
    expect(sel).toEqual({ startRow: 2, startCol: 3, endRow: 2, endCol: 8 });
  });

  it('does not swap when start equals end', () => {
    const sel = normalizeSelection({ startRow: 1, startCol: 4, endRow: 1, endCol: 4 });
    expect(sel).toEqual({ startRow: 1, startCol: 4, endRow: 1, endCol: 4 });
  });
});

describe('extractText', () => {
  function makeGrid(rows: number, cols: number, lines: string[]): CellGrid {
    const grid = new CellGrid(cols, rows);
    for (let r = 0; r < lines.length && r < rows; r++) {
      for (let c = 0; c < lines[r].length && c < cols; c++) {
        grid.setCell(r, c, lines[r].charCodeAt(c), 7, 0, 0);
      }
    }
    return grid;
  }

  it('extracts a single-row selection', () => {
    const grid = makeGrid(3, 20, ['Hello, World!', 'Second line', 'Third line']);
    const text = extractText(grid, 0, 0, 0, 12);
    expect(text).toBe('Hello, World!');
  });

  it('extracts a partial single-row selection', () => {
    const grid = makeGrid(3, 20, ['Hello, World!', 'Second line', 'Third line']);
    const text = extractText(grid, 0, 7, 0, 11);
    expect(text).toBe('World');
  });

  it('extracts a multi-row selection', () => {
    const grid = makeGrid(3, 20, ['Hello, World!', 'Second line', 'Third line']);
    const text = extractText(grid, 0, 7, 2, 4);
    expect(text).toBe('World!\nSecond line\nThird');
  });

  it('trims trailing spaces from each line', () => {
    const grid = makeGrid(2, 20, ['Hello', 'World']);
    // Cells beyond the text are spaces (default)
    const text = extractText(grid, 0, 0, 1, 19);
    expect(text).toBe('Hello\nWorld');
  });

  it('handles backwards selection (end before start)', () => {
    const grid = makeGrid(3, 20, ['Hello, World!', 'Second line', 'Third line']);
    // Backwards: from row 1 col 5 to row 0 col 0
    const text = extractText(grid, 1, 5, 0, 0);
    expect(text).toBe('Hello, World!\nSecond');
  });

  it('returns empty string for empty cells', () => {
    const grid = new CellGrid(10, 5); // all spaces
    const text = extractText(grid, 0, 0, 0, 9);
    expect(text).toBe('');
  });

  it('clamps to grid bounds', () => {
    const grid = makeGrid(3, 10, ['Hello', 'World']);
    // endRow beyond grid
    const text = extractText(grid, 0, 0, 10, 5);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });
});
