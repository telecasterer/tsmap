import { describe, it, expect } from 'vitest';
import { buildBinParetoData, buildTestBoxplotData, buildTestHistogramData, buildTrendData, buildScatterData, listNumericTests } from './aggregate';
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

// ── buildTrendData ────────────────────────────────────────────────────────────

describe('buildTrendData', () => {
  it('computes median/q1/q3 from die data', () => {
    const wafers = [
      wafer('W1', [1, 2, 3, 4, 5].map(v => ({ testValues: { 1: v } }))),
      wafer('W2', [6, 7, 8, 9, 10].map(v => ({ testValues: { 1: v } }))),
    ];
    const result = buildTrendData(wafers, 1);
    expect(result).toHaveLength(2);
    expect(result[0].median).toBeCloseTo(3);
    expect(result[1].median).toBeCloseTo(8);
  });

  it('returns NaN for wafer with no data for that test', () => {
    const wafers = [wafer('W1', [])];
    const [r] = buildTrendData(wafers, 1);
    expect(r.count).toBe(0);
    expect(Number.isNaN(r.median)).toBe(true);
  });

  it('labels each datum with wafer ID', () => {
    const wafers = [wafer('LOT-W1', [{ testValues: { 1: 1 } }])];
    expect(buildTrendData(wafers, 1)[0].label).toBe('LOT-W1');
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
