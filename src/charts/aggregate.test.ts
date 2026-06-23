import { describe, it, expect } from 'vitest';
import { buildBinParetoData, buildBinClusterData, buildYieldDataCombined, buildTestBoxplotData, buildTestBoxplotDataCombined, buildTestHistogramData, buildTestHistogramSeries, buildScatterData, buildScatterDataGrouped, buildCorrelationMatrix, filterCorrelationMatrix, listNumericTests } from './aggregate';
import type { WaferData } from '../types';

// ── helpers ───────────────────────────────────────────────────────────────────

function wafer(id: string, dies: Array<{ hbin?: number; sbin?: number; testValues?: Record<number, number> }>): WaferData {
  return {
    waferId: id,
    results: dies.map((d, i) => ({ x: i, y: 0, ...d })),
  };
}

// ── listNumericTests ──────────────────────────────────────────────────────────

describe('listNumericTests', () => {
  it('returns only parametric (P) tests', () => {
    const defs = {
      '1': { name: 'A', testType: 'P' as const },
      '2': { name: 'B', testType: 'F' as const },
      '3': { name: 'C', testType: 'P' as const },
    };
    const result = listNumericTests(defs);
    expect(result.map(t => t.testNumber)).toEqual([1, 3]);
  });

  it('sorts by test number ascending', () => {
    const defs = {
      '300': { name: 'C', testType: 'P' as const },
      '100': { name: 'A', testType: 'P' as const },
      '200': { name: 'B', testType: 'P' as const },
    };
    expect(listNumericTests(defs).map(t => t.testNumber)).toEqual([100, 200, 300]);
  });

  it('formats label with name and number', () => {
    const defs = { '42': { name: 'Vt', testType: 'P' as const } };
    expect(listNumericTests(defs)[0].label).toBe('Vt (#42)');
  });

  it('formats label as "Test N" when name is empty', () => {
    const defs = { '42': { name: '', testType: 'P' as const } };
    expect(listNumericTests(defs)[0].label).toBe('Test 42');
  });

  it('includes unit', () => {
    const defs = { '1': { name: 'X', testType: 'P' as const, units: 'mA' } };
    expect(listNumericTests(defs)[0].unit).toBe('mA');
  });

  it('returns empty array for empty input', () => {
    expect(listNumericTests({})).toEqual([]);
  });
});

// ── buildBinParetoData ────────────────────────────────────────────────────────

describe('buildBinParetoData', () => {
  it('counts hard bins across wafers', () => {
    const wafers = [
      wafer('W1', [{ hbin: 1 }, { hbin: 1 }, { hbin: 2 }]),
      wafer('W2', [{ hbin: 1 }, { hbin: 3 }]),
    ];
    const result = buildBinParetoData(wafers, 'hbin');
    const bin1 = result.find(d => d.binCode === 1)!;
    expect(bin1.value).toBe(3);
  });

  it('sorts by count descending', () => {
    const wafers = [wafer('W1', [{ hbin: 1 }, { hbin: 2 }, { hbin: 2 }, { hbin: 3 }])];
    const result = buildBinParetoData(wafers, 'hbin');
    expect(result[0].binCode).toBe(2);
  });

  it('calculates correct percentages', () => {
    const wafers = [wafer('W1', [{ hbin: 1 }, { hbin: 1 }, { hbin: 2 }, { hbin: 2 }])];
    const result = buildBinParetoData(wafers, 'hbin');
    for (const d of result) expect(d.percent).toBeCloseTo(50);
  });

  it('tracks which wafer indices a bin appears on', () => {
    const wafers = [
      wafer('W1', [{ hbin: 1 }]),
      wafer('W2', [{ hbin: 2 }]),
      wafer('W3', [{ hbin: 1 }]),
    ];
    const result = buildBinParetoData(wafers, 'hbin');
    const bin1 = result.find(d => d.binCode === 1)!;
    expect(bin1.waferIndices).toEqual([0, 2]);
  });

  it('uses soft bins when binType is sbin', () => {
    const wafers = [wafer('W1', [{ hbin: 1, sbin: 10 }])];
    const result = buildBinParetoData(wafers, 'sbin');
    expect(result[0].binCode).toBe(10);
    expect(result[0].label).toContain('SBin');
  });

  it('returns empty array for empty wafers', () => {
    expect(buildBinParetoData([], 'hbin')).toEqual([]);
  });

  it('skips dies with no bin value', () => {
    const wafers = [wafer('W1', [{ hbin: 1 }, {}])];
    const result = buildBinParetoData(wafers, 'hbin');
    expect(result[0].value).toBe(1);
  });
});

// ── buildTestBoxplotData ──────────────────────────────────────────────────────

