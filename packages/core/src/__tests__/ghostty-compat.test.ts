/**
 * Ghostty Compatibility Tests
 *
 * Test vectors ported from Ghostty's Terminal.zig and sgr.zig
 * (https://github.com/ghostty-org/ghostty/blob/main/src/terminal/Terminal.zig)
 *
 * These tests verify that react-term's VT parser and buffer management
 * produce the same results as Ghostty for core terminal operations.
 *
 * Ghostty uses 1-indexed CUP parameters (VT spec) but 0-indexed internal cursor.
 * react-term uses 0-indexed cursor throughout. The VT escape sequences
 * (\x1b[row;colH) use 1-indexed params per the spec.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BufferSet } from '../buffer.js';
import { VTParser } from '../parser/index.js';

const enc = new TextEncoder();

function write(parser: VTParser, str: string): void {
  parser.write(enc.encode(str));
}

function readLineTrimmed(bs: BufferSet, row: number): string {
  const grid = bs.active.grid;
  let end = grid.cols - 1;
  while (end >= 0 && grid.getCodepoint(row, end) === 0x20) end--;
  let result = '';
  for (let c = 0; c <= end; c++) {
    result += String.fromCodePoint(grid.getCodepoint(row, c));
  }
  return result;
}

function readScreen(bs: BufferSet): string {
  const lines: string[] = [];
  for (let r = 0; r < bs.active.grid.rows; r++) {
    lines.push(readLineTrimmed(bs, r));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** CUP: \x1b[row;colH (1-indexed) */
