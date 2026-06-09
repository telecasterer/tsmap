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

/** Per-wafer five-number summary (min/Q1/median/Q3/max) for one test, for box-plot rendering. */
export function buildTestBoxplotData(lotSummary: LotStatsSummary, wafers: WaferData[], testNumber: number): BoxplotDatum[] {
  return wafers.map((wafer, waferIndex) => {
    const entry = lotSummary.perWaferTestStats?.find(e => e.waferIndex === waferIndex);
    const stats = entry?.tests.find(t => t.testNumber === testNumber);
    if (!stats || stats.count === 0) {
      return { waferIndex, label: wafer.waferId, min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, count: 0 };
    }
    return {
      waferIndex,
      label: wafer.waferId,
      min: stats.min,
      q1: stats.q1,
      median: stats.median,
      q3: stats.q3,
      max: stats.max,
      count: stats.count,
    };
  });
}

/**
 * Per-wafer trend data for one test — median + Q1/Q3 band in lot order.
 * Reads directly from perWaferTestStats when available; falls back to walking die results.
 */
export function buildTrendData(lotSummary: LotStatsSummary, wafers: WaferData[], testNumber: number): TrendDatum[] {
  return wafers.map((wafer, waferIndex) => {
    const entry = lotSummary.perWaferTestStats?.find(e => e.waferIndex === waferIndex);
    const stats = entry?.tests.find(t => t.testNumber === testNumber);
    if (!stats || stats.count === 0) {
      return { waferIndex, label: wafer.waferId, median: NaN, q1: NaN, q3: NaN, count: 0 };
    }
    return { waferIndex, label: wafer.waferId, median: stats.median, q1: stats.q1, q3: stats.q3, count: stats.count };
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

/** Pearson correlation matrix for all parametric tests across all dies in the lot. */
export function buildCorrelationMatrix(wafers: WaferData[], testOptions: TestOption[]): CorrelationMatrix {
  if (testOptions.length < 2) return { tests: testOptions, cells: [] };

  // Collect all values per test in a single pass
  const valueMap = new Map<number, number[]>();
  for (const t of testOptions) valueMap.set(t.testNumber, []);

  for (const wafer of wafers) {
    for (const die of wafer.results) {
      if (!die.testValues) continue;
      for (const t of testOptions) {
        const v = die.testValues[t.testNumber];
        if (v !== undefined && Number.isFinite(v)) valueMap.get(t.testNumber)!.push(v);
      }
    }
  }

  const cells = [];
  const n = testOptions.length;
  for (let yi = 0; yi < n; yi++) {
    for (let xi = 0; xi < n; xi++) {
      if (xi === yi) { cells.push({ xIndex: xi, yIndex: yi, r: 1 }); continue; }
      const xs = valueMap.get(testOptions[xi].testNumber)!;
      const ys = valueMap.get(testOptions[yi].testNumber)!;
      // Pair values from matching die positions by walking wafers again for equal-length pairing
      const paired: [number, number][] = [];
      for (const wafer of wafers) {
        for (const die of wafer.results) {
          const x = die.testValues?.[testOptions[xi].testNumber];
          const y = die.testValues?.[testOptions[yi].testNumber];
          if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) paired.push([x, y]);
        }
      }
      if (paired.length < 3) { cells.push({ xIndex: xi, yIndex: yi, r: null }); continue; }
      const mn = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
      const pxs = paired.map(p => p[0]);
      const pys = paired.map(p => p[1]);
      const mx = mn(pxs), my = mn(pys);
      let num = 0, dx2 = 0, dy2 = 0;
      for (const [px, py] of paired) { num += (px - mx) * (py - my); dx2 += (px - mx) ** 2; dy2 += (py - my) ** 2; }
      const denom = Math.sqrt(dx2 * dy2);
      cells.push({ xIndex: xi, yIndex: yi, r: denom === 0 ? null : Math.max(-1, Math.min(1, num / denom)) });
      void xs; void ys; // suppress unused warning — xs/ys used implicitly via paired loop
    }
  }
  return { tests: testOptions, cells };
}

/** Histogram of one test's values across the whole lot, divided into `bucketCount` equal-width buckets. */
export function buildTestHistogramData(wafers: WaferData[], testNumber: number, bucketCount = 16): HistogramBucket[] {
  const values: number[] = [];
  for (const wafer of wafers) {
    for (const die of wafer.results) {
      const v = die.testValues?.[testNumber];
      if (v !== undefined && Number.isFinite(v)) values.push(v);
    }
  }
  if (values.length === 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
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
