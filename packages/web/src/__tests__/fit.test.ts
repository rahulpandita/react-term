import { describe, it, expect } from 'vitest';
import { calculateFit } from '../fit.js';

/**
 * Helper to create a mock HTMLElement with a given bounding rect.
 */
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

describe('calculateFit', () => {
  it('calculates columns and rows for a normal container', () => {
    const result = calculateFit(mockContainer(800, 600), 8, 16);
    expect(result.cols).toBe(100);
    expect(result.rows).toBe(37);
  });

  it('enforces minimum of 2 cols and 1 row', () => {
    const result = calculateFit(mockContainer(10, 10), 8, 16);
    expect(result.cols).toBeGreaterThanOrEqual(2);
    expect(result.rows).toBeGreaterThanOrEqual(1);
  });

  it('returns 80x24 when width produces Infinity', () => {
    const result = calculateFit(mockContainer(100, 100), 0, 16);
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it('returns 80x24 when height produces Infinity', () => {
    const result = calculateFit(mockContainer(100, 100), 8, 0);
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it('returns 80x24 when both are zero', () => {
    const result = calculateFit(mockContainer(100, 100), 0, 0);
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it('handles very small container gracefully', () => {
    const result = calculateFit(mockContainer(1, 1), 8, 16);
    expect(result.cols).toBe(2); // min cols
    expect(result.rows).toBe(1); // min rows
  });

  it('handles fractional cell sizes', () => {
    const result = calculateFit(mockContainer(805, 601), 8.5, 16.5);
    expect(result.cols).toBe(Math.max(2, Math.floor(805 / 8.5)));
    expect(result.rows).toBe(Math.max(1, Math.floor(601 / 16.5)));
  });
});
