import { invoke } from '@tauri-apps/api/core';
import type { ParsedFile, WaferData, TestDef } from './types';

export type { ParsedFile } from './types';

// ── Logging hook ──────────────────────────────────────────────────────────────
export let logFn: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {};
export function setLogFn(fn: typeof logFn) { logFn = fn; }

// ── STDF (Rust backend) ───────────────────────────────────────────────────────

interface RustParsedStdf {
  meta: ParsedFile['meta'];
  wafers: WaferData[];
  testDefs: Record<string, TestDef>;
  sites: { headNum: number; siteNum: number }[];
}

export async function loadStdfPath(path: string): Promise<ParsedFile> {
  const stdf = await invoke<RustParsedStdf>('parse_stdf', { path });
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return { fileName, meta: stdf.meta, wafers: stdf.wafers, testDefs: stdf.testDefs };
}
