// @vitest-environment jsdom

import type { CursorState } from "@next_term/core";
import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HighlightRange } from "../renderer.js";
import { Canvas2DRenderer } from "../renderer.js";

// ---------------------------------------------------------------------------
// Attribute bit constants (mirror renderer.ts private constants)
// ---------------------------------------------------------------------------
const ATTR_BOLD = 0x01;
const ATTR_ITALIC = 0x02;
const ATTR_UNDERLINE = 0x04;
const ATTR_STRIKETHROUGH = 0x08;
const ATTR_INVERSE = 0x40;

// ---------------------------------------------------------------------------
// Minimal CanvasRenderingContext2D mock
//
// We capture fillStyle / strokeStyle / globalAlpha at the moment each draw
// call is made, so tests can verify what color was active for each rect.
// ---------------------------------------------------------------------------
interface DrawOp {
  type: "fillRect" | "fillText" | "stroke";
  args: number[];
  fillStyle: string;
  strokeStyle: string;
  globalAlpha: number;
  font?: string;
}

function makeMockCtx() {
  const ops: DrawOp[] = [];
  const ctx = {
    fillStyle: "" as string,
    strokeStyle: "" as string,
    globalAlpha: 1 as number,
    lineWidth: 1 as number,
    font: "" as string,
    ops,
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    measureText: vi.fn().mockReturnValue({
      width: 8,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 4,
    }),
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push({
        type: "fillRect",
        args: [x, y, w, h],
        fillStyle: ctx.fillStyle,
        strokeStyle: ctx.strokeStyle,
        globalAlpha: ctx.globalAlpha,
      });
    },
    fillText(_text: string, x: number, y: number) {
      ops.push({
        type: "fillText",
        args: [x, y],
        fillStyle: ctx.fillStyle,
        strokeStyle: ctx.strokeStyle,
        globalAlpha: ctx.globalAlpha,
        font: ctx.font,
      });
    },
    stroke() {
      ops.push({
        type: "stroke",
        args: [],
        fillStyle: ctx.fillStyle,
        strokeStyle: ctx.strokeStyle,
        globalAlpha: ctx.globalAlpha,
      });
    },
  };
  return ctx;
}
type MockCtx = ReturnType<typeof makeMockCtx>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// With the mock above, measureCellSize resolves to:
//   cellWidth  = ceil(8)       = 8
//   cellHeight = ceil(12 + 4)  = 16
const CELL_W = 8;
const CELL_H = 16;

const HIDDEN_CURSOR: CursorState = {
  row: 0,
  col: 0,
  visible: false,
  style: "block",
  wrapPending: false,
};

function cursor(row: number, col: number, style: CursorState["style"]): CursorState {
  return { row, col, visible: true, style, wrapPending: false };
}