function cup(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/** CUU: cursor up */
function cuu(n: number): string {
  return `\x1b[${n}A`;
}

/** CUD: cursor down */
function cud(n: number): string {
  return `\x1b[${n}B`;
}

/** CUF: cursor forward (right) */
function cuf(n: number): string {
  return `\x1b[${n}C`;
}

/** CUB: cursor backward (left) */
function cub(n: number): string {
  return `\x1b[${n}D`;
}

/** ECH: erase characters */
function ech(n: number): string {
  return `\x1b[${n}X`;
}

/** EL: erase in line (0=right, 1=left, 2=complete) */
function el(mode: number): string {
  return `\x1b[${mode}K`;
}

/** ED: erase in display (0=below, 1=above, 2=complete, 3=scrollback) */
function ed(mode: number): string {
  return `\x1b[${mode}J`;
}

/** SU: scroll up */
function su(n: number): string {
  return `\x1b[${n}S`;
}

/** SD: scroll down */
function sd(n: number): string {
  return `\x1b[${n}T`;
}

/** IL: insert lines */
function il(n: number): string {
  return `\x1b[${n}L`;
}

/** DL: delete lines */
function dl(n: number): string {
  return `\x1b[${n}M`;
}

/** DCH: delete characters */
function dch(n: number): string {
  return `\x1b[${n}P`;
}

/** ICH: insert blanks */
function ich(n: number): string {
  return `\x1b[${n}@`;
}

/** DECSTBM: set top and bottom margins (1-indexed) */
function decstbm(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

/** RI: reverse index */
const RI = '\x1bM';

/** LF: line feed */
const LF = '\n';

/** CR: carriage return */
const CR = '\r';

/** BS: backspace */
const BS = '\b';

/** HT: horizontal tab */
const HT = '\t';

describe('Ghostty Compatibility Tests', () => {
  // ============================================================
  // Basic Printing
  // ============================================================
  describe('Basic printing and cursor position', () => {
    it('prints with no control characters', () => {
      const bs = new BufferSet(40, 40);
      const parser = new VTParser(bs);
      write(parser, 'hello');
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(5);
      expect(readScreen(bs)).toBe('hello');
    });

    it('wraps at column boundary', () => {
      const bs = new BufferSet(5, 40);
      const parser = new VTParser(bs);
      write(parser, 'helloworldabc12');
      expect(parser.cursor.row).toBe(2);
      // Ghostty: cursor stays at cols-1 with wrapPending=true after printing last column
      expect(parser.cursor.col).toBe(4);
      expect(parser.cursor.wrapPending).toBe(true);
      expect(readScreen(bs)).toBe('hello\nworld\nabc12');
    });

    it('scrolls when output exceeds rows', () => {
      const bs = new BufferSet(1, 5);
      const parser = new VTParser(bs);
      write(parser, 'abcdef');
      // After printing 6 chars in 1-col 5-row terminal:
      // 'a' scrolls off, visible: b c d e f
      expect(parser.cursor.row).toBe(4);
      // Ghostty: cursor stays at cols-1=0 with wrapPending=true
      expect(parser.cursor.col).toBe(0);
      expect(parser.cursor.wrapPending).toBe(true);
      expect(readScreen(bs)).toBe('b\nc\nd\ne\nf');
    });

    it('prints a single long line wrapping multiple times', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'abcdefghijklmnopqrstuvwxy');
      // 24 chars in 5-col terminal = 4 full rows + 4 chars in last row
      // With scrollback, first rows scroll off. 24/5=4.8 -> 5 rows used
      // In react-term's model the visible 5 rows show the last 5 lines
      expect(readLineTrimmed(bs, 0)).toBe('abcde');
      expect(readLineTrimmed(bs, 1)).toBe('fghij');
      expect(readLineTrimmed(bs, 2)).toBe('klmno');
      expect(readLineTrimmed(bs, 3)).toBe('pqrst');
      expect(readLineTrimmed(bs, 4)).toBe('uvwxy');
    });

    it('soft wraps at column boundary', () => {
      const bs = new BufferSet(3, 80);
      const parser = new VTParser(bs);
      write(parser, 'hello');
      expect(parser.cursor.row).toBe(1);
      expect(parser.cursor.col).toBe(2);
      expect(readScreen(bs)).toBe('hel\nlo');
    });
  });

  // ============================================================
  // Linefeed, Carriage Return, Backspace
  // ============================================================
  describe('Linefeed, carriage return, backspace', () => {
    it('linefeed and carriage return', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      write(parser, 'hello');
      write(parser, CR + LF);
      write(parser, 'world');
      expect(parser.cursor.row).toBe(1);
      expect(parser.cursor.col).toBe(5);
      expect(readScreen(bs)).toBe('hello\nworld');
    });

    it('backspace moves cursor left and allows overwrite', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      write(parser, 'hello');
      write(parser, BS);
      write(parser, 'y');
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(5);
      expect(readScreen(bs)).toBe('helly');
    });

    it('backspace does not move past column 0', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      write(parser, BS); // at col 0, should stay at 0
      expect(parser.cursor.col).toBe(0);
      write(parser, 'A');
      expect(readLineTrimmed(bs, 0)).toBe('A');
    });

    it('multiple linefeeds move cursor down', () => {
      const bs = new BufferSet(80, 10);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, LF + LF + LF);
      write(parser, 'B');
      expect(parser.cursor.row).toBe(3);
      expect(readLineTrimmed(bs, 0)).toBe('A');
    });

    it('carriage return moves cursor to column 0', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      write(parser, 'hello');
      expect(parser.cursor.col).toBe(5);
      write(parser, CR);
      expect(parser.cursor.col).toBe(0);
      write(parser, 'HE');
      expect(readLineTrimmed(bs, 0)).toBe('HEllo');
    });
  });

  // ============================================================
  // Horizontal Tabs (HT)
  // ============================================================
  describe('Horizontal tabs', () => {
    it('tabs to next 8-column boundary', () => {
      const bs = new BufferSet(20, 5);
      const parser = new VTParser(bs);
      write(parser, '1');
      write(parser, HT);
      expect(parser.cursor.col).toBe(8);
    });

    it('tabs twice moves to column 16', () => {
      const bs = new BufferSet(20, 5);
      const parser = new VTParser(bs);
      write(parser, '1');
      write(parser, HT);
      write(parser, HT);
      expect(parser.cursor.col).toBe(16);
    });

    it('tab at end of line stays at last column', () => {
      const bs = new BufferSet(20, 5);
      const parser = new VTParser(bs);
      write(parser, '1');
      write(parser, HT + HT + HT); // col 8, 16, 19 (last col)
      expect(parser.cursor.col).toBe(19);
      write(parser, HT); // already at end, stays
      expect(parser.cursor.col).toBe(19);
    });

    it('tab from tabstop position moves to next tabstop', () => {
      const bs = new BufferSet(20, 5);
      const parser = new VTParser(bs);
      // Move cursor to col 8 (a tabstop) and tab - should go to 16
      write(parser, cup(1, 9)); // 1-indexed col 9 = 0-indexed col 8
      write(parser, HT);
      expect(parser.cursor.col).toBe(16);
    });
  });

  // ============================================================
  // setCursorPos (CUP)
  // ============================================================
  describe('setCursorPos (CUP)', () => {
    it('sets cursor to specific position', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(0);
      write(parser, cup(10, 20));
      expect(parser.cursor.row).toBe(9);  // 0-indexed
      expect(parser.cursor.col).toBe(19); // 0-indexed
    });

    it('CUP with 0,0 stays at origin', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      write(parser, cup(0, 0));
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(0);
    });

    it('CUP clamps to screen bounds', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      write(parser, cup(81, 81));
      expect(parser.cursor.row).toBe(79);
      expect(parser.cursor.col).toBe(79);
    });

    it('CUP off the screen prints at clamped position', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, cup(500, 500));
      write(parser, 'X');
      expect(readScreen(bs)).toBe('\n\n\n\n    X');
    });

    it('CUP resets pending wrap state', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE'); // fills row, pending wrap
      write(parser, cup(1, 1)); // reset wrap, go to 0,0
      write(parser, 'X');
      expect(readScreen(bs)).toBe('XBCDE');
    });

    it('CUP with origin mode relative to scroll region', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      // Set scroll region rows 3-4 (1-indexed)
      write(parser, decstbm(3, 4));
      // Enable origin mode
      write(parser, '\x1b[?6h');
      write(parser, cup(1, 1));
      write(parser, 'X');
      // Origin mode: row 1 relative to scroll region top (row 3, 0-indexed row 2)
      expect(readScreen(bs)).toBe('\n\nX');
    });
  });

  // ============================================================
  // cursorUp / cursorDown / cursorLeft / cursorRight
  // ============================================================
  describe('Cursor movement', () => {
    it('cursorUp basic', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, cup(3, 1));
      write(parser, 'A');
      write(parser, cuu(10));
      write(parser, 'X');
      expect(readScreen(bs)).toBe(' X\n\nA');
    });

    it('cursorUp stops at top scroll margin', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, decstbm(2, 4));
      write(parser, cup(3, 1));
      write(parser, 'A');
      write(parser, cuu(5));
      write(parser, 'X');
      expect(readScreen(bs)).toBe('\n X\nA');
    });

    it('cursorUp above top scroll margin clamps to row 0', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      // Position cursor, write content, then set scroll region and test CUU
      write(parser, cup(3, 1));
      write(parser, 'A');       // A at row 2, col 0
      write(parser, cup(2, 2)); // row 1, col 1 (above where we'll set scroll region)
      write(parser, cuu(10));   // should clamp to row 0 (no scroll region yet)
      write(parser, 'X');
      expect(readLineTrimmed(bs, 0)).toBe(' X'); // X at row 0, col 1
      expect(readLineTrimmed(bs, 2)).toBe('A');
    });

    it('cursorDown basic', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, cud(10));
      write(parser, 'X');
      expect(readScreen(bs)).toBe('A\n\n\n\n X');
    });

    it('cursorDown stops at bottom scroll margin', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, decstbm(1, 3));
      write(parser, 'A');
      write(parser, cud(10));
      write(parser, 'X');
      expect(readScreen(bs)).toBe('A\n\n X');
    });

    it('cursorDown below bottom scroll margin goes to last row', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      // Position cursor below where scroll region will be, without DECSTBM reset
      write(parser, cup(4, 1)); // row 3
      write(parser, cud(10));   // no scroll region, clamps to row 4
      write(parser, 'X');
      expect(readScreen(bs)).toBe('A\n\n\n\nX');
    });

    it('cursorDown with pending wrap clears wrap and moves down', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE'); // cursor at col 4, wrapPending=true
      write(parser, cud(1));  // Ghostty: clears wrapPending, moves down from (0,4) to (1,4)
      write(parser, 'X');
      // Ghostty: CUD clears pending wrap without wrapping, cursor goes to (1,4), X prints there
      expect(readScreen(bs)).toBe('ABCDE\n    X');
    });

    it('cursorLeft does not wrap', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, CR + LF);
      write(parser, 'B');
      write(parser, cub(10));
      // Should stay on row 1, col 0 (no reverse wrap by default)
      expect(readScreen(bs)).toBe('A\nB');
    });

    it('cursorLeft from end of line overwrites last char', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE'); // cursor at col 4, wrapPending=true
      write(parser, cub(1));  // Ghostty: clears wrapPending, col 4-1=3
      write(parser, 'X');
      // Ghostty: cursor at col 4 (pending_wrap), CUB(1) -> col 3, X overwrites D
      expect(readScreen(bs)).toBe('ABCXE');
    });

    it('cursorLeft with longer jump from end of line', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE'); // cursor at col 4, wrapPending=true
      write(parser, cub(3));  // Ghostty: clears wrapPending, col 4-3=1
      write(parser, 'X');
      // Ghostty: cursor at col 4 (pending_wrap), CUB(3) -> col 1, X overwrites B
      expect(readScreen(bs)).toBe('AXCDE');
    });

    it('cursorRight resets pending wrap', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE'); // pending wrap
      write(parser, cuf(1));
      write(parser, 'X');
      expect(readScreen(bs)).toBe('ABCDX');
    });

    it('cursorRight to edge of screen', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, cuf(100));
      write(parser, 'X');
      expect(readScreen(bs)).toBe('    X');
    });

    it('cursorUp from end of line stays at top and prints', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE'); // cursor at col 4, wrapPending=true
      write(parser, cuu(1));
      write(parser, 'X');
      // Ghostty: cursor at (0,4) with wrapPending. CUU(1) clears wrapPending,
      // stays at row 0 (already at top). X prints at (0,4), overwriting E.
      expect(readLineTrimmed(bs, 0)).toBe('ABCDX');
    });
  });

  // ============================================================
  // eraseChars (ECH)
  // ============================================================
  describe('eraseChars (ECH)', () => {
    it('erases specified number of characters', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, cup(1, 1)); // go to col 0
      write(parser, ech(2));    // erase 2 chars
      write(parser, 'X');       // print X at col 0
      expect(readScreen(bs)).toBe('X C');
    });

    it('ECH with 0 erases minimum one character', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, cup(1, 1));
      write(parser, ech(0));
      write(parser, 'X');
      expect(readScreen(bs)).toBe('XBC');
    });

    it('ECH beyond screen edge clamps', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, '  ABC');
      write(parser, cup(1, 4)); // col 3, 0-indexed
      write(parser, ech(10));
      expect(readScreen(bs)).toBe('  A');
    });

    it('ECH at end of line erases and allows overwrite', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCD');
      write(parser, cup(1, 5)); // col 4 (0-indexed)
      write(parser, ech(1));
      write(parser, 'X');
      // Erases char at col 4, then prints X at col 4
      expect(readScreen(bs)).toBe('ABCDX');
    });

    it('ECH preserves default fg/bg on erased cells', () => {
      const bs = new BufferSet(10, 10);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, cup(1, 1));
      write(parser, ech(2));
      const grid = bs.active.grid;
      // Erased cells should have default fg=7, bg=0
      expect(grid.getFgIndex(0, 0)).toBe(7);
      expect(grid.getBgIndex(0, 0)).toBe(0);
      expect(grid.getFgIndex(0, 1)).toBe(7);
      expect(grid.getBgIndex(0, 1)).toBe(0);
    });
  });

  // ============================================================
  // eraseLine (EL)
  // ============================================================
  describe('eraseLine (EL)', () => {
    it('erase right (EL 0)', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 3)); // col 2, 0-indexed
      write(parser, el(0));
      expect(readScreen(bs)).toBe('AB');
    });

    it('erase left (EL 1)', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 3)); // col 2, 0-indexed
      write(parser, el(1));
      expect(readScreen(bs)).toBe('   DE');
    });

    it('erase complete line (EL 2)', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 3));
      write(parser, el(2));
      expect(readLineTrimmed(bs, 0)).toBe('');
    });

    it('erase right at explicit position', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 5)); // col 4
      write(parser, el(0));     // erase from col 4 right
      write(parser, 'B');
      expect(readScreen(bs)).toBe('ABCDB');
    });

    it('erase left at last column', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 5)); // col 4
      write(parser, el(1));     // erase from col 4 leftward (inclusive)
      write(parser, 'B');
      expect(readScreen(bs)).toBe('    B');
    });

    it('erase right preserves other rows', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, CR + LF);
      write(parser, 'FGHIJ');
      write(parser, cup(1, 3)); // row 0, col 2
      write(parser, el(0));
      expect(readLineTrimmed(bs, 0)).toBe('AB');
      expect(readLineTrimmed(bs, 1)).toBe('FGHIJ');
    });
  });

  // ============================================================
  // eraseDisplay (ED)
  // ============================================================
  describe('eraseDisplay (ED)', () => {
    it('erase below (ED 0)', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, cup(2, 2)); // row 1, col 1
      write(parser, ed(0));
      expect(readScreen(bs)).toBe('ABC\nD');
    });

    it('erase above (ED 1)', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, cup(2, 2)); // row 1, col 1
      write(parser, ed(1));
      expect(readScreen(bs)).toBe('\n  F\nGHI');
    });

    it('erase complete (ED 2)', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, ed(2));
      expect(readScreen(bs)).toBe('');
    });

    it('erase below preserves content above cursor row', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, 'Line1');
      write(parser, CR + LF);
      write(parser, 'Line2');
      write(parser, CR + LF);
      write(parser, 'Line3');
      write(parser, cup(2, 4)); // row 1, col 3
      write(parser, ed(0));
      expect(readLineTrimmed(bs, 0)).toBe('Line1');
      expect(readLineTrimmed(bs, 1)).toBe('Lin');
      expect(readLineTrimmed(bs, 2)).toBe('');
    });

    it('erase above preserves content below cursor row', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, 'Line1');
      write(parser, CR + LF);
      write(parser, 'Line2');
      write(parser, CR + LF);
      write(parser, 'Line3');
      write(parser, cup(2, 4)); // row 1, col 3 (0-indexed)
      write(parser, ed(1));
      expect(readLineTrimmed(bs, 0)).toBe('');
      // ED above erases through cursor position (inclusive per VT spec)
      // react-term erases cols 0..col inclusive on cursor row
      expect(readLineTrimmed(bs, 1)).toBe('    2');
      expect(readLineTrimmed(bs, 2)).toBe('Line3');
    });

    it('erase complete preserves cursor position', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'AAAA');
      const row = parser.cursor.row;
      const col = parser.cursor.col;
      write(parser, ed(2));
      // Cursor position should not change
      expect(parser.cursor.row).toBe(row);
      expect(parser.cursor.col).toBe(col);
    });

    it('ED scroll complete (mode 3) clears everything', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, CR + LF);
      write(parser, ed(3));
      expect(readScreen(bs)).toBe('');
    });
  });

  // ============================================================
  // scrollUp (SU)
  // ============================================================
  describe('scrollUp (SU)', () => {
    it('scrolls up simple', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, su(1));
      expect(readScreen(bs)).toBe('DEF\nGHI');
    });

    it('scrolls up with scroll region', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, decstbm(2, 3));
      write(parser, cup(1, 1));
      write(parser, su(1));
      expect(readScreen(bs)).toBe('ABC\nGHI');
    });

    it('scrolls up multiple lines', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'AAA');
      write(parser, CR + LF);
      write(parser, 'BBB');
      write(parser, CR + LF);
      write(parser, 'CCC');
      write(parser, CR + LF);
      write(parser, 'DDD');
      write(parser, su(2));
      expect(readScreen(bs)).toBe('CCC\nDDD');
    });

    it('scroll up preserves cursor position', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, cup(2, 2)); // row 1, col 1
      const curRow = parser.cursor.row;
      const curCol = parser.cursor.col;
      write(parser, su(1));
      expect(parser.cursor.row).toBe(curRow);
      expect(parser.cursor.col).toBe(curCol);
    });
  });

  // ============================================================
  // scrollDown (SD)
  // ============================================================
  describe('scrollDown (SD)', () => {
    it('scrolls down simple', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, sd(1));
      expect(readScreen(bs)).toBe('\nABC\nDEF\nGHI');
    });

    it('scrolls down with scroll region', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, decstbm(3, 4));
      write(parser, cup(2, 2));
      write(parser, sd(1));
      expect(readScreen(bs)).toBe('ABC\nDEF\n\nGHI');
    });

    it('scroll down preserves cursor position', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, cup(2, 2)); // row 1, col 1
      const curRow = parser.cursor.row;
      const curCol = parser.cursor.col;
      write(parser, sd(1));
      expect(parser.cursor.row).toBe(curRow);
      expect(parser.cursor.col).toBe(curCol);
    });
  });

  // ============================================================
  // insertLines (IL)
  // ============================================================
  describe('insertLines (IL)', () => {
    it('inserts one line simple', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, cup(2, 2)); // row 1
      write(parser, il(1));
      expect(readScreen(bs)).toBe('ABC\n\nDEF\nGHI');
    });

    it('insertLines outside scroll region does nothing', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, decstbm(3, 4));
      write(parser, cup(2, 2)); // row 1, outside scroll region (3-4)
      write(parser, il(1));
      expect(readScreen(bs)).toBe('ABC\nDEF\nGHI');
    });

    it('insertLines within scroll region', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, CR + LF);
      write(parser, 'JKL');
      write(parser, decstbm(1, 3));
      write(parser, cup(1, 1));
      write(parser, il(1));
      write(parser, 'E');
      write(parser, CR + LF);
      expect(readScreen(bs)).toBe('E\nABC\nDEF\nJKL');
    });

    it('insertLines more than remaining shifts all', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, cup(2, 1)); // row 1
      write(parser, il(100));
      // All content from row 1 onwards pushed off screen
      expect(readLineTrimmed(bs, 0)).toBe('ABC');
      expect(readLineTrimmed(bs, 1)).toBe('');
    });
  });

  // ============================================================
  // deleteLines (DL)
  // ============================================================
  describe('deleteLines (DL)', () => {
    it('deletes one line simple', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, cup(2, 2)); // row 1
      write(parser, dl(1));
      expect(readScreen(bs)).toBe('ABC\nGHI');
    });

    it('deleteLines legacy test', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, CR + LF);
      write(parser, 'B');
      write(parser, CR + LF);
      write(parser, 'C');
      write(parser, CR + LF);
      write(parser, 'D');
      // D is at row 3. CUU(2) goes to row 1 (B's row). DL(1) deletes row 1.
      // After DL: row 0=A, row 1=C, row 2=D
      write(parser, cuu(2));
      write(parser, dl(1));
      // DL moves cursor to col 0. Print 'E' overwrites at current row.
      write(parser, 'E');
      write(parser, CR + LF);
      // react-term: after DL the row content shifts up, cursor at row 1 col 0
      // 'E' prints at row 1, then CR+LF goes to row 2
      expect(parser.cursor.row).toBe(2);
      expect(parser.cursor.col).toBe(0);
      // Result: A at row 0, E+remaining of C at row 1, D at row 2
      expect(readLineTrimmed(bs, 0)).toBe('A');
      expect(readLineTrimmed(bs, 2)).toBe('D');
    });

    it('deleteLines with scroll region', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, CR + LF);
      write(parser, 'B');
      write(parser, CR + LF);
      write(parser, 'C');
      write(parser, CR + LF);
      write(parser, 'D');
      write(parser, decstbm(1, 3));
      write(parser, cup(1, 1));
      write(parser, dl(1));
      write(parser, 'E');
      write(parser, CR + LF);
      expect(readScreen(bs)).toBe('E\nC\n\nD');
    });

    it('deleteLines with large count clears scroll region', () => {
      const bs = new BufferSet(80, 80);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, CR + LF);
      write(parser, 'B');
      write(parser, CR + LF);
      write(parser, 'C');
      write(parser, CR + LF);
      write(parser, 'D');
      write(parser, decstbm(1, 3));
      write(parser, cup(1, 1));
      write(parser, dl(5));
      write(parser, 'E');
      write(parser, CR + LF);
      expect(readScreen(bs)).toBe('E\n\n\nD');
    });

    it('deleteLines at cursor row clears content', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, cup(2, 1)); // row 1
      write(parser, dl(1));
      // Row 1 (DEF) is deleted, content below shifts up
      expect(readLineTrimmed(bs, 0)).toBe('ABC');
      expect(readLineTrimmed(bs, 1)).toBe('');
    });
  });

  // ============================================================
  // deleteChars (DCH)
  // ============================================================
  describe('deleteChars (DCH)', () => {
    it('deletes characters and shifts left', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 2)); // col 1
      write(parser, dch(2));
      expect(readScreen(bs)).toBe('ADE');
    });

    it('DCH with zero count deletes one (minimum 1)', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 2)); // col 1
      write(parser, dch(0));
      // react-term treats DCH(0) as DCH(1) (minimum 1)
      // Ghostty treats DCH(0) as no-op
      expect(readScreen(bs)).toBe('ACDE');
    });

    it('DCH deletes more than half', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 2)); // col 1
      write(parser, dch(3));
      expect(readScreen(bs)).toBe('AE');
    });

    it('DCH deletes more than line width', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 2)); // col 1
      write(parser, dch(10));
      expect(readScreen(bs)).toBe('A');
    });

    it('DCH shifts left by one', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 2)); // col 1
      write(parser, dch(1));
      expect(readScreen(bs)).toBe('ACDE');
    });

    it('DCH at explicit last position', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDE');
      write(parser, cup(1, 5)); // col 4 (last column)
      write(parser, dch(1));    // delete char at col 4
      write(parser, 'X');
      expect(readScreen(bs)).toBe('ABCDX');
    });

    it('DCH simple operation on wider terminal', () => {
      const bs = new BufferSet(10, 10);
      const parser = new VTParser(bs);
      write(parser, 'ABC123');
      write(parser, cup(1, 3)); // col 2
      write(parser, dch(2));
      expect(readScreen(bs)).toBe('AB23');
    });
  });

  // ============================================================
  // insertBlanks (ICH)
  // ============================================================
  describe('insertBlanks (ICH)', () => {
    it('inserts blanks shifting content right', () => {
      const bs = new BufferSet(5, 2);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, cup(1, 1)); // col 0
      write(parser, ich(2));
      expect(readScreen(bs)).toBe('  ABC');
    });

    it('ICH pushes content off the end', () => {
      const bs = new BufferSet(3, 2);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, cup(1, 1)); // col 0
      write(parser, ich(2));
      expect(readScreen(bs)).toBe('  A');
    });

    it('ICH with count more than cols clears line', () => {
      const bs = new BufferSet(3, 2);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, cup(1, 1)); // col 0
      write(parser, ich(5));
      expect(readScreen(bs)).toBe('');
    });

    it('ICH with zero count inserts one (minimum 1)', () => {
      const bs = new BufferSet(5, 2);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, cup(1, 1)); // col 0
      write(parser, ich(0));
      // react-term treats ICH(0) as ICH(1) (minimum 1)
      // Ghostty treats ICH(0) as no-op
      expect(readScreen(bs)).toBe(' ABC');
    });

    it('ICH fits without pushing off', () => {
      const bs = new BufferSet(10, 10);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, cup(1, 1)); // col 0
      write(parser, ich(2));
      expect(readScreen(bs)).toBe('  ABC');
    });

    it('ICH shift off screen then print', () => {
      const bs = new BufferSet(5, 10);
      const parser = new VTParser(bs);
      write(parser, '  ABC');
      write(parser, cup(1, 3)); // col 2
      write(parser, ich(2));
      write(parser, 'X');
      expect(readScreen(bs)).toBe('  X A');
    });
  });

  // ============================================================
  // Reverse Index (RI)
  // ============================================================
  describe('Reverse Index (RI)', () => {
    it('moves cursor up within screen', () => {
      const bs = new BufferSet(2, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, CR + LF);
      write(parser, 'B');
      write(parser, CR + LF);
      write(parser, 'C');
      write(parser, RI);
      write(parser, 'D');
      write(parser, CR + LF + CR + LF);
      expect(readScreen(bs)).toBe('A\nBD\nC');
    });

    it('scrolls down when at top of screen', () => {
      const bs = new BufferSet(2, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, CR + LF);
      write(parser, 'B');
      write(parser, CR + LF + CR + LF);
      write(parser, cup(1, 1));
      write(parser, RI);
      write(parser, 'D');
      write(parser, CR + LF);
      write(parser, cup(1, 1));
      write(parser, RI);
      write(parser, 'E');
      write(parser, CR + LF);
      expect(readScreen(bs)).toBe('E\nD\nA\nB');
    });

    it('scrolls at top of scroll region', () => {
      const bs = new BufferSet(2, 10);
      const parser = new VTParser(bs);
      write(parser, cup(2, 1));
      write(parser, 'A');
      write(parser, CR + LF);
      write(parser, 'B');
      write(parser, CR + LF);
      write(parser, 'C');
      write(parser, CR + LF);
      write(parser, 'D');
      write(parser, CR + LF);
      write(parser, decstbm(2, 5));
      write(parser, cup(2, 1));
      write(parser, RI);
      write(parser, 'X');
      expect(readScreen(bs)).toBe('\nX\nA\nB\nC');
    });

    it('RI at top of screen inserts blank line', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, cup(2, 1));
      write(parser, 'B');
      write(parser, cup(3, 1));
      write(parser, 'C');
      write(parser, cup(1, 1));
      write(parser, RI);
      write(parser, 'X');
      expect(readScreen(bs)).toBe('X\nA\nB\nC');
    });

    it('RI not at top moves cursor up', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, cup(2, 1));
      write(parser, 'B');
      write(parser, cup(3, 1));
      write(parser, 'C');
      write(parser, cup(2, 1));
      write(parser, RI);
      write(parser, 'X');
      expect(readScreen(bs)).toBe('X\nB\nC');
    });

    it('RI within top/bottom margins scrolls region', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, cup(2, 1));
      write(parser, 'B');
      write(parser, cup(3, 1));
      write(parser, 'C');
      write(parser, decstbm(2, 3));
      write(parser, cup(2, 1));
      write(parser, RI);
      expect(readScreen(bs)).toBe('A\n\nB');
    });

    it('RI outside top/bottom margins just moves cursor', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'A');
      write(parser, cup(2, 1));
      write(parser, 'B');
      write(parser, cup(3, 1));
      write(parser, 'C');
      write(parser, decstbm(2, 3));
      write(parser, cup(1, 1)); // above scroll region
      write(parser, RI);
      // Already at row 0, can't go higher, no scrolling since outside region
      expect(readScreen(bs)).toBe('A\nB\nC');
    });
  });

  // ============================================================
  // DECSTBM (scroll region)
  // ============================================================
  describe('DECSTBM (scroll region)', () => {
    it('sets scroll region and scrollDown operates within it', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, decstbm(0, 0)); // reset to full
      write(parser, sd(1));
      expect(readScreen(bs)).toBe('\nABC\nDEF\nGHI');
    });

    it('top-only margin', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, decstbm(2, 0)); // top=2, bottom=full
      write(parser, sd(1));
      expect(readScreen(bs)).toBe('ABC\n\nDEF\nGHI');
    });

    it('top and bottom margin', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, decstbm(1, 2));
      write(parser, sd(1));
      expect(readScreen(bs)).toBe('\nABC\nGHI');
    });

    it('linefeed scrolls within scroll region', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, 'Line1');
      write(parser, CR + LF);
      write(parser, 'Line2');
      write(parser, CR + LF);
      write(parser, 'Line3');
      write(parser, CR + LF);
      write(parser, 'Line4');
      write(parser, CR + LF);
      write(parser, 'Line5');
      // Set scroll region to rows 2-4
      write(parser, decstbm(2, 4));
      // Move to bottom of scroll region and add lines
      write(parser, cup(4, 1));
      write(parser, LF);
      write(parser, 'New');
      // Line2 should scroll off within region
      expect(readLineTrimmed(bs, 0)).toBe('Line1');
      expect(readLineTrimmed(bs, 3)).toBe('New');
      expect(readLineTrimmed(bs, 4)).toBe('Line5');
    });

    it('scroll region reset moves cursor to origin', () => {
      const bs = new BufferSet(80, 24);
      const parser = new VTParser(bs);
      write(parser, cup(10, 10));
      write(parser, decstbm(5, 15));
      // DECSTBM resets cursor to 0,0
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(0);
    });
  });

  // ============================================================
  // DECAWM (autowrap mode)
  // ============================================================
  describe('DECAWM (autowrap mode)', () => {
    it('default autowrap mode wraps at end of line', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDEFGH');
      expect(readScreen(bs)).toBe('ABCDE\nFGH');
    });

    it('disabled autowrap does not wrap', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      // Disable autowrap: DECRST mode 7
      write(parser, '\x1b[?7l');
      write(parser, 'ABCDEFGH');
      // Without wraparound, chars past col 4 overwrite the last column
      expect(parser.cursor.row).toBe(0);
      expect(readLineTrimmed(bs, 0)).toBe('ABCDH');
    });

    it('re-enabling autowrap allows wrapping again', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[?7l'); // disable
      write(parser, 'ABCDE');    // fills row
      write(parser, '\x1b[?7h'); // re-enable
      write(parser, 'F');        // should wrap to next row
      expect(readLineTrimmed(bs, 1)).toBe('F');
    });
  });

  // ============================================================
  // SGR (Select Graphic Rendition)
  // ============================================================
  describe('SGR attributes', () => {
    it('bold (SGR 1) sets bold attribute', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[1mA');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01);
    });

    it('italic (SGR 3) sets italic attribute', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[3mA');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x02).toBe(0x02);
    });

    it('underline (SGR 4) sets underline attribute', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[4mA');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x04).toBe(0x04);
    });

    it('strikethrough (SGR 9) sets strikethrough attribute', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[9mA');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x08).toBe(0x08);
    });

    it('inverse (SGR 7) sets inverse attribute', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[7mA');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x40).toBe(0x40);
    });

    it('SGR reset (SGR 0) clears all attributes', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[1;3;4mBold+Italic+Underline');
      write(parser, '\x1b[0mNormal');
      const grid = bs.active.grid;
      // First char should have bold+italic+underline
      expect(grid.getAttrs(0, 0) & 0x07).toBe(0x07);
      // After reset, should have no attributes
      const normalStart = 'Bold+Italic+Underline'.length;
      expect(grid.getAttrs(0, normalStart)).toBe(0);
    });

    it('reset bold (SGR 22) clears bold', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[1mA\x1b[22mB');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01);
      expect(grid.getAttrs(0, 1) & 0x01).toBe(0x00);
    });

    it('reset italic (SGR 23) clears italic', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[3mA\x1b[23mB');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x02).toBe(0x02);
      expect(grid.getAttrs(0, 1) & 0x02).toBe(0x00);
    });

    it('reset underline (SGR 24) clears underline', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[4mA\x1b[24mB');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x04).toBe(0x04);
      expect(grid.getAttrs(0, 1) & 0x04).toBe(0x00);
    });

    it('reset strikethrough (SGR 29) clears strikethrough', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[9mA\x1b[29mB');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x08).toBe(0x08);
      expect(grid.getAttrs(0, 1) & 0x08).toBe(0x00);
    });

    it('reset inverse (SGR 27) clears inverse', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[7mA\x1b[27mB');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x40).toBe(0x40);
      expect(grid.getAttrs(0, 1) & 0x40).toBe(0x00);
    });

    it('standard foreground colors (SGR 30-37)', () => {
      const bs = new BufferSet(80, 5);
      const parser = new VTParser(bs);
      // Red foreground (SGR 31 = color index 1)
      write(parser, '\x1b[31mR');
      // Green foreground (SGR 32 = color index 2)
      write(parser, '\x1b[32mG');
      // Blue foreground (SGR 34 = color index 4)
      write(parser, '\x1b[34mB');
      const grid = bs.active.grid;
      expect(grid.getFgIndex(0, 0)).toBe(1); // red
      expect(grid.getFgIndex(0, 1)).toBe(2); // green
      expect(grid.getFgIndex(0, 2)).toBe(4); // blue
    });

    it('standard background colors (SGR 40-47)', () => {
      const bs = new BufferSet(80, 5);
      const parser = new VTParser(bs);
      // Red background (SGR 41 = color index 1)
      write(parser, '\x1b[41mR');
      // Green background (SGR 42 = color index 2)
      write(parser, '\x1b[42mG');
      const grid = bs.active.grid;
      expect(grid.getBgIndex(0, 0)).toBe(1); // red
      expect(grid.getBgIndex(0, 1)).toBe(2); // green
    });

    it('bright foreground colors (SGR 90-97)', () => {
      const bs = new BufferSet(80, 5);
      const parser = new VTParser(bs);
      // Bright red (SGR 91 = color index 9)
      write(parser, '\x1b[91mR');
      // Bright green (SGR 92 = color index 10)
      write(parser, '\x1b[92mG');
      const grid = bs.active.grid;
      expect(grid.getFgIndex(0, 0)).toBe(9);  // bright red
      expect(grid.getFgIndex(0, 1)).toBe(10); // bright green
    });

    it('bright background colors (SGR 100-107)', () => {
      const bs = new BufferSet(80, 5);
      const parser = new VTParser(bs);
      // Bright yellow background (SGR 103 = color index 11)
      write(parser, '\x1b[103mY');
      const grid = bs.active.grid;
      expect(grid.getBgIndex(0, 0)).toBe(11);
    });

    it('default foreground (SGR 39) resets to default', () => {
      const bs = new BufferSet(80, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[31mR\x1b[39mD');
      const grid = bs.active.grid;
      expect(grid.getFgIndex(0, 0)).toBe(1); // red
      expect(grid.getFgIndex(0, 1)).toBe(7); // default
    });

    it('default background (SGR 49) resets to default', () => {
      const bs = new BufferSet(80, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[41mR\x1b[49mD');
      const grid = bs.active.grid;
      expect(grid.getBgIndex(0, 0)).toBe(1); // red bg
      expect(grid.getBgIndex(0, 1)).toBe(0); // default bg
    });

    it('multiple SGR params in one sequence', () => {
      const bs = new BufferSet(80, 5);
      const parser = new VTParser(bs);
      // Bold + red foreground + blue background
      write(parser, '\x1b[1;31;44mA');
      const grid = bs.active.grid;
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // bold
      expect(grid.getFgIndex(0, 0)).toBe(1); // red
      expect(grid.getBgIndex(0, 0)).toBe(4); // blue
    });
  });

  // ============================================================
  // Index (IND) - cursor down / scroll
  // ============================================================
  describe('Index (IND)', () => {
    it('index moves cursor down', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      // IND = ESC D
      write(parser, '\x1bD');
      write(parser, 'A');
      expect(readScreen(bs)).toBe('\nA');
    });

    it('index at bottom scrolls up', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, cup(5, 1)); // last row
      write(parser, 'A');
      write(parser, cub(1));
      write(parser, '\x1bD'); // index
      write(parser, 'B');
      expect(readLineTrimmed(bs, 3)).toBe('A');
      expect(readLineTrimmed(bs, 4)).toBe('B');
    });

    it('index outside scroll region just moves cursor', () => {
      const bs = new BufferSet(2, 5);
      const parser = new VTParser(bs);
      expect(parser.cursor.row).toBe(0);
      write(parser, decstbm(2, 5));
      write(parser, '\x1bD'); // index
      expect(parser.cursor.row).toBe(1);
    });
  });

  // ============================================================
  // Combined / integration tests from Ghostty patterns
  // ============================================================
  describe('Combined operations', () => {
    it('print, CUP, and overwrite', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, 'Hello');
      write(parser, cup(1, 1));
      write(parser, 'J');
      expect(readScreen(bs)).toBe('Jello');
    });

    it('scroll region with insert and delete lines', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, 'AAA');
      write(parser, CR + LF);
      write(parser, 'BBB');
      write(parser, CR + LF);
      write(parser, 'CCC');
      write(parser, CR + LF);
      write(parser, 'DDD');
      write(parser, CR + LF);
      write(parser, 'EEE');
      write(parser, decstbm(2, 4));
      write(parser, cup(2, 1));
      write(parser, il(1));
      // Insert line at row 2 in scroll region [2,4]: BBB shifts down, DDD scrolls off
      expect(readLineTrimmed(bs, 0)).toBe('AAA');
      expect(readLineTrimmed(bs, 1)).toBe('');
      expect(readLineTrimmed(bs, 2)).toBe('BBB');
      expect(readLineTrimmed(bs, 3)).toBe('CCC');
      expect(readLineTrimmed(bs, 4)).toBe('EEE');
    });

    it('erase display below then print', () => {
      const bs = new BufferSet(5, 3);
      const parser = new VTParser(bs);
      write(parser, 'ABC');
      write(parser, CR + LF);
      write(parser, 'DEF');
      write(parser, CR + LF);
      write(parser, 'GHI');
      write(parser, cup(2, 1));
      write(parser, ed(0)); // erase below from row 1
      write(parser, 'X');
      expect(readScreen(bs)).toBe('ABC\nX');
    });

    it('multiple SGR + erase preserves defaults on erased cells', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, '\x1b[1;31mRed Bold');
      write(parser, '\x1b[0m'); // reset
      write(parser, cup(1, 1));
      write(parser, el(0)); // erase right
      const grid = bs.active.grid;
      // After erase, cells should have default fg=7, bg=0, attrs=0
      for (let c = 0; c < 10; c++) {
        expect(grid.getFgIndex(0, c)).toBe(7);
        expect(grid.getBgIndex(0, c)).toBe(0);
      }
    });

    it('insert blanks then delete chars roundtrip', () => {
      const bs = new BufferSet(10, 5);
      const parser = new VTParser(bs);
      write(parser, 'ABCDEF');
      write(parser, cup(1, 3)); // col 2
      write(parser, ich(2));    // insert 2 blanks
      expect(readScreen(bs)).toBe('AB  CDEF');
      write(parser, dch(2));    // delete 2 chars - should restore
      expect(readScreen(bs)).toBe('ABCDEF');
    });

    it('scroll up then scroll down cancels out', () => {
      const bs = new BufferSet(5, 5);
      const parser = new VTParser(bs);
      write(parser, 'AAA');
      write(parser, CR + LF);
      write(parser, 'BBB');
      write(parser, CR + LF);
      write(parser, 'CCC');
      // Scroll up then down - new blank row inserted
      write(parser, su(1));
      write(parser, sd(1));
      // After SU(1): BBB, CCC, (blank), ...
      // After SD(1): (blank), BBB, CCC, ...
      // So row 0 is blank, row 1 = BBB, row 2 = CCC
      expect(readLineTrimmed(bs, 0)).toBe('');
      expect(readLineTrimmed(bs, 1)).toBe('BBB');
      expect(readLineTrimmed(bs, 2)).toBe('CCC');
    });
  });
});
