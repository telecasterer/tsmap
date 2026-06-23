import type { DieResult } from '@paulrobins/wafermap';

export interface TestDef {
  name: string;
  testType: 'P' | 'F';
  loLimit?: number;
  hiLimit?: number;
  units?: string;
}

export interface WaferData {
  waferId: string;
  results: DieResult[];
  partCount?: number;
  goodCount?: number;
  failCount?: number;
  /**
   * Provenance of this wafer — which file/lot/program it came from. Stamped at
   * merge time (see `stampSource` in main.ts). Wafers produced by the same
   * `ParsedFile` share ONE `WaferSource` instance by reference, so grouping can
   * key on referential identity and an edit to a lot's metadata is a single
   * write seen by all its wafers. Optional because pre-merge / test wafers may
   * not be stamped yet.
   */
  source?: WaferSource;
}

export interface LotMeta {
  lotId?: string;
  partType?: string;
  jobName?: string;
  testerType?: string;
  nodeName?: string;
  sublotId?: string;
}

/**
 * Wafer provenance / metadata used as a faceting dimension (group / compare /
 * split by lot, program, temperature, …). Built once per loaded file from its
 * `LotMeta` + filename and shared by reference across that file's wafers.
 *
 * `program`, `temp`, and `date` are not in today's `LotMeta` (only STDF/ATDF
 * MIR fills the base fields); until the parser is enriched they arrive via
 * `extras`. `extras` also carries CSV/JSON user-mapped metadata columns.
 */
export interface WaferSource {
  lotId?: string;
  sublotId?: string;
  partType?: string;
  program?: string;
  testerType?: string;
  nodeName?: string;
  temp?: string;
  date?: string;
  sourceFile: string;
  extras?: Record<string, string>;
}

export interface ParsedFile {
  fileName: string;
  meta: LotMeta;
  wafers: WaferData[];
  testDefs: Record<string, TestDef>;
  /** Non-fatal parser advisories to surface in the log panel. */
  warnings?: string[];
}
