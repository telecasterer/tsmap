// Faceting metadata: the distinct-values table over wafer provenance. Phase 2 of
// the metadata plan — the honest, full-dataset answer to "what can I group /
// compare / split by?", replacing the unreliable 5-row cardinality hint in the
// CSV/JSON mapping dialog. Pure and DOM-free for testability.

import type { WaferData, WaferSource } from './types';

/** One distinct value of a facet field, with how much data it covers. */
export interface FacetValue {
  value: string;
  waferCount: number;
  dieCount: number;
}

/** A metadata field that wafers can be grouped/split on, plus its distinct values. */
export interface FacetField {
  /** Key into WaferSource (named field) or into WaferSource.extras. */
  key: string;
  /** Human-readable column label. */
  label: string;
  /** Distinct non-empty values, sorted by coverage (wafer count desc, then label). */
  values: FacetValue[];
  /**
   * True when the field has more than one distinct value across the loaded
   * wafers — i.e. splitting on it actually partitions the data. A single-value
   * (or zero-value) field is kept in the table but flagged so the UI can show
   * "nothing to split" rather than offering a pointless split.
   */
  splittable: boolean;
}

// Named WaferSource fields exposed as facets, in display order. `sourceFile` is
// included — "compare by file" is a legitimate facet. `extras` keys are appended
// dynamically after these.
const NAMED_FIELDS: Array<{ key: keyof WaferSource; label: string }> = [
  { key: 'lotId',      label: 'Lot' },
  { key: 'sublotId',   label: 'Sublot' },
  { key: 'partType',   label: 'Part type' },
  { key: 'program',    label: 'Program' },
  { key: 'testerType', label: 'Tester' },
  { key: 'nodeName',   label: 'Node' },
  { key: 'temp',       label: 'Temperature' },
  { key: 'date',       label: 'Date' },
  { key: 'sourceFile', label: 'Source file' },
];

/** Read a facet field's raw value off a wafer's source (named field or extra). */
export function facetValueOf(wafer: WaferData, key: string): string | undefined {
  const source = wafer.source;
  if (!source) return undefined;
  const named = (source as unknown as Record<string, unknown>)[key];
  if (typeof named === 'string') return named;
  const extra = source.extras?.[key];
  return typeof extra === 'string' ? extra : undefined;
}

/**
 * Build the distinct-values table over wafer provenance. One entry per metadata
 * field that has at least one non-empty value across `wafers`; each carries its
 * distinct values with wafer and die coverage. Computed over the full dataset —
 * unlike the 5-row sample hint, these counts are exact.
 */
export function buildFacetTable(wafers: WaferData[]): FacetField[] {
  // Collect candidate keys: named fields plus any extras key seen on any wafer,
  // preserving named order then first-seen order for extras.
  const extraKeys: string[] = [];
  const seenExtra = new Set<string>();
  for (const w of wafers) {
    if (!w.source?.extras) continue;
    for (const k of Object.keys(w.source.extras)) {
      if (!seenExtra.has(k)) { seenExtra.add(k); extraKeys.push(k); }
    }
  }

  const fields: Array<{ key: string; label: string }> = [
    ...NAMED_FIELDS.map(f => ({ key: f.key as string, label: f.label })),
    ...extraKeys.map(k => ({ key: k, label: k })),
  ];

  const table: FacetField[] = [];
  for (const { key, label } of fields) {
    // value → { wafers, dies }
    const byValue = new Map<string, { waferCount: number; dieCount: number }>();
    for (const w of wafers) {
      const v = facetValueOf(w, key);
      if (v === undefined || v === '') continue;
      const entry = byValue.get(v) ?? { waferCount: 0, dieCount: 0 };
      entry.waferCount += 1;
      entry.dieCount += w.results.length;
      byValue.set(v, entry);
    }
    if (byValue.size === 0) continue; // field absent across all wafers — omit entirely

    const values: FacetValue[] = Array.from(byValue, ([value, c]) => ({
      value, waferCount: c.waferCount, dieCount: c.dieCount,
    }));
    values.sort((a, b) => b.waferCount - a.waferCount || a.value.localeCompare(b.value, undefined, { numeric: true }));

    table.push({ key, label, values, splittable: values.length > 1 });
  }

  return table;
}