describe('buildTestBoxplotData', () => {
  it('computes five-number summary from die data', () => {
    const wafers = [wafer('W1', [1, 2, 3, 4, 5].map(v => ({ testValues: { 1: v } })))];
    const [r] = buildTestBoxplotData(wafers, 1);
    expect(r.min).toBe(1);
    expect(r.max).toBe(5);
    expect(r.median).toBe(3);
    expect(r.count).toBe(5);
  });

  it('returns NaN stats when test absent for that wafer', () => {
    const wafers = [wafer('W1', [{ testValues: { 2: 1.0 } }])];
    const [r] = buildTestBoxplotData(wafers, 1);
    expect(r.count).toBe(0);
    expect(Number.isNaN(r.min)).toBe(true);
    expect(Number.isNaN(r.median)).toBe(true);
  });

  it('returns NaN stats when wafer has no dies', () => {
    const wafers = [wafer('W1', [])];
    const [r] = buildTestBoxplotData(wafers, 1);
    expect(r.count).toBe(0);
    expect(Number.isNaN(r.min)).toBe(true);
  });

  it('returns one datum per wafer', () => {
    const wafers = [
      wafer('W1', [{ testValues: { 1: 1 } }]),
      wafer('W2', [{ testValues: { 1: 2 } }]),
      wafer('W3', [{ testValues: { 1: 3 } }]),
    ];
    expect(buildTestBoxplotData(wafers, 1)).toHaveLength(3);
  });

  it('labels datum with wafer ID', () => {
    const wafers = [wafer('LOT-W3', [{ testValues: { 1: 1 } }])];
    expect(buildTestBoxplotData(wafers, 1)[0].label).toBe('LOT-W3');
  });
});

// ── combined (aggregate-per-group) builders ─────────────────────────────────────

describe('buildYieldDataCombined', () => {
  it('pools wafers per group as a die-count-weighted mean yield', () => {
    // Lot A: W0 80% over 10 dies, W1 90% over 30 dies → (80*10+90*30)/40 = 87.5
    // Lot B: W2 50% over 20 dies → 50
    const wafers = [
      wafer('W0', Array(10).fill({ hbin: 1 })),
      wafer('W1', Array(30).fill({ hbin: 1 })),
      wafer('W2', Array(20).fill({ hbin: 1 })),
    ];
    const lotSummary = {
      lotYieldSeries: [
        { waferIndex: 0, yieldPercent: 80 },
        { waferIndex: 1, yieldPercent: 90 },
        { waferIndex: 2, yieldPercent: 50 },
      ],
    } as unknown as Parameters<typeof buildYieldDataCombined>[1];
    const groupBy = (w: WaferData) => (w.waferId === 'W2' ? 'B' : 'A');

    const data = buildYieldDataCombined(wafers, lotSummary, 'waferId', groupBy);
    const byLabel = Object.fromEntries(data.map(d => [d.label, d]));
    expect(byLabel.A.value).toBeCloseTo(87.5, 5);
    expect(byLabel.B.value).toBe(50);
    // group A row covers both its wafers (drill-down opens all)
    expect(byLabel.A.waferIndices).toEqual([0, 1]);
  });
});

describe('buildBinClusterData', () => {
  it('returns pareto-ordered bins each with per-group counts aligned to groups', () => {
    // HBin 1: A=3 (W0:2,W1:1), B=1 (W2) → total 4. HBin 4: A=1 (W1), B=2 (W2) → total 3.
    const wafers = [
      wafer('W0', [{ hbin: 1 }, { hbin: 1 }]),
      wafer('W1', [{ hbin: 1 }, { hbin: 4 }]),
      wafer('W2', [{ hbin: 1 }, { hbin: 4 }, { hbin: 4 }]),
    ];
    const groupBy = (w: WaferData) => (w.waferId === 'W2' ? 'B' : 'A');
    const out = buildBinClusterData(wafers, 'hbin', groupBy);

    expect(out.groups).toEqual(['A', 'B']);          // first-seen order = legend
    expect(out.bins.map(b => b.binCode)).toEqual([1, 4]); // pareto: bin 1 (4) before bin 4 (3)

    const bin1 = out.bins[0];
    expect(bin1.total).toBe(4);
    expect(bin1.counts).toEqual([3, 1]);             // [A, B] aligned to groups
    expect(bin1.waferIndices[0]).toEqual([0, 1]);    // A's wafers with bin 1

    const bin4 = out.bins[1];
    expect(bin4.counts).toEqual([1, 2]);             // A=1, B=2
  });

  it('ignores wafers whose group is undefined', () => {
    const wafers = [wafer('W0', [{ hbin: 1 }]), wafer('W1', [{ hbin: 1 }])];
    const groupBy = (w: WaferData) => (w.waferId === 'W0' ? 'A' : undefined);
    const out = buildBinClusterData(wafers, 'hbin', groupBy);
    expect(out.groups).toEqual(['A']);
    expect(out.bins[0].counts).toEqual([1]);
  });

  it('returns empty groups/bins when nothing is grouped', () => {
    const out = buildBinClusterData([wafer('W0', [{ hbin: 1 }])], 'hbin', () => undefined);
    expect(out.groups).toEqual([]);
    expect(out.bins).toEqual([]);
  });
});

