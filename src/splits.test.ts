import { describe, it, expect } from 'vitest';
import { getSplitLabel, setSplitLabel, clearAllSplits, listSplitValues, parseSplitsCsv, formatSplitsCsv, waferDisplayLabel, splitsFingerprint, SPLIT_FIELD_KEY } from './splits';
import type { WaferData } from './types';

function wafer(id: string, fields?: Array<{ key: string; value: string }>): WaferData {
  return { waferId: id, results: [], fields };
}

/** A wafer stamped with lot-level provenance (source.fields), as real
 * STDF/ATDF loads produce — distinct from `wafer()`'s per-wafer-only fields,
 * since splitsFingerprint reads lotId/partType via facetValueOf, which
 * prefers source.fields. */
function waferWithLot(id: string, sourceFile: string, lotId?: string, partType?: string): WaferData {
  const fields = [
    ...(lotId !== undefined ? [{ key: 'lotId', value: lotId }] : []),
    ...(partType !== undefined ? [{ key: 'partType', value: partType }] : []),
  ];
  return { waferId: id, results: [], source: { sourceFile, fields } };
}

describe('getSplitLabel / setSplitLabel', () => {
  it('returns undefined when no split is assigned', () => {
    expect(getSplitLabel(wafer('W1'))).toBeUndefined();
  });

  it('assigns a split to a wafer with no fields yet', () => {
    const w = wafer('W1');
    setSplitLabel(w, 'TT');
    expect(getSplitLabel(w)).toBe('TT');
    expect(w.fields).toEqual([{ key: SPLIT_FIELD_KEY, value: 'TT' }]);
  });

  it('preserves other fields when assigning a split', () => {
    const w = wafer('W1', [{ key: 'lotId', value: 'LOT1' }]);
    setSplitLabel(w, 'FF');
    expect(w.fields).toEqual([{ key: 'lotId', value: 'LOT1' }, { key: SPLIT_FIELD_KEY, value: 'FF' }]);
  });

  it('overwrites an existing split assignment', () => {
    const w = wafer('W1');
    setSplitLabel(w, 'TT');
    setSplitLabel(w, 'FF');
    expect(getSplitLabel(w)).toBe('FF');
    expect(w.fields).toHaveLength(1);
  });

  it('trims whitespace', () => {
    const w = wafer('W1');
    setSplitLabel(w, '  SS  ');
    expect(getSplitLabel(w)).toBe('SS');
  });

  it('clears the split when set to undefined', () => {
    const w = wafer('W1');
    setSplitLabel(w, 'TT');
    setSplitLabel(w, undefined);
    expect(getSplitLabel(w)).toBeUndefined();
    expect(w.fields).toEqual([]);
  });

  it('clears the split when set to an empty/whitespace string', () => {
    const w = wafer('W1');
    setSplitLabel(w, 'TT');
    setSplitLabel(w, '   ');
    expect(getSplitLabel(w)).toBeUndefined();
  });

  it('never writes to source.fields — only wafer.fields', () => {
    const source = { sourceFile: 'lot.stdf', fields: [] };
    const w: WaferData = { waferId: 'W1', results: [], source };
    setSplitLabel(w, 'TT');
    expect(source.fields).toEqual([]);
    expect(getSplitLabel(w)).toBe('TT');
  });
});

describe('clearAllSplits', () => {
  it('clears every wafer regardless of prior assignment', () => {
    const wafers = [wafer('W1'), wafer('W2'), wafer('W3')];
    setSplitLabel(wafers[0], 'TT');
    setSplitLabel(wafers[1], 'FF');
    // W3 left unassigned.
    clearAllSplits(wafers);
    expect(wafers.map(getSplitLabel)).toEqual([undefined, undefined, undefined]);
  });

  it('is a no-op on an already-empty set of assignments', () => {
    const wafers = [wafer('W1'), wafer('W2')];
    expect(() => clearAllSplits(wafers)).not.toThrow();
    expect(wafers.map(getSplitLabel)).toEqual([undefined, undefined]);
  });
});

describe('waferDisplayLabel', () => {
  it('returns the raw ID when the suffix is disabled', () => {
    const w = wafer('W1');
    setSplitLabel(w, 'TT');
    expect(waferDisplayLabel(w, false)).toBe('W1');
  });

  it('returns the raw ID when no split is assigned, even with the suffix enabled', () => {
    expect(waferDisplayLabel(wafer('W1'), true)).toBe('W1');
  });

  it('appends " · <split>" when enabled and a split is assigned', () => {
    const w = wafer('W1');
    setSplitLabel(w, 'FF');
    expect(waferDisplayLabel(w, true)).toBe('W1 · FF');
  });
});

