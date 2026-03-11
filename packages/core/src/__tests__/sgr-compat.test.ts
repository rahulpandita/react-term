import { describe, it, expect, beforeEach } from 'vitest';
import { BufferSet } from '../buffer.js';
import { VTParser } from '../parser/index.js';

const enc = new TextEncoder();

function write(parser: VTParser, str: string): void {
  parser.write(enc.encode(str));
}

describe('SGR Compatibility Tests (ported from xterm.js / ghostty)', () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
    parser = new VTParser(bs);
  });

  // Helper: write a character after applying SGR and return grid accessors for row 0, col 0
  function writeCharWithSGR(sgr: string, ch = 'X'): void {
    write(parser, sgr + ch);
  }

  const grid = () => bs.active.grid;

  // ---------------------------------------------------------------------------
  // Basic attributes
  // ---------------------------------------------------------------------------

  describe('basic attributes', () => {
    it('SGR 0 resets all attributes', () => {
      write(parser, '\x1b[1;3;4m'); // bold + italic + underline
      write(parser, '\x1b[0mA');
      expect(grid().getAttrs(0, 0)).toBe(0);
    });

    it('SGR 1 sets bold (attr bit 0)', () => {
      writeCharWithSGR('\x1b[1m');
      expect(grid().getAttrs(0, 0) & 0x01).toBe(0x01);
    });

    it('SGR 3 sets italic (attr bit 1)', () => {
      writeCharWithSGR('\x1b[3m');
      expect(grid().getAttrs(0, 0) & 0x02).toBe(0x02);
    });

    it('SGR 4 sets underline (attr bit 2)', () => {
      writeCharWithSGR('\x1b[4m');
      expect(grid().getAttrs(0, 0) & 0x04).toBe(0x04);
    });

    it('SGR 9 sets strikethrough (attr bit 3)', () => {
      writeCharWithSGR('\x1b[9m');
      expect(grid().getAttrs(0, 0) & 0x08).toBe(0x08);
    });

    it('SGR 7 sets inverse (attr bit 6)', () => {
      writeCharWithSGR('\x1b[7m');
      expect(grid().getAttrs(0, 0) & 0x40).toBe(0x40);
    });

    it('SGR 22 resets bold', () => {
      write(parser, '\x1b[1m');  // set bold
      write(parser, '\x1b[22mA');
      expect(grid().getAttrs(0, 0) & 0x01).toBe(0);
    });

    it('SGR 23 resets italic', () => {
      write(parser, '\x1b[3m');
      write(parser, '\x1b[23mA');
      expect(grid().getAttrs(0, 0) & 0x02).toBe(0);
    });

    it('SGR 24 resets underline', () => {
      write(parser, '\x1b[4m');
      write(parser, '\x1b[24mA');
      expect(grid().getAttrs(0, 0) & 0x04).toBe(0);
    });

    it('SGR 27 resets inverse', () => {
      write(parser, '\x1b[7m');
      write(parser, '\x1b[27mA');
      expect(grid().getAttrs(0, 0) & 0x40).toBe(0);
    });

    it('SGR 29 resets strikethrough', () => {
      write(parser, '\x1b[9m');
      write(parser, '\x1b[29mA');
      expect(grid().getAttrs(0, 0) & 0x08).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Standard foreground colors (30-37)
  // ---------------------------------------------------------------------------

  describe('standard foreground colors', () => {
    it.each([
      [30, 0], [31, 1], [32, 2], [33, 3],
      [34, 4], [35, 5], [36, 6], [37, 7],
    ])('SGR %i sets fg index %i', (sgr, expected) => {
      writeCharWithSGR(`\x1b[${sgr}m`);
      expect(grid().getFgIndex(0, 0)).toBe(expected);
      expect(grid().isFgRGB(0, 0)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Standard background colors (40-47)
  // ---------------------------------------------------------------------------

  describe('standard background colors', () => {
    it.each([
      [40, 0], [41, 1], [42, 2], [43, 3],
      [44, 4], [45, 5], [46, 6], [47, 7],
    ])('SGR %i sets bg index %i', (sgr, expected) => {
      writeCharWithSGR(`\x1b[${sgr}m`);
      expect(grid().getBgIndex(0, 0)).toBe(expected);
      expect(grid().isBgRGB(0, 0)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Bright foreground colors (90-97)
  // ---------------------------------------------------------------------------

  describe('bright foreground colors', () => {
    it.each([
      [90, 8], [91, 9], [92, 10], [93, 11],
      [94, 12], [95, 13], [96, 14], [97, 15],
    ])('SGR %i sets fg index %i', (sgr, expected) => {
      writeCharWithSGR(`\x1b[${sgr}m`);
      expect(grid().getFgIndex(0, 0)).toBe(expected);
      expect(grid().isFgRGB(0, 0)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Bright background colors (100-107)
  // ---------------------------------------------------------------------------

  describe('bright background colors', () => {
    it.each([
      [100, 8], [101, 9], [102, 10], [103, 11],
      [104, 12], [105, 13], [106, 14], [107, 15],
    ])('SGR %i sets bg index %i', (sgr, expected) => {
      writeCharWithSGR(`\x1b[${sgr}m`);
      expect(grid().getBgIndex(0, 0)).toBe(expected);
      expect(grid().isBgRGB(0, 0)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Default color reset
  // ---------------------------------------------------------------------------

  describe('default color reset', () => {
    it('SGR 39 resets fg to default (index 7)', () => {
      write(parser, '\x1b[31m');  // set red
      write(parser, '\x1b[39mA');
      expect(grid().getFgIndex(0, 0)).toBe(7);
      expect(grid().isFgRGB(0, 0)).toBe(false);
    });

    it('SGR 49 resets bg to default (index 0)', () => {
      write(parser, '\x1b[42m');  // set green bg
      write(parser, '\x1b[49mA');
      expect(grid().getBgIndex(0, 0)).toBe(0);
      expect(grid().isBgRGB(0, 0)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 256 colors (38;5;n and 48;5;n)
  // ---------------------------------------------------------------------------

  describe('256 colors', () => {
    it('38;5;123 sets fg palette index 123', () => {
      writeCharWithSGR('\x1b[38;5;123m');
      expect(grid().getFgIndex(0, 0)).toBe(123);
      expect(grid().isFgRGB(0, 0)).toBe(false);
    });

    it('48;5;200 sets bg palette index 200', () => {
      writeCharWithSGR('\x1b[48;5;200m');
      expect(grid().getBgIndex(0, 0)).toBe(200);
      expect(grid().isBgRGB(0, 0)).toBe(false);
    });

    it('38;5;0 sets fg palette index 0', () => {
      writeCharWithSGR('\x1b[38;5;0m');
      expect(grid().getFgIndex(0, 0)).toBe(0);
    });

    it('38;5;255 sets fg palette index 255', () => {
      writeCharWithSGR('\x1b[38;5;255m');
      expect(grid().getFgIndex(0, 0)).toBe(255);
    });
  });

  // ---------------------------------------------------------------------------
  // 24-bit RGB colors (semicolon notation: 38;2;r;g;b)
  // ---------------------------------------------------------------------------

  describe('24-bit RGB colors (semicolon notation)', () => {
    it('38;2;255;0;0 sets fg to red RGB', () => {
      writeCharWithSGR('\x1b[38;2;255;0;0m');
      expect(grid().isFgRGB(0, 0)).toBe(true);
      // The packed RGB value: (255 << 16) | (0 << 8) | 0 = 0xFF0000
      // The fg index field stores the low byte of fgRGB
      // Full RGB is stored in rgbColors
      expect(grid().rgbColors[0]).toBe(0xFF0000);
    });

    it('48;2;0;255;0 sets bg to green RGB', () => {
      writeCharWithSGR('\x1b[48;2;0;255;0m');
      expect(grid().isBgRGB(0, 0)).toBe(true);
      expect(grid().rgbColors[256 + 0]).toBe(0x00FF00);
    });

    it('38;2;100;150;200 sets fg to custom RGB', () => {
      writeCharWithSGR('\x1b[38;2;100;150;200m');
      expect(grid().isFgRGB(0, 0)).toBe(true);
      expect(grid().rgbColors[0]).toBe((100 << 16) | (150 << 8) | 200);
    });
  });

  // ---------------------------------------------------------------------------
  // Combined attributes
  // ---------------------------------------------------------------------------

  describe('combined attributes', () => {
    it('1;3;4;31 sets bold + italic + underline + red fg', () => {
      writeCharWithSGR('\x1b[1;3;4;31m');
      const attrs = grid().getAttrs(0, 0);
      expect(attrs & 0x01).toBe(0x01); // bold
      expect(attrs & 0x02).toBe(0x02); // italic
      expect(attrs & 0x04).toBe(0x04); // underline
      expect(grid().getFgIndex(0, 0)).toBe(1); // red
    });

    it('SGR 0 after combined attributes resets everything', () => {
      write(parser, '\x1b[1;3;4;31m');
      write(parser, '\x1b[0mA');
      expect(grid().getAttrs(0, 0)).toBe(0);
      expect(grid().getFgIndex(0, 0)).toBe(7); // default
      expect(grid().getBgIndex(0, 0)).toBe(0); // default
    });

    it('multiple SGR in one sequence: 1;31;42', () => {
      writeCharWithSGR('\x1b[1;31;42m');
      expect(grid().getAttrs(0, 0) & 0x01).toBe(0x01); // bold
      expect(grid().getFgIndex(0, 0)).toBe(1); // red
      expect(grid().getBgIndex(0, 0)).toBe(2); // green
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('empty SGR (just \\x1b[m) acts as reset', () => {
      write(parser, '\x1b[1;31m'); // bold + red
      write(parser, '\x1b[mA');
      expect(grid().getAttrs(0, 0)).toBe(0);
      expect(grid().getFgIndex(0, 0)).toBe(7);
    });

    it('unknown SGR codes are ignored without breaking state', () => {
      write(parser, '\x1b[1m'); // bold
      write(parser, '\x1b[999mA'); // unknown, should be ignored
      // Bold should still be active from previous SGR
      expect(grid().getAttrs(0, 0) & 0x01).toBe(0x01);
    });

    it('SGR attributes persist across multiple characters', () => {
      write(parser, '\x1b[1;31mABC');
      for (let col = 0; col < 3; col++) {
        expect(grid().getAttrs(0, col) & 0x01).toBe(0x01); // bold
        expect(grid().getFgIndex(0, col)).toBe(1); // red
      }
    });

    it('SGR reset only affects subsequent characters', () => {
      write(parser, '\x1b[1mA\x1b[0mB');
      // 'A' at col 0 should be bold
      expect(grid().getAttrs(0, 0) & 0x01).toBe(0x01);
      // 'B' at col 1 should not be bold
      expect(grid().getAttrs(0, 1) & 0x01).toBe(0);
    });
  });
});