describe('buildTestHistogramSeries', () => {
  it('returns one series per non-empty group over shared bucket ranges', () => {
    const wafers = [
      wafer('W0', [{ testValues: { 1: 0 } }, { testValues: { 1: 10 } }]),  // group A
      wafer('W1', [{ testValues: { 1: 5 } }]),                              // group B
    ];
    const groupBy = (w: WaferData) => (w.waferId === 'W0' ? 'A' : 'B');
    const out = buildTestHistogramSeries(wafers, 1, groupBy, 10);
    // shared range spans both groups' data (0..10)
    expect(out.ranges[0].rangeLow).toBe(0);
    expect(out.ranges[out.ranges.length - 1].rangeHigh).toBe(10);
    expect(out.series.map(s => s.groupKey)).toEqual(['A', 'B']);
    // every series has one count per bucket
    for (const s of out.series) expect(s.counts).toHaveLength(out.ranges.length);
    // group A has 2 dies, group B has 1 — totals preserved
    expect(out.series[0].counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(out.series[1].counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('omits empty groups and returns empty when no data', () => {
    const wafers = [wafer('W0', [{ hbin: 1 }])]; // no testValues for test 1
    const out = buildTestHistogramSeries(wafers, 1, () => 'A', 8);
    expect(out.series).toEqual([]);
    expect(out.ranges).toEqual([]);
  });
});

describe('buildTestBoxplotDataCombined', () => {
  it('pools all dies of a group into one five-number summary', () => {
    const wafers = [
      wafer('W0', [{ testValues: { 1: 1 } }, { testValues: { 1: 3 } }]),
      wafer('W1', [{ testValues: { 1: 5 } }]),       // same group as W0
      wafer('W2', [{ testValues: { 1: 100 } }]),     // other group
    ];
    const groupBy = (w: WaferData) => (w.waferId === 'W2' ? 'B' : 'A');
    const out = buildTestBoxplotDataCombined(wafers, 1, groupBy);
    const a = out.find(d => d.label === 'A')!;
    expect(a.count).toBe(3);      // 1, 3, 5 pooled across W0+W1
    expect(a.min).toBe(1);
    expect(a.median).toBe(3);
    expect(a.max).toBe(5);
    expect(a.waferIndex).toBe(-1); // a group is not a single wafer
  });
});

// ── buildTestHistogramData ────────────────────────────────────────────────────

describe('buildTestHistogramData', () => {
  it('returns empty array when no values', () => {
    const wafers = [wafer('W1', [{ hbin: 1 }])];
    expect(buildTestHistogramData(wafers, 1)).toEqual([]);
  });

  it('returns bucketCount buckets', () => {
    const wafers = [wafer('W1', [
      { testValues: { 1: 1 } },
      { testValues: { 1: 2 } },
      { testValues: { 1: 3 } },
    ])];
    expect(buildTestHistogramData(wafers, 1, 8)).toHaveLength(8);
  });

  it('all values land in buckets (total count equals die count)', () => {
    const wafers = [wafer('W1', Array.from({ length: 20 }, (_, i) => ({ testValues: { 1: i } })))];
    const buckets = buildTestHistogramData(wafers, 1, 4);
    const total = buckets.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(20);
  });

  it('single-value range puts everything in one bucket', () => {
    const wafers = [wafer('W1', [
      { testValues: { 1: 5 } },
      { testValues: { 1: 5 } },
      { testValues: { 1: 5 } },
    ])];
    const buckets = buildTestHistogramData(wafers, 1, 4);
    const total = buckets.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(3);
  });

  it('bucket rangeLow/rangeHigh are monotonically increasing', () => {
    const wafers = [wafer('W1', [
      { testValues: { 1: 0 } },
      { testValues: { 1: 10 } },
    ])];
    const buckets = buildTestHistogramData(wafers, 1, 4);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].rangeLow).toBeGreaterThan(buckets[i - 1].rangeLow);
    }
  });

  it('skips non-finite values', () => {
    const wafers = [wafer('W1', [
      { testValues: { 1: 1 } },
      { testValues: { 1: NaN } },
      { testValues: { 1: 3 } },
    ])];
    const buckets = buildTestHistogramData(wafers, 1, 4);
    const total = buckets.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(2);
  });
});

// ── buildScatterData ──────────────────────────────────────────────────────────

describe('buildScatterData', () => {
  it('returns one point per die that has both test values', () => {
    const wafers = [wafer('W1', [
      { testValues: { 1: 1, 2: 10 } },
      { testValues: { 1: 2, 2: 20 } },
      { testValues: { 1: 3 } },          // missing test 2 — excluded
    ])];
    const points = buildScatterData(wafers, 1, 2);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ x: 1, y: 10 });
    expect(points[1]).toMatchObject({ x: 2, y: 20 });
  });

  it('aggregates across multiple wafers', () => {
    const wafers = [
      wafer('W1', [{ testValues: { 1: 1, 2: 10 } }]),
      wafer('W2', [{ testValues: { 1: 2, 2: 20 } }]),
    ];
    expect(buildScatterData(wafers, 1, 2)).toHaveLength(2);
  });

  it('includes hbin on each point', () => {
    const wafers = [wafer('W1', [{ hbin: 3, testValues: { 1: 1, 2: 2 } }])];
    expect(buildScatterData(wafers, 1, 2)[0].hbin).toBe(3);
  });

  it('skips non-finite values', () => {
    const wafers = [wafer('W1', [
      { testValues: { 1: NaN, 2: 1 } },
      { testValues: { 1: 1, 2: Infinity } },
      { testValues: { 1: 1, 2: 1 } },
    ])];
    expect(buildScatterData(wafers, 1, 2)).toHaveLength(1);
  });

  it('returns empty array when no dies have both tests', () => {
    const wafers = [wafer('W1', [{ testValues: { 1: 1 } }])];
    expect(buildScatterData(wafers, 1, 2)).toHaveLength(0);
  });
});

