import { invoke } from '@tauri-apps/api/core';
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
