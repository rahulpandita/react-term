import { beforeEach, describe, expect, it } from "vitest";
import { BufferSet } from "../buffer.js";
import { VTParser } from "../parser/index.js";
import { readLineTrimmed, write } from "./helpers.js";

function _readLine(bs: BufferSet, row: number, startCol = 0, endCol?: number): string {
  const grid = bs.active.grid;
  const end = endCol ?? grid.cols;
  let result = "";
  for (let c = startCol; c < end; c++) {
    const cp = grid.getCodepoint(row, c);
    if (cp === 0x20 && c >= end) break;
    result += String.fromCodePoint(cp);
  }
  return result;
}

describe("VTParser", () => {
  let bs: BufferSet;
  let parser: VTParser;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
    parser = new VTParser(bs);
  });

  describe("Print ASCII text", () => {
    it("prints simple text at cursor position", () => {
      write(parser, "Hello");
      expect(readLineTrimmed(bs, 0)).toBe("Hello");
      expect(parser.cursor.col).toBe(5);
      expect(parser.cursor.row).toBe(0);
    });

    it("handles CR+LF", () => {
      write(parser, "Line1\r\nLine2");
      expect(readLineTrimmed(bs, 0)).toBe("Line1");
      expect(readLineTrimmed(bs, 1)).toBe("Line2");
    });

    it("wraps at end of line", () => {
      const long = `${"A".repeat(80)}B`;
      write(parser, long);
      expect(readLineTrimmed(bs, 0)).toBe("A".repeat(80));
      expect(readLineTrimmed(bs, 1)).toBe("B");
    });
  });

  describe("SGR (Select Graphic Rendition)", () => {
    it("applies bold attribute", () => {
      write(parser, "\x1b[1mB");
      const grid = bs.active.grid;
      const attrs = grid.getAttrs(0, 0);
      expect(attrs & 0x01).toBe(0x01); // ATTR_BOLD
    });

    it("applies italic attribute", () => {
      write(parser, "\x1b[3mI");
      const grid = bs.active.grid;
      const attrs = grid.getAttrs(0, 0);
      expect(attrs & 0x02).toBe(0x02); // ATTR_ITALIC
    });

    it("sets 16 foreground colors", () => {
      write(parser, "\x1b[31mR"); // red
      const grid = bs.active.grid;
      expect(grid.getFgIndex(0, 0)).toBe(1); // red = index 1
    });

    it("sets 16 background colors", () => {
      write(parser, "\x1b[44mB"); // blue bg
      const grid = bs.active.grid;
      expect(grid.getBgIndex(0, 0)).toBe(4); // blue = index 4
    });

    it("sets bright foreground colors", () => {
      write(parser, "\x1b[91mR"); // bright red
      const grid = bs.active.grid;
      expect(grid.getFgIndex(0, 0)).toBe(9); // bright red = 8 + 1
    });

    it("sets 256-color foreground", () => {
      write(parser, "\x1b[38;5;196mR"); // 256-color red
      const grid = bs.active.grid;
      expect(grid.getFgIndex(0, 0)).toBe(196);
    });

    it("sets 256-color background", () => {
      write(parser, "\x1b[48;5;21mB"); // 256-color blue bg
      const grid = bs.active.grid;
      expect(grid.getBgIndex(0, 0)).toBe(21);
    });

    it("sets 24-bit RGB foreground", () => {
      write(parser, "\x1b[38;2;255;128;0mR"); // RGB orange
      const grid = bs.active.grid;
      expect(grid.isFgRGB(0, 0)).toBe(true);
    });

    it("sets 24-bit RGB background", () => {
      write(parser, "\x1b[48;2;0;128;255mB"); // RGB blue bg
      const grid = bs.active.grid;
      expect(grid.isBgRGB(0, 0)).toBe(true);
    });

    it("resets all attributes with SGR 0", () => {
      write(parser, "\x1b[1;31mA\x1b[0mB");
      const grid = bs.active.grid;
      // 'A' should be bold + red fg
      expect(grid.getAttrs(0, 0) & 0x01).toBe(0x01);
      expect(grid.getFgIndex(0, 0)).toBe(1);
      // 'B' should be reset
      expect(grid.getAttrs(0, 1)).toBe(0);
      expect(grid.getFgIndex(0, 1)).toBe(7); // default fg
    });
  });

  describe("Cursor movement", () => {
    it("CUP moves cursor to position", () => {
      write(parser, "\x1b[5;10H");
      expect(parser.cursor.row).toBe(4); // 1-based to 0-based
      expect(parser.cursor.col).toBe(9);
    });

    it("CUP defaults to 1;1", () => {
      write(parser, "ABC\x1b[H");
      expect(parser.cursor.row).toBe(0);
      expect(parser.cursor.col).toBe(0);
    });

    it("CUU moves cursor up", () => {
      write(parser, "\x1b[5;1H\x1b[2A");
      expect(parser.cursor.row).toBe(2);
    });

    it("CUD moves cursor down", () => {
      write(parser, "\x1b[1;1H\x1b[3B");
      expect(parser.cursor.row).toBe(3);
    });

    it("CUF moves cursor forward", () => {
      write(parser, "\x1b[1;1H\x1b[5C");
      expect(parser.cursor.col).toBe(5);
    });

    it("CUB moves cursor backward", () => {
      write(parser, "\x1b[1;10H\x1b[3D");
      expect(parser.cursor.col).toBe(6);
    });

    it("HVP works like CUP", () => {
      write(parser, "\x1b[3;7f");
      expect(parser.cursor.row).toBe(2);
      expect(parser.cursor.col).toBe(6);
    });
  });

  describe("Erase", () => {
    it("ED 0 erases from cursor to end of display", () => {
      write(parser, "AAAA\r\nBBBB\r\nCCCC");
      write(parser, "\x1b[2;2H\x1b[0J"); // cursor at row 1, col 1

      // Row 0 should be intact
      expect(readLineTrimmed(bs, 0)).toBe("AAAA");
      // Row 1: col 0 should remain, cols 1+ cleared
      const grid = bs.active.grid;
      expect(grid.getCodepoint(1, 0)).toBe(0x42); // 'B'
      expect(grid.getCodepoint(1, 1)).toBe(0x20); // cleared
      // Row 2 should be cleared
      expect(readLineTrimmed(bs, 2)).toBe("");
    });

    it("ED 1 erases from beginning to cursor", () => {
      write(parser, "AAAA\r\nBBBB\r\nCCCC");
      write(parser, "\x1b[2;2H\x1b[1J");

      // Row 0 should be cleared
      expect(readLineTrimmed(bs, 0)).toBe("");
      // Row 1: col 0-1 cleared, rest remains
      const grid = bs.active.grid;
      expect(grid.getCodepoint(1, 0)).toBe(0x20);
      expect(grid.getCodepoint(1, 1)).toBe(0x20);
      expect(grid.getCodepoint(1, 2)).toBe(0x42);
    });

    it("ED 2 erases entire display", () => {
      write(parser, "AAAA\r\nBBBB");
      write(parser, "\x1b[2J");
      expect(readLineTrimmed(bs, 0)).toBe("");
      expect(readLineTrimmed(bs, 1)).toBe("");
    });

    it("EL 0 erases from cursor to end of line", () => {
      write(parser, "ABCDEF");
      write(parser, "\x1b[1;3H\x1b[0K");
      expect(readLineTrimmed(bs, 0)).toBe("AB");
    });

    it("EL 1 erases from beginning of line to cursor", () => {
      write(parser, "ABCDEF");
      write(parser, "\x1b[1;3H\x1b[1K");
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x20);
      expect(grid.getCodepoint(0, 1)).toBe(0x20);
      expect(grid.getCodepoint(0, 2)).toBe(0x20); // cursor position also erased
      expect(grid.getCodepoint(0, 3)).toBe(0x44); // 'D' intact
    });

    it("EL 2 erases entire line", () => {
      write(parser, "ABCDEF");
      write(parser, "\x1b[1;3H\x1b[2K");
      expect(readLineTrimmed(bs, 0)).toBe("");
    });
  });

  describe("Scroll regions (DECSTBM)", () => {
    it("sets scroll region and scrolls within it", () => {
      // Fill rows
      for (let r = 0; r < 5; r++) {
        write(parser, `\x1b[${r + 1};1HRow${r}`);
      }
      // Set scroll region rows 2-4 (1-based)
      write(parser, "\x1b[2;4r");
      // Move to bottom of region and add a line to trigger scroll
      write(parser, "\x1b[4;1H");
      write(parser, "\n");

      // Row 0 should be unchanged (outside scroll region)
      expect(readLineTrimmed(bs, 0)).toBe("Row0");
      // Row 1 should now have what was row 2
      expect(readLineTrimmed(bs, 1)).toBe("Row2");
      // Row 2 should now have what was row 3
      expect(readLineTrimmed(bs, 2)).toBe("Row3");
      // Row 3 (bottom of region) should be cleared
      expect(readLineTrimmed(bs, 3)).toBe("");
      // Row 4 should be unchanged
      expect(readLineTrimmed(bs, 4)).toBe("Row4");
    });
  });

  describe("Alternate buffer", () => {
    it("DECSET 1049 switches to alternate buffer", () => {
      write(parser, "NormalText");
      write(parser, "\x1b[?1049h"); // switch to alternate
      expect(bs.isAlternate).toBe(true);
      // Alternate buffer should be clear
      expect(readLineTrimmed(bs, 0)).toBe("");
    });

    it("DECRST 1049 switches back to normal buffer", () => {
      write(parser, "NormalText");
      write(parser, "\x1b[?1049h"); // alternate
      write(parser, "AltText");
      write(parser, "\x1b[?1049l"); // back to normal
      expect(bs.isAlternate).toBe(false);
      expect(readLineTrimmed(bs, 0)).toBe("NormalText");
    });
  });

  describe("Tab stops", () => {
    it("tab advances to next tab stop", () => {
      write(parser, "A\tB");
      expect(parser.cursor.col).toBe(9); // tab to 8, then 'B' at 8, cursor at 9
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x41); // 'A'
      expect(grid.getCodepoint(0, 8)).toBe(0x42); // 'B'
    });

    it("clears individual tab stop with CSI 0 g", () => {
      write(parser, "\x1b[1;9H\x1b[0g"); // move to col 8, clear tab stop
      write(parser, "\x1b[1;1H"); // back to start
      write(parser, "\t");
      // Should skip col 8 and go to 16
      expect(parser.cursor.col).toBe(16);
    });

    it("clears all tab stops with CSI 3 g", () => {
      write(parser, "\x1b[3g"); // clear all
      write(parser, "\x1b[1;1H");
      write(parser, "\t");
      // Should go to end of line since no tab stops
      expect(parser.cursor.col).toBe(79);
    });
  });

  describe("UTF-8 decoding", () => {
    it("decodes 2-byte UTF-8 characters", () => {
      // 'e' with acute accent U+00E9 = 0xC3 0xA9
      parser.write(new Uint8Array([0xc3, 0xa9]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0xe9);
    });

    it("decodes 3-byte UTF-8 characters", () => {
      // Euro sign U+20AC = 0xE2 0x82 0xAC
      parser.write(new Uint8Array([0xe2, 0x82, 0xac]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x20ac);
    });

    it("decodes 4-byte UTF-8 characters", () => {
      // Emoji U+1F600 = 0xF0 0x9F 0x98 0x80
      parser.write(new Uint8Array([0xf0, 0x9f, 0x98, 0x80]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x1f600);
    });

    it("handles mixed ASCII and UTF-8", () => {
      // "Hi" + euro sign + "!"
      parser.write(new Uint8Array([0x48, 0x69, 0xe2, 0x82, 0xac, 0x21]));
      const grid = bs.active.grid;
      expect(grid.getCodepoint(0, 0)).toBe(0x48); // H
      expect(grid.getCodepoint(0, 1)).toBe(0x69); // i
      expect(grid.getCodepoint(0, 2)).toBe(0x20ac); // euro
      expect(grid.getCodepoint(0, 3)).toBe(0x21); // !
    });
  });

  describe("Cursor visibility", () => {
    it("DECTCEM hides and shows cursor", () => {
      expect(parser.cursor.visible).toBe(true);
      write(parser, "\x1b[?25l"); // hide
      expect(parser.cursor.visible).toBe(false);
      write(parser, "\x1b[?25h"); // show
      expect(parser.cursor.visible).toBe(true);
    });
  });

  describe("Save/restore cursor", () => {
    it("CSI s / CSI u saves and restores cursor", () => {
      write(parser, "\x1b[5;10H");
      write(parser, "\x1b[s"); // save
      write(parser, "\x1b[1;1H"); // move
      write(parser, "\x1b[u"); // restore
      expect(parser.cursor.row).toBe(4);
      expect(parser.cursor.col).toBe(9);
    });

    it("ESC 7 / ESC 8 saves and restores cursor", () => {
      write(parser, "\x1b[3;5H");
      write(parser, "\x1b7"); // DECSC
      write(parser, "\x1b[1;1H");
      write(parser, "\x1b8"); // DECRC
      expect(parser.cursor.row).toBe(2);
      expect(parser.cursor.col).toBe(4);
    });
  });

  describe("Scrollback", () => {
    it("pushes lines into scrollback when scrolling", () => {
      // Fill entire screen
      for (let r = 0; r < 24; r++) {
        write(parser, `R${r}\r\n`);
      }
      // Scrollback should have some entries
      expect(bs.scrollback.length).toBeGreaterThan(0);
    });
  });

  describe("OSC 52 clipboard", () => {
    it("calls osc52 callback on clipboard write (BEL terminator)", () => {
      let calledSelection = "";
      let calledData: string | null = undefined as unknown as string | null;
      parser.setOsc52Callback((selection, data) => {
        calledSelection = selection;
        calledData = data;
      });
      // Base64 of "hello" is "aGVsbG8="
      write(parser, "\x1b]52;c;aGVsbG8=\x07");
      expect(calledSelection).toBe("c");
      expect(calledData).toBe("aGVsbG8=");
    });

    it("calls osc52 callback on clipboard write (ST terminator)", () => {
      let calledData: string | null = null;
      parser.setOsc52Callback((_sel, data) => {
        calledData = data;
      });
      write(parser, "\x1b]52;c;aGVsbG8=\x1b\\");
      expect(calledData).toBe("aGVsbG8=");
    });

    it("calls osc52 callback with null data for query (?) request", () => {
      let calledSelection = "";
      let calledData: string | null = "not-null";
      parser.setOsc52Callback((selection, data) => {
        calledSelection = selection;
        calledData = data;
      });
      write(parser, "\x1b]52;c;?\x07");
      expect(calledSelection).toBe("c");
      expect(calledData).toBeNull();
    });

    it("passes through selection string (multiple chars)", () => {
      let calledSelection = "";
      parser.setOsc52Callback((selection) => {
        calledSelection = selection;
      });
      write(parser, "\x1b]52;ps;dGVzdA==\x07");
      expect(calledSelection).toBe("ps");
    });

    it("does not call osc52 callback when none registered", () => {
      // Should not throw when no callback registered
      expect(() => {
        write(parser, "\x1b]52;c;aGVsbG8=\x07");
      }).not.toThrow();
    });

    it("does not interfere with title after osc52 sequence", () => {
      let title = "";
      parser.setTitleChangeCallback((t) => {
        title = t;
      });
      write(parser, "\x1b]52;c;aGVsbG8=\x07");
      write(parser, "\x1b]0;MyTitle\x07");
      expect(title).toBe("MyTitle");
    });
  });

  describe("OSC 4 color palette", () => {
    it("calls osc4 callback for a single palette entry (BEL terminator)", () => {
      const calls: Array<{ index: number; spec: string }> = [];
      parser.setOsc4Callback((index, spec) => {
        calls.push({ index, spec });
      });
      // Set color index 1 to red
      write(parser, "\x1b]4;1;rgb:ff/00/00\x07");
      expect(calls).toHaveLength(1);
      expect(calls[0].index).toBe(1);
      expect(calls[0].spec).toBe("rgb:ff/00/00");
    });

    it("calls osc4 callback with ST terminator", () => {
      let idx = -1;
      let sp = "";
      parser.setOsc4Callback((index, spec) => {
        idx = index;
        sp = spec;
      });
      write(parser, "\x1b]4;2;#00ff00\x1b\\");
      expect(idx).toBe(2);
      expect(sp).toBe("#00ff00");
    });

    it("calls osc4 callback with null spec for query (?)", () => {
      let idx = -1;
      let sp: string | null = "not-null";
      parser.setOsc4Callback((index, spec) => {
        idx = index;
        sp = spec;
      });
      write(parser, "\x1b]4;5;?\x07");
      expect(idx).toBe(5);
      expect(sp).toBeNull();
    });

    it("handles multiple index;spec pairs in one OSC 4 sequence", () => {
      const calls: Array<{ index: number; spec: string | null }> = [];
      parser.setOsc4Callback((index, spec) => {
        calls.push({ index, spec });
      });
      // Two pairs: index 3 → blue, index 7 → query
      write(parser, "\x1b]4;3;rgb:00/00/ff;7;?\x07");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({ index: 3, spec: "rgb:00/00/ff" });
      expect(calls[1]).toEqual({ index: 7, spec: null });
    });

    it("does not call osc4 callback when none registered", () => {
      expect(() => {
        write(parser, "\x1b]4;1;rgb:ff/00/00\x07");
      }).not.toThrow();
    });

    it("handles color index 0 and 255 (boundary values)", () => {
      const calls: Array<{ index: number; spec: string | null }> = [];
      parser.setOsc4Callback((index, spec) => {
        calls.push({ index, spec });
      });
      write(parser, "\x1b]4;0;rgb:00/00/00\x07");
      write(parser, "\x1b]4;255;rgb:ff/ff/ff\x07");
      expect(calls[0].index).toBe(0);
      expect(calls[1].index).toBe(255);
    });
  });

  describe("OSC 7 current working directory", () => {
    it("calls osc7 callback with URI (BEL terminator)", () => {
      let cwd = "";
      parser.setOsc7Callback((uri) => {
        cwd = uri;
      });
      write(parser, "\x1b]7;file:///hostname/home/user/project\x07");
      expect(cwd).toBe("file:///hostname/home/user/project");
    });

    it("calls osc7 callback with ST terminator", () => {
      let cwd = "";
      parser.setOsc7Callback((uri) => {
        cwd = uri;
      });
      write(parser, "\x1b]7;file:///localhost/tmp\x1b\\");
      expect(cwd).toBe("file:///localhost/tmp");
    });

    it("calls osc7 callback with empty URI", () => {
      let called = false;
      parser.setOsc7Callback((uri) => {
        called = true;
        expect(uri).toBe("");
      });
      write(parser, "\x1b]7;\x07");
      expect(called).toBe(true);
    });

    it("does not call osc7 callback when none registered", () => {
      expect(() => {
        write(parser, "\x1b]7;file:///some/path\x07");
      }).not.toThrow();
    });

    it("does not interfere with title callback (OSC 2)", () => {
      let title = "";
      let cwd = "";
      parser.setTitleChangeCallback((t) => {
        title = t;
      });
      parser.setOsc7Callback((uri) => {
        cwd = uri;
      });
      write(parser, "\x1b]2;MyTitle\x07");
      write(parser, "\x1b]7;file:///home/user\x07");
      expect(title).toBe("MyTitle");
      expect(cwd).toBe("file:///home/user");
    });
  });
});
