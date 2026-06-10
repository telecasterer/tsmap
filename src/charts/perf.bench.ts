/**
 * Performance benchmarks for the charts hot paths and wmap rendering pipeline.
 *
 * Run with: NODE_OPTIONS="--max-old-space-size=4096" npx vitest bench src/charts/perf.bench.ts
 *
 * Covers:
 *   - buildCorrelationMatrix at small/medium/large test counts
 *   - buildScatterData, buildBinParetoData, buildTestHistogramData
 *   - buildWaferMap + analyzeWaferMap (the map rendering hot path)
 *   - buildLotStatsSummary equivalent (full pipeline per wafer + lot)
 */

import { bench, describe } from 'vitest';
import { buildCorrelationMatrix, buildScatterData, buildBinParetoData, buildTestHistogramData, listNumericTests } from './aggregate';
import { buildWaferMap } from '@paulrobins/wafermap';
import { analyzeWaferMap, analyzeWaferLot } from '@paulrobins/wafermap/stats';
import type { WaferData } from '../types';
import type { TestDef } from '../types';

// ── Synthetic data generators ────────────────────────────────────────────────

function makeWafers(waferCount: number, diesPerWafer: number, testCount: number): WaferData[] {
  return Array.from({ length: waferCount }, (_, wi) =>
    ({
      waferId: `W${wi + 1}`,
      results: Array.from({ length: diesPerWafer }, (_, di) => {
        const testValues: Record<number, number> = {};
        for (let t = 0; t < testCount; t++) {
          // Introduce some correlations to make it realistic
          testValues[1000 + t] = Math.sin(di * 0.1 + t) * 10 + 50 + Math.random() * 2;
        }
        return { x: di % 100, y: Math.floor(di / 100), hbin: di % 3 === 0 ? 2 : 1, testValues };
      }),
    }),
  );
}

function makeTestDefs(testCount: number): Record<string, TestDef> {
  const defs: Record<string, TestDef> = {};
  for (let t = 0; t < testCount; t++) {
    defs[String(1000 + t)] = { name: `test_${t}`, testType: 'P' };
  }
  return defs;
}

// ── Shared fixtures ──────────────────────────────────────────────────────────
// Kept modest so the benchmark worker doesn't OOM on fixture construction.
// The correlation matrix accumulator algo scales linearly in D regardless,
// so the relative slopes matter more than absolute size.

// Small: 3 wafers × 500 dies × 20 tests
const smallWafers  = makeWafers(3,   500, 20);
const smallDefs    = makeTestDefs(20);
const smallOpts    = listNumericTests(smallDefs);

// Medium: 10 wafers × 2k dies × 50 tests
const medWafers    = makeWafers(10, 2_000, 50);
const medDefs      = makeTestDefs(50);
const medOpts      = listNumericTests(medDefs);

// Large: 25 wafers × 4k dies × 100 tests  (~10M die×test touches)
const largeWafers  = makeWafers(25, 4_000, 100);
const largeDefs    = makeTestDefs(100);
const largeOpts    = listNumericTests(largeDefs);

// ── buildCorrelationMatrix ───────────────────────────────────────────────────

describe('buildCorrelationMatrix', () => {
  bench('small  (5w × 1k dies × 25 tests)', () => {
    buildCorrelationMatrix(smallWafers, smallOpts);
  });

  bench('medium (10w × 5k dies × 50 tests)', () => {
    buildCorrelationMatrix(medWafers, medOpts);
  });

  bench('large  (25w × 10k dies × 100 tests)', () => {
    buildCorrelationMatrix(largeWafers, largeOpts);
  });
});

// ── buildScatterData ─────────────────────────────────────────────────────────

describe('buildScatterData', () => {
  bench('small  (5w × 1k dies)', () => {
    buildScatterData(smallWafers, 1000, 1001);
  });

  bench('medium (10w × 5k dies)', () => {
    buildScatterData(medWafers, 1000, 1001);
  });

  bench('large  (25w × 10k dies)', () => {
    buildScatterData(largeWafers, 1000, 1001);
  });
});

// ── buildBinParetoData ───────────────────────────────────────────────────────

describe('buildBinParetoData', () => {
  bench('large  (25w × 10k dies)', () => {
    buildBinParetoData(largeWafers, 'hbin');
  });
});

// ── buildTestHistogramData ───────────────────────────────────────────────────

describe('buildTestHistogramData', () => {
  bench('large  (25w × 10k dies)', () => {
    buildTestHistogramData(largeWafers, 1000);
  });
});

// ── wmap rendering pipeline ──────────────────────────────────────────────────
// These benchmark buildWaferMap + analyzeWaferMap (the map rendering hot path
// called once per wafer in buildLotStatsSummary) and the full lot pipeline.

const wmapDefs = [
  { testNumber: 1000, name: 'test_0', limitLow: 40, limitHigh: 60 },
  { testNumber: 1001, name: 'test_1', limitLow: 40, limitHigh: 60 },
];

describe('wmap: buildWaferMap + analyzeWaferMap', () => {
  bench('medium — enableTestValueAnalysis:true  (1w × 2k dies × 50 tests)', () => {
    const waferMap = buildWaferMap({ results: medWafers[0].results, testDefs: wmapDefs });
    analyzeWaferMap(waferMap, { enableTestValueAnalysis: true });
  });

  bench('medium — enableTestValueAnalysis:false (1w × 2k dies × 50 tests)', () => {
    const waferMap = buildWaferMap({ results: medWafers[0].results, testDefs: wmapDefs });
    analyzeWaferMap(waferMap, { enableTestValueAnalysis: false });
  });

  bench('large  — enableTestValueAnalysis:true  (1w × 4k dies × 100 tests)', () => {
    const waferMap = buildWaferMap({ results: largeWafers[0].results, testDefs: wmapDefs });
    analyzeWaferMap(waferMap, { enableTestValueAnalysis: true });
  });

  bench('large  — enableTestValueAnalysis:false (1w × 4k dies × 100 tests)', () => {
    const waferMap = buildWaferMap({ results: largeWafers[0].results, testDefs: wmapDefs });
    analyzeWaferMap(waferMap, { enableTestValueAnalysis: false });
  });
});

describe('wmap: full lot pipeline (buildWaferMap + analyzeWaferMap × N + analyzeWaferLot)', () => {
  bench('medium (10 wafers × 2k dies × 50 tests)', () => {
    const items = medWafers.map((w, i) => {
      const waferMap = buildWaferMap({ results: w.results, testDefs: wmapDefs });
      const statsSummary = analyzeWaferMap(waferMap, { enableTestValueAnalysis: true });
      return { ...waferMap, label: `W${i}`, statsSummary };
    });
    analyzeWaferLot(items, { perWaferSummaries: items.map(i => i.statsSummary), enableTestValueAnalysis: true });
  });
});
