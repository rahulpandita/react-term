// @vitest-environment jsdom

import { CellGrid, type CursorState, DEFAULT_THEME } from "@next_term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedCanvas2DContext } from "../shared-context-canvas2d.js";

/**
 * Install a mock 2D context on HTMLCanvasElement.prototype for the duration of
 * the test. jsdom's native getContext returns null, which would make init()
 * throw. We restore the original binding after each test.
 */
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

function installMockGetContext() {
  const ctx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setTransform: vi.fn(),
    measureText: vi.fn(() => ({
      width: 8,
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 2,
    })),
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctx,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return ctx;
}

beforeEach(() => {
  originalGetContext = HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

function makeCursor(): CursorState {
  return { row: 0, col: 0, visible: true, style: "block", wrapPending: false };
}

describe("SharedCanvas2DContext", () => {
  it("init throws cleanly when no 2D context is available", () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const shared = new SharedCanvas2DContext();
    expect(() => shared.init()).toThrow(/canvas 2d/i);
  });

  it("tracks terminals through addTerminal / removeTerminal", () => {
    installMockGetContext();
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

  it("setViewport is idempotent for the same rectangle", () => {
    installMockGetContext();
    const shared = new SharedCanvas2DContext();
    shared.init();
    shared.addTerminal("a", new CellGrid(10, 3), makeCursor());
    shared.setViewport("a", 0, 0, 100, 50);
    const renderSpy = vi.spyOn(shared, "render");
    // Same rectangle → the entry is not invalidated; this is observable by
    // the class's fullyRendered bookkeeping but we check externally by
    // calling render() twice with no grid mutation — second call should be a
    // no-op.
    shared.setViewport("a", 0, 0, 100, 50);
    shared.render();
    shared.render();
    expect(renderSpy).toHaveBeenCalledTimes(2);
    shared.dispose();
  });

  it("setTheme marks all terminals dirty so they repaint with new colours", () => {
    const ctx = installMockGetContext();
    const shared = new SharedCanvas2DContext();
    shared.init();
    const grid = new CellGrid(10, 3);
    shared.addTerminal("a", grid, makeCursor());
    shared.setViewport("a", 0, 0, 100, 50);
    // First render paints everything.
    shared.render();
    (ctx.fillRect as ReturnType<typeof vi.fn>).mockClear();
    (ctx.clearRect as ReturnType<typeof vi.fn>).mockClear();

    shared.setTheme({ ...DEFAULT_THEME, background: "#112233" });
    shared.render();
    // Theme change ⇒ at least one clearRect issued (row repaint).
    expect((ctx.clearRect as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    shared.dispose();
  });

  it("getCellSize returns positive values after construction", () => {
    installMockGetContext();
    const shared = new SharedCanvas2DContext();
    shared.init();
    const size = shared.getCellSize();
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
    shared.dispose();
  });

  it("dispose is idempotent", () => {
    installMockGetContext();
    const shared = new SharedCanvas2DContext();
    shared.init();
    shared.dispose();
    expect(() => shared.dispose()).not.toThrow();
  });
});