describe('listSplitValues', () => {
  it('returns distinct split values in first-seen order', () => {
    const wafers = [wafer('W1'), wafer('W2'), wafer('W3')];
    setSplitLabel(wafers[0], 'FF');
    setSplitLabel(wafers[1], 'TT');
    setSplitLabel(wafers[2], 'FF');
    expect(listSplitValues(wafers)).toEqual(['FF', 'TT']);
  });

  it('skips wafers with no split assigned', () => {
    const wafers = [wafer('W1'), wafer('W2')];
    setSplitLabel(wafers[1], 'TT');
    expect(listSplitValues(wafers)).toEqual(['TT']);
  });
});

describe('splitsFingerprint', () => {
  it('is identical for the same lot reloaded from a differently named/sized file', () => {
    const first = [
      waferWithLot('W01', 'lot_25c.stdf', 'LOT1', 'CHIP-A'),
      waferWithLot('W02', 'lot_25c.stdf', 'LOT1', 'CHIP-A'),
    ];
    const second = [
      waferWithLot('W01', 'lot_85c.stdf', 'LOT1', 'CHIP-A'),
      waferWithLot('W02', 'lot_85c.stdf', 'LOT1', 'CHIP-A'),
    ];
    expect(splitsFingerprint(first)).toBe(splitsFingerprint(second));
  });

  it('differs for two unrelated lots that happen to reuse the same wafer IDs', () => {
    const lotA = [waferWithLot('W01', 'a.stdf', 'LOT-A'), waferWithLot('W02', 'a.stdf', 'LOT-A')];
    const lotB = [waferWithLot('W01', 'b.stdf', 'LOT-B'), waferWithLot('W02', 'b.stdf', 'LOT-B')];
    expect(splitsFingerprint(lotA)).not.toBe(splitsFingerprint(lotB));
  });

  it('differs when part type differs but lot ID and wafer ID match', () => {
    const a = [waferWithLot('W01', 'x.stdf', 'LOT1', 'CHIP-A')];
    const b = [waferWithLot('W01', 'x.stdf', 'LOT1', 'CHIP-B')];
    expect(splitsFingerprint(a)).not.toBe(splitsFingerprint(b));
  });

  it('falls back to wafer ID alone without throwing when no lot metadata is present', () => {
    const wafers = [wafer('W01'), wafer('W02')];
    expect(() => splitsFingerprint(wafers)).not.toThrow();
    expect(splitsFingerprint(wafers)).toBe(splitsFingerprint([wafer('W02'), wafer('W01')]));
  });

  it('is independent of wafer order', () => {
    const a = [waferWithLot('W01', 'x.stdf', 'LOT1'), waferWithLot('W02', 'x.stdf', 'LOT1')];
    const b = [waferWithLot('W02', 'x.stdf', 'LOT1'), waferWithLot('W01', 'x.stdf', 'LOT1')];
    expect(splitsFingerprint(a)).toBe(splitsFingerprint(b));
  });
});

describe('formatSplitsCsv / parseSplitsCsv round-trip', () => {
  it('round-trips assignments through CSV', () => {
    const wafers = [wafer('W1'), wafer('W2'), wafer('W3')];
    setSplitLabel(wafers[0], 'TT');
    setSplitLabel(wafers[1], 'FF');
    // W3 left unassigned.

    const csv = formatSplitsCsv(wafers);
    const parsed = parseSplitsCsv(csv);

    expect(parsed.get('W1')).toBe('TT');
    expect(parsed.get('W2')).toBe('FF');
    expect(parsed.get('W3')).toBe('');
  });

  it('skips comment and header lines', () => {
    const parsed = parseSplitsCsv('# a comment\nwaferId,split\nW1,TT\n\nW2,FF');
    expect(parsed.size).toBe(2);
    expect(parsed.get('W1')).toBe('TT');
    expect(parsed.get('W2')).toBe('FF');
  });

  it('tolerates malformed lines (no comma)', () => {
    const parsed = parseSplitsCsv('W1,TT\ngarbage line\nW2,FF');
    expect(parsed.size).toBe(2);
    expect(parsed.get('W1')).toBe('TT');
    expect(parsed.get('W2')).toBe('FF');
  });

  it('keeps empty-split rows so a caller can distinguish "cleared" from "not mentioned"', () => {
    const parsed = parseSplitsCsv('W1,');
    expect(parsed.has('W1')).toBe(true);
    expect(parsed.get('W1')).toBe('');
  });
});
