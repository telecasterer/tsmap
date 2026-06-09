// Pure, DOM-free utility functions extracted from main.ts for testability.

import type { ParsedFile, TestDef, WaferData } from './types';
import type { RustParsedFile, StdfTestNames } from './platform';
import type { TestDef as WmapTestDef } from '@paulrobins/wafermap';
import type { PlotMode } from '@paulrobins/wafermap';

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function rustToLocal(r: RustParsedFile, fileName: string): ParsedFile {
  return { fileName, meta: r.meta, wafers: r.wafers, testDefs: r.testDefs };
}

/** Convert tsmap's `Record<string, TestDef>` to wmap's `TestDef[]`. */
export function toWmapTestDefs(testDefs: Record<string, TestDef>): WmapTestDef[] {
  return Object.entries(testDefs).map(([key, def]) => ({
    testNumber: Number(key),
    name: def.name || `Test ${key}`,
    unit: def.units,
    limitLow: def.loLimit,
    limitHigh: def.hiLimit,
  }));
}

export function autoPlotMode(wafers: WaferData[]): PlotMode {
  const sample = wafers[0]?.results ?? [];
  const hasHbin = sample.some(d => d.hbin !== undefined);
  const hasSbin = sample.some(d => d.sbin !== undefined);
  const hasValues = sample.some(d => d.testValues && Object.keys(d.testValues).length > 0);
  return hasHbin ? 'hardBin' : hasSbin ? 'softBin' : hasValues ? 'value' : 'hardBin';
}

/**
 * Prune, backfill, and apply name overrides to a parsed file's testDefs and
 * die testValues after a filtered parse.
 *
 * - Prunes testDefs and per-die testValues to only the selected test numbers.
 * - Backfills any selected tests missing from testDefs (stop-on-fail gap) from
 *   firstPassDefs when provided.
 * - Applies nameOverrides on top of whatever names were in testDefs.
 *
 * Mutates `parsed` in place and returns it.
 */
export function applyTestSelection(
  parsed: ParsedFile,
  selection: number[],
  firstPassDefs: StdfTestNames | null,
  nameOverrides: Map<number, string>,
): ParsedFile {
  const selectionSet = new Set(selection.map(String));

  // Prune testDefs to selection.
  for (const key of Object.keys(parsed.testDefs)) {
    if (!selectionSet.has(key)) delete parsed.testDefs[key];
  }

  // Prune per-die testValues to selection.
  for (const wafer of parsed.wafers) {
    for (const die of wafer.results) {
      if (!die.testValues) continue;
      for (const key of Object.keys(die.testValues)) {
        if (!selectionSet.has(key)) delete die.testValues[Number(key)];
      }
    }
  }

  // Backfill selected tests missing due to stop-on-fail.
  if (firstPassDefs) {
    for (const key of selection.map(String)) {
      if (!(key in parsed.testDefs) && key in firstPassDefs) {
        parsed.testDefs[key] = firstPassDefs[key];
      }
    }
  }

  // Apply name overrides.
  for (const [num, name] of nameOverrides) {
    const key = String(num);
    if (key in parsed.testDefs) {
      parsed.testDefs[key] = { ...parsed.testDefs[key], name };
    }
  }

  return parsed;
}
