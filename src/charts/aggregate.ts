import type { LotStatsSummary } from '@paulrobins/wafermap/stats';
import type { TestDef, WaferData } from '../types';
import type { BinType, BinClusterData, BoxplotDatum, ChartDatum, CorrelationMatrix, HistogramBucket, HistogramSeriesData, ScatterPoint, TestOption, YieldSortBy } from './types';

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

/**
 * Combined yield: one bar per group, pooling the group's wafers. The pooled
 * yield is the die-count-weighted mean of per-wafer yields — exact for the
 * standard pass/total definition (Σ pass / Σ total = Σ(yield·dies)/Σ dies).
 * `waferIndices` lists every wafer in the group (drives drill-down to open all).
 */
export function buildYieldDataCombined(
  wafers: WaferData[],
  lotSummary: LotStatsSummary,
  sortBy: YieldSortBy,
  groupBy: (wafer: WaferData) => string | undefined,
): ChartDatum[] {
  const groups = new Map<string, { weighted: number; dies: number; waferIndices: number[] }>();
  const order: string[] = [];
  for (const { waferIndex, yieldPercent } of lotSummary.lotYieldSeries) {
    const w = wafers[waferIndex];
    if (!w) continue;
    const key = groupBy(w);
    if (key === undefined) continue;
    let g = groups.get(key);
    if (!g) { g = { weighted: 0, dies: 0, waferIndices: [] }; groups.set(key, g); order.push(key); }
    const dies = w.results.length;
    g.weighted += (yieldPercent ?? 0) * dies;
    g.dies += dies;
    g.waferIndices.push(waferIndex);
  }

  // No groupKey: each row already *is* a group, so the chart renders as a plain
  // per-group bar list (the label is the group name) — no redundant headers.
  const data: ChartDatum[] = order.map(key => {
    const g = groups.get(key)!;
    const pct = g.dies > 0 ? g.weighted / g.dies : 0;
    return { label: key, value: pct, percent: pct, waferIndices: g.waferIndices };
  });

  if (sortBy === 'yield') data.sort((a, b) => b.value - a.value);
  else data.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
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

/**
 * Combined bin pareto as clustered bars: one cluster per bin, holding a count
 * per group (aligned to the returned `groups` order, which is the legend). Bins
 * are pareto-ordered (largest total first). Drives a side-by-side clustered bar
 * chart — used only in combined mode; per-wafer mode keeps the plain pareto.
 */
export function buildBinClusterData(
  wafers: WaferData[],
  binType: BinType,
  groupBy: (wafer: WaferData) => string | undefined,
): BinClusterData {
  const groupOrder: string[] = [];
  const groupIndex = new Map<string, number>();
  // bin -> { total, counts[], waferIndexSets[] } aligned to groupOrder.
  const bins = new Map<number, { total: number; counts: number[]; sets: Set<number>[] }>();
  const binOrder: number[] = [];

  const ensureGroup = (g: string): number => {
    let i = groupIndex.get(g);
    if (i === undefined) { i = groupOrder.length; groupIndex.set(g, i); groupOrder.push(g); }
    return i;
  };

  wafers.forEach((wafer, waferIndex) => {
    const group = groupBy(wafer);
    if (group === undefined) return;
    const gi = ensureGroup(group);
    for (const die of wafer.results) {
      const bin = binType === 'hbin' ? die.hbin : die.sbin;
      if (bin === undefined) continue;
      let b = bins.get(bin);
      if (!b) { b = { total: 0, counts: [], sets: [] }; bins.set(bin, b); binOrder.push(bin); }
      b.total++;
      b.counts[gi] = (b.counts[gi] ?? 0) + 1;
      (b.sets[gi] ??= new Set()).add(waferIndex);
    }
  });

  binOrder.sort((a, b) => bins.get(b)!.total - bins.get(a)!.total);
  const nGroups = groupOrder.length;

  const binsOut = binOrder.map(bin => {
    const b = bins.get(bin)!;
    const counts = Array.from({ length: nGroups }, (_, i) => b.counts[i] ?? 0);
    const waferIndices = Array.from({ length: nGroups }, (_, i) =>
      b.sets[i] ? Array.from(b.sets[i]).sort((x, y) => x - y) : []);
    return {
      binCode: bin,
      label: `${binType === 'hbin' ? 'HBin' : 'SBin'} ${bin}`,
      total: b.total,
      counts,
      waferIndices,
    };
  });

  return { groups: groupOrder, bins: binsOut };
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

/**
 * Combined boxplot: one box per group, pooling every die of the group's wafers
 * into a single five-number summary for `testNumber`. `waferIndex` is set to -1
 * (a group is not a single wafer); `waferIndices` carries every wafer pooled
 * into the group (drives drill-down to a per-wafer detail view); `label` is
 * the group key.
 */
export function buildTestBoxplotDataCombined(
  wafers: WaferData[],
  testNumber: number,
  groupBy: (wafer: WaferData) => string | undefined,
): BoxplotDatum[] {
  const groups = new Map<string, { values: number[]; waferIndices: number[] }>();
  const order: string[] = [];
  wafers.forEach((wafer, waferIndex) => {
    const key = groupBy(wafer);
    if (key === undefined) return;
    let g = groups.get(key);
    if (!g) { g = { values: [], waferIndices: [] }; groups.set(key, g); order.push(key); }
    g.waferIndices.push(waferIndex);
    for (const die of wafer.results) {
      const v = die.testValues?.[testNumber];
      if (v !== undefined && Number.isFinite(v)) g.values.push(v);
    }
  });

  return order.map(key => {
    const g = groups.get(key)!;
    const values = g.values.sort((a, b) => a - b);
    if (values.length === 0) {
      return { waferIndex: -1, waferIndices: g.waferIndices, label: key, min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, count: 0 };
    }
    return {
      waferIndex: -1,
      waferIndices: g.waferIndices,
      label: key,
      min: values[0],
      q1: quantile(values, 0.25),
      median: quantile(values, 0.5),
      q3: quantile(values, 0.75),
      max: values[values.length - 1],
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

/**
 * Scatter points tagged with their facet group, for colour-by-group scatter
 * (group replaces hard-bin colour). Wafers whose group is undefined are skipped.
 */
export function buildScatterDataGrouped(
  wafers: WaferData[], xTest: number, yTest: number,
  groupBy: (wafer: WaferData) => string | undefined,
): ScatterPoint[] {
  const points: ScatterPoint[] = [];
  for (const wafer of wafers) {
    const group = groupBy(wafer);
    if (group === undefined) continue;
    for (const die of wafer.results) {
      const x = die.testValues?.[xTest];
      const y = die.testValues?.[yTest];
      if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ x, y, hbin: die.hbin, group });
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

export interface CorrelationSummary {
  /** Filtered matrix — tests trimmed to [minTests, maxTests] by significance. */
  matrix: CorrelationMatrix;
  /** Upper-triangle pairs with |r| ≥ 0.7 (across the full input matrix). */
  strongPairs: number;
  /** Upper-triangle pairs with 0.4 ≤ |r| < 0.7 (across the full input matrix). */
  moderatePairs: number;
  /** Upper-triangle pairs with |r| < threshold that were excluded from display. */
  hiddenWeakPairs: number;
  /** Strongest pair by |r|, or null if no non-null off-diagonal cells exist. */
  strongestPair: { xLabel: string; yLabel: string; r: number } | null;
}

/**
 * Filter a correlation matrix to tests involved in significant pairs, clamped to
 * [minTests, maxTests]. Pairs are ranked by |r|; the threshold gates which pairs
 * count as "significant" for display selection, but all pair counts are computed
 * over the full input matrix for the summary line. Original test-number order is
 * preserved so matrix axes stay sorted.
 */
export function filterCorrelationMatrix(
  matrix: CorrelationMatrix,
  { threshold = 0.3, minTests = 6, maxTests = 20 }: { threshold?: number; minTests?: number; maxTests?: number } = {},
): CorrelationSummary {
  // Collect upper-triangle pairs with their |r|
  type Pair = { xi: number; yi: number; absR: number };
  const allPairs: Pair[] = [];
  let strongPairs = 0, moderatePairs = 0;
  let strongestPair: CorrelationSummary['strongestPair'] = null;

  for (const cell of matrix.cells) {
    if (cell.xIndex >= cell.yIndex || cell.r === null) continue;
    const absR = Math.abs(cell.r);
    allPairs.push({ xi: cell.xIndex, yi: cell.yIndex, absR });
    if (strongestPair === null || absR > Math.abs(strongestPair.r)) {
      strongestPair = { xLabel: matrix.tests[cell.xIndex].label, yLabel: matrix.tests[cell.yIndex].label, r: cell.r };
    }
  }

  // Sort pairs by |r| descending to pick the most significant for display
  allPairs.sort((a, b) => b.absR - a.absR);

  // Grow the display test set by adding tests from pairs, most significant first,
  // until we reach maxTests or exhaust significant pairs (|r| ≥ threshold).
  // Then pad with the next-best pairs until minTests is reached.
  const displayTestIndices = new Set<number>();

  for (const { xi, yi, absR } of allPairs) {
    const belowThreshold = absR < threshold;
    if (displayTestIndices.size >= maxTests) continue;
    if (belowThreshold && displayTestIndices.size >= minTests) continue;
    displayTestIndices.add(xi);
    if (displayTestIndices.size < maxTests) displayTestIndices.add(yi);
  }

  // Fallback: when too few pairs have a computable r (e.g. a single low-variance
  // group restricted from a multi-lot load — within-lot spread can be ~0, so
  // Pearson is undefined), still show the first tests so the matrix renders with
  // explicit blank cells rather than collapsing to nothing. Without this a group
  // with no significant pairs shows an empty grid that reads as "broken".
  if (displayTestIndices.size < Math.min(minTests, matrix.tests.length)) {
    for (let i = 0; i < matrix.tests.length && displayTestIndices.size < Math.min(maxTests, minTests, matrix.tests.length); i++) {
      displayTestIndices.add(i);
    }
  }

  // Sort display tests by mean |r| descending so the most correlated tests cluster top-left
  const sortedIndices = (() => {
    const indices = Array.from(displayTestIndices);
    const sumR = new Map<number, number>();
    const cnt  = new Map<number, number>();
    for (const { xi, yi, absR } of allPairs) {
      if (!displayTestIndices.has(xi) || !displayTestIndices.has(yi)) continue;
      sumR.set(xi, (sumR.get(xi) ?? 0) + absR);
      sumR.set(yi, (sumR.get(yi) ?? 0) + absR);
      cnt.set(xi,  (cnt.get(xi)  ?? 0) + 1);
      cnt.set(yi,  (cnt.get(yi)  ?? 0) + 1);
    }
    const meanR = (i: number) => (cnt.get(i) ?? 0) > 0 ? sumR.get(i)! / cnt.get(i)! : 0;
    return indices.sort((a, b) => meanR(b) - meanR(a));
  })();
  const displayTests = sortedIndices.map(i => matrix.tests[i]);

  // Remap cells to new indices
  const newIndexOf = new Map(sortedIndices.map((origI, newI) => [origI, newI]));
  const displayTestNums = new Set(displayTests.map(t => t.testNumber));
  const trimmedCells = matrix.cells
    .filter(c => displayTestNums.has(matrix.tests[c.xIndex].testNumber) &&
                 displayTestNums.has(matrix.tests[c.yIndex].testNumber))
    .map(c => ({ xIndex: newIndexOf.get(c.xIndex)!, yIndex: newIndexOf.get(c.yIndex)!, r: c.r }));

  // Count pair strengths across displayed tests only, so the summary is coherent with what's shown
  let hiddenWeakPairs = 0;
  for (const { xi, yi, absR } of allPairs) {
    const inDisplay = displayTestIndices.has(xi) && displayTestIndices.has(yi);
    if (inDisplay) {
      if (absR >= 0.7) strongPairs++;
      else if (absR >= 0.4) moderatePairs++;
    } else if (absR < threshold) {
      hiddenWeakPairs++;
    }
  }

  return {
    matrix: { tests: displayTests, cells: trimmedCells },
    strongPairs,
    moderatePairs,
    hiddenWeakPairs,
    strongestPair,
  };
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

  let dataMin = values[0], dataMax = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < dataMin) dataMin = values[i];
    if (values[i] > dataMax) dataMax = values[i];
  }
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

/**
 * Faceted histogram: one count-series per group over a *shared* set of buckets,
 * so the series overlay and compare directly. The bucket range spans every
 * group's dies (and the limits when given) so all series align on one axis.
 * Groups are returned in first-seen order; empty groups are omitted.
 */
export function buildTestHistogramSeries(
  wafers: WaferData[], testNumber: number,
  groupBy: (wafer: WaferData) => string | undefined,
  bucketCount = 16, limitLow?: number, limitHigh?: number,
): HistogramSeriesData {
  // Pass 1: collect each group's values and the global min/max.
  const byGroup = new Map<string, number[]>();
  const order: string[] = [];
  let dataMin = Infinity, dataMax = -Infinity;
  for (const wafer of wafers) {
    const key = groupBy(wafer);
    if (key === undefined) continue;
    let vals = byGroup.get(key);
    if (!vals) { vals = []; byGroup.set(key, vals); order.push(key); }
    for (const die of wafer.results) {
      const v = die.testValues?.[testNumber];
      if (v !== undefined && Number.isFinite(v)) {
        vals.push(v);
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
    }
  }
  const nonEmpty = order.filter(k => byGroup.get(k)!.length > 0);
  if (nonEmpty.length === 0) return { ranges: [], series: [] };

  const min = limitLow  !== undefined ? Math.min(dataMin, limitLow)  : dataMin;
  const max = limitHigh !== undefined ? Math.max(dataMax, limitHigh) : dataMax;
  const span = max - min || 1;
  const width = span / bucketCount;

  const ranges = Array.from({ length: bucketCount }, (_, i) => ({
    rangeLow: min + i * width,
    rangeHigh: min + (i + 1) * width,
  }));

  const series = nonEmpty.map(groupKey => {
    const counts = new Array(bucketCount).fill(0);
    for (const v of byGroup.get(groupKey)!) {
      const index = Math.min(bucketCount - 1, Math.floor((v - min) / width));
      counts[index]++;
    }
    return { groupKey, counts };
  });

  return { ranges, series };
}
