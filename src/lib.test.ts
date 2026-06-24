import { describe, it, expect } from 'vitest';
import { basename, toWmapTestDefs, autoPlotMode, applyTestSelection, makeWaferSource, toWmapWaferMeta } from './lib';
import type { LotMeta, ParsedFile, TestDef, WaferSource } from './types';

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
    applyTestSelection(parsed, [1001], null, new Map([[1001, 'User Name']]));
    expect(parsed.testDefs['1001'].name).toBe('User Name');
  });

  it('name overrides win over backfill names', () => {
    const parsed = makeParsed({});
    const firstPass = { '1001': { name: 'STDF Name', testType: 'P' as const } };
    applyTestSelection(parsed, [1001], firstPass, new Map([[1001, 'User Name']]));
    expect(parsed.testDefs['1001'].name).toBe('User Name');
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
});
