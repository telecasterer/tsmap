import { describe, it, expect } from 'vitest';
import { tokenize, detectRole } from './mappingUI';

const noSample: Record<string, string>[] = [];
const numericSample = (col: string, val = '1.5'): Record<string, string>[] => [{ [col]: val }];

// ── tokenize ──────────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('splits snake_case', () => expect(tokenize('die_x')).toEqual(['die', 'x']));
  it('splits camelCase', () => expect(tokenize('waferIndex')).toEqual(['wafer', 'index']));
  it('splits PascalCase', () => expect(tokenize('WaferID')).toEqual(['wafer', 'id']));
  it('splits dash-case', () => expect(tokenize('hard-bin')).toEqual(['hard', 'bin']));
  it('lowercases all tokens', () => expect(tokenize('HardBin')).toEqual(['hard', 'bin']));
  it('filters empty tokens', () => expect(tokenize('_x_')).toEqual(['x']));
});

// ── detectRole ────────────────────────────────────────────────────────────────

describe('detectRole — x/y', () => {
  it.each(['x', 'die_x', 'xloc', 'col', 'column', 'step_x'])('detects x: %s', col => {
    expect(detectRole(col, noSample)).toBe('x');
  });
  it.each(['y', 'die_y', 'yloc', 'row', 'step_y'])('detects y: %s', col => {
    expect(detectRole(col, noSample)).toBe('y');
  });
});

describe('detectRole — bins', () => {
  it.each(['hbin', 'hard_bin', 'bin', 'hardbin'])('detects hbin: %s', col => {
    expect(detectRole(col, noSample)).toBe('hbin');
  });
  it.each(['sbin', 'soft_bin', 'softbin'])('detects sbin: %s', col => {
    expect(detectRole(col, noSample)).toBe('sbin');
  });
});

describe('detectRole — wafer / lot', () => {
  it.each(['wafer', 'wafer_id', 'wfr_id', 'wafernum'])('detects wafer: %s', col => {
    expect(detectRole(col, noSample)).toBe('wafer');
  });
  it.each(['lot', 'lot_id', 'lotid'])('detects lot: %s', col => {
    expect(detectRole(col, noSample)).toBe('lot');
  });
});

describe('detectRole — limits / units', () => {
  it.each(['lo_limit', 'low_limit', 'lsl', 'min_limit'])('detects loLimit: %s', col => {
    expect(detectRole(col, noSample)).toBe('loLimit');
  });
  it.each(['hi_limit', 'high_limit', 'usl', 'max_limit'])('detects hiLimit: %s', col => {
    expect(detectRole(col, noSample)).toBe('hiLimit');
  });
  it.each(['units', 'unit', 'uom'])('detects units: %s', col => {
    expect(detectRole(col, noSample)).toBe('units');
  });
});

describe('detectRole — test vs metadata fallback', () => {
  it('classifies numeric column as test', () => {
    expect(detectRole('leakage_current', numericSample('leakage_current'))).toBe('test');
  });
  it('classifies non-numeric column as metadata', () => {
    expect(detectRole('device', [{ device: 'ASIC-42' }])).toBe('metadata');
  });
  it('classifies numeric column with NON_TEST_TOKEN as metadata', () => {
    expect(detectRole('site_id', numericSample('site_id'))).toBe('metadata');
  });
  it('classifies empty-sample numeric-looking column as metadata', () => {
    // No sample data — cannot confirm numeric
    expect(detectRole('mystery', noSample)).toBe('metadata');
  });
});
