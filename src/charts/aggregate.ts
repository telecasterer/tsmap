import type { LotStatsSummary } from '@paulrobins/wafermap/stats';
import type { TestDef, WaferData } from '../types';
import type { BinType, BoxplotDatum, ChartDatum, CorrelationMatrix, HistogramBucket, ScatterPoint, TestOption, TrendDatum, YieldSortBy } from './types';

export function buildYieldData(
  wafers: WaferData[],
  lotSummary: LotStatsSummary,
  sortBy: YieldSortBy,
): ChartDatum[] {
  const data: ChartDatum[] = lotSummary.lotYieldSeries.map(({ waferIndex, yieldPercent }) => {
    const pct = yieldPercent ?? 0;
    return {
      label: wafers[waferIndex]?.waferId ?? `#${waferIndex}`,
      value: pct,
      percent: pct,
      waferIndices: [waferIndex],
    };
  });

  if (sortBy === 'yield') {
    data.sort((a, b) => b.value - a.value);
  } else {
    data.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }
  return data;
}

export function buildBinParetoData(wafers: WaferData[], binType: BinType): ChartDatum[] {
  const counts = new Map<number, { count: number; waferIndices: Set<number> }>();
  let totalDies = 0;

  wafers.forEach((wafer, waferIndex) => {
    for (const die of wafer.results) {
      const bin = binType === 'hbin' ? die.hbin : die.sbin;
      if (bin === undefined) continue;
      totalDies++;
      let entry = counts.get(bin);
      if (!entry) {
        entry = { count: 0, waferIndices: new Set() };
        counts.set(bin, entry);
      }
      entry.count++;
      entry.waferIndices.add(waferIndex);
    }
  });

  const data: ChartDatum[] = Array.from(counts.entries()).map(([bin, { count, waferIndices }]) => ({
    label: `${binType === 'hbin' ? 'HBin' : 'SBin'} ${bin}`,
    value: count,
    percent: totalDies > 0 ? (count / totalDies) * 100 : 0,
    waferIndices: Array.from(waferIndices).sort((a, b) => a - b),
    binCode: bin,
  }));

  data.sort((a, b) => b.value - a.value);
  return data;
}

/** Parametric tests (numeric measurements) available for box-plotting, sorted by test number. */
export function listNumericTests(testDefs: Record<string, TestDef>): TestOption[] {
  return Object.entries(testDefs)
    .filter(([, def]) => def.testType === 'P')
    .map(([key, def]) => ({
      testNumber: Number(key),
      label: def.name ? `${def.name} (#${key})` : `Test ${key}`,
      unit: def.units,
    }))
    .sort((a, b) => a.testNumber - b.testNumber);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Per-wafer five-number summary (min/Q1/median/Q3/max) for one test, for box-plot rendering. */
export function buildTestBoxplotData(wafers: WaferData[], testNumber: number): BoxplotDatum[] {
  return wafers.map((wafer, waferIndex) => {
    const values = wafer.results
      .map(d => d.testValues?.[testNumber])
      .filter((v): v is number => v !== undefined && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (values.length === 0) {
      return { waferIndex, label: wafer.waferId, min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, count: 0 };
    }
    return {
      waferIndex,
      label: wafer.waferId,
      min: values[0],
      q1: quantile(values, 0.25),
      median: quantile(values, 0.5),
      q3: quantile(values, 0.75),
      max: values[values.length - 1],
      count: values.length,
    };
  });
}

/** Per-wafer trend data for one test — median + Q1/Q3 band in lot order. */
export function buildTrendData(wafers: WaferData[], testNumber: number): TrendDatum[] {
  return wafers.map((wafer, waferIndex) => {
    const values = wafer.results
      .map(d => d.testValues?.[testNumber])
      .filter((v): v is number => v !== undefined && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (values.length === 0) {
      return { waferIndex, label: wafer.waferId, median: NaN, q1: NaN, q3: NaN, count: 0 };
    }
    return {
      waferIndex,
      label: wafer.waferId,
      median: quantile(values, 0.5),
      q1: quantile(values, 0.25),
      q3: quantile(values, 0.75),
      count: values.length,
    };
  });
}

/** All die scatter points for two tests across the whole lot. */
export function buildScatterData(wafers: WaferData[], xTest: number, yTest: number): ScatterPoint[] {
  const points: ScatterPoint[] = [];
  for (const wafer of wafers) {
    for (const die of wafer.results) {
      const x = die.testValues?.[xTest];
      const y = die.testValues?.[yTest];
      if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ x, y, hbin: die.hbin });
      }
    }
  }
  return points;
}

/** Pearson correlation matrix for all parametric tests across all dies in the lot.
 *
 *  Running-accumulator algorithm: one die-walk, 6 Float64 accumulators per upper-triangle
 *  pair (count, sumX, sumY, sumXX, sumYY, sumXY). No pair arrays stored — O(N²) memory,
 *  O(N×D + N²) time.
 */
