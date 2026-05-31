import { invoke } from '@tauri-apps/api/core';
import type { DieResult } from '@paulrobins/wafermap';
import type { ParsedFile, WaferData, TestDef } from './types';
import { parseAtdf } from './atdfParser';

export type { ParsedFile } from './types';

// ── CSV ───────────────────────────────────────────────────────────────────────

function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? '').trim()]));
  });
}

const CSV_RESERVED = new Set(['lot', 'wafer', 'x', 'y', 'hbin', 'sbin']);

function csvRowToDieResult(row: Record<string, string>): DieResult | null {
  const x = parseInt(row['x'] ?? row['X'], 10);
  const y = parseInt(row['y'] ?? row['Y'], 10);
  if (isNaN(x) || isNaN(y)) return null;

  const hbin = parseInt(row['hbin'] ?? row['hardBin'] ?? '1', 10);
  const sbin = row['sbin'] != null ? parseInt(row['sbin'], 10) : undefined;

  const testValues: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!CSV_RESERVED.has(k.toLowerCase())) {
      const n = parseFloat(v);
      if (!isNaN(n)) testValues[k] = n;
    }
  }

  return {
    x, y, hbin,
    ...(sbin != null ? { sbin } : {}),
    ...(Object.keys(testValues).length ? { testValues } : {}),
  };
}

function parseCsv(text: string, fileName: string): ParsedFile {
  const rows = parseCsvRows(text);
  const hasWaferCol = rows.length > 0 && ('wafer' in rows[0] || 'Wafer' in rows[0]);
  const waferMap = new Map<string, DieResult[]>();

  for (const row of rows) {
    const waferId = hasWaferCol ? (row['wafer'] ?? row['Wafer'] ?? 'W1') : 'W1';
    const die = csvRowToDieResult(row);
    if (!die) continue;
    if (!waferMap.has(waferId)) waferMap.set(waferId, []);
    waferMap.get(waferId)!.push(die);
  }

  const wafers: WaferData[] = Array.from(waferMap.entries()).map(([waferId, results]) => ({ waferId, results }));

  const testDefs: Record<string, TestDef> = {};
  if (rows.length > 0) {
    for (const k of Object.keys(rows[0])) {
      if (!CSV_RESERVED.has(k.toLowerCase())) {
        testDefs[k] = { name: k, testType: 'P' };
      }
    }
  }

  return { fileName, meta: {}, wafers, testDefs };
}

// ── JSON ──────────────────────────────────────────────────────────────────────

function parseJson(text: string, fileName: string): ParsedFile {
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

// ── Shared text parser (used by both loadFile and native open) ────────────────

export function parseText(text: string, fileName: string, ext: string): ParsedFile {
  if (ext === 'json') return parseJson(text, fileName);
  if (ext === 'atdf' || ext === 'atd') return parseAtdf(text, fileName);
  return parseCsv(text, fileName);
}

// ── loadFile: browser / HTML input path (text formats only) ──────────────────

export async function loadFile(file: File): Promise<ParsedFile> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const text = await file.text();
  return parseText(text, file.name, ext);
}
