import { describe, it, expect } from 'vitest';
import { basename, toWmapTestDefs, autoPlotMode, applyTestSelection, applyTestOverrides, diffTestOverride, makeWaferSource, toWmapWaferMeta, toWaferData } from './lib';
import type { LotMeta, ParsedFile, TestDef, TestOverride, WaferSource } from './types';

// ── basename ──────────────────────────────────────────────────────────────────

describe('basename', () => {
  it('extracts filename from unix path', () => {
    expect(basename('/home/user/data/lot.stdf')).toBe('lot.stdf');
  });
  it('extracts filename from windows path', () => {
    expect(basename('C:\\Users\\user\\lot.stdf')).toBe('lot.stdf');
  });
  it('returns bare filename unchanged', () => {
    expect(basename('lot.stdf')).toBe('lot.stdf');
  });
  it('returns empty string for trailing slash', () => {
    expect(basename('/some/dir/')).toBe('');
  });
});

// ── toWmapTestDefs ────────────────────────────────────────────────────────────

describe('toWmapTestDefs', () => {
  it('maps keys to testNumber', () => {
    const defs: Record<string, TestDef> = {
      '1001': { name: 'Continuity', testType: 'P', loLimit: 0.1, hiLimit: 1.5, units: 'mA' },
    };
    const result = toWmapTestDefs(defs);
    expect(result).toHaveLength(1);
    expect(result[0].testNumber).toBe(1001);
  });

  it('maps limit field names', () => {
    const defs: Record<string, TestDef> = {
      '5': { name: 'Vt', testType: 'P', loLimit: 0.5, hiLimit: 1.2, units: 'V' },
    };
    const [r] = toWmapTestDefs(defs);
    expect(r.limitLow).toBe(0.5);
    expect(r.limitHigh).toBe(1.2);
    expect(r.unit).toBe('V');
    expect(r.name).toBe('Vt');
  });

  it('handles missing optional fields', () => {
    const defs: Record<string, TestDef> = {
      '10': { name: '', testType: 'F' },
    };
    const [r] = toWmapTestDefs(defs);
    expect(r.limitLow).toBeUndefined();
    expect(r.limitHigh).toBeUndefined();
    expect(r.unit).toBeUndefined();
  });

  it('falls back to "Test N" when name is empty', () => {
    const defs: Record<string, TestDef> = {
      '9001': { name: '', testType: 'F' },
    };
    expect(toWmapTestDefs(defs)[0].name).toBe('Test 9001');
  });

  it('returns one entry per key', () => {
    const defs: Record<string, TestDef> = {
      '1': { name: 'A', testType: 'P' },
      '2': { name: 'B', testType: 'P' },
      '3': { name: 'C', testType: 'F' },
    };
    expect(toWmapTestDefs(defs)).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    expect(toWmapTestDefs({})).toEqual([]);
  });
});

// ── autoPlotMode ──────────────────────────────────────────────────────────────

describe('autoPlotMode', () => {
  it('prefers hardBin when hbin present', () => {
    const wafers = [{ waferId: 'W1', results: [{ x: 0, y: 0, hbin: 1, sbin: 2, testValues: { 1: 0.5 } }] }];
    expect(autoPlotMode(wafers)).toBe('hardBin');
  });

  it('falls back to softBin when no hbin', () => {
    const wafers = [{ waferId: 'W1', results: [{ x: 0, y: 0, sbin: 2, testValues: { 1: 0.5 } }] }];
    expect(autoPlotMode(wafers)).toBe('softBin');
  });

  it('falls back to value when only testValues', () => {
    const wafers = [{ waferId: 'W1', results: [{ x: 0, y: 0, testValues: { 1: 0.5 } }] }];
    expect(autoPlotMode(wafers)).toBe('value');
  });

  it('falls back to value when only functional verdicts (testPass) exist', () => {
    const wafers = [{ waferId: 'W1', results: [{ x: 0, y: 0, testPass: { 2001: true } }] }];
    expect(autoPlotMode(wafers)).toBe('value');
  });

  it('defaults to hardBin for empty results', () => {
    expect(autoPlotMode([{ waferId: 'W1', results: [] }])).toBe('hardBin');
  });

  it('defaults to hardBin for empty wafers', () => {
    expect(autoPlotMode([])).toBe('hardBin');
  });
});

// ── applyTestSelection ────────────────────────────────────────────────────────

function makeParsed(testDefs: Record<string, TestDef>, testValues: Record<number, number> = {}): ParsedFile {
  return {
    fileName: 'test.stdf',
    meta: { fields: [] },
    wafers: [{
      waferId: 'W1',
      results: [{ x: 0, y: 0, hbin: 1, testValues }],
    }],
    testDefs,
  };
}

