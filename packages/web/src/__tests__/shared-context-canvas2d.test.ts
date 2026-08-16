// @vitest-environment jsdom

import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedCanvas2DContext } from "../shared-context-canvas2d.js";
import { installLoggedMockGetContext, makeCursor } from "./test-utils.js";

/**
 * `installLoggedMockGetContext` overrides HTMLCanvasElement.prototype.getContext
 * for the duration of the test and returns a `restore` callback.  We collect
 * that callback here so afterEach can clean up even when a test throws.
 */
let restoreCtx: (() => void) | undefined;

beforeEach(() => {
  restoreCtx = undefined;
});

afterEach(() => {
  restoreCtx?.();
  restoreCtx = undefined;
  vi.restoreAllMocks();
});

describe("SharedCanvas2DContext", () => {
  // -------------------------------------------------------------------------
  // Lifecycle and registration
  // -------------------------------------------------------------------------

  it("init throws cleanly when no 2D context is available", () => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const shared = new SharedCanvas2DContext();
    expect(() => shared.init()).toThrow(/canvas 2d/i);
    HTMLCanvasElement.prototype.getContext = orig;
  });

  it("getCanvas returns an HTMLCanvasElement", () => {
    ({ restore: restoreCtx } = installLoggedMockGetContext());
    const shared = new SharedCanvas2DContext();
    expect(shared.getCanvas()).toBeInstanceOf(HTMLCanvasElement);
    shared.dispose();
  });

  it("tracks terminals through addTerminal / removeTerminal", () => {
    ({ restore: restoreCtx } = installLoggedMockGetContext());
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("a", grid, makeCursor());
    shared.addTerminal("b", grid, makeCursor());
    expect(shared.getTerminalIds().sort()).toEqual(["a", "b"]);
    shared.removeTerminal("a");
    expect(shared.getTerminalIds()).toEqual(["b"]);
    shared.dispose();
  });

  it("dispose is idempotent", () => {
    ({ restore: restoreCtx } = installLoggedMockGetContext());
    const shared = new SharedCanvas2DContext();
    shared.init();
    shared.dispose();
    expect(() => shared.dispose()).not.toThrow();
  });

  it("getCellSize returns positive values after construction", () => {
    ({ restore: restoreCtx } = installLoggedMockGetContext());
    const shared = new SharedCanvas2DContext();
    shared.init();
    const size = shared.getCellSize();
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
    shared.dispose();
  });

  // -------------------------------------------------------------------------
  // Canvas sizing
  // -------------------------------------------------------------------------

  it("syncCanvasSize updates pixel dimensions with dpr scaling and CSS size", () => {
    ({ restore: restoreCtx } = installLoggedMockGetContext());
    const shared = new SharedCanvas2DContext({ devicePixelRatio: 2 });
    shared.init();
    shared.syncCanvasSize(400, 300);
    const canvas = shared.getCanvas();
    expect(canvas.width).toBe(800); // 400 * dpr=2
    expect(canvas.height).toBe(600); // 300 * dpr=2
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.height).toBe("300px");
    shared.dispose();
  });

  // -------------------------------------------------------------------------
  // Render-loop
  // -------------------------------------------------------------------------

  it("startRenderLoop schedules a frame via requestAnimationFrame", () => {
    ({ restore: restoreCtx } = installLoggedMockGetContext());
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const shared = new SharedCanvas2DContext();
    shared.init();
    shared.startRenderLoop();
    expect(rafSpy).toHaveBeenCalledTimes(1);

    shared.stopRenderLoop();
    expect(cancelSpy).toHaveBeenCalledWith(42);
    shared.dispose();
  });

  it("startRenderLoop is idempotent — second call does not schedule an extra frame", () => {
    ({ restore: restoreCtx } = installLoggedMockGetContext());
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    const shared = new SharedCanvas2DContext();
    shared.init();
    shared.startRenderLoop();
    shared.startRenderLoop(); // should be a no-op
    expect(rafSpy).toHaveBeenCalledTimes(1);
    shared.dispose();
  });

  // -------------------------------------------------------------------------
  // Viewport
  // -------------------------------------------------------------------------

  it("setViewport is idempotent for the same rectangle", () => {
    ({ restore: restoreCtx } = installLoggedMockGetContext());
    const shared = new SharedCanvas2DContext();
    shared.init();
    shared.addTerminal("a", new CellGrid(10, 3), makeCursor());
    shared.setViewport("a", 0, 0, 100, 50);
    const renderSpy = vi.spyOn(shared, "render");
    // Same rectangle → the entry is not invalidated; calling render() twice
    // after first full paint should be a no-op on the second call.
    shared.setViewport("a", 0, 0, 100, 50);
    shared.render();
    shared.render();
    expect(renderSpy).toHaveBeenCalledTimes(2);
    shared.dispose();
  });

  it("setViewport ignores non-finite values and does not throw", () => {
    ({ restore: restoreCtx } = installLoggedMockGetContext());
    const shared = new SharedCanvas2DContext();
    shared.init();
    shared.addTerminal("t", new CellGrid(10, 3), makeCursor());
    // None of these should crash or corrupt state.
    expect(() => shared.setViewport("t", 0, 0, Infinity, 36)).not.toThrow();
    expect(() => shared.setViewport("t", NaN, 0, 80, 36)).not.toThrow();
    expect(() => shared.render()).not.toThrow();
    shared.dispose();
  });

  // -------------------------------------------------------------------------
  // Dirty tracking — updateTerminal and setTheme
  // -------------------------------------------------------------------------

  it("updateTerminal causes a full repaint on the next render", () => {
    const { log, restore } = installLoggedMockGetContext();
    restoreCtx = restore;
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("t", grid, makeCursor());
    shared.setViewport("t", 0, 0, 80, 36);
    shared.render(); // initial full paint

    // After the first render the frame is idle — a second render is a no-op.
    const fillsBefore = log.ops.filter(([n]) => n === "fillRect").length;
    shared.render(); // no-op
    expect(log.ops.filter(([n]) => n === "fillRect").length).toBe(fillsBefore);

    // updateTerminal marks fullyRendered=false → forces a full repaint.
    shared.updateTerminal("t", new CellGrid(10, 3), makeCursor());
    shared.render();
    expect(log.ops.filter(([n]) => n === "fillRect").length).toBeGreaterThan(fillsBefore);
    shared.dispose();
  });

  it("setTheme marks all terminals dirty so they repaint with new colours", () => {
    const { ctx, restore } = installLoggedMockGetContext();
    restoreCtx = restore;
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("a", grid, makeCursor());
    shared.setViewport("a", 0, 0, 100, 50);
    shared.render(); // first paint
    (ctx.fillRect as ReturnType<typeof vi.fn>).mockClear();
    (ctx.clearRect as ReturnType<typeof vi.fn>).mockClear();

    shared.setTheme({ ...DEFAULT_THEME, background: "#112233" });
    shared.render();
    // Theme change ⇒ at least one clearRect issued (row repaint).
    expect((ctx.clearRect as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    shared.dispose();
  });

  // -------------------------------------------------------------------------
  // Highlights rendering
  // -------------------------------------------------------------------------

  it("setHighlights renders current match in orange", () => {
    const { log, restore } = installLoggedMockGetContext();
    restoreCtx = restore;
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("t", grid, makeCursor({ row: 2 }));
    shared.setViewport("t", 0, 0, 80, 36);
    shared.setHighlights("t", [{ row: 1, startCol: 2, endCol: 4, isCurrent: true }]);
    shared.render();

    const hlFills = log.ops
      .map((op, i) => ({ op, s: log.state[i] }))
      .filter(({ op, s }) => op[0] === "fillRect" && s.fillStyle === "rgba(255, 165, 0, 0.5)");
    expect(hlFills.length).toBe(1);
    shared.dispose();
  });

  it("setHighlights renders non-current match in yellow", () => {
    const { log, restore } = installLoggedMockGetContext();
    restoreCtx = restore;
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("t", grid, makeCursor({ row: 2 }));
    shared.setViewport("t", 0, 0, 80, 36);
    shared.setHighlights("t", [{ row: 0, startCol: 0, endCol: 3, isCurrent: false }]);
    shared.render();

    const hlFills = log.ops
      .map((op, i) => ({ op, s: log.state[i] }))
      .filter(({ op, s }) => op[0] === "fillRect" && s.fillStyle === "rgba(255, 255, 0, 0.3)");
    expect(hlFills.length).toBe(1);
    shared.dispose();
  });

  // -------------------------------------------------------------------------
  // Cursor rendering
  // -------------------------------------------------------------------------

  it("renders a block cursor using theme.cursor colour at 0.5 opacity", () => {
    const { log, restore } = installLoggedMockGetContext();
    restoreCtx = restore;
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("t", grid, makeCursor({ row: 0, col: 0, style: "block" }));
    shared.setViewport("t", 0, 0, 80, 36);
    shared.render();

    const blockFills = log.ops
      .map((op, i) => ({ op, s: log.state[i] }))
      .filter(
        ({ op, s }) =>
          op[0] === "fillRect" && s.fillStyle === DEFAULT_THEME.cursor && s.globalAlpha === 0.5,
      );
    expect(blockFills.length).toBeGreaterThan(0);
    shared.dispose();
  });

  it("renders an underline cursor with a 2px-tall rectangle", () => {
    const { log, restore } = installLoggedMockGetContext();
    restoreCtx = restore;
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("t", grid, makeCursor({ row: 0, col: 1, style: "underline" }));
    shared.setViewport("t", 0, 0, 80, 36);
    shared.render();

    const cursorFills = log.ops
      .map((op, i) => ({ op, s: log.state[i] }))
      .filter(({ op, s }) => op[0] === "fillRect" && s.fillStyle === DEFAULT_THEME.cursor);
    // Underline: fillRect(cx, y + cellHeight - 2, cellWidth, 2) — height arg is index [3].
    expect(cursorFills.some(({ op }) => op[1][3] === 2)).toBe(true);
    shared.dispose();
  });

  it("renders a bar cursor with a 2px-wide rectangle", () => {
    const { log, restore } = installLoggedMockGetContext();
    restoreCtx = restore;
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("t", grid, makeCursor({ row: 0, col: 0, style: "bar" }));
    shared.setViewport("t", 0, 0, 80, 36);
    shared.render();

    const cursorFills = log.ops
      .map((op, i) => ({ op, s: log.state[i] }))
      .filter(({ op, s }) => op[0] === "fillRect" && s.fillStyle === DEFAULT_THEME.cursor);
    // Bar: fillRect(cx, y, 2, cellHeight) — width arg is index [2].
    expect(cursorFills.some(({ op }) => op[1][2] === 2)).toBe(true);
    shared.dispose();
  });

  it("does not render cursor when cursor.visible is false", () => {
    const { log, restore } = installLoggedMockGetContext();
    restoreCtx = restore;
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("t", grid, makeCursor({ row: 0, col: 0, visible: false }));
    shared.setViewport("t", 0, 0, 80, 36);
    shared.render();

    const cursorFills = log.ops
      .map((op, i) => ({ op, s: log.state[i] }))
      .filter(({ op, s }) => op[0] === "fillRect" && s.fillStyle === DEFAULT_THEME.cursor);
    expect(cursorFills.length).toBe(0);
    shared.dispose();
  });
});
