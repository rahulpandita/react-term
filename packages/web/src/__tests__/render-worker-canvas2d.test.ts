import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import { describe, expect, it, vi } from "vitest";
import {
  ATTR_BOLD,
  ATTR_INVERSE,
  ATTR_ITALIC,
  ATTR_STRIKETHROUGH,
  ATTR_UNDERLINE,
} from "../cell-attrs.js";
import type { BackendInitOptions } from "../render-worker-backend.js";
import { Canvas2DBackend } from "../render-worker-canvas2d.js";

/**
 * A hand-rolled mock of the subset of OffscreenCanvasRenderingContext2D that
 * Canvas2DBackend actually touches. Records both method calls AND state-setter
 * writes (fillStyle, globalAlpha) so we can assert on the style that was
 * active when a particular drawing call fired.
 *
 * Every recorded entry lands in `calls` in the order it happened — so a
 * fillStyle assignment followed by fillRect is visible as two adjacent entries,
 * which is enough to verify "the highlight color was in effect when fillRect
 * painted on row 1".
 */
interface CallLog {
  ops: Array<[string, unknown[]]>;
  /** For each op, the fillStyle / globalAlpha that was active when it ran. */
  state: Array<{ fillStyle: unknown; globalAlpha: number }>;
}

function createMockContext() {
  const log: CallLog = { ops: [], state: [] };
  let fillStyle: unknown = "";
  let globalAlpha = 1;
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      log.ops.push([name, args]);
      log.state.push({ fillStyle, globalAlpha });
    });
  const ctx = {
    clearRect: record("clearRect"),
    fillRect: record("fillRect"),
    fillText: record("fillText"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    setTransform: record("setTransform"),
    measureText: vi.fn(() => ({ width: 8, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 2 })),
    font: "",
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: unknown) {
      fillStyle = v;
    },
    strokeStyle: "",
    lineWidth: 1,
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(v: number) {
      globalAlpha = v;
    },
  } as unknown as CanvasRenderingContext2D;
  // Expose the simple `calls` alias for existing tests that only care about op names.
  return { ctx, calls: log.ops, log };
}

function createMockOffscreenCanvas(mockCtx: CanvasRenderingContext2D) {
  return {
    width: 100,
    height: 100,
    getContext: vi.fn(() => mockCtx),
    addEventListener: vi.fn(),
  } as unknown as OffscreenCanvas;
}

function defaultInit(canvas: OffscreenCanvas): BackendInitOptions {
  return {
    canvas,
    theme: { ...DEFAULT_THEME },
    fontSize: 14,
    fontFamily: "monospace",
    fontWeight: 400,
    fontWeightBold: 700,
    dpr: 1,
    cols: 10,
    rows: 3,
    cellWidth: 8,
    cellHeight: 16,
    baselineOffset: 12,
  };
}

