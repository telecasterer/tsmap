import type { DieResult } from '@paulrobins/wafermap';

export interface TestDef {
  name: string;
  testType: 'P' | 'F';
  loLimit?: number;
  hiLimit?: number;
  units?: string;
}

/**
 * One metadata field as a raw key/value pair, as emitted by the parser
 * (`@paulrobins/testdata-parser`). `key` is the source field name (camelCase
 * STDF key like `lotId`, `testTemp`, `startT`, or a CSV/JSON column name).
 * Friendly labels + which fields to surface as facets live in `metadata.ts` —
 * adding/relabelling a field never touches the parser.
 */
export interface MetaField {
  key: string;
  value: string;
}

export interface WaferData {
  waferId: string;
  results: DieResult[];
  partCount?: number;
  goodCount?: number;
  failCount?: number;
  /** Per-wafer metadata from the parser (STDF/ATDF WIR/WRR fields). */
  fields?: MetaField[];
  /**
   * Provenance of this wafer — which file/lot it came from. Stamped at merge
   * time (see `makeWaferSource`/stamping in main.ts). Wafers produced by the
   * same `ParsedFile` share ONE `WaferSource` instance by reference, so grouping
   * can key on referential identity and an edit to a lot's metadata is a single
   * write seen by all its wafers. Optional because pre-merge / test wafers may
   * not be stamped yet.
   */
  source?: WaferSource;
}

/** Lot-level metadata from the parser: an ordered list of raw key/value fields. */
export interface LotMeta {
  fields: MetaField[];
}

/**
 * Wafer provenance used as a faceting dimension (group / compare / split by lot,
 * program, temperature, …). Built once per loaded file and shared by reference
 * across that file's wafers. Generic: `fields` holds the file's lot-level
 * metadata verbatim (raw keys); tsmap's curation table maps keys → labels and
 * decides which to surface.
 */
export interface WaferSource {
  sourceFile: string;
  fields: MetaField[];
}

export interface ParsedFile {
  fileName: string;
  meta: LotMeta;
  wafers: WaferData[];
  testDefs: Record<string, TestDef>;
  /** Non-fatal parser advisories to surface in the log panel. */
  warnings?: string[];
}
