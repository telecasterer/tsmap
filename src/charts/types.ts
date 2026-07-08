export type ChartKind = 'yield' | 'binPareto' | 'testBoxplot';

export type BinType = 'hbin' | 'sbin';

export type YieldSortBy = 'yield' | 'waferId';

export interface ChartDatum {
  label: string;
  value: number;
  percent: number;
  waferIndices: number[];
  /** Bin code this datum represents — only set for binPareto data, used to drive lotStack drill-down. */
  binCode?: number;
}

export interface ChartSelection {
  kind: ChartKind;
  data: ChartDatum[];
}

/** Five-number summary of one wafer's values for a single test — drives a box-plot row. */
export interface BoxplotDatum {
  /** -1 for a group row (combined mode); the wafer's index otherwise. */
  waferIndex: number;
  /** Set only on a group row (combined mode) — every wafer index pooled into it. */
  waferIndices?: number[];
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  count: number;
}

/** A selectable parametric test, listed in the box-plot test selector. */
export interface TestOption {
  testNumber: number;
  label: string;
  unit?: string;
}

/** One bucket of a test-value histogram — count of dies whose value falls in [rangeLow, rangeHigh). */
export interface HistogramBucket {
  rangeLow: number;
  rangeHigh: number;
  count: number;
}

/** One overlaid series in a faceted histogram — per-group counts over the shared bucket ranges. */
export interface HistogramSeries {
  groupKey: string;
  /** Count per bucket, aligned to the shared `ranges` array. */
  counts: number[];
}

/** Faceted histogram: shared bucket ranges plus one count-series per group. */
export interface HistogramSeriesData {
  /** Shared bucket boundaries — one per bucket, in order. */
  ranges: Array<{ rangeLow: number; rangeHigh: number }>;
  series: HistogramSeries[];
}

/** One bin's clustered bars: a count per group (aligned to the parent's `groups` order). */
export interface BinCluster {
  binCode: number;
  label: string;
  /** Total dies of this bin across all groups — drives pareto ordering. */
  total: number;
  /** Per-group die counts for this bin, aligned to `BinClusterData.groups`. */
  counts: number[];
  /** Per-group wafer indices having this bin, aligned to `groups` (drill-down). */
  waferIndices: number[][];
}

/** Clustered bin pareto: the group list (legend order) plus one cluster per bin. */
export interface BinClusterData {
  groups: string[];
  bins: BinCluster[];
}

/** One die's X/Y test values for a scatter plot. */
export interface ScatterPoint {
  x: number;
  y: number;
  hbin: number | undefined;
  /** Facet group (lot/program/…) this die belongs to — set only by the grouped builder. */
  group?: string;
}

/** Pearson r for a pair of tests — drives the correlation matrix. */
export interface CorrelationCell {
  xIndex: number;
  yIndex: number;
  r: number | null; // null = insufficient data
}

/** Full correlation matrix: ordered test list + NxN cells. */
export interface CorrelationMatrix {
  tests: TestOption[];
  cells: CorrelationCell[];
}
