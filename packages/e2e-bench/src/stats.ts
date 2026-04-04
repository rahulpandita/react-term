export interface StatsResult {
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
  cv: number;
  q1: number;
  q3: number;
  iqr: number;
  filtered: number[];
  outliers: number[];
  stable: boolean;
}

export function computeStats(values: number[]): StatsResult {
  if (values.length === 0) {
    return {
      mean: 0,
      median: 0,
      stddev: 0,
      min: 0,
      max: 0,
      cv: 0,
      q1: 0,
      q3: 0,
      iqr: 0,
      filtered: [],
      outliers: [],
      stable: false,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  const median = n % 2 === 1 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

  // Q1/Q3: median of lower/upper halves
  const lowerHalf = sorted.slice(0, Math.floor(n / 2));
  const upperHalf = sorted.slice(Math.ceil(n / 2));
  const q1 = medianOf(lowerHalf);
  const q3 = medianOf(upperHalf);
  const iqr = q3 - q1;

  // IQR outlier removal
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  const filtered: number[] = [];
  const outliers: number[] = [];
  for (const v of values) {
    if (v < lowerBound || v > upperBound) {
      outliers.push(v);
    } else {
      filtered.push(v);
    }
  }

  const mean =
    filtered.length > 0
      ? filtered.reduce((a, b) => a + b, 0) / filtered.length
      : values.reduce((a, b) => a + b, 0) / values.length;

  const source = filtered.length > 0 ? filtered : values;
  const variance = source.reduce((sum, v) => sum + (v - mean) ** 2, 0) / source.length;
  const stddev = Math.sqrt(variance);

  const cv = mean !== 0 ? stddev / Math.abs(mean) : 0;

  return {
    mean,
    median,
    stddev,
    min: sorted[0],
    max: sorted[n - 1],
    cv,
    q1,
    q3,
    iqr,
    filtered,
    outliers,
    stable: cv < 0.1,
  };
}

export function medianOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  const n = arr.length;
  return n % 2 === 1 ? arr[Math.floor(n / 2)] : (arr[n / 2 - 1] + arr[n / 2]) / 2;
}
