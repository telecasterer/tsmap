// Pure, DOM-free utility functions extracted from main.ts for testability.

import type { LotMeta, ParsedFile, TestDef, WaferData, WaferSource } from './types';
import type { RustParsedFile, StdfTestNames } from './platform';
import type { TestDef as WmapTestDef } from '@paulrobins/wafermap';
import type { PlotMode } from '@paulrobins/wafermap';
import type { WaferMetadata } from '@paulrobins/wafermap/renderer';

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function rustToLocal(r: RustParsedFile, fileName: string): ParsedFile {
  return { fileName, meta: r.meta, wafers: r.wafers, testDefs: r.testDefs, warnings: r.warnings };
}

/**
 * Build a `WaferSource` provenance tag from a parsed file's lot metadata and
 * filename. One instance is created per loaded file and shared by reference
 * across all wafers it produced (see stamping in main.ts) — do not call this
 * per-wafer. The lot `fields` are carried verbatim (generic key/value); the
 * curation table in metadata.ts owns labels and which fields are surfaced.
 */
export function makeWaferSource(meta: LotMeta, sourceFile: string): WaferSource {
  return { sourceFile, fields: meta.fields ?? [] };
}

// Map raw metadata keys → wmap WaferMetadata named slots, so wmap renders them
// with its own nice labels. Unknown keys pass through verbatim via the open
// index signature, so nothing is lost. `temperature` is coerced to a number.
const WMAP_META_KEY: Record<string, keyof WaferMetadata> = {
  lotId: 'lot',
  partType: 'product',
  jobName: 'testProgram',
  startT: 'testDate',
  operName: 'operator',
};

/**
 * Map a tsmap `WaferSource` to wmap's `WaferMetadata` (passed as
 * `buildWaferMap({ waferConfig: { metadata } })`). Wafer-level only — tsmap
 * does not stamp per-die `DieMetadata`. Known keys map to wmap's named slots;
 * everything else flows through wmap's open index signature.
 */
export function toWmapWaferMeta(source: WaferSource | undefined, waferId: string): WaferMetadata | undefined {
  if (!source) return undefined;
  const meta: WaferMetadata = { waferId };
  for (const { key, value } of source.fields) {
    if (key === 'testTemp') {
      const t = Number(value);
      if (Number.isFinite(t)) meta.temperature = t; else meta.testTemp = value;
    } else {
      const mapped = WMAP_META_KEY[key];
      meta[mapped ?? key] = value;
    }
  }
  return meta;
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
