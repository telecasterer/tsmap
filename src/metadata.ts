// Faceting metadata: the distinct-values table over wafer provenance — the
// honest, full-dataset answer to "what can I group / compare / split by?".
// Pure and DOM-free for testability.
//
// The parser (`@paulrobins/testdata-parser`) emits ALL non-empty metadata
// fields generically as { key, value } (raw STDF/ATDF keys + CSV/JSON column
// names). This module owns the *curation*: friendly labels, which fields to
// surface as facets, and which are dates (grouped by day). Adding, relabelling,
// or hiding a field is a change here only — never a parser republish.

import type { WaferData } from './types';

/** One distinct value of a facet field, with how much data it covers. */
export interface FacetValue {
  value: string;
  waferCount: number;
  dieCount: number;
}

/** A metadata field that wafers can be grouped/split on, plus its distinct values. */
export interface FacetField {
  /** Raw metadata key (e.g. `lotId`, `testTemp`, or a CSV column name). */
  key: string;
  /** Human-readable column label (curated, or the raw key for unknown fields). */
  label: string;
  /** Distinct non-empty values, sorted by coverage (wafer count desc, then label). */
  values: FacetValue[];
  /**
   * True when the field has more than one distinct value across the loaded
   * wafers — i.e. splitting on it actually partitions the data. A single-value
   * field is kept in the table but flagged so the UI can show "nothing to split".
   */
  splittable: boolean;
}

/** Curation entry for a known metadata key. */
interface FieldMeta {
  label: string;
  /** Show this field in the facet dropdown by default. */
  facet: boolean;
  /** Value is an ISO datetime; facet by its date portion only. */
  date?: boolean;
}

// Curated known fields: friendly label + whether surfaced as a facet by default
// + date handling. Order here is the display order in the facet dropdown; keys
// not listed still appear (labelled by their raw key) unless HIDDEN_KEYS lists
// them. Edit this table freely — no parser change needed.
const FIELD_META: Record<string, FieldMeta> = {
  // High-value faceting axes, shown first.
  lotId:      { label: 'Lot',         facet: true },
  sublotId:   { label: 'Sublot',      facet: true },
  partType:   { label: 'Part type',   facet: true },
  jobName:    { label: 'Program',     facet: true },
  testTemp:   { label: 'Temperature', facet: true },
  startT:     { label: 'Test date',   facet: true, date: true },
  testerType: { label: 'Tester',      facet: true },
  nodeName:   { label: 'Node',        facet: true },
  operName:   { label: 'Operator',    facet: true },
  // Wafer-level (WIR/WRR).
  frameId:    { label: 'Frame',       facet: true },
  maskId:     { label: 'Mask',        facet: true },
  fabWaferId: { label: 'Fab wafer ID', facet: true },
  // Present but low cardinality / rarely useful to split on — labelled, not
  // offered as a default facet (still shown if they happen to vary).
  jobRev:     { label: 'Program rev',  facet: false },
  execType:   { label: 'Exec type',    facet: false },
  execVer:    { label: 'Exec version', facet: false },
  testCode:   { label: 'Test code',    facet: false },
  flowId:     { label: 'Flow',         facet: false },
  specName:   { label: 'Spec',         facet: false },
  specVer:    { label: 'Spec version', facet: false },
  familyId:   { label: 'Family',       facet: false },
  dateCode:   { label: 'Date code',    facet: false },
  facilityId: { label: 'Facility',     facet: false },
  floorId:    { label: 'Floor',        facet: false },
  processId:  { label: 'Process',      facet: false },
  designRev:  { label: 'Design rev',   facet: false },
  serialNum:  { label: 'Tester serial', facet: false },
};

const DISPLAY_ORDER = Object.keys(FIELD_META);

function labelFor(key: string): string {
  return FIELD_META[key]?.label ?? key;
}

/** Truncate an ISO datetime (or any string) to its date portion `YYYY-MM-DD`. */
function dateOnly(value: string): string {
  const t = value.indexOf('T');
  return t > 0 ? value.slice(0, t) : value;
}

/** Look up a field's value across a wafer's lot-level (source) and per-wafer fields. */
function rawValueOf(wafer: WaferData, key: string): string | undefined {
  const fromSource = wafer.source?.fields.find(f => f.key === key)?.value;
  if (fromSource !== undefined) return fromSource;
  return wafer.fields?.find(f => f.key === key)?.value;
}

/**
 * The faceting value of a field for a wafer: the raw value, except date-typed
 * fields are truncated to date-only so grouping is by day, not timestamp.
 */
export function facetValueOf(wafer: WaferData, key: string): string | undefined {
  const raw = rawValueOf(wafer, key);
  if (raw === undefined || raw === '') return undefined;
  return FIELD_META[key]?.date ? dateOnly(raw) : raw;
}

/**
 * Build the distinct-values table over wafer provenance. Reads both lot-level
 * (`source.fields`) and per-wafer (`wafer.fields`) metadata. One entry per field
 * that has at least one non-empty value; curated fields appear first in display
 * order, unknown fields after (labelled by raw key). Counts are exact over the
 * full dataset.
 *
 * `facetableOnly` (default true) restricts to fields curated `facet: true` plus
 * any unknown field (so newly-emitted parser fields surface without curation);
 * pass false to include the low-value curated fields too.
 */
export function buildFacetTable(wafers: WaferData[], facetableOnly = true): FacetField[] {
  // Collect every distinct key present, in curated display order then first-seen.
  const present = new Set<string>();
  for (const w of wafers) {
    for (const f of w.source?.fields ?? []) present.add(f.key);
    for (const f of w.fields ?? []) present.add(f.key);
  }

  const ordered: string[] = [
    ...DISPLAY_ORDER.filter(k => present.has(k)),
    ...[...present].filter(k => !(k in FIELD_META)),
  ];

  const table: FacetField[] = [];
  for (const key of ordered) {
    const known = FIELD_META[key];
    // Surface curated facet fields and any unknown field; skip curated-but-not-facet
    // fields unless explicitly asked for.
    if (facetableOnly && known && !known.facet) continue;

    const byValue = new Map<string, { waferCount: number; dieCount: number }>();
    for (const w of wafers) {
      const v = facetValueOf(w, key);
      if (v === undefined || v === '') continue;
      const entry = byValue.get(v) ?? { waferCount: 0, dieCount: 0 };
      entry.waferCount += 1;
      entry.dieCount += w.results.length;
      byValue.set(v, entry);
    }
    if (byValue.size === 0) continue;

    const values: FacetValue[] = Array.from(byValue, ([value, c]) => ({
      value, waferCount: c.waferCount, dieCount: c.dieCount,
    }));
    values.sort((a, b) => b.waferCount - a.waferCount || a.value.localeCompare(b.value, undefined, { numeric: true }));

    table.push({ key, label: labelFor(key), values, splittable: values.length > 1 });
  }

  return table;
}
