// Web parser worker — runs the testdata-parser WASM module off the main thread
// so large STDF/ATDF files don't freeze the page. The Tauri build parses in
// native Rust (spawn_blocking) and never loads this worker.
//
// Protocol: the host posts { id, op, bytes, mapping?, selected? } and transfers
// the bytes ArrayBuffer. The worker replies { id, ok, result } or { id, ok:false,
// error }. Requests are correlated by id. A panic inside WASM becomes a trap that
// fires the worker's global 'error' event; the host side rejects all pending
// promises in that case (see platform.ts).

import type { CsvMapping } from './mappingUI';

type WasmModule = typeof import('@paulrobins/testdata-parser');

export type ParserOp =
  | 'parseStdf'
  | 'parseAtdf'
  | 'parseCsv'
  | 'parseJson'
  | 'stdfTestNames'
  | 'atdfTestNames'
  | 'parseStdfFiltered'
  | 'parseAtdfFiltered';

export interface ParserRequest {
  id: number;
  op: ParserOp;
  bytes: Uint8Array;
  mapping?: CsvMapping;
  selected?: number[];
}

export type ParserResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

let wasmPromise: Promise<WasmModule> | null = null;

function loadWasm(): Promise<WasmModule> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      // Explicit asset URL so Vite resolves and copies the .wasm correctly under
      // both `dev:web` and the relative-base GitHub Pages build. Vite rewrites
      // import.meta.url inside a module worker, so this resolves next to the
      // bundled worker chunk. Mirrors loadWasm() in platform.ts.
      const wasmUrl = new URL(
        '@paulrobins/testdata-parser/testdata_parser_bg.wasm',
        import.meta.url,
      );
      const mod = await import('@paulrobins/testdata-parser');
      // Pass { module_or_path } — the bare-URL form is deprecated in wasm-bindgen.
      await (mod.default as (opts: { module_or_path: URL }) => Promise<unknown>)({
        module_or_path: wasmUrl,
      });
      return mod;
    })();
  }
  return wasmPromise;
}

function run(wasm: WasmModule, req: ParserRequest): unknown {
  switch (req.op) {
    case 'parseStdf':         return wasm.parse_stdf(req.bytes);
    case 'parseAtdf':         return wasm.parse_atdf(req.bytes);
    case 'parseCsv':          return wasm.parse_csv(req.bytes, req.mapping);
    case 'parseJson':         return wasm.parse_json(req.bytes, req.mapping);
    case 'stdfTestNames':     return wasm.stdf_test_names(req.bytes);
    case 'atdfTestNames':     return wasm.atdf_test_names(req.bytes);
    case 'parseStdfFiltered': return wasm.parse_stdf_filtered(req.bytes, req.selected ?? []);
    case 'parseAtdfFiltered': return wasm.parse_atdf_filtered(req.bytes, req.selected ?? []);
  }
}

self.onmessage = async (e: MessageEvent<ParserRequest>) => {
  const req = e.data;
  try {
    const wasm = await loadWasm();
    const result = run(wasm, req);
    const res: ParserResponse = { id: req.id, ok: true, result };
    (self as unknown as Worker).postMessage(res);
  } catch (err) {
    const res: ParserResponse = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(res);
  }
};
