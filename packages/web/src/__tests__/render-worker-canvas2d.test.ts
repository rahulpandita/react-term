import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import { describe, expect, it, vi } from "vitest";
import type { BackendInitOptions } from "../render-worker-backend.js";
import { Canvas2DBackend } from "../render-worker-canvas2d.js";

/**
 * A hand-rolled mock of the subset of OffscreenCanvasRenderingContext2D that
 * Canvas2DBackend actually touches. We assert against the recorded call log
 * rather than pixel output, since jsdom has no real 2D context.
 */
function createMockContext() {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push([name, args]);
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
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
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

  it("paints highlight overlays on their row", () => {
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
      selection: null,
      highlights: [{ row: 1, startCol: 2, endCol: 5, isCurrent: true }],
    });

    // fillRect called at least once on the highlighted row (row 1 starts at y=16).
    const highlightFill = calls.find(
      ([n, args]) => n === "fillRect" && Array.isArray(args) && args[1] === 16 && args[3] === 16,
    );
    expect(highlightFill).toBeDefined();
  });
});