describe('buildScatterDataGrouped', () => {
  it('tags each point with its wafer’s group', () => {
    const wafers = [
      wafer('W1', [{ testValues: { 1: 1, 2: 10 } }]),
      wafer('W2', [{ testValues: { 1: 2, 2: 20 } }]),
    ];
    const groupBy = (w: WaferData) => (w.waferId === 'W1' ? 'A' : 'B');
    const pts = buildScatterDataGrouped(wafers, 1, 2, groupBy);
    expect(pts).toHaveLength(2);
    expect(pts.find(p => p.x === 1)!.group).toBe('A');
    expect(pts.find(p => p.x === 2)!.group).toBe('B');
  });

  it('skips wafers whose group is undefined', () => {
    const wafers = [
      wafer('W1', [{ testValues: { 1: 1, 2: 10 } }]),
      wafer('W2', [{ testValues: { 1: 2, 2: 20 } }]),
    ];
    const groupBy = (w: WaferData) => (w.waferId === 'W1' ? 'A' : undefined);
    const pts = buildScatterDataGrouped(wafers, 1, 2, groupBy);
    expect(pts).toHaveLength(1);
    expect(pts[0].group).toBe('A');
  });
});

describe('filterCorrelationMatrix', () => {
  const testOptions = [
    { testNumber: 1, label: 'T1' },
    { testNumber: 2, label: 'T2' },
    { testNumber: 3, label: 'T3' },
  ];

  it('still shows tests when a group has no computable correlations (zero variance)', () => {
    // All dies identical → zero variance → every off-diagonal r is null. This is
    // the small/low-variance lot case that previously rendered an empty matrix.
    const wafers = [wafer('W1', Array.from({ length: 5 }, () => ({
      testValues: { 1: 1, 2: 2, 3: 3 },
    })))];
    const matrix = buildCorrelationMatrix(wafers, testOptions);
    const offDiagNonNull = matrix.cells.filter(c => c.xIndex !== c.yIndex && c.r !== null);
    expect(offDiagNonNull).toHaveLength(0); // confirms the null-r precondition

    const { matrix: filtered, strongestPair } = filterCorrelationMatrix(matrix, { minTests: 6, maxTests: 20 });
    expect(filtered.tests.length).toBe(3);   // fallback shows the tests, not an empty grid
    expect(strongestPair).toBeNull();
  });

  it('selects correlated tests normally when data has variance', () => {
    const wafers = [wafer('W1', Array.from({ length: 20 }, (_, i) => ({
      testValues: { 1: i, 2: i * 2, 3: 100 - i },  // T1~T2 perfectly correlated
    })))];
    const matrix = buildCorrelationMatrix(wafers, testOptions);
    const { strongestPair } = filterCorrelationMatrix(matrix, { minTests: 6, maxTests: 20 });
    expect(strongestPair).not.toBeNull();
    expect(Math.abs(strongestPair!.r)).toBeCloseTo(1, 5);
  });
});
