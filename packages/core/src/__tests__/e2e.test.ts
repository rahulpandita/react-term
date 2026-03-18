import { beforeEach, describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";
import { enc, readLineTrimmed, write } from "./helpers.js";

describe("E2E Full Pipeline Tests", () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
    parser = new VTParser(bs);
  });

  // ============================================================
  // 1. Shell prompt rendering
  // ============================================================
  describe("Shell prompt rendering", () => {
    it("renders a typical bash prompt with correct colors", () => {
      // \x1b[01;32muser@host\x1b[00m:\x1b[01;34m~/code\x1b[00m$
      write(parser, "\x1b[01;32muser@host\x1b[00m:\x1b[01;34m~/code\x1b[00m$ ");

      const grid = bs.active.grid;

      // "user@host" should be bold green (fg=2)
      for (let c = 0; c < 9; c++) {
        expect(grid.getFgIndex(0, c)).toBe(2); // green
        expect(grid.getAttrs(0, c) & 0x01).toBe(0x01); // bold
      }

      // ":" should be default (fg=7, no bold)
      expect(grid.getCodepoint(0, 9)).toBe(":".charCodeAt(0));
      expect(grid.getFgIndex(0, 9)).toBe(7);
      expect(grid.getAttrs(0, 9)).toBe(0);

      // "~/code" should be bold blue (fg=4)
      const tildeStart = 10;
      for (let c = tildeStart; c < tildeStart + 6; c++) {
        expect(grid.getFgIndex(0, c)).toBe(4); // blue
        expect(grid.getAttrs(0, c) & 0x01).toBe(0x01); // bold
      }

      // "$ " should be default
      const dollarPos = 16;
      expect(grid.getCodepoint(0, dollarPos)).toBe("$".charCodeAt(0));
      expect(grid.getFgIndex(0, dollarPos)).toBe(7);
      expect(grid.getAttrs(0, dollarPos)).toBe(0);
    });
  });

  // ============================================================
  // 2. ls --color output
  // ============================================================
  describe("ls --color output", () => {
    it("renders colored directory listing with correct colors across lines", () => {
      // Simulate: directories in blue, executables in green, regular files in default
      write(parser, "\x1b[01;34mdocuments\x1b[0m  ");
      write(parser, "\x1b[01;32mscript.sh\x1b[0m  ");
      write(parser, "readme.txt\r\n");
      write(parser, "\x1b[01;34mdownloads\x1b[0m  ");
      write(parser, "\x1b[01;31marchive.tar.gz\x1b[0m");

      const grid = bs.active.grid;

      // "documents" should be bold blue
      expect(grid.getFgIndex(0, 0)).toBe(4); // blue
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01); // bold

      // "script.sh" should be bold green (starts at col 11)
      expect(grid.getFgIndex(0, 11)).toBe(2); // green
      expect(grid.getAttrs(0, 11) & 0x01).toBe(0x01); // bold

      // "readme.txt" should be default (starts at col 22)
      expect(grid.getFgIndex(0, 22)).toBe(7); // default
      expect(grid.getAttrs(0, 22)).toBe(0);

      // Second line: "downloads" in blue
      expect(grid.getFgIndex(1, 0)).toBe(4); // blue
      // "archive.tar.gz" in red
      expect(grid.getFgIndex(1, 11)).toBe(1); // red
    });
  });

  // ============================================================
  // 3. vim startup (alternate buffer)
  // ============================================================
  describe("vim startup simulation", () => {
    it("enters alternate buffer, draws content, exits and restores", () => {
      // Write some content in normal buffer
      write(parser, "Normal buffer line 1\r\n");
      write(parser, "Normal buffer line 2");

      // Enter alternate buffer (like vim does)
      write(parser, "\x1b[?1049h"); // save cursor + switch to alt
      expect(bs.isAlternate).toBe(true);

      // Clear alternate screen
      write(parser, "\x1b[2J");
      // Position cursor
      write(parser, "\x1b[1;1H");

      // Draw some vim-like content
      write(parser, "File content line 1");
      write(parser, "\x1b[2;1H");
      write(parser, "File content line 2");

      // Draw status line at bottom (row 24)
      write(parser, "\x1b[24;1H");
      write(parser, '\x1b[7m "test.txt" 2L, 38B\x1b[0m');

      // Verify alternate buffer content
      expect(readLineTrimmed(bs, 0)).toBe("File content line 1");
      expect(readLineTrimmed(bs, 1)).toBe("File content line 2");

      // Status line should have inverse attribute
      const grid = bs.active.grid;
      expect(grid.getAttrs(23, 1) & 0x40).toBe(0x40); // ATTR_INVERSE

      // Exit vim: switch back to normal buffer
      write(parser, "\x1b[?1049l");
      expect(bs.isAlternate).toBe(false);

      // Normal buffer should be restored
      expect(readLineTrimmed(bs, 0)).toBe("Normal buffer line 1");
      expect(readLineTrimmed(bs, 1)).toBe("Normal buffer line 2");
    });
  });

  // ============================================================
  // 4. tmux-style split with scroll regions
  // ============================================================
  describe("tmux-style split with scroll regions", () => {
    it("sets scroll regions and writes content in each", () => {
      // Top pane: rows 1-12
      write(parser, "\x1b[1;12r"); // set scroll region
      write(parser, "\x1b[1;1H"); // home of top pane
      write(parser, "Top pane line 1");
      write(parser, "\x1b[2;1H");
      write(parser, "Top pane line 2");

      // Separator at row 13
      write(parser, "\x1b[r"); // reset scroll region
      write(parser, "\x1b[13;1H");
      write(parser, `\x1b[7m${"-".repeat(80)}\x1b[0m`);

      // Bottom pane: rows 14-24
      write(parser, "\x1b[14;24r");
      write(parser, "\x1b[14;1H");
      write(parser, "Bottom pane line 1");
      write(parser, "\x1b[15;1H");
      write(parser, "Bottom pane line 2");

      // Verify content
      expect(readLineTrimmed(bs, 0)).toBe("Top pane line 1");
      expect(readLineTrimmed(bs, 1)).toBe("Top pane line 2");
      expect(readLineTrimmed(bs, 12)).toBe("-".repeat(80));
      expect(readLineTrimmed(bs, 13)).toBe("Bottom pane line 1");
      expect(readLineTrimmed(bs, 14)).toBe("Bottom pane line 2");

      // Separator should have inverse attribute
      const grid = bs.active.grid;
      expect(grid.getAttrs(12, 0) & 0x40).toBe(0x40);
    });
  });

  // ============================================================
  // 5. Progress bar
  // ============================================================
  describe("Progress bar", () => {
    it("renders progress bar using CR to overwrite the line", () => {
      // Simulate a progress bar that updates using \r
      for (let pct = 0; pct <= 100; pct += 10) {
        const filled = Math.round(pct / 5);
        const empty = 20 - filled;
        const bar = `[${"#".repeat(filled)}${" ".repeat(empty)}] ${pct}%`;
        write(parser, `\r${bar}`);
      }

      // Final state should show 100%
      const line = readLineTrimmed(bs, 0);
      expect(line).toBe("[####################] 100%");
      expect(parser.cursor.row).toBe(0);
    });
  });

  // ============================================================
  // 6. 256-color theme
  // ============================================================
  describe("256-color theme", () => {
    it("writes text using all 256 colors and verifies color indices", () => {
      // We can only fit 80 chars per line on an 80-col terminal
      // Write a character for each of the first 80 colors
      for (let i = 0; i < 80; i++) {
        write(parser, `\x1b[38;5;${i}m${String.fromCharCode(0x41 + (i % 26))}`);
      }

      const grid = bs.active.grid;
      for (let i = 0; i < 80; i++) {
        expect(grid.getFgIndex(0, i)).toBe(i);
      }
    });

    it("verifies 24-bit RGB colors", () => {
      write(parser, "\x1b[38;2;255;0;0mR"); // pure red
      write(parser, "\x1b[38;2;0;255;0mG"); // pure green
      write(parser, "\x1b[38;2;0;0;255mB"); // pure blue

      const grid = bs.active.grid;
      expect(grid.isFgRGB(0, 0)).toBe(true);
      expect(grid.isFgRGB(0, 1)).toBe(true);
      expect(grid.isFgRGB(0, 2)).toBe(true);
    });
  });

  // ============================================================
  // 7. Stress test
  // ============================================================
  describe("Stress test", () => {
    it("writes 100KB of mixed text and escape sequences without crashing", () => {
      // Generate 100KB of mixed content
      let data = "";
      const colors = [31, 32, 33, 34, 35, 36, 37];
      for (let i = 0; data.length < 100000; i++) {
        const color = colors[i % colors.length];
        data += `\x1b[${color}m`;
        data += String.fromCharCode(0x41 + (i % 26));
        if (i % 80 === 79) {
          data += "\r\n";
        }
      }
      write(parser, data);

      // Parser should be in consistent state
      expect(parser.cursor.row).toBeLessThanOrEqual(23);
      expect(parser.cursor.col).toBeLessThan(80);
      // No crash occurred - test passes
    });

    it("handles rapid alternation between text and escape sequences", () => {
      let data = "";
      for (let i = 0; i < 1000; i++) {
        data += `\x1b[${1 + (i % 9)}m`; // various SGR attributes
        data += "X";
        data += "\x1b[0m"; // reset
      }
      write(parser, data);
      // Should complete without crash
      expect(parser.cursor.row).toBeLessThanOrEqual(23);
    });
  });

  // ============================================================
  // 8. Split writes
  // ============================================================
  describe("Split writes", () => {
    it("produces identical result for single write vs byte-by-byte writes", () => {
      // A complex sequence
      const sequence = "\x1b[1;31mHello\x1b[0m \x1b[42mWorld\x1b[0m\r\n\x1b[5;10HPos";

      // Single write
      const bs1 = new BufferSet(80, 24);
      const parser1 = new VTParser(bs1);
      write(parser1, sequence);

      // Byte-by-byte write
      const bs2 = new BufferSet(80, 24);
      const parser2 = new VTParser(bs2);
      const bytes = enc.encode(sequence);
      for (let i = 0; i < bytes.length; i++) {
        parser2.write(new Uint8Array([bytes[i]]));
      }

      // Compare grid contents
      const grid1 = bs1.active.grid;
      const grid2 = bs2.active.grid;
      for (let r = 0; r < 24; r++) {
        for (let c = 0; c < 80; c++) {
          expect(grid2.getCodepoint(r, c)).toBe(grid1.getCodepoint(r, c));
          expect(grid2.getFgIndex(r, c)).toBe(grid1.getFgIndex(r, c));
          expect(grid2.getBgIndex(r, c)).toBe(grid1.getBgIndex(r, c));
          expect(grid2.getAttrs(r, c)).toBe(grid1.getAttrs(r, c));
        }
      }

      // Compare cursor positions
      expect(parser2.cursor.row).toBe(parser1.cursor.row);
      expect(parser2.cursor.col).toBe(parser1.cursor.col);
    });

    it("splits a multi-byte escape sequence at every possible boundary", () => {
      // ESC [ 1 ; 3 1 m = 7 bytes
      const sequence = "\x1b[1;31mA";
      const bytes = enc.encode(sequence);

      // Reference: single write
      const bsRef = new BufferSet(80, 24);
      const parserRef = new VTParser(bsRef);
      parserRef.write(bytes);

      // For each possible split point
      for (let split = 1; split < bytes.length; split++) {
        const bsTest = new BufferSet(80, 24);
        const parserTest = new VTParser(bsTest);
        parserTest.write(bytes.slice(0, split));
        parserTest.write(bytes.slice(split));

        const gridRef = bsRef.active.grid;
        const gridTest = bsTest.active.grid;

        // Compare the first cell (where 'A' should be)
        expect(gridTest.getCodepoint(0, 0)).toBe(gridRef.getCodepoint(0, 0));
        expect(gridTest.getFgIndex(0, 0)).toBe(gridRef.getFgIndex(0, 0));
        expect(gridTest.getAttrs(0, 0)).toBe(gridRef.getAttrs(0, 0));
        expect(parserTest.cursor.col).toBe(parserRef.cursor.col);
      }
    });

    it("splits a UTF-8 sequence followed by escape sequence at every boundary", () => {
      // Euro sign (3 bytes) + ESC[31m (5 bytes) + 'A' (1 byte) = 9 bytes
      const bytes = new Uint8Array([0xe2, 0x82, 0xac, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x41]);

      // Reference
      const bsRef = new BufferSet(80, 24);
      const parserRef = new VTParser(bsRef);
      parserRef.write(bytes);

      for (let split = 1; split < bytes.length; split++) {
        const bsTest = new BufferSet(80, 24);
        const parserTest = new VTParser(bsTest);
        parserTest.write(bytes.slice(0, split));
        parserTest.write(bytes.slice(split));

        const gridRef = bsRef.active.grid;
        const gridTest = bsTest.active.grid;

        // Euro sign at (0,0)
        expect(gridTest.getCodepoint(0, 0)).toBe(gridRef.getCodepoint(0, 0));
        // 'A' at (0,1) with red foreground
        expect(gridTest.getCodepoint(0, 1)).toBe(gridRef.getCodepoint(0, 1));
        expect(gridTest.getFgIndex(0, 1)).toBe(gridRef.getFgIndex(0, 1));
      }
    });
  });

  // ============================================================
  // Additional realistic scenarios
  // ============================================================
  describe("Realistic scenarios", () => {
    it("handles clear screen + redraw (common terminal operation)", () => {
      // Fill screen with content
      for (let r = 0; r < 5; r++) {
        write(parser, `Line ${r}\r\n`);
      }

      // Clear screen and redraw (like pressing Ctrl-L)
      write(parser, "\x1b[2J\x1b[H");
      write(parser, "After clear");

      expect(readLineTrimmed(bs, 0)).toBe("After clear");
      expect(readLineTrimmed(bs, 1)).toBe("");
      expect(parser.cursor.row).toBe(0);
    });

    it("handles scroll region within alternate buffer", () => {
      write(parser, "\x1b[?1049h"); // alternate buffer
      write(parser, "\x1b[2J\x1b[H"); // clear

      // Set up scroll region for main area (leaving status bar at bottom)
      write(parser, "\x1b[1;23r");

      // Fill scroll region
      for (let r = 0; r < 23; r++) {
        write(parser, `\x1b[${r + 1};1HLine ${r}`);
      }

      // Write status bar outside scroll region
      write(parser, "\x1b[r"); // reset scroll region first
      write(parser, "\x1b[24;1H\x1b[7mStatus: OK\x1b[0m");

      // Go back to scroll region and trigger scroll
      write(parser, "\x1b[1;23r");
      write(parser, "\x1b[23;1H\nNew line");

      // Status bar should still be intact
      const grid = bs.active.grid;
      expect(grid.getCodepoint(23, 0)).toBe("S".charCodeAt(0));
      expect(grid.getAttrs(23, 0) & 0x40).toBe(0x40); // inverse

      // Exit alternate buffer
      write(parser, "\x1b[?1049l");
      expect(bs.isAlternate).toBe(false);
    });

    it("handles cursor save/restore across complex operations", () => {
      write(parser, "\x1b[10;20H"); // position cursor
      write(parser, "\x1b7"); // save cursor (DECSC)

      // Do a bunch of operations
      write(parser, "\x1b[1;1H"); // move
      write(parser, "Some text");
      write(parser, "\x1b[2J"); // clear screen
      write(parser, "\x1b[5;5H");

      // Restore cursor
      write(parser, "\x1b8");
      expect(parser.cursor.row).toBe(9);
      expect(parser.cursor.col).toBe(19);
    });

    it("handles DSR response during complex output", () => {
      write(parser, "\x1b[5;1H"); // position at row 5, col 1
      write(parser, "Text");
      write(parser, "\x1b[6n"); // DSR

      expect(parser.hasResponse()).toBe(true);
      const response = parser.readResponse();
      expect(response).toBeDefined();
      const decoded = new TextDecoder().decode(response as Uint8Array);
      // Cursor should be at row 5, col 5 (after writing "Text" starting at col 1)
      expect(decoded).toBe("\x1b[5;5R");

      // Can continue writing after DSR
      write(parser, " more text");
      expect(readLineTrimmed(bs, 4)).toBe("Text more text");
    });

    it("handles multiple DSR responses queued up", () => {
      write(parser, "\x1b[1;1H\x1b[6n");
      write(parser, "\x1b[5;5H\x1b[6n");
      write(parser, "\x1b[10;10H\x1b[6n");

      expect(parser.hasResponse()).toBe(true);
      const r1 = parser.readResponse();
      const r2 = parser.readResponse();
      const r3 = parser.readResponse();
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(r3).toBeDefined();
      expect(new TextDecoder().decode(r1 as Uint8Array)).toBe("\x1b[1;1R");
      expect(new TextDecoder().decode(r2 as Uint8Array)).toBe("\x1b[5;5R");
      expect(new TextDecoder().decode(r3 as Uint8Array)).toBe("\x1b[10;10R");
      expect(parser.hasResponse()).toBe(false);
    });
  });
});
