import { describe, it, expect } from 'vitest';
import { parseTestListFile } from './testSelectorUI';

describe('parseTestListFile', () => {
  it('parses comma-separated number and name', () => {
    const result = parseTestListFile('1001,Continuity\n1002,Voltage');
    expect(result).toEqual([
      { num: 1001, name: 'Continuity' },
      { num: 1002, name: 'Voltage' },
    ]);
  });

  it('parses semicolon separator', () => {
    const result = parseTestListFile('1001;Continuity');
    expect(result).toEqual([{ num: 1001, name: 'Continuity' }]);
  });

  it('parses space separator', () => {
    const result = parseTestListFile('1001 Continuity');
    expect(result).toEqual([{ num: 1001, name: 'Continuity' }]);
  });

  it('parses number-only lines (no name)', () => {
    const result = parseTestListFile('1001\n1002');
    expect(result).toEqual([
      { num: 1001, name: undefined },
      { num: 1002, name: undefined },
    ]);
  });

  it('skips comment lines starting with #', () => {
    const text = '# tsmap test list\n# Saved: 2026-01-01\n1001,Foo';
    const result = parseTestListFile(text);
    expect(result).toEqual([{ num: 1001, name: 'Foo' }]);
  });

  it('skips blank lines', () => {
    const result = parseTestListFile('\n1001,A\n\n1002,B\n');
    expect(result).toHaveLength(2);
  });

  it('skips non-numeric first token', () => {
    const result = parseTestListFile('not_a_number,Foo\n1001,Bar');
    expect(result).toEqual([{ num: 1001, name: 'Bar' }]);
  });

  it('handles names with spaces (space-separated becomes joined)', () => {
    const result = parseTestListFile('1001,My First Test');
    expect(result[0].name).toBe('My First Test');
  });

  it('trims whitespace from lines', () => {
    const result = parseTestListFile('  1001  ,  Foo  ');
    expect(result[0].num).toBe(1001);
  });

  it('returns empty array for empty input', () => {
    expect(parseTestListFile('')).toEqual([]);
    expect(parseTestListFile('# comment only')).toEqual([]);
  });

  it('parses the tsmap saved format', () => {
    const saved = [
      '# tsmap test list',
      '# Saved: 2026-06-09T06:26:25.547Z',
      '1001,My first test',
      '1002,My second test',
    ].join('\n');
    const result = parseTestListFile(saved);
    expect(result).toEqual([
      { num: 1001, name: 'My first test' },
      { num: 1002, name: 'My second test' },
    ]);
  });
});
