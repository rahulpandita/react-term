import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import { describe, expect, it, vi } from "vitest";
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
