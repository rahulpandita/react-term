import { beforeEach, describe, expect, it } from "vitest";
import { Buffer, BufferSet } from "../buffer.js";

// ---------------------------------------------------------------------------
// Buffer — tab stops
// ---------------------------------------------------------------------------
describe("Buffer tab stops", () => {
  let buf: Buffer;

  beforeEach(() => {
    buf = new Buffer(80, 24);
  });

  it("initialises default tab stops every 8 columns", () => {
    // Default tab stop interval is 8; first stop is at column 8
    expect(buf.nextTabStop(0)).toBe(8);
    expect(buf.nextTabStop(7)).toBe(8);
    expect(buf.nextTabStop(8)).toBe(16);
    expect(buf.nextTabStop(15)).toBe(16);
  });

  it("nextTabStop clamps to cols-1 when past last stop", () => {
    // Last default stop at 72 (< 80). From 72 there is no next stop.
    expect(buf.nextTabStop(72)).toBe(79);
    expect(buf.nextTabStop(75)).toBe(79);
    expect(buf.nextTabStop(79)).toBe(79);
  });

  it("prevTabStop returns the stop strictly before the given column", () => {
    expect(buf.prevTabStop(16)).toBe(8);
    expect(buf.prevTabStop(9)).toBe(8);
    expect(buf.prevTabStop(8)).toBe(0);
  });

  it("prevTabStop clamps to 0 when before first stop", () => {
    expect(buf.prevTabStop(0)).toBe(0);
    expect(buf.prevTabStop(1)).toBe(0);
    expect(buf.prevTabStop(7)).toBe(0);
  });

  it("custom tab stops are respected by nextTabStop/prevTabStop", () => {
    buf.tabStops = new Set([5, 10, 20]);
    expect(buf.nextTabStop(0)).toBe(5);
    expect(buf.nextTabStop(5)).toBe(10);
    expect(buf.prevTabStop(20)).toBe(10);
    expect(buf.prevTabStop(10)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Buffer — cursor save / restore
// ---------------------------------------------------------------------------
describe("Buffer cursor save / restore", () => {
  let buf: Buffer;

  beforeEach(() => {
    buf = new Buffer(80, 24);
  });

  it("restoreCursor with no prior save is a no-op", () => {
    buf.cursor.row = 5;
    buf.cursor.col = 10;
    buf.restoreCursor();
    expect(buf.cursor.row).toBe(5);
    expect(buf.cursor.col).toBe(10);
  });

  it("saveCursor / restoreCursor round-trips all cursor fields", () => {
    buf.cursor = { row: 3, col: 7, visible: false, style: "underline", wrapPending: true };
    buf.saveCursor();

    // Mutate cursor
    buf.cursor = { row: 0, col: 0, visible: true, style: "block", wrapPending: false };

    buf.restoreCursor();
    expect(buf.cursor.row).toBe(3);
    expect(buf.cursor.col).toBe(7);
    expect(buf.cursor.visible).toBe(false);
    expect(buf.cursor.style).toBe("underline");
    expect(buf.cursor.wrapPending).toBe(true);
  });

  it("saved cursor is independent of cursor object (deep copy)", () => {
    buf.cursor.row = 2;
    buf.saveCursor();

    // Changing cursor after save should not affect saved state
    buf.cursor.row = 9;
    buf.restoreCursor();
    expect(buf.cursor.row).toBe(2);
  });

  it("multiple saves — last save wins", () => {
    buf.cursor.row = 1;
    buf.saveCursor();
    buf.cursor.row = 2;
    buf.saveCursor();
    buf.cursor.row = 3;
    buf.restoreCursor();
    expect(buf.cursor.row).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Buffer — scrollUp / scrollDown
// ---------------------------------------------------------------------------
describe("Buffer scrollUp", () => {
  it("shifts rows up, clearing the bottom row", () => {
    const buf = new Buffer(10, 5);
    // Write a distinguishable value into each row's first cell
    for (let r = 0; r < 5; r++) {
      buf.grid.setCell(r, 0, 0x41 + r, 7, 0, 0); // 'A', 'B', 'C', 'D', 'E'
    }
    buf.scrollUp();
    // Row 0 should now contain what was row 1 ('B')
    expect(buf.grid.getCodepoint(0, 0)).toBe(0x42);
    // Row 1 should contain what was row 2 ('C')
    expect(buf.grid.getCodepoint(1, 0)).toBe(0x43);
    // Last row should be cleared (space 0x20)
    expect(buf.grid.getCodepoint(4, 0)).toBe(0x20);
  });

  it("respects scrollTop / scrollBottom region", () => {
    const buf = new Buffer(10, 5);
    buf.scrollTop = 1;
    buf.scrollBottom = 3;
    for (let r = 0; r < 5; r++) {
      buf.grid.setCell(r, 0, 0x41 + r, 7, 0, 0);
    }
    buf.scrollUp();
    // Row 0 is outside region — must be unchanged ('A')
    expect(buf.grid.getCodepoint(0, 0)).toBe(0x41);
    // Row 1 should contain what was row 2 ('C')
    expect(buf.grid.getCodepoint(1, 0)).toBe(0x43);
    // Row 2 should contain what was row 3 ('D')
    expect(buf.grid.getCodepoint(2, 0)).toBe(0x44);
    // Row 3 (scrollBottom) is cleared
    expect(buf.grid.getCodepoint(3, 0)).toBe(0x20);
    // Row 4 is outside region — must be unchanged ('E')
    expect(buf.grid.getCodepoint(4, 0)).toBe(0x45);
  });
});

describe("Buffer scrollDown", () => {
  it("shifts rows down, clearing the top row", () => {
    const buf = new Buffer(10, 5);
    for (let r = 0; r < 5; r++) {
      buf.grid.setCell(r, 0, 0x41 + r, 7, 0, 0);
    }
    buf.scrollDown();
    // Row 1 should contain what was row 0 ('A')
    expect(buf.grid.getCodepoint(1, 0)).toBe(0x41);
    // Row 2 should contain what was row 1 ('B')
    expect(buf.grid.getCodepoint(2, 0)).toBe(0x42);
    // Top row is cleared
    expect(buf.grid.getCodepoint(0, 0)).toBe(0x20);
  });

  it("respects scrollTop / scrollBottom region", () => {
    const buf = new Buffer(10, 5);
    buf.scrollTop = 1;
    buf.scrollBottom = 3;
    for (let r = 0; r < 5; r++) {
      buf.grid.setCell(r, 0, 0x41 + r, 7, 0, 0);
    }
    buf.scrollDown();
    // Row 0 outside region — unchanged ('A')
    expect(buf.grid.getCodepoint(0, 0)).toBe(0x41);
    // scrollTop (row 1) is cleared
    expect(buf.grid.getCodepoint(1, 0)).toBe(0x20);
    // Row 2 should contain what was row 1 ('B')
    expect(buf.grid.getCodepoint(2, 0)).toBe(0x42);
    // Row 3 should contain what was row 2 ('C')
    expect(buf.grid.getCodepoint(3, 0)).toBe(0x43);
    // Row 4 outside region — unchanged ('E')
    expect(buf.grid.getCodepoint(4, 0)).toBe(0x45);
  });
});

// ---------------------------------------------------------------------------
// BufferSet — alternate screen
// ---------------------------------------------------------------------------
describe("BufferSet alternate screen", () => {
  let bs: BufferSet;

  beforeEach(() => {
    bs = new BufferSet(80, 24);
  });

  it("starts on normal buffer", () => {
    expect(bs.isAlternate).toBe(false);
    expect(bs.active).toBe(bs.normal);
  });

  it("activateAlternate switches active to alternate and clears it", () => {
    // Write something to normal buffer
    bs.normal.grid.setCell(0, 0, 0x41, 7, 0, 0);

    bs.activateAlternate();
    expect(bs.isAlternate).toBe(true);
    expect(bs.active).toBe(bs.alternate);

    // Alternate buffer should be clean (space)
    expect(bs.alternate.grid.getCodepoint(0, 0)).toBe(0x20);
    // Normal buffer is untouched
    expect(bs.normal.grid.getCodepoint(0, 0)).toBe(0x41);
  });

  it("activateAlternate resets alternate cursor to origin", () => {
    bs.alternate.cursor.row = 5;
    bs.alternate.cursor.col = 10;
    bs.activateAlternate();
    expect(bs.alternate.cursor.row).toBe(0);
    expect(bs.alternate.cursor.col).toBe(0);
    expect(bs.alternate.cursor.visible).toBe(true);
    expect(bs.alternate.cursor.wrapPending).toBe(false);
  });

  it("activateAlternate is idempotent (already on alternate)", () => {
    bs.activateAlternate();
    bs.alternate.grid.setCell(1, 1, 0x42, 7, 0, 0);
    bs.activateAlternate(); // second call — should NOT clear again
    // Cell written after first switch should still be there
    expect(bs.alternate.grid.getCodepoint(1, 1)).toBe(0x42);
  });

  it("activateNormal switches back from alternate", () => {
    bs.activateAlternate();
    bs.activateNormal();
    expect(bs.isAlternate).toBe(false);
    expect(bs.active).toBe(bs.normal);
  });

  it("activateNormal is idempotent (already on normal)", () => {
    bs.activateNormal(); // no-op
    expect(bs.active).toBe(bs.normal);
  });

  it("alternate scroll region resets to full screen", () => {
    bs.activateAlternate();
    expect(bs.alternate.scrollTop).toBe(0);
    expect(bs.alternate.scrollBottom).toBe(23);
  });
});

// ---------------------------------------------------------------------------
// BufferSet — scrollback
// ---------------------------------------------------------------------------
describe("BufferSet scrollback", () => {
  it("pushScrollback adds a line", () => {
    const bs = new BufferSet(80, 24);
    const line = new Uint32Array(80);
    line[0] = 0x41;
    bs.pushScrollback(line);
    expect(bs.scrollback.length).toBe(1);
    expect(bs.scrollback[0][0]).toBe(0x41);
  });

  it("pushScrollback evicts oldest line when maxScrollback is exceeded", () => {
    const bs = new BufferSet(80, 24, 3);
    for (let i = 0; i < 5; i++) {
      const line = new Uint32Array(80);
      line[0] = i;
      bs.pushScrollback(line);
    }
    expect(bs.scrollback.length).toBe(3);
    // Oldest entries (0, 1) were evicted; remaining are 2, 3, 4
    expect(bs.scrollback[0][0]).toBe(2);
    expect(bs.scrollback[1][0]).toBe(3);
    expect(bs.scrollback[2][0]).toBe(4);
  });

  it("scrollUpWithHistory pushes normal-buffer top row into scrollback", () => {
    const bs = new BufferSet(80, 24);
    bs.normal.grid.setCell(0, 0, 0x5a, 7, 0, 0); // 'Z' at row 0, col 0
    bs.scrollUpWithHistory();
    expect(bs.scrollback.length).toBe(1);
    // Scrollback stores raw packed cell data; check the codepoint bits
    // codepoint is stored in lower 21 bits of word 0 of the cell
    const cellWord0 = bs.scrollback[0][0]; // first cell, first word
    expect(cellWord0 & 0x1fffff).toBe(0x5a);
  });

  it("scrollUpWithHistory does NOT push to scrollback on alternate buffer", () => {
    const bs = new BufferSet(80, 24);
    bs.activateAlternate();
    bs.alternate.grid.setCell(0, 0, 0x5a, 7, 0, 0);
    bs.scrollUpWithHistory();
    expect(bs.scrollback.length).toBe(0);
  });

  it("scrollUpWithHistory does NOT push to scrollback when scrollTop != 0", () => {
    const bs = new BufferSet(80, 24);
    bs.normal.scrollTop = 2; // scroll region doesn't start at top
    bs.scrollUpWithHistory();
    expect(bs.scrollback.length).toBe(0);
  });

  it("starts with empty scrollback", () => {
    const bs = new BufferSet(80, 24);
    expect(bs.scrollback.length).toBe(0);
  });

  it("custom maxScrollback is respected", () => {
    const bs = new BufferSet(80, 24, 10);
    expect(bs.maxScrollback).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// BufferSet — scrollbackWrap
// ---------------------------------------------------------------------------
describe("BufferSet scrollbackWrap", () => {
  it("pushScrollback stores wrap flag", () => {
    const bs = new BufferSet(10, 5, 100);
    const row = new Uint32Array(20);
    bs.pushScrollback(row, true);
    expect(bs.scrollbackWrap[0]).toBe(true);
  });

  it("pushScrollback defaults wrapped to false", () => {
    const bs = new BufferSet(10, 5, 100);
    const row = new Uint32Array(20);
    bs.pushScrollback(row);
    expect(bs.scrollbackWrap[0]).toBe(false);
  });

  it("scrollbackWrap evicted in sync with scrollback", () => {
    const bs = new BufferSet(10, 5, 3); // max 3
    bs.pushScrollback(new Uint32Array(20), true); // [true]
    bs.pushScrollback(new Uint32Array(20), false); // [true, false]
    bs.pushScrollback(new Uint32Array(20), true); // [true, false, true]
    bs.pushScrollback(new Uint32Array(20), false); // [false, true, false] — first evicted
    expect(bs.scrollback.length).toBe(3);
    expect(bs.scrollbackWrap.length).toBe(3);
    expect(bs.scrollbackWrap[0]).toBe(false);
    expect(bs.scrollbackWrap[1]).toBe(true);
    expect(bs.scrollbackWrap[2]).toBe(false);
  });

  it("scrollUpWithHistory stores compact flag for non-RGB rows", () => {
    const bs = new BufferSet(10, 3, 5);
    // Write a plain row (no RGB) to row 0
    bs.active.grid.setCell(0, 0, 0x41, 7, 0, 0);
    bs.scrollUpWithHistory();
    expect(bs.scrollback.length).toBe(1);
    expect(bs.scrollbackCompact[0]).toBe(true);
    expect(bs.scrollback[0].length).toBe(10 * 2); // compact: 2 words/cell
  });

  it("scrollUpWithHistory stores full row for RGB rows", () => {
    const bs = new BufferSet(10, 3, 5);
    bs.active.grid.setCell(0, 0, 0x41, 0, 0, 0, true, false, 0xff0000);
    bs.scrollUpWithHistory();
    expect(bs.scrollback.length).toBe(1);
    expect(bs.scrollbackCompact[0]).toBe(false);
    expect(bs.scrollback[0].length).toBe(10 * 4); // full: CELL_SIZE words/cell
  });

  it("pushScrollback evicts compact flag alongside row data", () => {
    const bs = new BufferSet(10, 3, 2);
    bs.pushScrollback(new Uint32Array(20), false, true); // compact
    bs.pushScrollback(new Uint32Array(40), false, false); // full
    bs.pushScrollback(new Uint32Array(20), false, true); // evicts first
    expect(bs.scrollbackCompact.length).toBe(2);
    expect(bs.scrollbackCompact[0]).toBe(false);
    expect(bs.scrollbackCompact[1]).toBe(true);
  });
});