describe('applyTestSelection', () => {
  it('prunes testDefs to selection', () => {
    const parsed = makeParsed({
      '1001': { name: 'A', testType: 'P' },
      '1002': { name: 'B', testType: 'P' },
      '1003': { name: 'C', testType: 'P' },
    });
    applyTestSelection(parsed, [1001, 1003], null, new Map());
    expect(Object.keys(parsed.testDefs)).toEqual(['1001', '1003']);
  });

  it('prunes per-die testValues to selection', () => {
    const parsed = makeParsed(
      { '1001': { name: 'A', testType: 'P' }, '1002': { name: 'B', testType: 'P' } },
      { 1001: 0.5, 1002: 1.2 },
    );
    applyTestSelection(parsed, [1001], null, new Map());
    expect(parsed.wafers[0].results[0].testValues).toEqual({ 1001: 0.5 });
  });

  it('prunes per-die testPass to selection', () => {
    const parsed = makeParsed(
      { '1001': { name: 'A', testType: 'P' }, '2001': { name: 'scan', testType: 'F' }, '2002': { name: 'bist', testType: 'F' } },
    );
    parsed.wafers[0].results[0].testPass = { 2001: true, 2002: false };
    applyTestSelection(parsed, [1001, 2001], null, new Map());
    expect(parsed.wafers[0].results[0].testPass).toEqual({ 2001: true });
  });

  it('backfills stop-on-fail tests from firstPassDefs', () => {
    const parsed = makeParsed({ '1001': { name: 'A', testType: 'P' } });
    const firstPass = {
      '1001': { name: 'A', testType: 'P' as const },
      '1002': { name: 'B', testType: 'P' as const },
    };
    applyTestSelection(parsed, [1001, 1002], firstPass, new Map());
    expect('1002' in parsed.testDefs).toBe(true);
    expect(parsed.testDefs['1002'].name).toBe('B');
  });

  it('does not backfill tests not in firstPassDefs', () => {
    const parsed = makeParsed({ '1001': { name: 'A', testType: 'P' } });
    applyTestSelection(parsed, [1001, 9999], { '1001': { name: 'A', testType: 'P' } }, new Map());
    expect('9999' in parsed.testDefs).toBe(false);
  });

  it('applies name overrides', () => {
    const parsed = makeParsed({ '1001': { name: 'Original', testType: 'P' } });
    applyTestSelection(parsed, [1001], null, new Map([[1001, { name: 'User Name' }]]));
    expect(parsed.testDefs['1001'].name).toBe('User Name');
  });

  it('name overrides win over backfill names', () => {
    const parsed = makeParsed({});
    const firstPass = { '1001': { name: 'STDF Name', testType: 'P' as const } };
    applyTestSelection(parsed, [1001], firstPass, new Map([[1001, { name: 'User Name' }]]));
    expect(parsed.testDefs['1001'].name).toBe('User Name');
  });

  it('applies limit, units, and testType overrides', () => {
    const parsed = makeParsed({ '1001': { name: 'A', testType: 'P', loLimit: 0, hiLimit: 1 } });
    applyTestSelection(parsed, [1001], null, new Map([[1001, { loLimit: -5, hiLimit: 5, units: 'mA', testType: 'P' }]]));
    expect(parsed.testDefs['1001']).toEqual({ name: 'A', testType: 'P', loLimit: -5, hiLimit: 5, units: 'mA' });
  });

  it('empty selection removes all testDefs and testValues', () => {
    const parsed = makeParsed(
      { '1001': { name: 'A', testType: 'P' } },
      { 1001: 0.5 },
    );
    applyTestSelection(parsed, [], null, new Map());
    expect(Object.keys(parsed.testDefs)).toHaveLength(0);
    expect(parsed.wafers[0].results[0].testValues).toEqual({});
  });

  it('returns the mutated parsed object', () => {
    const parsed = makeParsed({ '1': { name: 'X', testType: 'P' } });
    const returned = applyTestSelection(parsed, [1], null, new Map());
    expect(returned).toBe(parsed);
  });

  it('handles dies with no testValues gracefully', () => {
    const parsed: ParsedFile = {
      fileName: 'test.stdf',
      meta: { fields: [] },
      wafers: [{ waferId: 'W1', results: [{ x: 0, y: 0, hbin: 1 }] }],
      testDefs: { '1001': { name: 'A', testType: 'P' } },
    };
    expect(() => applyTestSelection(parsed, [1001], null, new Map())).not.toThrow();
  });
});

// ── applyTestOverrides ──────────────────────────────────────────────────────────

