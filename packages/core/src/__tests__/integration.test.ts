import { describe, it, expect } from 'vitest';
import { BufferSet } from '../buffer.js';
import { VTParser } from '../parser/index.js';

/** Helper: encode a string as Uint8Array and feed it to the parser. */
function write(parser: VTParser, text: string): void {
  parser.write(new TextEncoder().encode(text));
}

/** Create a fresh 80x24 BufferSet + VTParser pair. */
function setup(cols = 80, rows = 24) {
  const bs = new BufferSet(cols, rows);
  const parser = new VTParser(bs);
  return { bs, parser, grid: bs.active.grid };
}

// ---------------------------------------------------------------------------
// 1. ASCII text roundtrip
// ---------------------------------------------------------------------------
describe('ASCII text roundtrip', () => {
  it('writes "Hello" and reads back correct codepoints, fg, and bg', () => {
    const { parser, grid } = setup();
    write(parser, 'Hello');

    const expected = 'Hello';
    for (let i = 0; i < expected.length; i++) {
      expect(grid.getCodepoint(0, i)).toBe(expected.charCodeAt(i));
      expect(grid.getFgIndex(0, i)).toBe(7);
      expect(grid.getBgIndex(0, i)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SGR bold + color
// ---------------------------------------------------------------------------
describe('SGR bold + color', () => {
  it('parses bold red "X" with correct attrs, fg, and codepoint', () => {
    const { parser, grid } = setup();
    write(parser, '\x1b[1;31mX\x1b[0m');

    expect(grid.getCodepoint(0, 0)).toBe(0x58); // 'X'
    expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // bold bit
    expect(grid.getFgIndex(0, 0)).toBe(1); // red
    expect(grid.isFgRGB(0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. 256-color foreground
// ---------------------------------------------------------------------------
describe('256-color foreground', () => {
  it('sets fgIndex to 123 via SGR 38;5;123', () => {
    const { parser, grid } = setup();
    write(parser, '\x1b[38;5;123mA\x1b[0m');

    expect(grid.getCodepoint(0, 0)).toBe(0x41); // 'A'
    expect(grid.getFgIndex(0, 0)).toBe(123);
    expect(grid.isFgRGB(0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. 24-bit RGB foreground
// ---------------------------------------------------------------------------
describe('24-bit RGB foreground', () => {
  it('sets RGB fg via SGR 38;2;100;200;50', () => {
    const { parser, grid } = setup();
    write(parser, '\x1b[38;2;100;200;50mR\x1b[0m');

    expect(grid.getCodepoint(0, 0)).toBe(0x52); // 'R'
    expect(grid.isFgRGB(0, 0)).toBe(true);
    // rgbColors[col] holds packed RGB for foreground
    const expectedRGB = (100 << 16) | (200 << 8) | 50;
    expect(grid.rgbColors[0]).toBe(expectedRGB);
  });
});

// ---------------------------------------------------------------------------
// 5. Background colors (standard)
// ---------------------------------------------------------------------------
describe('Background colors', () => {
  it('sets bgIndex to 2 (green) via SGR 42', () => {
    const { parser, grid } = setup();
    write(parser, '\x1b[42mB\x1b[0m');

    expect(grid.getCodepoint(0, 0)).toBe(0x42); // 'B'
    expect(grid.getBgIndex(0, 0)).toBe(2);
    expect(grid.isBgRGB(0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. 256-color background
// ---------------------------------------------------------------------------
describe('256-color background', () => {
  it('sets bgIndex to 200 via SGR 48;5;200', () => {
    const { parser, grid } = setup();
    write(parser, '\x1b[48;5;200mC\x1b[0m');

    expect(grid.getCodepoint(0, 0)).toBe(0x43); // 'C'
    expect(grid.getBgIndex(0, 0)).toBe(200);
    expect(grid.isBgRGB(0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. RGB background
// ---------------------------------------------------------------------------
describe('RGB background', () => {
  it('sets RGB bg via SGR 48;2;10;20;30', () => {
    const { parser, grid } = setup();
    write(parser, '\x1b[48;2;10;20;30mD\x1b[0m');

    expect(grid.getCodepoint(0, 0)).toBe(0x44); // 'D'
    expect(grid.isBgRGB(0, 0)).toBe(true);
    const expectedRGB = (10 << 16) | (20 << 8) | 30;
    expect(grid.rgbColors[256 + 0]).toBe(expectedRGB);
  });
});

// ---------------------------------------------------------------------------
// 8. Inverse attribute
// ---------------------------------------------------------------------------
describe('Inverse attribute', () => {
  it('sets inverse bit via SGR 7', () => {
    const { parser, grid } = setup();
    write(parser, '\x1b[7mI\x1b[0m');

    expect(grid.getCodepoint(0, 0)).toBe(0x49); // 'I'
    expect(grid.getAttrs(0, 0) & 0x40).toBe(0x40); // inverse bit
  });
});

// ---------------------------------------------------------------------------
// 9. Cursor position after write
// ---------------------------------------------------------------------------
describe('Cursor position after write', () => {
  it('cursor is at row=1, col=2 after "AB\\r\\nCD"', () => {
    const { parser, bs } = setup();
    write(parser, 'AB\r\nCD');

    expect(bs.active.cursor.row).toBe(1);
    expect(bs.active.cursor.col).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 10. Erase clears to defaults
// ---------------------------------------------------------------------------
describe('Erase clears to defaults', () => {
  it('ESC[2K resets row 0 cells to space, fg=7, bg=0', () => {
    const { parser, grid } = setup();
    write(parser, 'XXXXX');
    // Move cursor back to row 0 so EL operates on row 0
    write(parser, '\x1b[1;1H'); // CUP to row 1, col 1 (0-based: 0,0)
    write(parser, '\x1b[2K'); // Erase entire line

    for (let c = 0; c < 5; c++) {
      expect(grid.getCodepoint(0, c)).toBe(0x20); // space
      expect(grid.getFgIndex(0, c)).toBe(7);
      expect(grid.getBgIndex(0, c)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Dirty tracking
// ---------------------------------------------------------------------------
describe('Dirty tracking', () => {
  it('only the written row is dirty after clearing and writing one char', () => {
    const { parser, grid } = setup();
    // Clear all dirty flags
    for (let r = 0; r < 24; r++) grid.clearDirty(r);

    // Write a single character at row 0
    write(parser, 'Z');

    expect(grid.isDirty(0)).toBe(true);
    for (let r = 1; r < 24; r++) {
      expect(grid.isDirty(r)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Scrollback
// ---------------------------------------------------------------------------
describe('Scrollback', () => {
  it('writing 30 lines into a 24-row terminal fills scrollback and grid shows last 24 lines', () => {
    const { bs, parser, grid } = setup(80, 24);

    // Write 30 lines: "Line 00\n" through "Line 29\n"
    for (let i = 0; i < 30; i++) {
      const line = `Line ${String(i).padStart(2, '0')}`;
      write(parser, line + '\r\n');
    }

    // Should have scrollback entries (30 lines overflow 24 rows)
    expect(bs.scrollback.length).toBeGreaterThan(0);

    // After writing 30 lines (each followed by \r\n), the terminal scrolls.
    // 30 lines of content + 30 newlines means 30 content rows used. With 24
    // visible rows, 7 lines get scrolled out (the last \r\n after "Line 29"
    // pushes one more). Row 0 should contain "Line 07".
    const row0Text = readRowText(grid, 0, 7);
    expect(row0Text).toBe('Line 07');

    // "Line 29" should appear at row 22 (30 - 7 - 1 = 22, since the final
    // \r\n moves cursor to the next row, leaving Line 29 one row above bottom).
    const row22Text = readRowText(grid, 22, 7);
    expect(row22Text).toBe('Line 29');
  });
});

/** Read `length` characters from a grid row as a string. */
function readRowText(grid: import('../cell-grid.js').CellGrid, row: number, length: number): string {
  let s = '';
  for (let c = 0; c < length; c++) {
    s += String.fromCodePoint(grid.getCodepoint(row, c));
  }
  return s;
}
