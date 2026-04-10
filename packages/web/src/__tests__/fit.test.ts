import { afterEach, describe, expect, it } from "vitest";
import { calculateFit } from "../fit.js";

/**
 * Helper to create a mock HTMLElement with a given bounding rect and padding.
 * Installs a global getComputedStyle mock so calculateFit can read padding.
 */
function mockContainer(
  width: number,
  height: number,
  padding: { top?: number; right?: number; bottom?: number; left?: number } = {},
): HTMLElement {
  const el = {
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

  // Install getComputedStyle on globalThis so calculateFit can use it
  (globalThis as Record<string, unknown>).getComputedStyle = () =>
    ({
      paddingTop: `${padding.top ?? 0}px`,
      paddingRight: `${padding.right ?? 0}px`,
      paddingBottom: `${padding.bottom ?? 0}px`,
      paddingLeft: `${padding.left ?? 0}px`,
    }) as unknown as CSSStyleDeclaration;

  return el;
}

describe("calculateFit", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).getComputedStyle;
  });

  it("calculates columns and rows for a normal container", () => {
    const result = calculateFit(mockContainer(800, 600), 8, 16);
    expect(result.cols).toBe(100);
    expect(result.rows).toBe(37);
  });

  it("enforces minimum of 2 cols and 1 row", () => {
    const result = calculateFit(mockContainer(10, 10), 8, 16);
    expect(result.cols).toBeGreaterThanOrEqual(2);
    expect(result.rows).toBeGreaterThanOrEqual(1);
  });

  it("returns 80x24 when width produces Infinity", () => {
    const result = calculateFit(mockContainer(100, 100), 0, 16);
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it("returns 80x24 when height produces Infinity", () => {
    const result = calculateFit(mockContainer(100, 100), 8, 0);
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it("returns 80x24 when both are zero", () => {
    const result = calculateFit(mockContainer(100, 100), 0, 0);
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it("handles very small container gracefully", () => {
    const result = calculateFit(mockContainer(1, 1), 8, 16);
    expect(result.cols).toBe(2); // min cols
    expect(result.rows).toBe(1); // min rows
  });

  it("handles fractional cell sizes", () => {
    const result = calculateFit(mockContainer(805, 601), 8.5, 16.5);
    expect(result.cols).toBe(Math.max(2, Math.floor(805 / 8.5)));
    expect(result.rows).toBe(Math.max(1, Math.floor(601 / 16.5)));
  });

  it("subtracts uniform padding from container dimensions", () => {
    // 350x283 container with 16px padding on all sides → content area 318x251
    const result = calculateFit(
      mockContainer(350, 283, { top: 16, right: 16, bottom: 16, left: 16 }),
      9,
      16,
    );
    // 318/9 = 35.3 → 35 cols, 251/16 = 15.6 → 15 rows
    expect(result.cols).toBe(35);
    expect(result.rows).toBe(15);
  });

  it("subtracts asymmetric padding correctly", () => {
    // 800x600 with padding: 10px top, 20px right, 30px bottom, 40px left
    // content: (800-20-40) x (600-10-30) = 740 x 560
    const result = calculateFit(
      mockContainer(800, 600, { top: 10, right: 20, bottom: 30, left: 40 }),
      8,
      16,
    );
    expect(result.cols).toBe(Math.floor(740 / 8));
    expect(result.rows).toBe(Math.floor(560 / 16));
  });

  it("handles zero padding (no change from bounding rect)", () => {
    const result = calculateFit(mockContainer(800, 600), 8, 16);
    expect(result.cols).toBe(100);
    expect(result.rows).toBe(37);
  });
});