describe('applyTestOverrides', () => {
  it('partial override leaves other fields untouched', () => {
    const testDefs: Record<string, TestDef> = { '1001': { name: 'A', testType: 'P', loLimit: 0, hiLimit: 1, units: 'V' } };
    applyTestOverrides(testDefs, new Map([[1001, { hiLimit: 5 }]]));
    expect(testDefs['1001']).toEqual({ name: 'A', testType: 'P', loLimit: 0, hiLimit: 5, units: 'V' });
  });

  it('override always wins over the parsed value', () => {
    const testDefs: Record<string, TestDef> = { '1001': { name: 'A', testType: 'P', loLimit: 0 } };
    applyTestOverrides(testDefs, new Map([[1001, { loLimit: -99 }]]));
    expect(testDefs['1001'].loLimit).toBe(-99);
  });

  it('name-only override does not blank existing limits', () => {
    const testDefs: Record<string, TestDef> = { '1001': { name: 'A', testType: 'P', loLimit: 0, hiLimit: 1 } };
    applyTestOverrides(testDefs, new Map([[1001, { name: 'Renamed' }]]));
    expect(testDefs['1001']).toEqual({ name: 'Renamed', testType: 'P', loLimit: 0, hiLimit: 1 });
  });

  it('ignores an override for a test number absent from testDefs', () => {
    const testDefs: Record<string, TestDef> = { '1001': { name: 'A', testType: 'P' } };
    applyTestOverrides(testDefs, new Map([[9999, { name: 'Ghost' }]]));
    expect(testDefs).toEqual({ '1001': { name: 'A', testType: 'P' } });
  });

  it('applies an explicit 0 override (not treated as falsy-skip)', () => {
    const testDefs: Record<string, TestDef> = { '1001': { name: 'A', testType: 'P', loLimit: 5 } };
    applyTestOverrides(testDefs, new Map([[1001, { loLimit: 0 }]]));
    expect(testDefs['1001'].loLimit).toBe(0);
  });

  it('applies a testType override', () => {
    const testDefs: Record<string, TestDef> = { '1001': { name: 'A', testType: 'P' } };
    applyTestOverrides(testDefs, new Map([[1001, { testType: 'F' }]]));
    expect(testDefs['1001'].testType).toBe('F');
  });

  it('drops loLimit/hiLimit for an already-functional test, but keeps name/units', () => {
    const testDefs: Record<string, TestDef> = { '2001': { name: 'scan', testType: 'F' } };
    applyTestOverrides(testDefs, new Map([[2001, { name: 'Scan Chain', loLimit: 0, hiLimit: 1, units: 'x' }]]));
    expect(testDefs['2001']).toEqual({ name: 'Scan Chain', testType: 'F', units: 'x' });
  });

  it('drops a new loLimit/hiLimit override when the same override reclassifies to functional', () => {
    // Reclassifying to F blocks *new* limit overrides on this merge — it doesn't
    // retroactively scrub limits already present on the TestDef (that combination
    // can't occur from real parser output; FTR-based tests never carry limits).
    const testDefs: Record<string, TestDef> = { '1001': { name: 'A', testType: 'P', loLimit: 0.1, hiLimit: 1.5 } };
    applyTestOverrides(testDefs, new Map([[1001, { testType: 'F', loLimit: 0, hiLimit: 1 }]]));
    expect(testDefs['1001']).toEqual({ name: 'A', testType: 'F', loLimit: 0.1, hiLimit: 1.5 });
  });

  it('allows loLimit/hiLimit when an override reclassifies a test to parametric', () => {
    const testDefs: Record<string, TestDef> = { '2001': { name: 'scan', testType: 'F' } };
    applyTestOverrides(testDefs, new Map([[2001, { testType: 'P', loLimit: 0, hiLimit: 1 }]]));
    expect(testDefs['2001']).toEqual({ name: 'scan', testType: 'P', loLimit: 0, hiLimit: 1 });
  });
});

// ── diffTestOverride ────────────────────────────────────────────────────────────

describe('diffTestOverride', () => {
  it('returns undefined when there is no diff', () => {
    const def: TestDef = { name: 'A', testType: 'P', loLimit: 0, hiLimit: 1, units: 'V' };
    expect(diffTestOverride(def, { ...def })).toBeUndefined();
  });

  it('returns only the field(s) that differ', () => {
    const original: TestDef = { name: 'A', testType: 'P' };
    const current: TestDef = { name: 'Renamed', testType: 'P' };
    const diff: TestOverride | undefined = diffTestOverride(current, original);
    expect(diff).toEqual({ name: 'Renamed' });
  });

  it('returns multiple differing fields', () => {
    const original: TestDef = { name: 'A', testType: 'P', loLimit: 0 };
    const current: TestDef = { name: 'A', testType: 'F', loLimit: -5, hiLimit: 5 };
    expect(diffTestOverride(current, original)).toEqual({ testType: 'F', loLimit: -5, hiLimit: 5 });
  });
});

