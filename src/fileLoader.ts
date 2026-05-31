import { invoke } from '@tauri-apps/api/core';
import type { DieResult } from '@paulrobins/wafermap';
import type { ParsedFile, WaferData, TestDef } from './types';
import { parseAtdf } from './atdfParser';

export type { ParsedFile } from './types';

// ── Logging hook ──────────────────────────────────────────────────────────────
export let logFn: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {};
export function setLogFn(fn: typeof logFn) { logFn = fn; }

// ── ATDF ──────────────────────────────────────────────────────────────────────

export function parseAtdfText(text: string, fileName: string): ParsedFile {
  return parseAtdf(text, fileName);
}

// ── JSON ──────────────────────────────────────────────────────────────────────

export function parseJsonText(text: string, fileName: string): ParsedFile {
  const raw = JSON.parse(text);
  if (Array.isArray(raw)) {
    return { fileName, meta: {}, wafers: [{ waferId: 'W1', results: raw as DieResult[] }], testDefs: {} };
  }
  if (raw.wafers && Array.isArray(raw.wafers)) {
    return { fileName, meta: raw.meta ?? {}, wafers: raw.wafers, testDefs: raw.testDefs ?? {} };
  }
  const results: DieResult[] = raw.results ?? raw.dies ?? [];
  return { fileName, meta: raw.meta ?? {}, wafers: [{ waferId: raw.waferId ?? 'W1', results }], testDefs: raw.testDefs ?? {} };
}

// ── STDF (Rust backend) ───────────────────────────────────────────────────────

interface RustParsedStdf {
  meta: ParsedFile['meta'];
  wafers: WaferData[];
  testDefs: Record<string, TestDef>;
  sites: { headNum: number; siteNum: number }[];
}

export async function loadStdfPath(path: string): Promise<ParsedFile> {
  const stdf = await invoke<RustParsedStdf>('parse_stdf', { path });
  return { fileName: path.split('/').pop() ?? path, meta: stdf.meta, wafers: stdf.wafers, testDefs: stdf.testDefs };
}