describe("Canvas2DBackend", () => {
  it("init acquires a 2D context and sets the DPR transform", () => {
    const { ctx } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init({ ...defaultInit(canvas), dpr: 2 });
    expect(canvas.getContext).toHaveBeenCalledWith("2d");
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });

  it("init throws when the 2D context is unavailable", () => {
    const canvas = {
      width: 100,
      height: 100,
      getContext: vi.fn(() => null),
      addEventListener: vi.fn(),
    } as unknown as OffscreenCanvas;
    const backend = new Canvas2DBackend();
    expect(() => backend.init(defaultInit(canvas))).toThrow(/2d context/i);
  });

  it("render paints dirty cells and clears the dirty flag", () => {
    const { ctx, calls } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));

    // A 10x3 grid with a visible character in row 1.
    const grid = new CellGrid(10, 3);
    grid.setCell(1, 0, "A".codePointAt(0) ?? 0x41, 7, 0, 0);

    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [],
    });

    // Row 1 was dirty → we expect at least one clearRect + fillText.
    const cleared = calls.filter(([n]) => n === "clearRect");
    const filled = calls.filter(([n]) => n === "fillText");
    expect(cleared.length).toBeGreaterThan(0);
    expect(filled.some(([, args]) => args[0] === "A")).toBe(true);

    // Dirty flag cleared after paint.
    expect(grid.isDirty(1)).toBe(false);
  });

  it("renders reversed selections (endRow < startRow) after normalization", () => {
    const { ctx, calls } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));

    const grid = new CellGrid(10, 3);
    grid.markAllDirty();

    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: { startRow: 2, startCol: 4, endRow: 0, endCol: 1 },
      highlights: [],
    });

    // At least one fillRect was issued with the selection theme colour.
    // (We can't easily inspect fillStyle history without deeper mocking,
    // but we can confirm fillRect was called at all — the selection path
    // is the only reason globalAlpha ever drops to 0.5 here, and it'd be
    // skipped entirely without normalization.)
    expect(calls.some(([n]) => n === "fillRect")).toBe(true);
  });

  it("paints current-match highlights in orange at their row", () => {
    const { ctx, log } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));

    const grid = new CellGrid(10, 3);
    grid.markAllDirty();

    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [{ row: 1, startCol: 2, endCol: 5, isCurrent: true }],
    });

    // Find a fillRect that was issued while the highlight color was active on
    // row 1 (y=16, the second row at cellHeight=16). Tautological-guard: this
    // assertion fails if the highlight code is removed, because no fillRect
    // for row 1 would land with the orange fillStyle.
    const matches = log.ops
      .map((op, i) => ({ op, state: log.state[i] }))
      .filter(
        ({ op, state }) =>
          op[0] === "fillRect" &&
          Array.isArray(op[1]) &&
          op[1][1] === 16 &&
          state.fillStyle === "rgba(255, 165, 0, 0.5)",
      );
    expect(matches.length).toBeGreaterThan(0);
  });

  it("paints non-current highlights in yellow", () => {
    const { ctx, log } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));
    const grid = new CellGrid(10, 3);
    grid.markAllDirty();
    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [{ row: 0, startCol: 0, endCol: 3, isCurrent: false }],
    });
    const matches = log.ops
      .map((op, i) => ({ op, state: log.state[i] }))
      .filter(
        ({ op, state }) => op[0] === "fillRect" && state.fillStyle === "rgba(255, 255, 0, 0.3)",
      );
    expect(matches.length).toBeGreaterThan(0);
  });

  it.each([
    ["block", { globalAlpha: 0.5 }],
    ["bar", { globalAlpha: 1 }],
    ["underline", { globalAlpha: 1 }],
  ])("draws a %s cursor with the theme cursor color", (style, expectedState) => {
    const { ctx, log } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));
    const grid = new CellGrid(10, 3);
    grid.markAllDirty();

    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 1,
      cursorCol: 2,
      cursorVisible: true,
      cursorStyle: style,
      selection: null,
      highlights: [],
    });

    // The cursor's fillRect must run with the theme cursor color AND the
    // style-specific alpha. Block cursors use globalAlpha 0.5; bar and
    // underline leave alpha at 1.
    const cursorFills = log.ops
      .map((op, i) => ({ op, state: log.state[i] }))
      .filter(
        ({ op, state }) =>
          op[0] === "fillRect" &&
          state.fillStyle === DEFAULT_THEME.cursor &&
          state.globalAlpha === expectedState.globalAlpha,
      );
    expect(cursorFills.length).toBeGreaterThan(0);
  });

  it("does not draw a cursor when cursorVisible is false", () => {
    const { ctx, log } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));
    const grid = new CellGrid(10, 3);
    grid.markAllDirty();
    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 1,
      cursorCol: 2,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [],
    });
    // No fillRect should have used theme.cursor as fillStyle.
    const cursorFills = log.ops
      .map((op, i) => ({ op, state: log.state[i] }))
      .filter(({ op, state }) => op[0] === "fillRect" && state.fillStyle === DEFAULT_THEME.cursor);
    expect(cursorFills).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Attribute rendering tests