// ── makeWaferSource ─────────────────────────────────────────────────────────────

describe('makeWaferSource', () => {
  it('carries the lot fields and filename onto a WaferSource', () => {
    const meta: LotMeta = { fields: [
      { key: 'lotId', value: 'LOT1' }, { key: 'partType', value: 'NMOS' },
    ] };
    const src = makeWaferSource(meta, 'lot1.stdf');
    expect(src.sourceFile).toBe('lot1.stdf');
    expect(src.fields).toEqual(meta.fields);
  });

  it('handles an empty lot meta', () => {
    const src = makeWaferSource({ fields: [] }, 'bare.csv');
    expect(src.sourceFile).toBe('bare.csv');
    expect(src.fields).toEqual([]);
  });
});

// ── toWaferData ─────────────────────────────────────────────────────────────────

describe('toWaferData', () => {
  const src: WaferSource = { sourceFile: 'a.stdf', fields: [{ key: 'lotId', value: 'A' }] };

  it('carries per-wafer fields and source through the merge projection', () => {
    // Regression: the rename/merge flow used to drop `fields`, killing WIR/WRR facets.
    const fields = [{ key: 'frameId', value: 'F1' }, { key: 'maskId', value: 'M1' }];
    const out = toWaferData({
      waferId: 'W1', results: [{ x: 0, y: 0, hbin: 1 }],
      partCount: 10, goodCount: 9, failCount: 1, fields, source: src,
    });
    expect(out.fields).toBe(fields);   // same reference, not dropped
    expect(out.source).toBe(src);      // shared provenance reference preserved
    expect(out).toEqual({
      waferId: 'W1', results: [{ x: 0, y: 0, hbin: 1 }],
      partCount: 10, goodCount: 9, failCount: 1, fields, source: src,
    });
  });

  it('tolerates a minimal wafer (only id + results)', () => {
    const out = toWaferData({ waferId: 'W1', results: [] });
    expect(out.fields).toBeUndefined();
    expect(out.source).toBeUndefined();
  });
});

// ── toWmapWaferMeta ─────────────────────────────────────────────────────────────

const source = (o: Record<string, string>): WaferSource =>
  ({ sourceFile: 'f', fields: Object.entries(o).map(([key, value]) => ({ key, value })) });

describe('toWmapWaferMeta', () => {
  it('returns undefined when there is no source', () => {
    expect(toWmapWaferMeta(undefined, 'W1')).toBeUndefined();
  });

  it('maps known keys to wmap WaferMetadata names', () => {
    const m = toWmapWaferMeta(source({ lotId: 'LOT1', partType: 'NMOS', jobName: 'PGM_X', startT: '2026-06-23', testTemp: '25' }), 'W7')!;
    expect(m.waferId).toBe('W7');
    expect(m.lot).toBe('LOT1');
    expect(m.product).toBe('NMOS');
    expect(m.testProgram).toBe('PGM_X');
    expect(m.testDate).toBe('2026-06-23');
    expect(m.temperature).toBe(25); // coerced to number
  });

  it('keeps temperature as a string field when not numeric', () => {
    const m = toWmapWaferMeta(source({ testTemp: 'hot' }), 'W1')!;
    expect(m.temperature).toBeUndefined();
    expect(m.testTemp).toBe('hot');
  });

  it('passes unknown keys through wmap’s open index signature', () => {
    const m = toWmapWaferMeta(source({ frameId: 'FR-9', customThing: 'X' }), 'W1')!;
    expect(m.frameId).toBe('FR-9');
    expect(m.customThing).toBe('X');
  });

  it('emits only waferId when the source has no fields', () => {
    const m = toWmapWaferMeta(source({}), 'W1')!;
    expect(m.waferId).toBe('W1');
    expect('lot' in m).toBe(false);
  });

  it('maps a wafer split (splitLabel) to wmap\'s first-class `split` field', () => {
    const m = toWmapWaferMeta(source({ lotId: 'LOT1' }), 'W1', [{ key: 'splitLabel', value: 'TT' }])!;
    expect(m.lot).toBe('LOT1');
    expect(m.split).toBe('TT');
  });

  it('per-wafer fields win over same-named lot-level fields', () => {
    const m = toWmapWaferMeta(source({ lotId: 'LOT1' }), 'W1', [{ key: 'lotId', value: 'OVERRIDE' }])!;
    expect(m.lot).toBe('OVERRIDE');
  });

  it('still produces metadata from waferFields alone when there is no source', () => {
    const m = toWmapWaferMeta(undefined, 'W1', [{ key: 'splitLabel', value: 'FF' }])!;
    expect(m).toBeDefined();
    expect(m.waferId).toBe('W1');
    expect(m.split).toBe('FF');
  });
});
