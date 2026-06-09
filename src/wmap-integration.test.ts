/**
 * Integration tests calling real wmap functions to verify perWaferTestStats
 * is populated by analyzeWaferLot when perWaferSummaries are pre-built with
 * enableTestValueAnalysis: true.
 */
import { describe, it, expect } from 'vitest';
import { buildWaferMap } from '@paulrobins/wafermap';
import { analyzeWaferMap, analyzeWaferLot } from '@paulrobins/wafermap/stats';

function makeDie(x: number, y: number, testValues: Record<number, number>) {
  return { x, y, hbin: 1, testValues };
}

const TEST_DEFS = [
  { testNumber: 1001, name: 'test_a', limitLow: 90, limitHigh: 200 },
  { testNumber: 1002, name: 'test_b', limitLow: 190, limitHigh: 300 },
];

const WAFER_RESULTS = Array.from({ length: 20 }, (_, i) => makeDie(i % 5, Math.floor(i / 5), {
  1001: 100 + i,
  1002: 200 + i,
}));

describe('analyzeWaferLot perWaferTestStats', () => {
  it('analyzeWaferMap with enableTestValueAnalysis produces perTestStats', () => {
    const waferMap = buildWaferMap({ results: WAFER_RESULTS, testDefs: TEST_DEFS });
    const summary = analyzeWaferMap(waferMap, { enableTestValueAnalysis: true });
    expect(summary.stats.perTestStats).toBeDefined();
    expect(summary.stats.perTestStats?.length).toBeGreaterThan(0);
    expect(summary.stats.perTestStats?.[0].testNumber).toBe(1001);
  });

  it('analyzeWaferLot populates perWaferTestStats when summaries have perTestStats', () => {
    const waferMap = buildWaferMap({ results: WAFER_RESULTS, testDefs: TEST_DEFS });
    const statsSummary = analyzeWaferMap(waferMap, { enableTestValueAnalysis: true });
    const item = { ...waferMap, label: 'W1', statsSummary };

    const lotSummary = analyzeWaferLot([item], {
      perWaferSummaries: [statsSummary],
      enableTestValueAnalysis: true,
    });

    expect(lotSummary.perWaferTestStats).toBeDefined();
    expect(lotSummary.perWaferTestStats?.length).toBe(1);
    expect(lotSummary.perWaferTestStats?.[0].tests.map(t => t.testNumber)).toContain(1001);
  });

  it('perWaferTestStats has correct five-number summary', () => {
    const waferMap = buildWaferMap({ results: WAFER_RESULTS, testDefs: TEST_DEFS });
    const statsSummary = analyzeWaferMap(waferMap, { enableTestValueAnalysis: true });
    const item = { ...waferMap, label: 'W1', statsSummary };

    const lotSummary = analyzeWaferLot([item], {
      perWaferSummaries: [statsSummary],
      enableTestValueAnalysis: true,
    });

    const testStats = lotSummary.perWaferTestStats?.[0].tests.find(t => t.testNumber === 1001);
    expect(testStats).toBeDefined();
    expect(testStats!.min).toBeLessThan(testStats!.median);
    expect(testStats!.median).toBeLessThan(testStats!.max);
    expect(testStats!.q1).toBeLessThan(testStats!.q3);
    expect(testStats!.count).toBe(20);
  });

  it('perWaferTestStats works across multiple wafers', () => {
    const items = ['W1', 'W2', 'W3'].map(label => {
      const waferMap = buildWaferMap({ results: WAFER_RESULTS, testDefs: TEST_DEFS });
      const statsSummary = analyzeWaferMap(waferMap, { enableTestValueAnalysis: true });
      return { ...waferMap, label, statsSummary };
    });

    const lotSummary = analyzeWaferLot(items, {
      perWaferSummaries: items.map(i => i.statsSummary),
      enableTestValueAnalysis: true,
    });

    expect(lotSummary.perWaferTestStats?.length).toBe(3);
    expect(lotSummary.perWaferTestStats?.map(e => e.waferIndex)).toEqual([0, 1, 2]);
  });
});