function makeRenderer(cols = 80, rows = 24, cur: CursorState = HIDDEN_CURSOR) {
  const renderer = new Canvas2DRenderer({
    fontSize: 14,
    fontFamily: "monospace",
    theme: DEFAULT_THEME,
    devicePixelRatio: 1,
  });
  const canvas = document.createElement("canvas");
  const grid = new CellGrid(cols, rows);
  renderer.attach(canvas, grid, cur);
  // Clear all dirty flags so render() only touches what we explicitly mark.
  for (let r = 0; r < rows; r++) grid.clearDirty(r);
  return { renderer, canvas, grid };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Canvas2DRenderer — cursor rendering", () => {
  let mockCtx: MockCtx;
  let spy: { mockRestore(): void };

  beforeEach(() => {
    mockCtx = makeMockCtx();
    spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("block cursor — fillRect at cursor cell with globalAlpha 0.5", () => {
    const cur = cursor(2, 5, "block");
    const { renderer, grid } = makeRenderer(80, 24, cur);
    grid.markDirty(2); // ensure row is rendered
    mockCtx.ops.length = 0;
    renderer.render();

    // Block cursor: fillRect(x, y, cellW, cellH) with globalAlpha=0.5 and cursor color
    const op = mockCtx.ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === DEFAULT_THEME.cursor && o.globalAlpha === 0.5,
    );
    expect(op).toBeDefined();
    expect(op?.args[0]).toBe(5 * CELL_W); // x = col * cellWidth
    expect(op?.args[1]).toBe(2 * CELL_H); // y = row * cellHeight
    expect(op?.args[2]).toBe(CELL_W);
    expect(op?.args[3]).toBe(CELL_H);
    renderer.dispose();
  });

  it("underline cursor — fillRect at bottom of cell, height 2", () => {
    const cur = cursor(1, 3, "underline");
    const { renderer, grid } = makeRenderer(80, 24, cur);
    grid.markDirty(1);
    mockCtx.ops.length = 0;
    renderer.render();

    // Underline: fillRect(x, y + cellH - 2, cellW, 2) with cursor color, alpha=1
    const x = 3 * CELL_W; // 24
    const y = 1 * CELL_H + CELL_H - 2; // 16 + 14 = 30
    const op = mockCtx.ops.find(
      (o) =>
        o.type === "fillRect" &&
        o.fillStyle === DEFAULT_THEME.cursor &&
        o.args[0] === x &&
        o.args[1] === y &&
        o.args[3] === 2,
    );
    expect(op).toBeDefined();
    expect(op?.args[2]).toBe(CELL_W);
    renderer.dispose();
  });

  it("bar cursor — fillRect at left edge of cell, width 2", () => {
    const cur = cursor(0, 10, "bar");
    const { renderer, grid } = makeRenderer(80, 24, cur);
    grid.markDirty(0);
    mockCtx.ops.length = 0;
    renderer.render();

    // Bar: fillRect(x, y, 2, cellH) with cursor color, alpha=1
    const x = 10 * CELL_W; // 80
    const op = mockCtx.ops.find(
      (o) =>
        o.type === "fillRect" &&
        o.fillStyle === DEFAULT_THEME.cursor &&
        o.args[0] === x &&
        o.args[1] === 0 &&
        o.args[2] === 2,
    );
    expect(op).toBeDefined();
    expect(op?.args[3]).toBe(CELL_H);
    renderer.dispose();
  });

  it("hidden cursor — no cursor-coloured fillRect", () => {
    const { renderer, grid } = makeRenderer(80, 24, HIDDEN_CURSOR);
    grid.markDirty(0);
    mockCtx.ops.length = 0;
    renderer.render();

    const cursorOp = mockCtx.ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === DEFAULT_THEME.cursor,
    );
    expect(cursorOp).toBeUndefined();
    renderer.dispose();
  });
});

describe("Canvas2DRenderer — selection rendering", () => {
  let mockCtx: MockCtx;
  let spy: { mockRestore(): void };

  beforeEach(() => {
    mockCtx = makeMockCtx();
    spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  function selectionFillRects(ops: DrawOp[]) {
    // Selection draws with fillStyle = selectionBackground and alpha 0.5
    return ops.filter(
      (o) =>
        o.type === "fillRect" &&
        o.fillStyle === DEFAULT_THEME.selectionBackground &&
        o.globalAlpha === 0.5,
    );
  }

  it("single-row selection — one fillRect covering selected columns", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    renderer.setSelection({
      startRow: 3,
      startCol: 5,
      endRow: 3,
      endCol: 12,
    });
    grid.markAllDirty();
    mockCtx.ops.length = 0;
    renderer.render();

    const rects = selectionFillRects(mockCtx.ops);
    // For a single-row selection the logic checks sr===er, but the early
    // return is for same cell. startCol=5 ≠ endCol=12, so it should draw.
    expect(rects).toHaveLength(1);
    expect(rects[0].args[0]).toBe(5 * CELL_W); // x = startCol * cellW
    expect(rects[0].args[1]).toBe(3 * CELL_H); // y = row * cellH
    expect(rects[0].args[2]).toBe((12 - 5 + 1) * CELL_W); // w = span * cellW
    renderer.dispose();
  });

  it("multi-row selection — correct column extents per row", () => {
    const cols = 20;
    const { renderer, grid } = makeRenderer(cols, 10);
    renderer.setSelection({
      startRow: 1,
      startCol: 4,
      endRow: 3,
      endCol: 7,
    });
    grid.markAllDirty();
    mockCtx.ops.length = 0;
    renderer.render();

    const rects = selectionFillRects(mockCtx.ops);
    // Should have 3 rectangles: rows 1, 2, 3
    expect(rects).toHaveLength(3);

    // Row 1 (start row): from startCol to cols-1
    const row1 = rects.find((r) => r.args[1] === 1 * CELL_H);
    expect(row1?.args[0]).toBe(4 * CELL_W);
    expect(row1?.args[2]).toBe((cols - 1 - 4 + 1) * CELL_W);

    // Row 2 (middle row): from 0 to cols-1
    const row2 = rects.find((r) => r.args[1] === 2 * CELL_H);
    expect(row2?.args[0]).toBe(0);
    expect(row2?.args[2]).toBe(cols * CELL_W);

    // Row 3 (end row): from 0 to endCol
    const row3 = rects.find((r) => r.args[1] === 3 * CELL_H);
    expect(row3?.args[0]).toBe(0);
    expect(row3?.args[2]).toBe((7 - 0 + 1) * CELL_W);
    renderer.dispose();
  });

  it("reversed selection (start after end) — normalizeSelection corrects it", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    // Pass selection where start is after end
    renderer.setSelection({
      startRow: 5,
      startCol: 10,
      endRow: 3,
      endCol: 2,
    });
    grid.markAllDirty();
    mockCtx.ops.length = 0;
    renderer.render();

    const rects = selectionFillRects(mockCtx.ops);
    // After normalisation: startRow=3, startCol=2, endRow=5, endCol=10
    // Expect 3 rows drawn (3, 4, 5)
    expect(rects).toHaveLength(3);
    // The top row starts at startCol=2
    const topRow = rects.find((r) => r.args[1] === 3 * CELL_H);
    expect(topRow?.args[0]).toBe(2 * CELL_W);
    renderer.dispose();
  });

  it("null selection — no selection rectangles drawn", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    renderer.setSelection(null);
    grid.markAllDirty();
    mockCtx.ops.length = 0;
    renderer.render();

    const rects = selectionFillRects(mockCtx.ops);
    expect(rects).toHaveLength(0);
    renderer.dispose();
  });

  it("empty selection (same cell) — no selection rectangle drawn", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    renderer.setSelection({ startRow: 2, startCol: 5, endRow: 2, endCol: 5 });
    grid.markAllDirty();
    mockCtx.ops.length = 0;
    renderer.render();

    const rects = selectionFillRects(mockCtx.ops);
    expect(rects).toHaveLength(0);
    renderer.dispose();
  });
});

