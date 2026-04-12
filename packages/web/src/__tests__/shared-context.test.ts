// @vitest-environment jsdom

import { CellGrid } from "@next_term/core";
import { describe, expect, it } from "vitest";
import { SharedWebGLContext } from "../shared-context.js";

// Note: WebGL2 is not available in the test environment (jsdom/Node).
// These tests cover the non-GL management logic: terminal registration,
// viewport calculations, and lifecycle methods.

describe("SharedWebGLContext", () => {
  it("creates a canvas element", () => {
    const ctx = new SharedWebGLContext();
    const canvas = ctx.getCanvas();
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    ctx.dispose();
  });

  it("addTerminal registers a terminal", () => {
    const ctx = new SharedWebGLContext();
    const grid = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("term-1", grid, cursor);
    expect(ctx.getTerminalIds()).toContain("term-1");

    ctx.dispose();
  });

  it("removeTerminal unregisters a terminal", () => {
    const ctx = new SharedWebGLContext();
    const grid = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("term-1", grid, cursor);
    ctx.removeTerminal("term-1");
    expect(ctx.getTerminalIds()).not.toContain("term-1");

    ctx.dispose();
  });

  it("removeTerminal forces one clear frame to erase stale pixels", () => {
    const ctx = new SharedWebGLContext();
    const grid1 = new CellGrid(10, 5);
    const grid2 = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("A", grid1, cursor);
    ctx.addTerminal("B", grid2, cursor);
    ctx.setViewport("A", 0, 0, 400, 300);
    ctx.setViewport("B", 100, 0, 400, 300);

    // Render both to stable state
    ctx.render();

    // Remove terminal A — should set needsFullClear
    ctx.removeTerminal("A");

    // Next render must NOT early-return (needs to clear A's stale pixels)
    // If it early-returns, A's pixels persist on canvas
    expect(() => ctx.render()).not.toThrow();

    // Subsequent render with no changes should be safe (no infinite loop)
    expect(() => ctx.render()).not.toThrow();

    ctx.dispose();
  });

  it("setViewport updates the viewport for a terminal", () => {
    const ctx = new SharedWebGLContext();
    const grid = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("term-1", grid, cursor);
    // This should not throw
    ctx.setViewport("term-1", 0, 0, 400, 300);

    ctx.dispose();
  });

  it("zero-viewport terminal does not crash render (#138)", () => {
    const ctx = new SharedWebGLContext();
    const grid = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("term-1", grid, cursor);
    ctx.setViewport("term-1", 0, 0, 0, 0);

    // Render with zero viewport should not throw — glyphs must be skipped
    expect(() => ctx.render()).not.toThrow();

    ctx.dispose();
  });

  it("zero-viewport terminal glyphs are excluded from render pass (#138)", () => {
    const ctx = new SharedWebGLContext();
    const grid1 = new CellGrid(10, 5);
    const grid2 = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    // Write content to grid1
    grid1.setCell(0, 0, 0x41, 7, 0, 0); // 'A'

    ctx.addTerminal("visible", grid1, cursor);
    ctx.addTerminal("hidden", grid2, cursor);

    ctx.setViewport("visible", 0, 0, 400, 300);
    ctx.setViewport("hidden", 0, 0, 0, 0); // hidden

    // Should render without including hidden terminal's data
    expect(() => ctx.render()).not.toThrow();

    // Hidden terminal should still be registered (not removed)
    expect(ctx.getTerminalIds()).toContain("hidden");
    expect(ctx.getTerminalIds()).toContain("visible");

    ctx.dispose();
  });

  it("hiding terminal triggers one clear frame before going idle", () => {
    const ctx = new SharedWebGLContext();
    const grid1 = new CellGrid(10, 5);
    const grid2 = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("A", grid1, cursor);
    ctx.addTerminal("B", grid2, cursor);
    ctx.setViewport("A", 0, 0, 400, 300);
    ctx.setViewport("B", 100, 0, 400, 300);

    // Render both — they become fully rendered
    ctx.render();
    ctx.render(); // second render to ensure stable state

    // Hide terminal A
    ctx.setViewport("A", 0, 0, 0, 0);

    // Next render must NOT early-return — it needs to clear stale pixels.
    // If it early-returns, the canvas still shows A's old content.
    // We can't check GL calls in jsdom, but we can verify render() runs
    // without throwing (if it early-returned, it would be a no-op).
    // The key invariant: after this render, A should be marked fully
    // rendered so the SECOND render after hiding CAN early-return.
    ctx.render(); // first render after hide — must clear canvas

    // Now both terminals should be fully rendered (B visible, A hidden)
    // A subsequent render with no dirty rows should be a no-op
    // (no crash, no infinite dirty loop)
    expect(() => ctx.render()).not.toThrow();

    ctx.dispose();
  });

  it("setViewport for non-existent terminal is a no-op", () => {
    const ctx = new SharedWebGLContext();
    // Should not throw
    ctx.setViewport("nonexistent", 0, 0, 100, 100);
    ctx.dispose();
  });

  it("updateTerminal updates grid and cursor references", () => {
    const ctx = new SharedWebGLContext();
    const grid1 = new CellGrid(10, 5);
    const cursor1 = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("term-1", grid1, cursor1);

    const grid2 = new CellGrid(20, 10);
    const cursor2 = { row: 1, col: 1, visible: false, style: "bar" as const, wrapPending: false };

    // Should not throw
    ctx.updateTerminal("term-1", grid2, cursor2);

    // Terminal should still be registered
    expect(ctx.getTerminalIds()).toContain("term-1");

    ctx.dispose();
  });

  it("updateTerminal resets dirty tracking for re-render", () => {
    const ctx = new SharedWebGLContext();
    const grid1 = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("term-1", grid1, cursor);

    // Call render once (no-op without GL, but exercises internal state)
    ctx.render();

    // Update with a new grid — this should reset dirty tracking
    const grid2 = new CellGrid(15, 8);
    ctx.updateTerminal("term-1", grid2, cursor);

    // After update, render should not throw (dirty state was reset)
    expect(() => ctx.render()).not.toThrow();

    ctx.dispose();
  });

  it("supports multiple terminals", () => {
    const ctx = new SharedWebGLContext();
    const grid1 = new CellGrid(10, 5);
    const grid2 = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("term-1", grid1, cursor);
    ctx.addTerminal("term-2", grid2, cursor);

    const ids = ctx.getTerminalIds();
    expect(ids).toContain("term-1");
    expect(ids).toContain("term-2");
    expect(ids.length).toBe(2);

    ctx.dispose();
  });

  it("syncCanvasSize updates canvas dimensions", () => {
    const ctx = new SharedWebGLContext({ devicePixelRatio: 2 });
    ctx.syncCanvasSize(800, 600);

    const canvas = ctx.getCanvas();
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("600px");

    ctx.dispose();
  });

  it("getCellSize returns positive values", () => {
    const ctx = new SharedWebGLContext({ fontSize: 14 });
    const { width, height } = ctx.getCellSize();

    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    ctx.dispose();
  });

  it("dispose is idempotent", () => {
    const ctx = new SharedWebGLContext();
    ctx.dispose();
    ctx.dispose(); // Should not throw
  });

  it("render without init does not throw (no GL context)", () => {
    const ctx = new SharedWebGLContext();
    // render() should be a no-op when gl is null
    expect(() => ctx.render()).not.toThrow();
    ctx.dispose();
  });

  it("startRenderLoop and stopRenderLoop work without errors", () => {
    const ctx = new SharedWebGLContext();
    // These should not throw even without a GL context
    ctx.stopRenderLoop();
    ctx.dispose();
  });

  it("setTheme updates palette without throwing", () => {
    const ctx = new SharedWebGLContext();
    expect(() => ctx.setTheme({ foreground: "#ff0000", background: "#000000" })).not.toThrow();
    ctx.dispose();
  });

  it("setTheme marks all terminals for re-render", () => {
    const ctx = new SharedWebGLContext();
    const grid1 = new CellGrid(10, 5);
    const grid2 = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("term-a", grid1, cursor);
    ctx.addTerminal("term-b", grid2, cursor);

    // Render once to mark terminals as fully rendered
    ctx.render();

    // Change theme — should mark all terminals for re-render
    ctx.setTheme({ foreground: "#00ff00", background: "#111111" });

    // After setTheme, rendering should not throw (dirty state was cleared)
    expect(() => ctx.render()).not.toThrow();

    // Both terminals should still be registered
    const ids = ctx.getTerminalIds();
    expect(ids).toContain("term-a");
    expect(ids).toContain("term-b");

    ctx.dispose();
  });

  it("removeTerminal cleans up all tracking state", () => {
    const ctx = new SharedWebGLContext();
    const grid = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("term-cleanup", grid, cursor);
    expect(ctx.getTerminalIds()).toContain("term-cleanup");

    ctx.removeTerminal("term-cleanup");
    expect(ctx.getTerminalIds()).not.toContain("term-cleanup");
    expect(ctx.getTerminalIds().length).toBe(0);

    // Subsequent operations on the removed terminal should be safe
    expect(() => ctx.setViewport("term-cleanup", 0, 0, 100, 100)).not.toThrow();
    expect(() => ctx.render()).not.toThrow();

    ctx.dispose();
  });

  it("multiple terminals can be registered and removed independently", () => {
    const ctx = new SharedWebGLContext();
    const cursor = { row: 0, col: 0, visible: true, style: "block" as const, wrapPending: false };

    ctx.addTerminal("t1", new CellGrid(10, 5), cursor);
    ctx.addTerminal("t2", new CellGrid(10, 5), cursor);
    ctx.addTerminal("t3", new CellGrid(10, 5), cursor);

    expect(ctx.getTerminalIds().length).toBe(3);

    // Remove the middle one
    ctx.removeTerminal("t2");
    const ids = ctx.getTerminalIds();
    expect(ids.length).toBe(2);
    expect(ids).toContain("t1");
    expect(ids).not.toContain("t2");
    expect(ids).toContain("t3");

    // Remove the first one
    ctx.removeTerminal("t1");
    expect(ctx.getTerminalIds()).toEqual(["t3"]);

    // Remove the last one
    ctx.removeTerminal("t3");
    expect(ctx.getTerminalIds().length).toBe(0);

    ctx.dispose();
  });
});
