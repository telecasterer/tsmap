// Wafer splits: a user-assigned grouping axis (process corners like TT/FF/FS,
// or any ad-hoc experiment group) layered on top of the existing metadata
// faceting system. A split is stored as an ordinary per-wafer MetaField, so
// `buildFacetTable` (metadata.ts) picks it up for free and every existing
// grouped chart works with zero changes — this module only owns get/set,
// enumerating known values, and CSV round-trip.

import type { WaferData } from './types';

export const SPLIT_FIELD_KEY = 'splitLabel';

/** The split assigned to a wafer, if any. Per-wafer only — never `source.fields`,
 * since a split lot puts different wafers from the same file through different
 * conditions. */
export function getSplitLabel(wafer: WaferData): string | undefined {
  return wafer.fields?.find(f => f.key === SPLIT_FIELD_KEY)?.value;
}

/** The wafer ID as shown in map/gallery titles, cards, and summary panels —
 * the raw ID, plus " · <split>" when the wafer has a split assigned and the
 * caller opts in (the "Show split in wafer map labels" checkbox in the splits
 * modal). Never use this as a lookup/matching key — only `wafer.waferId` is
 * stable for CSV round-trip, localStorage, and dedup. */
export function waferDisplayLabel(wafer: WaferData, showSplit: boolean): string {
  if (!showSplit) return wafer.waferId;
  const split = getSplitLabel(wafer);
  return split ? `${wafer.waferId} · ${split}` : wafer.waferId;
}

/** Assign (or clear, with `undefined`/empty) a wafer's split. Mutates in place,
 * consistent with how `wafer.fields` is already built and passed by reference. */
export function setSplitLabel(wafer: WaferData, label: string | undefined): void {
  const trimmed = label?.trim();
  const fields = wafer.fields ?? (wafer.fields = []);
  const idx = fields.findIndex(f => f.key === SPLIT_FIELD_KEY);
  if (!trimmed) {
    if (idx >= 0) fields.splice(idx, 1);
    return;
  }
  if (idx >= 0) fields[idx] = { key: SPLIT_FIELD_KEY, value: trimmed };
  else fields.push({ key: SPLIT_FIELD_KEY, value: trimmed });
}

/** Clear every wafer's split assignment (the "Clear all" action in the splits
 * modal — distinct from clearing just the currently-selected rows). */
export function clearAllSplits(wafers: WaferData[]): void {
  for (const w of wafers) setSplitLabel(w, undefined);
}

/** Distinct split values currently in use, first-seen order — for populating
 * the assignment combobox with existing names before the user types a new one. */
export function listSplitValues(wafers: WaferData[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of wafers) {
    const v = getSplitLabel(w);
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/** Parse a `waferId,split` CSV (comment lines starting `#` and a `waferId,split`
 * header row are both skipped) into a waferId -> split map. Unassigned rows
 * (empty split column) are kept in the map with an empty string, so a caller
 * applying the result can distinguish "explicitly cleared" from "not mentioned". */
export function parseSplitsCsv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const commaIdx = line.indexOf(',');
    if (commaIdx < 0) continue;
    const waferId = line.slice(0, commaIdx).trim();
    const split = line.slice(commaIdx + 1).trim();
    if (!waferId || waferId.toLowerCase() === 'waferid') continue;
    map.set(waferId, split);
  }
  return map;
}

/** Serialize current split assignments for every loaded wafer to CSV, for
 * `platform.saveTextFile`. Unassigned wafers get an empty split column. */
export function formatSplitsCsv(wafers: WaferData[]): string {
  const lines = [
    '# tsmap wafer splits',
    `# Saved: ${new Date().toISOString()}`,
    'waferId,split',
    ...wafers.map(w => `${w.waferId},${getSplitLabel(w) ?? ''}`),
  ];
  return lines.join('\n');
}