describe("Canvas2DRenderer — highlight rendering", () => {
  let mockCtx: MockCtx;
  let spy: { mockRestore(): void };

  beforeEach(() => {
    mockCtx = makeMockCtx();
    spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("current highlight — fills with orange (rgba(255,165,0,0.5))", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    const hl: HighlightRange = {
      row: 2,
      startCol: 3,
      endCol: 7,
      isCurrent: true,
    };
    renderer.setHighlights([hl]);
    grid.markAllDirty();
    mockCtx.ops.length = 0;
    renderer.render();

    const op = mockCtx.ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === "rgba(255, 165, 0, 0.5)",
    );
    expect(op).toBeDefined();
    expect(op?.args[0]).toBe(3 * CELL_W);
    expect(op?.args[1]).toBe(2 * CELL_H);
    expect(op?.args[2]).toBe((7 - 3 + 1) * CELL_W);
    renderer.dispose();
  });

  it("non-current highlight — fills with yellow (rgba(255,255,0,0.3))", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    const hl: HighlightRange = {
      row: 5,
      startCol: 0,
      endCol: 4,
      isCurrent: false,
    };
    renderer.setHighlights([hl]);
    grid.markAllDirty();
    mockCtx.ops.length = 0;
    renderer.render();

    const op = mockCtx.ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === "rgba(255, 255, 0, 0.3)",
    );
    expect(op).toBeDefined();
    renderer.dispose();
  });

  it("empty highlights array — no highlight fillRects", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    renderer.setHighlights([]);
    grid.markAllDirty();
    mockCtx.ops.length = 0;
    renderer.render();

    const op = mockCtx.ops.find(
      (o) =>
        o.type === "fillRect" &&
        (o.fillStyle === "rgba(255, 165, 0, 0.5)" || o.fillStyle === "rgba(255, 255, 0, 0.3)"),
    );
    expect(op).toBeUndefined();
    renderer.dispose();
  });

  it("multiple highlights — both current and non-current drawn", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    renderer.setHighlights([
      { row: 0, startCol: 1, endCol: 3, isCurrent: true },
      { row: 1, startCol: 5, endCol: 8, isCurrent: false },
      { row: 2, startCol: 0, endCol: 2, isCurrent: false },
    ]);
    grid.markAllDirty();
    mockCtx.ops.length = 0;
    renderer.render();

    const current = mockCtx.ops.filter(
      (o) => o.type === "fillRect" && o.fillStyle === "rgba(255, 165, 0, 0.5)",
    );
    const others = mockCtx.ops.filter(
      (o) => o.type === "fillRect" && o.fillStyle === "rgba(255, 255, 0, 0.3)",
    );
    expect(current).toHaveLength(1);
    expect(others).toHaveLength(2);
    renderer.dispose();
  });
});

