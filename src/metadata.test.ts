import { describe, it, expect } from 'vitest';
import { buildFacetTable, facetValueOf } from './metadata';
import type { WaferData, WaferSource } from './types';

// Helper: a wafer with N dies and a given source.
function wafer(waferId: string, dieCount: number, source?: WaferSource): WaferData {
  return {
    waferId,
    results: Array.from({ length: dieCount }, (_, i) => ({ x: i, y: 0, hbin: 1 })),
    source,
  };
}

const src = (over: Partial<WaferSource>): WaferSource => ({ sourceFile: 'f.stdf', ...over });

describe('facetValueOf', () => {
  it('reads a named source field', () => {
    expect(facetValueOf(wafer('W1', 1, src({ lotId: 'A' })), 'lotId')).toBe('A');
  });
  it('reads an extras field', () => {
    expect(facetValueOf(wafer('W1', 1, src({ extras: { handler: 'H1' } })), 'handler')).toBe('H1');
  });
  it('returns undefined when no source', () => {
    expect(facetValueOf(wafer('W1', 1, undefined), 'lotId')).toBeUndefined();
  });
  it('returns undefined for an absent key', () => {
    expect(facetValueOf(wafer('W1', 1, src({ lotId: 'A' })), 'program')).toBeUndefined();
  });
});

describe('buildFacetTable', () => {
  it('omits fields that are absent across all wafers', () => {
    const table = buildFacetTable([wafer('W1', 10, src({ lotId: 'A' }))]);
    const keys = table.map(f => f.key);
    expect(keys).toContain('lotId');
    expect(keys).toContain('sourceFile');
    expect(keys).not.toContain('program'); // never set
    expect(keys).not.toContain('temp');
  });

  it('marks a single-value field non-splittable', () => {
    // Two wafers, same lot — one distinct value.
    const s = src({ lotId: 'LOT-1' });
    const table = buildFacetTable([wafer('W1', 5, s), wafer('W2', 7, s)]);
    const lot = table.find(f => f.key === 'lotId')!;
    expect(lot.values).toHaveLength(1);
    expect(lot.splittable).toBe(false);
    expect(lot.values[0]).toEqual({ value: 'LOT-1', waferCount: 2, dieCount: 12 });
  });

  it('marks a multi-value field splittable with correct wafer/die counts', () => {
    const a = src({ lotId: 'A', program: 'PGM' });
    const b = src({ lotId: 'B', program: 'PGM' });
    const table = buildFacetTable([
      wafer('W1', 10, a),
      wafer('W2', 20, a),
      wafer('W3', 5, b),
    ]);
    const lot = table.find(f => f.key === 'lotId')!;
    expect(lot.splittable).toBe(true);
    // sorted by wafer count desc: A (2 wafers, 30 dies) before B (1, 5)
    expect(lot.values).toEqual([
      { value: 'A', waferCount: 2, dieCount: 30 },
      { value: 'B', waferCount: 1, dieCount: 5 },
    ]);
    // program is constant across all three → present but not splittable
    const program = table.find(f => f.key === 'program')!;
    expect(program.splittable).toBe(false);
  });

  it('includes extras keys as facets', () => {
    const table = buildFacetTable([
      wafer('W1', 3, src({ extras: { site: '1' } })),
      wafer('W2', 4, src({ extras: { site: '2' } })),
    ]);
    const site = table.find(f => f.key === 'site')!;
    expect(site).toBeDefined();
    expect(site.label).toBe('site');
    expect(site.splittable).toBe(true);
    expect(site.values.map(v => v.value).sort()).toEqual(['1', '2']);
  });

  it('skips wafers with no source and empty values without crashing', () => {
    const table = buildFacetTable([
      wafer('W1', 2, undefined),
      wafer('W2', 3, src({ lotId: '' })),   // empty string ignored
      wafer('W3', 4, src({ lotId: 'A' })),
    ]);
    const lot = table.find(f => f.key === 'lotId')!;
    expect(lot.values).toEqual([{ value: 'A', waferCount: 1, dieCount: 4 }]);
  });

  it('returns an empty table when no wafer has a source', () => {
    expect(buildFacetTable([wafer('W1', 1), wafer('W2', 1)])).toEqual([]);
  });
});
