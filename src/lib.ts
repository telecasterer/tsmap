// Pure, DOM-free utility functions extracted from main.ts for testability.

import type { LotMeta, MetaField, ParsedFile, TestDef, TestOverride, WaferData, WaferSource } from './types';
import type { RustParsedFile, StdfTestNames } from './platform';
import type { TestDef as WmapTestDef } from '@paulrobins/wafermap';
import type { PlotMode } from '@paulrobins/wafermap';
import type { WaferMetadata } from '@paulrobins/wafermap/renderer';

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * Extracts a displayable message from a caught error. Tauri's `invoke()`
 * rejects with whatever the Rust command's `Err` serialises to — for
 * `Result<T, String>` that's a plain string, not an `Error` instance — so
 * `(e as Error).message` on it silently reads as `undefined` and swallows the
 * real diagnostic (this hid the root cause of a real bug once already). Use
 * this everywhere a caught value is turned into a log/toast message instead.
 */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
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

/**
 * Reconstruct a `WaferData` from a wafer-shaped object, carrying EVERY
 * `WaferData` field across. The rename/merge flow rebuilds wafers at several
 * points; routing them all through this one helper means adding a field to
 * `WaferData` is a single edit here, not N field-by-field copy sites that
 * silently drop the new field (per-wafer `fields` was lost exactly that way).
 * Preserves the shared `source` reference — do not deep-clone.
 */
export function toWaferData(w: Pick<WaferData, 'waferId' | 'results'> & Partial<WaferData>): WaferData {
  return {
    waferId: w.waferId,
    results: w.results,
    partCount: w.partCount,
    goodCount: w.goodCount,
    failCount: w.failCount,
    fields: w.fields,
    source: w.source,
  };
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
  splitLabel: 'split',
};

/**
 * Map a tsmap `WaferSource` (lot-level) plus optional per-wafer fields to
 * wmap's `WaferMetadata` (passed as `buildWaferMap({ waferConfig: { metadata } })`).
 * Known keys map to wmap's named slots; everything else flows through wmap's
 * open index signature. `waferFields` (e.g. a wafer's split assignment, see
 * `splits.ts`) is applied after `source.fields` so a per-wafer value wins
 * over a same-named lot-level one — previously omitted entirely, which meant
 * splits were invisible to wmap (its own summary panel/report had no way to
 * know a wafer's split; only tsmap's own separate charts code did, by
 * reading `getSplitLabel` directly instead of going through wmap's metadata).
 */
export function toWmapWaferMeta(source: WaferSource | undefined, waferId: string, waferFields?: MetaField[]): WaferMetadata | undefined {
  if (!source && !waferFields?.length) return undefined;
  const meta: WaferMetadata = { waferId };
  const applyField = ({ key, value }: MetaField) => {
    if (key === 'testTemp') {
      const t = Number(value);
      if (Number.isFinite(t)) meta.temperature = t; else meta.testTemp = value;
    } else {
      const mapped = WMAP_META_KEY[key];
      meta[mapped ?? key] = value;
    }
  };
  for (const f of source?.fields ?? []) applyField(f);
  for (const f of waferFields ?? []) applyField(f);
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
    testType: def.testType,
  }));
}

export function autoPlotMode(wafers: WaferData[]): PlotMode {
  const sample = wafers[0]?.results ?? [];
  const hasHbin = sample.some(d => d.hbin !== undefined);
  const hasSbin = sample.some(d => d.sbin !== undefined);
  const hasValues = sample.some(d =>
    (d.testValues && Object.keys(d.testValues).length > 0) ||
    (d.testPass && Object.keys(d.testPass).length > 0));
  return hasHbin ? 'hardBin' : hasSbin ? 'softBin' : hasValues ? 'value' : 'hardBin';
}

/**
 * Merges per-test overrides (name/loLimit/hiLimit/units/testType) onto
 * `testDefs` in place. A field is only overwritten when the override
 * actually specifies it (`!== undefined`) — this is what lets a rename-only
 * override leave limits untouched, a limit-only override leave the name
 * untouched, etc. Overrides for test numbers not present in `testDefs` are
 * silently ignored.
 */
export function applyTestOverrides(
  testDefs: Record<string, TestDef>,
  overrides: Map<number, TestOverride>,
): void {
  for (const [num, ov] of overrides) {
    const key = String(num);
    if (!(key in testDefs)) continue;
    // Functional tests (FTR — pass/fail only) never have a numeric measured
    // value to check a spec limit against, so a loLimit/hiLimit override is
    // meaningless dead data there — silently drop it rather than carry it
    // into TestDef. Effective type is the override's own testType if this
    // row supplies one (an explicit reclassification), else the test's
    // existing parsed type.
    const effectiveType = ov.testType ?? testDefs[key].testType;
    const allowLimits = effectiveType !== 'F';
    testDefs[key] = {
      ...testDefs[key],
      ...(ov.name !== undefined ? { name: ov.name } : {}),
      ...(allowLimits && ov.loLimit !== undefined ? { loLimit: ov.loLimit } : {}),
      ...(allowLimits && ov.hiLimit !== undefined ? { hiLimit: ov.hiLimit } : {}),
      ...(ov.units !== undefined ? { units: ov.units } : {}),
      ...(ov.testType !== undefined ? { testType: ov.testType } : {}),
    };
  }
}

/**
 * Diffs two TestDefs for the fields TestOverride can carry, returning only
 * the fields that actually differ (or `undefined` if none do). Used to seed
 * a fresh selector re-open with whatever overrides are already baked into
 * `current` but not reflected in `original` (e.g. re-opening "Filter tests…"
 * after an earlier rename/limit-load pass).
 */
export function diffTestOverride(current: TestDef, original: TestDef): TestOverride | undefined {
  const ov: TestOverride = {};
  if (current.name !== original.name) ov.name = current.name;
  if (current.loLimit !== original.loLimit) ov.loLimit = current.loLimit;
  if (current.hiLimit !== original.hiLimit) ov.hiLimit = current.hiLimit;
  if (current.units !== original.units) ov.units = current.units;
  if (current.testType !== original.testType) ov.testType = current.testType;
  return Object.keys(ov).length ? ov : undefined;
}

/**
 * Prune, backfill, and apply test overrides to a parsed file's testDefs and
 * die testValues after a filtered parse.
 *
 * - Prunes testDefs and per-die testValues to only the selected test numbers.
 * - Backfills any selected tests missing from testDefs (stop-on-fail gap) from
 *   firstPassDefs when provided.
 * - Applies testOverrides on top of whatever was in testDefs (see applyTestOverrides).
 *
 * Mutates `parsed` in place and returns it.
 */
export function applyTestSelection(
  parsed: ParsedFile,
  selection: number[],
  firstPassDefs: StdfTestNames | null,
  testOverrides: Map<number, TestOverride>,
): ParsedFile {
  const selectionSet = new Set(selection.map(String));

  // Prune testDefs to selection.
  for (const key of Object.keys(parsed.testDefs)) {
    if (!selectionSet.has(key)) delete parsed.testDefs[key];
  }

  // Prune per-die testValues and testPass to selection.
  for (const wafer of parsed.wafers) {
    for (const die of wafer.results) {
      if (die.testValues) {
        for (const key of Object.keys(die.testValues)) {
          if (!selectionSet.has(key)) delete die.testValues[Number(key)];
        }
      }
      if (die.testPass) {
        for (const key of Object.keys(die.testPass)) {
          if (!selectionSet.has(key)) delete die.testPass[Number(key)];
        }
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

  applyTestOverrides(parsed.testDefs, testOverrides);

  return parsed;
}