describe("Canvas2DRenderer — color resolution via render", () => {
  let mockCtx: MockCtx;
  let spy: { mockRestore(): void };

  beforeEach(() => {
    mockCtx = makeMockCtx();
    spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("default fg (index 7) uses theme.foreground for text", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    // Default cell: fgIndex=7, bgIndex=0, codepoint='A'=0x41
    grid.setCell(0, 0, 0x41, 7, 0, 0);
    mockCtx.ops.length = 0;
    renderer.render();

    // fillText should use theme.foreground
    const textOp = mockCtx.ops.find((o) => o.type === "fillText");
    expect(textOp).toBeDefined();
    expect(textOp?.fillStyle).toBe(DEFAULT_THEME.foreground);
    renderer.dispose();
  });

  it("explicit palette color (fg index 1 = red) uses palette[1]", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    // fgIndex=1 → palette[1] = DEFAULT_THEME.red
    grid.setCell(0, 0, 0x42, 1, 0, 0);
    mockCtx.ops.length = 0;
    renderer.render();

    const textOp = mockCtx.ops.find((o) => o.type === "fillText");
    expect(textOp?.fillStyle).toBe(DEFAULT_THEME.red);
    renderer.dispose();
  });

  it("RGB foreground color uses rgb(r,g,b) string", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    // fgIsRGB=true; store RGB value in grid.rgbColors at offset=col=0
    grid.setCell(0, 0, 0x43, 0, 0, 0, true, false); // fgIsRGB=true
    // rgb(255, 128, 64) → packed as (255 << 16) | (128 << 8) | 64
    grid.rgbColors[0] = (255 << 16) | (128 << 8) | 64;
    mockCtx.ops.length = 0;
    renderer.render();

    const textOp = mockCtx.ops.find((o) => o.type === "fillText");
    expect(textOp?.fillStyle).toBe("rgb(255,128,64)");
    renderer.dispose();
  });

  it("inverse attribute swaps fg and bg colors", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    // Use explicit fg=1 (red) and bg=2 (green), with ATTR_INVERSE=0x40
    // After inversion: fg becomes green (bg), bg becomes red (fg)
    // The cell will draw bg rect with red, and text with green palette color.
    grid.setCell(0, 0, 0x44, 1, 2, ATTR_INVERSE);
    mockCtx.ops.length = 0;
    renderer.render();

    // After inverse: effective bg = palette[1] (red), effective fg = palette[2] (green)
    // Background rect should be drawn with palette[1] = DEFAULT_THEME.red
    const bgOp = mockCtx.ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === DEFAULT_THEME.red,
    );
    expect(bgOp).toBeDefined();

    // Text should be drawn with palette[2] = DEFAULT_THEME.green
    const textOp = mockCtx.ops.find((o) => o.type === "fillText");
    expect(textOp?.fillStyle).toBe(DEFAULT_THEME.green);
    renderer.dispose();
  });

  it("RGB background color uses rgb(r,g,b) string for bg fillRect", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    // bgIsRGB=true: background is a true-color value stored at rgbColors[256+col]
    // fg stays as default (index 7 → theme.foreground)
    grid.setCell(0, 0, 0x43, 7, 0, 0, false, true); // codepoint 'C', fgIsRGB=false, bgIsRGB=true
    grid.rgbColors[256 + 0] = (200 << 16) | (100 << 8) | 50; // rgb(200,100,50)
    mockCtx.ops.length = 0;
    renderer.render();

    // A bg fillRect should be drawn using the RGB string (not theme.background)
    const bgOp = mockCtx.ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === "rgb(200,100,50)",
    );
    expect(bgOp).toBeDefined();

    // Text (codepoint 0x43='C') should use theme.foreground
    const textOp = mockCtx.ops.find((o) => o.type === "fillText");
    expect(textOp?.fillStyle).toBe(DEFAULT_THEME.foreground);
    renderer.dispose();
  });

  it("RGB background + ATTR_INVERSE: text uses RGB bg color, bg rect uses original fg", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    // fgIsRGB=false (fg=index 1, i.e. red palette), bgIsRGB=true, ATTR_INVERSE
    // After inversion: effective fg = rgb(200,100,50), effective bg = palette[1] (red)
    grid.setCell(0, 0, 0x44, 1, 0, ATTR_INVERSE, false, true); // codepoint 'D', bg=RGB, ATTR_INVERSE
    grid.rgbColors[256 + 0] = (200 << 16) | (100 << 8) | 50; // rgb(200,100,50) as bg
    mockCtx.ops.length = 0;
    renderer.render();

    // After inversion: bg rect should be drawn with original fg (palette[1] = DEFAULT_THEME.red)
    const bgOp = mockCtx.ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === DEFAULT_THEME.red,
    );
    expect(bgOp).toBeDefined();

    // Text should use the original bg color (rgb(200,100,50)) now acting as fg
    const textOp = mockCtx.ops.find((o) => o.type === "fillText");
    expect(textOp?.fillStyle).toBe("rgb(200,100,50)");
    renderer.dispose();
  });
});

