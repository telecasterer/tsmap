import { describe, it, expect } from 'vitest';
import { buildFacetTable, facetValueOf } from './metadata';
import type { MetaField, WaferData, WaferSource } from './types';

const fields = (o: Record<string, string>): MetaField[] =>
  Object.entries(o).map(([key, value]) => ({ key, value }));

const src = (o: Record<string, string>): WaferSource => ({ sourceFile: 'f.stdf', fields: fields(o) });

// Wafer with N dies, optional lot-level source and per-wafer fields.
function wafer(waferId: string, dieCount: number, source?: WaferSource, waferFields?: Record<string, string>): WaferData {
  return {
    waferId,
    results: Array.from({ length: dieCount }, (_, i) => ({ x: i, y: 0, hbin: 1 })),
    source,
    fields: waferFields ? fields(waferFields) : undefined,
  };
}

describe('facetValueOf', () => {
  it('reads a lot-level (source) field', () => {
    expect(facetValueOf(wafer('W1', 1, src({ lotId: 'A' })), 'lotId')).toBe('A');
  });
  it('reads a per-wafer field', () => {
    expect(facetValueOf(wafer('W1', 1, undefined, { frameId: 'FR-9' }), 'frameId')).toBe('FR-9');
  });
  it('returns undefined when no source and no wafer field', () => {
    expect(facetValueOf(wafer('W1', 1, undefined), 'lotId')).toBeUndefined();
  });
  it('returns undefined for an absent key', () => {
    expect(facetValueOf(wafer('W1', 1, src({ lotId: 'A' })), 'jobName')).toBeUndefined();
  });
  it('truncates date-typed fields to date-only', () => {
    expect(facetValueOf(wafer('W1', 1, src({ startT: '2026-06-23T14:31:00Z' })), 'startT')).toBe('2026-06-23');
  });
});

describe('buildFacetTable', () => {
  it('omits fields that are absent across all wafers', () => {
    const keys = buildFacetTable([wafer('W1', 10, src({ lotId: 'A' }))]).map(f => f.key);
    expect(keys).toContain('lotId');
    expect(keys).not.toContain('jobName');
    expect(keys).not.toContain('testTemp');
  });

  it('labels curated fields and marks a single-value field non-splittable', () => {
    const s = src({ lotId: 'LOT-1' });
    const lot = buildFacetTable([wafer('W1', 5, s), wafer('W2', 7, s)]).find(f => f.key === 'lotId')!;
    expect(lot.label).toBe('Lot');
    expect(lot.values).toHaveLength(1);
    expect(lot.splittable).toBe(false);
    expect(lot.values[0]).toEqual({ value: 'LOT-1', waferCount: 2, dieCount: 12 });
  });

  it('marks a multi-value field splittable with correct wafer/die counts', () => {
    const table = buildFacetTable([
      wafer('W1', 10, src({ lotId: 'A', jobName: 'PGM' })),
      wafer('W2', 20, src({ lotId: 'A', jobName: 'PGM' })),
      wafer('W3', 5, src({ lotId: 'B', jobName: 'PGM' })),
    ]);
    const lot = table.find(f => f.key === 'lotId')!;
    expect(lot.splittable).toBe(true);
    expect(lot.values).toEqual([
      { value: 'A', waferCount: 2, dieCount: 30 },
      { value: 'B', waferCount: 1, dieCount: 5 },
    ]);
    // jobName constant across all three → present but not splittable
    expect(table.find(f => f.key === 'jobName')!.splittable).toBe(false);
  });

  it('facets per-wafer fields (e.g. frame id from WRR)', () => {
    const table = buildFacetTable([
      wafer('W1', 3, undefined, { frameId: 'FR-1' }),
      wafer('W2', 4, undefined, { frameId: 'FR-2' }),
    ]);
    const frame = table.find(f => f.key === 'frameId')!;
    expect(frame.label).toBe('Frame');
    expect(frame.splittable).toBe(true);
    expect(frame.values.map(v => v.value).sort()).toEqual(['FR-1', 'FR-2']);
  });

  it('surfaces unknown keys labelled by their raw key', () => {
    const table = buildFacetTable([
      wafer('W1', 1, src({ customThing: 'X' })),
      wafer('W2', 1, src({ customThing: 'Y' })),
    ]);
    const custom = table.find(f => f.key === 'customThing')!;
    expect(custom).toBeDefined();
    expect(custom.label).toBe('customThing'); // falls back to raw key
  });

  it('hides curated non-facet fields by default, includes them when asked', () => {
    const wafers = [wafer('W1', 1, src({ specName: 'S1' })), wafer('W2', 1, src({ specName: 'S2' }))];
    expect(buildFacetTable(wafers).find(f => f.key === 'specName')).toBeUndefined();
    expect(buildFacetTable(wafers, false).find(f => f.key === 'specName')).toBeDefined();
  });

  it('groups a date field by day, not timestamp', () => {
    const table = buildFacetTable([
      wafer('W1', 1, src({ startT: '2026-06-23T08:00:00Z' })),
      wafer('W2', 1, src({ startT: '2026-06-23T17:30:00Z' })), // same day, different time
      wafer('W3', 1, src({ startT: '2026-06-24T09:00:00Z' })),
    ]);
    const date = table.find(f => f.key === 'startT')!;
    expect(date.values.map(v => v.value).sort()).toEqual(['2026-06-23', '2026-06-24']);
    expect(date.values.find(v => v.value === '2026-06-23')!.waferCount).toBe(2);
  });

  it('skips wafers with no source and empty values without crashing', () => {
    const table = buildFacetTable([
      wafer('W1', 2, undefined),
      wafer('W2', 3, src({ lotId: '' })),
      wafer('W3', 4, src({ lotId: 'A' })),
    ]);
    const lot = table.find(f => f.key === 'lotId')!;
    expect(lot.values).toEqual([{ value: 'A', waferCount: 1, dieCount: 4 }]);
  });

  it('returns an empty table when no wafer has metadata', () => {
    expect(buildFacetTable([wafer('W1', 1), wafer('W2', 1)])).toEqual([]);
  });
});
