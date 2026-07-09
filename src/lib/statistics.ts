// Statistical functions for metrics analysis

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

export function median(values: number[], excludeZeros: boolean = false): number {
  if (values.length === 0) return 0;

  let filtered = excludeZeros ? values.filter((v) => v > 0) : values;
  if (filtered.length === 0) return 0;

  const sorted = [...filtered].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;

  const avg = mean(values);
  const squareDiffs = values.map((value) => Math.pow(value - avg, 2));
  const avgSquareDiff = mean(squareDiffs);

  return Math.sqrt(avgSquareDiff);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (p < 0 || p > 100) throw new Error('Percentile must be between 0 and 100');

  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) return sorted[lower];
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export interface GaussianPoint {
  x: number;
  y: number;
}

export function gaussianDistribution(
  meanVal: number,
  stdDevVal: number,
  points: number = 100
): GaussianPoint[] {
  if (stdDevVal === 0 || points < 2) return [];

  const minX = Math.max(0, meanVal - 3 * stdDevVal);
  const maxX = meanVal + 3 * stdDevVal;
  const step = (maxX - minX) / (points - 1);

  const result: GaussianPoint[] = [];
  const coefficient = 1 / (stdDevVal * Math.sqrt(2 * Math.PI));

  for (let i = 0; i < points; i++) {
    const x = minX + i * step;
    const exponent = -Math.pow(x - meanVal, 2) / (2 * Math.pow(stdDevVal, 2));
    const y = coefficient * Math.exp(exponent);
    result.push({ x, y });
  }

  return result;
}

export interface StatsSummary {
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
  p90: number;
  p95: number;
  count: number;
}

export function calculateStats(values: number[], excludeZeros: boolean = false): StatsSummary {
  const filtered = excludeZeros ? values.filter((v) => v > 0) : values;

  if (filtered.length === 0) {
    return {
      mean: 0,
      median: 0,
      stdDev: 0,
      min: 0,
      max: 0,
      p25: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      count: 0,
    };
  }

  const sorted = [...filtered].sort((a, b) => a - b);

  return {
    mean: mean(filtered),
    median: median(filtered),
    stdDev: stdDev(filtered),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p25: percentile(filtered, 25),
    p75: percentile(filtered, 75),
    p90: percentile(filtered, 90),
    p95: percentile(filtered, 95),
    count: filtered.length,
  };
}

export function isVolatile(stdDevVal: number, medianVal: number): boolean {
  if (medianVal === 0) return false;
  return stdDevVal > medianVal * 1.5;
}

export function isStable(stdDevVal: number, medianVal: number): boolean {
  if (medianVal === 0) return true;
  return stdDevVal < medianVal * 0.5;
}

export function calculateGap(meanVal: number, medianVal: number): number {
  return meanVal - medianVal;
}

export function hasOutliers(gap: number): boolean {
  return Math.abs(gap) > 0.5;
}
