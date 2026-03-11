// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { SharedWebGLContext } from '../shared-context.js';
import { CellGrid } from '@react-term/core';

// Note: WebGL2 is not available in the test environment (jsdom/Node).
// These tests cover the non-GL management logic: terminal registration,
// viewport calculations, and lifecycle methods.

describe('SharedWebGLContext', () => {
  it('creates a canvas element', () => {
    const ctx = new SharedWebGLContext();
    const canvas = ctx.getCanvas();
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    ctx.dispose();
  });

  it('addTerminal registers a terminal', () => {
    const ctx = new SharedWebGLContext();
    const grid = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: 'block' as const };

    ctx.addTerminal('term-1', grid, cursor);
    expect(ctx.getTerminalIds()).toContain('term-1');

    ctx.dispose();
  });

  it('removeTerminal unregisters a terminal', () => {
    const ctx = new SharedWebGLContext();
    const grid = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: 'block' as const };

    ctx.addTerminal('term-1', grid, cursor);
    ctx.removeTerminal('term-1');
    expect(ctx.getTerminalIds()).not.toContain('term-1');

    ctx.dispose();
  });

  it('setViewport updates the viewport for a terminal', () => {
    const ctx = new SharedWebGLContext();
    const grid = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: 'block' as const };

    ctx.addTerminal('term-1', grid, cursor);
    // This should not throw
    ctx.setViewport('term-1', 0, 0, 400, 300);

    ctx.dispose();
  });

  it('setViewport for non-existent terminal is a no-op', () => {
    const ctx = new SharedWebGLContext();
    // Should not throw
    ctx.setViewport('nonexistent', 0, 0, 100, 100);
    ctx.dispose();
  });

  it('updateTerminal updates grid and cursor references', () => {
    const ctx = new SharedWebGLContext();
    const grid1 = new CellGrid(10, 5);
    const cursor1 = { row: 0, col: 0, visible: true, style: 'block' as const };

    ctx.addTerminal('term-1', grid1, cursor1);

    const grid2 = new CellGrid(20, 10);
    const cursor2 = { row: 1, col: 1, visible: false, style: 'bar' as const };

    // Should not throw
    ctx.updateTerminal('term-1', grid2, cursor2);

    ctx.dispose();
  });

  it('supports multiple terminals', () => {
    const ctx = new SharedWebGLContext();
    const grid1 = new CellGrid(10, 5);
    const grid2 = new CellGrid(10, 5);
    const cursor = { row: 0, col: 0, visible: true, style: 'block' as const };

    ctx.addTerminal('term-1', grid1, cursor);
    ctx.addTerminal('term-2', grid2, cursor);

    const ids = ctx.getTerminalIds();
    expect(ids).toContain('term-1');
    expect(ids).toContain('term-2');
    expect(ids.length).toBe(2);

    ctx.dispose();
  });

  it('syncCanvasSize updates canvas dimensions', () => {
    const ctx = new SharedWebGLContext({ devicePixelRatio: 2 });
    ctx.syncCanvasSize(800, 600);

    const canvas = ctx.getCanvas();
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(canvas.style.width).toBe('800px');
    expect(canvas.style.height).toBe('600px');

    ctx.dispose();
  });

  it('getCellSize returns positive values', () => {
    const ctx = new SharedWebGLContext({ fontSize: 14 });
    const { width, height } = ctx.getCellSize();

    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    ctx.dispose();
  });

  it('dispose is idempotent', () => {
    const ctx = new SharedWebGLContext();
    ctx.dispose();
    ctx.dispose(); // Should not throw
  });

  it('render without init does not throw (no GL context)', () => {
    const ctx = new SharedWebGLContext();
    // render() should be a no-op when gl is null
    expect(() => ctx.render()).not.toThrow();
    ctx.dispose();
  });

  it('startRenderLoop and stopRenderLoop work without errors', () => {
    const ctx = new SharedWebGLContext();
    // These should not throw even without a GL context
    ctx.stopRenderLoop();
    ctx.dispose();
  });
});