describe("Canvas2DRenderer — text attribute rendering", () => {
  let mockCtx: MockCtx;
  let spy: { mockRestore(): void };

  beforeEach(() => {
    mockCtx = makeMockCtx();
    spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("ATTR_BOLD sets bold font for text", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    grid.setCell(0, 0, 0x41, 7, 0, ATTR_BOLD); // 'A' with bold
    mockCtx.ops.length = 0;
    renderer.render();

    const textOp = mockCtx.ops.find((o) => o.type === "fillText");
    expect(textOp).toBeDefined();
    expect(textOp?.font).toContain("bold");
    expect(textOp?.font).not.toContain("italic");
    renderer.dispose();
  });

  it("ATTR_ITALIC sets italic font for text", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    grid.setCell(0, 0, 0x41, 7, 0, ATTR_ITALIC); // 'A' with italic
    mockCtx.ops.length = 0;
    renderer.render();

    const textOp = mockCtx.ops.find((o) => o.type === "fillText");
    expect(textOp).toBeDefined();
    expect(textOp?.font).toContain("italic");
    expect(textOp?.font).not.toContain("bold");
    renderer.dispose();
  });

  it("ATTR_BOLD | ATTR_ITALIC sets both bold and italic font", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    grid.setCell(0, 0, 0x41, 7, 0, ATTR_BOLD | ATTR_ITALIC);
    mockCtx.ops.length = 0;
    renderer.render();

    const textOp = mockCtx.ops.find((o) => o.type === "fillText");
    expect(textOp).toBeDefined();
    expect(textOp?.font).toContain("bold");
    expect(textOp?.font).toContain("italic");
    renderer.dispose();
  });

  it("ATTR_UNDERLINE draws a stroke with fg color", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    // fg=1 (red) so underline stroke should use palette[1] = DEFAULT_THEME.red
    grid.setCell(0, 0, 0x41, 1, 0, ATTR_UNDERLINE);
    mockCtx.ops.length = 0;
    renderer.render();

    const strokeOp = mockCtx.ops.find(
      (o) => o.type === "stroke" && o.strokeStyle === DEFAULT_THEME.red,
    );
    expect(strokeOp).toBeDefined();
    renderer.dispose();
  });

  it("ATTR_STRIKETHROUGH draws a stroke with fg color", () => {
    const { renderer, grid } = makeRenderer(10, 5);
    // fg=2 (green) so strikethrough stroke should use palette[2] = DEFAULT_THEME.green
    grid.setCell(0, 0, 0x41, 2, 0, ATTR_STRIKETHROUGH);
    mockCtx.ops.length = 0;
    renderer.render();

    const strokeOp = mockCtx.ops.find(
      (o) => o.type === "stroke" && o.strokeStyle === DEFAULT_THEME.green,
    );
    expect(strokeOp).toBeDefined();
    renderer.dispose();
  });
});

// ---------------------------------------------------------------------------
// Canvas2DRenderer — render optimization (dirty-row skipping)
// ---------------------------------------------------------------------------

