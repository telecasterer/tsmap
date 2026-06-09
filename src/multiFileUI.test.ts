import { describe, it, expect } from 'vitest';
import { resolveWaferId, detectMismatches } from './multiFileUI';
import type { RenamedWafer } from './multiFileUI';
import type { WaferData } from './types';

// ── resolveWaferId ────────────────────────────────────────────────────────────

describe('resolveWaferId', () => {
  it('returns non-generic IDs unchanged', () => {
    expect(resolveWaferId('LOT123-W05', 'lot.stdf')).toBe('LOT123-W05');
  });

  it('replaces generic W<n> with filename stem', () => {
    expect(resolveWaferId('W1', 'lot_wafer3.stdf')).toBe('lot_wafer3');
  });

  it('replaces zero-padded generic IDs', () => {
    expect(resolveWaferId('W01', 'wafer01.stdf')).toBe('wafer01');
  });

  it('falls back to contentId when filename has no stem', () => {
    expect(resolveWaferId('W1', '.stdf')).toBe('W1');
  });
});

// ── detectMismatches ──────────────────────────────────────────────────────────

function makeExisting(dieCount: number, bins: number[], x = 0): WaferData {
  return {
    waferId: 'E1',
    results: Array.from({ length: dieCount }, (_, i) => ({ x: x + i, y: 0, hbin: bins[i % bins.length] })),
  };
}

function makeIncoming(id: string, dieCount: number, bins: number[], x = 0): RenamedWafer {
  return {
    waferId: id,
    results: Array.from({ length: dieCount }, (_, i) => ({ x: x + i, y: 0, hbin: bins[i % bins.length] })),
  };
}

describe('detectMismatches', () => {
  it('returns no warnings when existing is empty', () => {
    const incoming = [makeIncoming('W1', 100, [1, 2])];
    expect(detectMismatches(incoming, [])).toHaveLength(0);
  });

  it('returns no warnings for matching wafers', () => {
    const existing = [makeExisting(100, [1, 2])];
    const incoming = [makeIncoming('W2', 100, [1, 2])];
    expect(detectMismatches(incoming, existing)).toHaveLength(0);
  });

  it('warns on die count difference >5%', () => {
    const existing = [makeExisting(100, [1])];
    const incoming = [makeIncoming('W2', 50, [1])];
    const warnings = detectMismatches(incoming, existing);
    expect(warnings.some(w => w.message.includes('Die count'))).toBe(true);
  });

  it('does not warn on die count difference <=5%', () => {
    const existing = [makeExisting(100, [1])];
    const incoming = [makeIncoming('W2', 102, [1])];
    const warnings = detectMismatches(incoming, existing);
    expect(warnings.some(w => w.message.includes('Die count'))).toBe(false);
  });

  it('warns on grid size (X-span) mismatch >4', () => {
    const existing = [makeExisting(10, [1], 0)];   // X: 0..9, span 9
    const incoming = [makeIncoming('W2', 10, [1], 20)]; // X: 20..29, span 9 — same span, no warn
    expect(detectMismatches(incoming, existing)).toHaveLength(0);
  });

  it('warns on different X-span', () => {
    // existing span = 9, incoming span = 20 → diff 11 > 4
    const existing = [{ waferId: 'E1', results: Array.from({ length: 10 }, (_, i) => ({ x: i, y: 0, hbin: 1 })) }];
    const incoming = [{ waferId: 'W2', results: Array.from({ length: 21 }, (_, i) => ({ x: i, y: 0, hbin: 1 })) }];
    const warnings = detectMismatches(incoming, existing);
    expect(warnings.some(w => w.message.includes('grid size'))).toBe(true);
  });

  it('warns on hard bin set mismatch', () => {
    const existing = [makeExisting(4, [1, 2])];
    const incoming = [makeIncoming('W2', 4, [3, 4])];
    const warnings = detectMismatches(incoming, existing);
    expect(warnings.some(w => w.message.includes('bin sets'))).toBe(true);
  });

  it('warns on duplicate wafer IDs', () => {
    const existing: WaferData[] = [{ waferId: 'W1', results: [{ x: 0, y: 0, hbin: 1 }] }];
    const incoming: RenamedWafer[] = [{ waferId: 'W1', results: [{ x: 0, y: 0, hbin: 1 }] }];
    const warnings = detectMismatches(incoming, existing);
    expect(warnings.some(w => w.message.includes('Duplicate'))).toBe(true);
  });

  it('can produce multiple warnings at once', () => {
    const existing = [makeExisting(100, [1, 2])];
    const incoming = [makeIncoming('W1', 50, [3, 4])]; // die count, bin set, duplicate
    const warnings = detectMismatches(incoming, existing);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('all warnings have level warn', () => {
    const existing = [makeExisting(100, [1])];
    const incoming = [makeIncoming('W1', 50, [2])];
    for (const w of detectMismatches(incoming, existing)) {
      expect(w.level).toBe('warn');
    }
  });
});
