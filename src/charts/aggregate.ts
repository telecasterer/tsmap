import type { LotStatsSummary } from '@paulrobins/wafermap/stats';
import type { TestDef, WaferData } from '../types';
import type { BinType, BoxplotDatum, ChartDatum, HistogramBucket, TestOption, YieldSortBy } from './types';

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

/** Linear-interpolation quantile (Excel/R-7 method) over a pre-sorted array. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
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