export function buildCorrelationMatrix(wafers: WaferData[], testOptions: TestOption[]): CorrelationMatrix {
  if (testOptions.length < 2) return { tests: testOptions, cells: [] };

  const n = testOptions.length;
  const nums = testOptions.map(t => t.testNumber);
  const pairs = (n * (n - 1)) / 2;

  // Flat typed arrays: 6 accumulators per upper-triangle pair, indexed by pairIndex(xi,yi).
  // pairIndex(xi, yi) for xi < yi: xi*n - xi*(xi+1)/2 + (yi - xi - 1)
  const cnt   = new Float64Array(pairs);
  const sumX  = new Float64Array(pairs);
  const sumY  = new Float64Array(pairs);
  const sumXX = new Float64Array(pairs);
  const sumYY = new Float64Array(pairs);
  const sumXY = new Float64Array(pairs);

  function pairIndex(xi: number, yi: number): number {
    // xi < yi guaranteed at call sites
    return xi * n - ((xi * (xi + 1)) >> 1) + (yi - xi - 1);
  }

  for (const wafer of wafers) {
    for (const die of wafer.results) {
      if (!die.testValues) continue;
      // Read all test values for this die once
      const vals = new Float64Array(n);
      const valid = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const v = die.testValues[nums[i]];
        if (v !== undefined && Number.isFinite(v)) { vals[i] = v; valid[i] = 1; }
      }
      for (let xi = 0; xi < n; xi++) {
        if (!valid[xi]) continue;
        const x = vals[xi];
        for (let yi = xi + 1; yi < n; yi++) {
          if (!valid[yi]) continue;
          const y = vals[yi];
          const pi = pairIndex(xi, yi);
          cnt[pi]++;
          sumX[pi]  += x;
          sumY[pi]  += y;
          sumXX[pi] += x * x;
          sumYY[pi] += y * y;
          sumXY[pi] += x * y;
        }
      }
    }
  }

  function pearsonFromAccumulators(pi: number): number | null {
    const c = cnt[pi];
    if (c < 3) return null;
    const mx = sumX[pi] / c, my = sumY[pi] / c;
    const covXY = sumXY[pi] / c - mx * my;
    const varX  = sumXX[pi] / c - mx * mx;
    const varY  = sumYY[pi] / c - my * my;
    const denom = Math.sqrt(varX * varY);
    return denom === 0 ? null : Math.max(-1, Math.min(1, covXY / denom));
  }

  const cells: CorrelationMatrix['cells'] = [];
  for (let yi = 0; yi < n; yi++) {
    for (let xi = 0; xi < n; xi++) {
      if (xi === yi) { cells.push({ xIndex: xi, yIndex: yi, r: 1 }); continue; }
      const lo = Math.min(xi, yi), hi = Math.max(xi, yi);
      const r = pearsonFromAccumulators(pairIndex(lo, hi));
      cells.push({ xIndex: xi, yIndex: yi, r });
    }
  }
  return { tests: testOptions, cells };
}

/**
 * From a fully-computed correlation matrix, return the top `limit` tests ranked
 * by mean |r| across all their non-diagonal, non-null pairings — i.e. the tests
 * most correlated with *something*. Result is in original test-number order so
 * the matrix axes stay sorted. When the matrix has ≤ limit tests, returns all.
 */
export function topCorrelatedTests(matrix: CorrelationMatrix, limit: number): TestOption[] {
  const n = matrix.tests.length;
  if (n <= limit) return matrix.tests;

  const sumAbsR = new Float64Array(n);
  const count = new Int32Array(n);
  for (const cell of matrix.cells) {
    if (cell.xIndex === cell.yIndex || cell.r === null) continue;
    sumAbsR[cell.xIndex] += Math.abs(cell.r);
    count[cell.xIndex]++;
  }
  const meanAbsR = Array.from({ length: n }, (_, i) => count[i] > 0 ? sumAbsR[i] / count[i] : 0);

  const indices = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => meanAbsR[b] - meanAbsR[a])
    .slice(0, limit)
    .sort((a, b) => a - b); // restore test-number order

  return indices.map(i => matrix.tests[i]);
}

/** Histogram of one test's values across the whole lot, divided into `bucketCount` equal-width buckets.
 *  If limitLow/limitHigh are provided the axis range is expanded to include them so limit lines always draw. */
export function buildTestHistogramData(
  wafers: WaferData[], testNumber: number, bucketCount = 16,
  limitLow?: number, limitHigh?: number,
): HistogramBucket[] {
  const values: number[] = [];
  for (const wafer of wafers) {
    for (const die of wafer.results) {
      const v = die.testValues?.[testNumber];
      if (v !== undefined && Number.isFinite(v)) values.push(v);
    }
  }
  if (values.length === 0) return [];

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const min = limitLow  !== undefined ? Math.min(dataMin, limitLow)  : dataMin;
  const max = limitHigh !== undefined ? Math.max(dataMax, limitHigh) : dataMax;
  const span = max - min || 1;
  const width = span / bucketCount;

  const buckets: HistogramBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    rangeLow: min + i * width,
    rangeHigh: min + (i + 1) * width,
    count: 0,
  }));

  for (const v of values) {
    const index = Math.min(bucketCount - 1, Math.floor((v - min) / width));
    buckets[index].count++;
  }
  return buckets;
}
