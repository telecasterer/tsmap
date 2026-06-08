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
