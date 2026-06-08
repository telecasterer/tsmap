// Platform abstraction — switches between Tauri IPC (native) and WASM (web).
// main.ts calls platform.* for all I/O; render/chart code is untouched.

import type { CsvMapping } from './mappingUI';
import type { LotMeta, WaferData, TestDef } from './types';

export interface RustParsedFile {
  meta: LotMeta;
  wafers: WaferData[];
  testDefs: Record<string, TestDef>;
  sites?: unknown[];
}

export interface HeadersResult {
  headers: string[];
  sample: Record<string, string>[];
  rowCount: number;
}

export interface FileHandle {
  name: string;
  bytes: Uint8Array;
  /** Native path — set by tauriPlatform, undefined in webPlatform. */
  path?: string;
}

export type StdfTestNames = Record<string, TestDef>;

export interface Platform {
  pickFiles(): Promise<FileHandle[]>;
  expandArchives(files: FileHandle[]): Promise<FileHandle[]>;
  parseStdf(file: FileHandle): Promise<RustParsedFile>;
  parseAtdf(file: FileHandle): Promise<RustParsedFile>;
  parseCsv(file: FileHandle, mapping: CsvMapping): Promise<RustParsedFile>;
  parseJson(file: FileHandle, mapping: CsvMapping): Promise<RustParsedFile>;
  csvHeaders(file: FileHandle): Promise<HeadersResult>;
  jsonHeaders(file: FileHandle): Promise<HeadersResult>;
  savePng(blob: Blob, stem: string): Promise<void>;
  openReport(html: string): void;
  stdfTestNames(file: FileHandle): Promise<StdfTestNames>;
  atdfTestNames(file: FileHandle): Promise<StdfTestNames>;
  parseStdfFiltered(file: FileHandle, selected: number[]): Promise<RustParsedFile>;
  parseAtdfFiltered(file: FileHandle, selected: number[]): Promise<RustParsedFile>;
}

// ── Tauri platform ────────────────────────────────────────────────────────────

