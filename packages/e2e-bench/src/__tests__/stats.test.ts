import { describe, expect, it } from "vitest";
import { computeStats } from "../stats.js";

describe("computeStats", () => {
  it("returns zeroed result for empty array", () => {
    const result = computeStats([]);
    expect(result.mean).toBe(0);
    expect(result.median).toBe(0);
    expect(result.stddev).toBe(0);
    expect(result.stable).toBe(false);
    expect(result.filtered).toEqual([]);
    expect(result.outliers).toEqual([]);
  });

  it("handles single value", () => {
    const result = computeStats([42]);
    expect(result.mean).toBe(42);
    expect(result.median).toBe(42);
    expect(result.stddev).toBe(0);
    expect(result.min).toBe(42);
    expect(result.max).toBe(42);
    expect(result.cv).toBe(0);
    expect(result.stable).toBe(true);
  });

  it("computes correct median for odd count", () => {
    const result = computeStats([3, 1, 2]);
    expect(result.median).toBe(2);
  });

  it("computes correct median for even count", () => {
    const result = computeStats([4, 1, 3, 2]);
    expect(result.median).toBe(2.5);
  });

  it("all identical values yields zero stddev and stable", () => {
    const result = computeStats([10, 10, 10, 10, 10]);
    expect(result.mean).toBe(10);
    expect(result.stddev).toBe(0);
    expect(result.cv).toBe(0);
    expect(result.stable).toBe(true);
    expect(result.outliers).toEqual([]);
  });

  it("detects outliers via IQR method", () => {
    // 1..10 are tightly grouped; 1000 is an outlier
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1000];
    const result = computeStats(values);
    expect(result.outliers).toContain(1000);
    expect(result.filtered).not.toContain(1000);
    // Mean should be computed from filtered values (without 1000)
    expect(result.mean).toBeCloseTo(5.5, 1);
  });

  it("marks unstable results with high CV", () => {
    // Values with high variance relative to mean
    const result = computeStats([1, 100, 1, 100, 1]);
    expect(result.stable).toBe(false);
    expect(result.cv).toBeGreaterThan(0.1);
  });

  it("marks stable results with low CV", () => {
    const result = computeStats([100, 101, 99, 100, 102, 98]);
    expect(result.stable).toBe(true);
    expect(result.cv).toBeLessThan(0.1);
  });

  it("computes correct Q1/Q3/IQR", () => {
    const result = computeStats([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.q1).toBe(2.5);
    expect(result.q3).toBe(6.5);
    expect(result.iqr).toBe(4);
  });
});