describe("Canvas2DRenderer — render optimization", () => {
  let mockCtx: MockCtx;
  let spy: { mockRestore(): void };

  beforeEach(() => {
    mockCtx = makeMockCtx();
    spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("render() only clears rows that are dirty", () => {
    // makeRenderer clears all dirty flags after attach.
    const { renderer, grid } = makeRenderer(80, 24);
    // Mark only row 5 dirty; cursor is at row 0 (HIDDEN_CURSOR) so it also marks row 0.
    grid.markDirty(5);
    mockCtx.clearRect.mockClear();

    renderer.render();

    // clearRect is called once per rendered row, with y = row * CELL_H
    const renderedYs = mockCtx.clearRect.mock.calls.map((c: number[]) => c[1]);
    expect(renderedYs).toContain(0 * CELL_H); // cursor row 0 always re-rendered
    expect(renderedYs).toContain(5 * CELL_H); // explicitly marked dirty
    // No other rows should have been cleared
    expect(renderedYs.filter((y: number) => y !== 0 && y !== 5 * CELL_H)).toHaveLength(0);
    renderer.dispose();
  });

  it("cursor movement marks old cursor row dirty so the ghost is erased", () => {
    const cur: CursorState = { row: 3, col: 0, visible: true, style: "block", wrapPending: false };
    const { renderer, grid } = makeRenderer(80, 24, cur);

    // First render: establishes prevCursorRow = 3 and prevCursorCol = 0
    grid.markDirty(3);
    renderer.render();

    // Clear all dirty flags and mockCtx call counts
    for (let r = 0; r < 24; r++) grid.clearDirty(r);
    mockCtx.clearRect.mockClear();

    // Move cursor to row 7
    cur.row = 7;
    cur.col = 2;

    renderer.render();

    const renderedYs = mockCtx.clearRect.mock.calls.map((c: number[]) => c[1]);
    // Old cursor row (3) must be re-rendered to erase the cursor ghost
    expect(renderedYs).toContain(3 * CELL_H);
    // New cursor row (7) must also be re-rendered to draw the cursor
    expect(renderedYs).toContain(7 * CELL_H);
    renderer.dispose();
  });

  it("render() is a no-op after dispose()", () => {
    const { renderer } = makeRenderer(10, 5);
    renderer.dispose();
    mockCtx.clearRect.mockClear();

    // Should not throw and should not draw anything
    expect(() => renderer.render()).not.toThrow();
    expect(mockCtx.clearRect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Canvas2DRenderer — lifecycle (setTheme, setFont, setSelection, setHighlights)
// ---------------------------------------------------------------------------

describe("Canvas2DRenderer — lifecycle", () => {
  let mockCtx: MockCtx;
  let spy: { mockRestore(): void };

  beforeEach(() => {
    mockCtx = makeMockCtx();
    spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("setTheme() marks all grid rows dirty", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    // Verify all rows are clean after makeRenderer's explicit clearDirty loop
    for (let r = 0; r < 24; r++) expect(grid.isDirty(r)).toBe(false);

    renderer.setTheme({ ...DEFAULT_THEME, background: "#000001" });

    for (let r = 0; r < 24; r++) expect(grid.isDirty(r)).toBe(true);
    renderer.dispose();
  });

  it("setTheme() without an attached grid does not throw", () => {
    const renderer = new Canvas2DRenderer({
      fontSize: 14,
      fontFamily: "monospace",
      theme: DEFAULT_THEME,
    });
    expect(() => renderer.setTheme({ ...DEFAULT_THEME })).not.toThrow();
    renderer.dispose();
  });

  it("setFont() marks all grid rows dirty", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    for (let r = 0; r < 24; r++) expect(grid.isDirty(r)).toBe(false);

    renderer.setFont(18, "Courier New");

    for (let r = 0; r < 24; r++) expect(grid.isDirty(r)).toBe(true);
    renderer.dispose();
  });

  it("setSelection() marks all grid rows dirty", () => {
    const { renderer, grid } = makeRenderer(80, 24);
    for (let r = 0; r < 24; r++) expect(grid.isDirty(r)).toBe(false);

    renderer.setSelection({ startRow: 0, startCol: 0, endRow: 1, endCol: 5 });

    for (let r = 0; r < 24; r++) expect(grid.isDirty(r)).toBe(true);
    renderer.dispose();
  });

  it("setHighlights() marks all grid rows dirty", () => {
    const hl: HighlightRange = { row: 2, startCol: 0, endCol: 4, isCurrent: true };
    const { renderer, grid } = makeRenderer(80, 24);
    for (let r = 0; r < 24; r++) expect(grid.isDirty(r)).toBe(false);

    renderer.setHighlights([hl]);

    for (let r = 0; r < 24; r++) expect(grid.isDirty(r)).toBe(true);
    renderer.dispose();
  });

  it("dispose() is idempotent — calling it twice does not throw", () => {
    const { renderer } = makeRenderer(10, 5);
    expect(() => {
      renderer.dispose();
      renderer.dispose();
    }).not.toThrow();
  });
});
