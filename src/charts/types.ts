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
  waferIndex: number;
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

/** One die's X/Y test values for a scatter plot. */
export interface ScatterPoint {
  x: number;
  y: number;
  hbin: number | undefined;
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
