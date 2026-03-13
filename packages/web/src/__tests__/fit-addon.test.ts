import { describe, expect, it } from "vitest";
import { FitAddon } from "../addons/fit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockContainer(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON() {},
    }),
  } as unknown as HTMLElement;
}

function createMockTerminal(
  cols: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
  container: HTMLElement,
) {
  let currentCols = cols;
  let currentRows = rows;

  return {
    get cols() {
      return currentCols;
    },
    get rows() {
      return currentRows;
    },
    get element() {
      return container;
    },
    getCellSize: () => ({ width: cellWidth, height: cellHeight }),
    resize(c: number, r: number) {
      currentCols = c;
      currentRows = r;
    },
  };
}

// ---------------------------------------------------------------------------
// FitAddon
// ---------------------------------------------------------------------------

describe("FitAddon", () => {
  it("proposeDimensions returns correct values", () => {
    const container = mockContainer(800, 600);
    const terminal = createMockTerminal(80, 24, 8, 16, container);
    const addon = new FitAddon();
    addon.activate(terminal as any);

    const dims = addon.proposeDimensions();
    expect(dims).not.toBeNull();
    expect(dims?.cols).toBe(100); // 800 / 8
    expect(dims?.rows).toBe(37); // floor(600 / 16)
  });

  it("proposeDimensions returns null before activation", () => {
    const addon = new FitAddon();
    expect(addon.proposeDimensions()).toBeNull();
  });

  it("proposeDimensions returns null when cell size is zero", () => {
    const container = mockContainer(800, 600);
    const terminal = createMockTerminal(80, 24, 0, 0, container);
    const addon = new FitAddon();
    addon.activate(terminal as any);

    expect(addon.proposeDimensions()).toBeNull();
  });

  it("fit calls resize on terminal", () => {
    const container = mockContainer(800, 600);
    const terminal = createMockTerminal(80, 24, 8, 16, container);
    const addon = new FitAddon();
    addon.activate(terminal as any);

    addon.fit();
    expect(terminal.cols).toBe(100);
    expect(terminal.rows).toBe(37);
  });

  it("fit does not resize when dimensions match", () => {
    const container = mockContainer(640, 384);
    // 640/8 = 80 cols, 384/16 = 24 rows — same as current
    const terminal = createMockTerminal(80, 24, 8, 16, container);
    const addon = new FitAddon();
    addon.activate(terminal as any);

    addon.fit();
    // Should remain the same (no resize called)
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
  });

  it("dispose cleans up", () => {
    const container = mockContainer(800, 600);
    const terminal = createMockTerminal(80, 24, 8, 16, container);
    const addon = new FitAddon();
    addon.activate(terminal as any);

    addon.dispose();
    expect(addon.proposeDimensions()).toBeNull();
  });
});