// ---------------------------------------------------------------------------

describe("Canvas2DBackend — attribute rendering", () => {
  function makeBackend() {
    const { ctx, calls, log } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));
    return { ctx, calls, log, backend };
  }

  function renderCell(backend: Canvas2DBackend, attrs: number, codepoint = 0x41) {
    const grid = new CellGrid(10, 3);
    grid.setCell(0, 0, codepoint, 7, 0, attrs);
    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [],
    });
  }

  it("ATTR_BOLD: font string uses fontWeightBold (700)", () => {
    const { ctx, backend } = makeBackend();
    renderCell(backend, ATTR_BOLD);
    expect(ctx.font).toContain("700");
  });

  it("ATTR_ITALIC: font string starts with 'italic '", () => {
    const { ctx, backend } = makeBackend();
    renderCell(backend, ATTR_ITALIC);
    expect(ctx.font).toMatch(/^italic /);
  });

  it("ATTR_UNDERLINE: stroke() is called for the underline", () => {
    const { calls, backend } = makeBackend();
    renderCell(backend, ATTR_UNDERLINE);
    expect(calls.some(([n]) => n === "stroke")).toBe(true);
  });

  it("ATTR_STRIKETHROUGH: stroke() is called for the strikethrough", () => {
    const { calls, backend } = makeBackend();
    renderCell(backend, ATTR_STRIKETHROUGH);
    expect(calls.some(([n]) => n === "stroke")).toBe(true);
  });

  it("ATTR_INVERSE: background fillRect painted with theme.foreground", () => {
    // Default fg=index 7 → theme.foreground; bg=index 0 → theme.background.
    // ATTR_INVERSE swaps fg↔bg, making bg = theme.foreground, which ≠ background
    // → a background fillRect must be painted.
    const { log, backend } = makeBackend();
    renderCell(backend, ATTR_INVERSE);
    const bgFills = log.ops
      .map((op, i) => ({ op, state: log.state[i] }))
      .filter(
        ({ op, state }) => op[0] === "fillRect" && state.fillStyle === DEFAULT_THEME.foreground,
      );
    expect(bgFills.length).toBeGreaterThan(0);
  });

  it("wide cell: underline spans two cell widths", () => {
    // ATTR_WIDE = 0x80 (bit 7 of the attrs byte), ATTR_UNDERLINE = 0x04.
    const ATTR_WIDE = 0x80;
    const { calls, backend } = makeBackend();
    const grid = new CellGrid(10, 3);
    grid.setCell(0, 0, 0x4100 /* ㄀ wide codepoint placeholder */, 7, 0, ATTR_WIDE | ATTR_UNDERLINE);
    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [],
    });
    // The lineTo call for the underline should target x + effWidth = 0 + 2*8 = 16.
    const lineToCalls = calls.filter(([n]) => n === "lineTo");
    expect(lineToCalls.some(([, args]) => Array.isArray(args) && args[0] === 16)).toBe(true);
  });

  it("RGB foreground: fillStyle is set to rgb(r,g,b) string", () => {
    // fgIsRGB=true, fgRGB=0xff8040 → "rgb(255,128,64)"
    const { log, backend } = makeBackend();
    const grid = new CellGrid(10, 3);
    grid.setCell(0, 0, 0x41, 0, 0, 0, true, false, 0xff8040, 0);
    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [],
    });
    const textFills = log.ops
      .map((op, i) => ({ op, state: log.state[i] }))
      .filter(({ op, state }) => op[0] === "fillText" && state.fillStyle === "rgb(255,128,64)");
    expect(textFills.length).toBeGreaterThan(0);
  });

  it("RGB background: bg fillRect is painted with rgb(r,g,b)", () => {
    // bgIsRGB=true, bgRGB=0x102030 → "rgb(16,32,48)" ≠ theme.background
    const { log, backend } = makeBackend();
    const grid = new CellGrid(10, 3);
    grid.setCell(0, 0, 0x41, 7, 0, 0, false, true, 0, 0x102030);
    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [],
    });
    const bgFills = log.ops
      .map((op, i) => ({ op, state: log.state[i] }))
      .filter(({ op, state }) => op[0] === "fillRect" && state.fillStyle === "rgb(16,32,48)");
    expect(bgFills.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Configuration method tests
// ---------------------------------------------------------------------------

describe("Canvas2DBackend — configuration methods", () => {
  it("setFont: updated fontWeightBold appears in bold text render", () => {
    const { ctx } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));
    backend.setFont(14, "monospace", 400, 900, 1, 8, 16, 12);

    const grid = new CellGrid(10, 3);
    grid.setCell(0, 0, 0x41, 7, 0, ATTR_BOLD);
    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [],
    });
    expect(ctx.font).toContain("900");
  });

  it("setTheme: updated foreground color appears in text render", () => {
    const { log } = createMockContext();
    // Re-create with a fresh pair to avoid state from other tests.
    const { ctx: ctx2, log: log2 } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx2);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));
    backend.setTheme({ ...DEFAULT_THEME, foreground: "#ff0000" });

    const grid = new CellGrid(10, 3);
    grid.setCell(0, 0, 0x41, 7, 0, 0); // index 7 → theme.foreground
    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: null,
      highlights: [],
    });

    void log; // silence unused warning
    const textFills = log2.ops
      .map((op, i) => ({ op, state: log2.state[i] }))
      .filter(({ op, state }) => op[0] === "fillText" && state.fillStyle === "#ff0000");
    expect(textFills.length).toBeGreaterThan(0);
  });

  it("syncCanvasSize: updates canvas width and height", () => {
    const { ctx } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));
    // cols=5, rows=2, cellWidth=10, cellHeight=20, dpr=2 → 100×80 physical
    backend.syncCanvasSize(5, 2, 10, 20, 2);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(80);
  });

  it("dispose: render() is a no-op and does not throw", () => {
    const { ctx, calls } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));
    backend.dispose();

    const grid = new CellGrid(10, 3);
    grid.setCell(0, 0, 0x41, 7, 0, 0);
    expect(() =>
      backend.render({
        grid,
        cols: 10,
        rows: 3,
        cursorRow: 0,
        cursorCol: 0,
        cursorVisible: false,
        cursorStyle: "block",
        selection: null,
        highlights: [],
      }),
    ).not.toThrow();
    expect(calls.filter(([n]) => n === "fillText")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-row selection tests
// ---------------------------------------------------------------------------

describe("Canvas2DBackend — multi-row selection geometry", () => {
  it("middle row of a multi-row selection uses full column span", () => {
    const { log } = createMockContext();
    const { ctx: ctx2, log: log2 } = createMockContext();
    const canvas = createMockOffscreenCanvas(ctx2);
    const backend = new Canvas2DBackend();
    backend.init(defaultInit(canvas));

    const grid = new CellGrid(10, 3);
    grid.markAllDirty();

    // 3-row selection: row 0 (start at col 3) → row 2 (end at col 6).
    // Row 1 is the middle row — should cover cols 0..9 (full width = 10*8 = 80).
    backend.render({
      grid,
      cols: 10,
      rows: 3,
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: false,
      cursorStyle: "block",
      selection: { startRow: 0, startCol: 3, endRow: 2, endCol: 6 },
      highlights: [],
    });

    void log; // silence unused
    // A fillRect at y=16 (row 1) with width 80 (10 cols × 8 px) using selectionBackground.
    const middleRowSel = log2.ops
      .map((op, i) => ({ op, state: log2.state[i] }))
      .filter(
        ({ op, state }) =>
          op[0] === "fillRect" &&
          Array.isArray(op[1]) &&
          op[1][1] === 16 &&
          (op[1][2] as number) === 80 &&
          state.fillStyle === DEFAULT_THEME.selectionBackground,
      );
    expect(middleRowSel.length).toBeGreaterThan(0);
  });
});