function makeTauriPlatform(): Platform {
  // Lazy imports so the module never fails to load in the browser
  const getInvoke = () => import('@tauri-apps/api/core').then(m => m.invoke);
  const getDialog = () => import('@tauri-apps/plugin-dialog');
  const getFs = () => import('@tauri-apps/plugin-fs');

  return {
    async pickFiles() {
      const { invoke } = await import('@tauri-apps/api/core');
      const { open: dialogOpen } = await import('@tauri-apps/plugin-dialog');
      const lastDir = await invoke<string | null>('get_last_dir').catch(() => null);
      const result = await dialogOpen({
        multiple: true,
        defaultPath: lastDir ?? undefined,
        filters: [
          { name: 'Wafer map files', extensions: ['stdf', 'std', 'atdf', 'atd', 'csv', 'json', 'gz', 'zip'] },
          { name: 'STDF', extensions: ['stdf', 'std'] },
          { name: 'ATDF', extensions: ['atdf', 'atd'] },
          { name: 'CSV / JSON', extensions: ['csv', 'json'] },
          { name: 'Archives', extensions: ['gz', 'zip'] },
        ],
      });
      const paths = Array.isArray(result) ? result : result ? [result] : [];
      if (paths.length > 0) invoke('set_last_dir', { path: paths[0] }).catch(() => {});
      return paths.map(path => ({
        name: path.split(/[\\/]/).pop() ?? path,
        bytes: new Uint8Array(0),
        path,
      }));
    },

    async expandArchives(files) {
      const invoke = await getInvoke();
      const expanded: FileHandle[] = [];
      for (const f of files) {
        if (f.path && f.name.toLowerCase().endsWith('.zip')) {
          const extracted = await invoke<string[]>('extract_archive', { path: f.path });
          for (const p of extracted) {
            expanded.push({ name: p.split(/[\\/]/).pop() ?? p, bytes: new Uint8Array(0), path: p });
          }
        } else {
          expanded.push(f);
        }
      }
      return expanded;
    },

    async parseStdf(file) {
      const invoke = await getInvoke();
      return invoke<RustParsedFile>('parse_stdf', { path: file.path });
    },

    async parseAtdf(file) {
      const invoke = await getInvoke();
      return invoke<RustParsedFile>('parse_atdf', { path: file.path });
    },

    async parseCsv(file, mapping) {
      const invoke = await getInvoke();
      return invoke<RustParsedFile>('parse_csv', { path: file.path, mapping });
    },

    async parseJson(file, mapping) {
      const invoke = await getInvoke();
      return invoke<RustParsedFile>('parse_json', { path: file.path, mapping });
    },

    async csvHeaders(file) {
      const invoke = await getInvoke();
      return invoke<HeadersResult>('csv_headers', { path: file.path });
    },

    async jsonHeaders(file) {
      const invoke = await getInvoke();
      return invoke<HeadersResult>('json_headers', { path: file.path });
    },

    async savePng(blob, stem) {
      const { save: dialogSave } = await getDialog();
      const { writeFile } = await getFs();
      const path = await dialogSave({
        defaultPath: `${stem}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      });
      if (path) {
        const buf = await blob.arrayBuffer();
        await writeFile(path, new Uint8Array(buf));
      }
    },

    openReport(html) {
      getInvoke().then(invoke => invoke('write_temp_html', { html }));
    },

    async stdfTestNames(file) {
      const invoke = await getInvoke();
      return invoke<StdfTestNames>('stdf_test_names', { path: file.path });
    },

    async atdfTestNames(file) {
      const invoke = await getInvoke();
      return invoke<StdfTestNames>('atdf_test_names', { path: file.path });
    },

    async parseStdfFiltered(file, selected) {
      const invoke = await getInvoke();
      return invoke<RustParsedFile>('parse_stdf_filtered', { path: file.path, selected });
    },

    async parseAtdfFiltered(file, selected) {
      const invoke = await getInvoke();
      return invoke<RustParsedFile>('parse_atdf_filtered', { path: file.path, selected });
    },
  };
}

// ── WASM platform ─────────────────────────────────────────────────────────────

type WasmModule = typeof import('@paulrobins/testdata-parser');
let wasmModule: WasmModule | null = null;

async function loadWasm(): Promise<WasmModule> {
  if (wasmModule) return wasmModule;
  // Import the WASM binary URL via Vite's ?url suffix so Vite resolves and
  // copies the asset correctly. Without this, the package's own import.meta.url
  // resolution points to node_modules and the dev server returns 404 HTML.
  const wasmUrl = new URL('@paulrobins/testdata-parser/testdata_parser_bg.wasm', import.meta.url);
  const mod = await import('@paulrobins/testdata-parser');
  await (mod.default as (url: URL) => Promise<unknown>)(wasmUrl);
  wasmModule = mod;
  return mod;
}

/** Decompress a .gz file using the browser's native DecompressionStream. */
async function decompressGzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(bytes as unknown as ArrayBuffer);
  writer.close();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Extract a .zip archive, returning all contained files as FileHandles. */
async function extractZip(bytes: Uint8Array): Promise<FileHandle[]> {
  const { unzipSync } = await import('fflate');
  const files = unzipSync(bytes);
  return Object.entries(files).map(([name, data]) => ({ name, bytes: data }));
}

/** Parse CSV bytes: detect delimiter, extract headers, sample rows, count rows. */
function parseCsvHeaders(bytes: Uint8Array): HeadersResult {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  const firstLine = lines[0] ?? '';
  const commas = firstLine.split(',').length - 1;
  const tabs = firstLine.split('\t').length - 1;
  const semis = firstLine.split(';').length - 1;
  const delim = tabs >= commas && tabs >= semis ? '\t' : semis > commas ? ';' : ',';

  const headers = firstLine.split(delim).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const sample: Record<string, string>[] = [];
  for (let i = 1; i < Math.min(lines.length, 6); i++) {
    const row: Record<string, string> = {};
    const cells = lines[i].split(delim);
    headers.forEach((h, j) => { row[h] = (cells[j] ?? '').trim().replace(/^["']|["']$/g, ''); });
    sample.push(row);
  }
  return { headers, sample, rowCount: lines.length - 1 };
}

/** Parse JSON bytes: extract column names and sample rows. */
function parseJsonHeaders(bytes: Uint8Array): HeadersResult {
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text);
  const arr: unknown[] = Array.isArray(parsed) ? parsed : [];

  // Detect nested shape: [{ waferId, results: [{die}] }]
  const firstItem = arr[0];
  const rows: Record<string, unknown>[] =
    firstItem && typeof firstItem === 'object' && Array.isArray((firstItem as Record<string, unknown>).results)
      ? (arr as Array<{ results: unknown[] }>).flatMap(w => w.results as Record<string, unknown>[])
      : arr as Record<string, unknown>[];

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const sample = rows.slice(0, 5).map(r =>
    Object.fromEntries(headers.map(h => [h, String(r[h] ?? '')]))
  );
  return { headers, sample, rowCount: rows.length };
}

function makeWebPlatform(): Platform {
  return {
    // Web file picking is handled directly in main.ts via <input id="file-input">
    // so the click stays in the synchronous user-gesture chain.
    async pickFiles() { return []; },

    async expandArchives(files) {
      const expanded: FileHandle[] = [];
      for (const f of files) {
        const lower = f.name.toLowerCase();
        if (lower.endsWith('.zip')) {
          const inner = await extractZip(f.bytes);
          expanded.push(...inner);
        } else if (lower.endsWith('.gz')) {
          const decompressed = await decompressGzip(f.bytes);
          // Strip .gz to get the inner filename
          expanded.push({ name: f.name.slice(0, -3), bytes: decompressed });
        } else {
          expanded.push(f);
        }
      }
      return expanded;
    },

    async parseStdf(file) {
      const wasm = await loadWasm();
      return wasm.parse_stdf(file.bytes) as RustParsedFile;
    },

    async parseAtdf(file) {
      const wasm = await loadWasm();
      return wasm.parse_atdf(file.bytes) as RustParsedFile;
    },

    async parseCsv(file, mapping) {
      const wasm = await loadWasm();
      return wasm.parse_csv(file.bytes, mapping) as RustParsedFile;
    },

    async parseJson(file, mapping) {
      const wasm = await loadWasm();
      return wasm.parse_json(file.bytes, mapping) as RustParsedFile;
    },

    async csvHeaders(file) {
      return parseCsvHeaders(file.bytes);
    },

    async jsonHeaders(file) {
      return parseJsonHeaders(file.bytes);
    },

    async savePng(blob, stem) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${stem}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    openReport(html) {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },

    async stdfTestNames(file) {
      const wasm = await loadWasm();
      return wasm.stdf_test_names(file.bytes) as StdfTestNames;
    },

    async atdfTestNames(file) {
      const wasm = await loadWasm();
      return wasm.atdf_test_names(file.bytes) as StdfTestNames;
    },

    async parseStdfFiltered(file, selected) {
      const wasm = await loadWasm();
      return wasm.parse_stdf_filtered(file.bytes, selected) as RustParsedFile;
    },

    async parseAtdfFiltered(file, selected) {
      const wasm = await loadWasm();
      return wasm.parse_atdf_filtered(file.bytes, selected) as RustParsedFile;
    },
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

export const isTauri = '__TAURI_INTERNALS__' in window;

export function createPlatform(): Platform {
  return isTauri ? makeTauriPlatform() : makeWebPlatform();
}
