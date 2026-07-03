# @paulrobins/testdata-parser

Rust/WASM parsers for semiconductor test data formats: **STDF**, **ATDF**, **CSV**, and **JSON**. Compiled to a single WASM module via `wasm-bindgen`; the same Rust source also builds natively (used by [tsmap](https://github.com/paulrobins/tsmap)'s Tauri backend).

All formats parse to one shared shape (`ParsedStdf` / `ScanResult`) — there is no format-specific output type on the JS side.

## Install

```bash
npm install @paulrobins/testdata-parser
```

## Usage

The module must be initialized once before calling any parse function — it loads and instantiates the WASM binary.

```js
import init, { parse_stdf } from '@paulrobins/testdata-parser';

await init(); // fetches testdata_parser_bg.wasm relative to the module URL
const bytes = new Uint8Array(await file.arrayBuffer());
const parsed = parse_stdf(bytes); // ParsedStdf, or throws a string error
```

`init()` also installs a panic hook that routes any Rust panic to `console.error` with a stack trace, instead of an opaque WASM trap.

In a bundler/dev-server context, `new URL('...testdata_parser_bg.wasm', import.meta.url)` resolution can be finicky — see tsmap's `parserWorker.ts` for a worked example of loading this module off the main thread in a Vite app.

## API

Every parse function takes raw file bytes (`Uint8Array`) and returns a plain JS object (via `serde-wasm-bindgen`), or throws a `string` on error. Gzip-compressed input (`.gz`) is transparently decompressed for every format.

| Function | Signature | Returns |
| --- | --- | --- |
| `parse_stdf` | `(bytes: Uint8Array) => ParsedStdf` | Full parse of an STDF file |
| `parse_atdf` | `(bytes: Uint8Array) => ParsedStdf` | Full parse of an ATDF file |
| `parse_csv` | `(bytes: Uint8Array, mapping: CsvMapping) => ParsedStdf` | Full parse of a CSV, using an explicit column mapping |
| `parse_json` | `(bytes: Uint8Array, mapping: CsvMapping) => ParsedStdf` | Full parse of a JSON array-of-records file, using the same mapping shape as CSV |
| `stdf_test_names` | `(bytes: Uint8Array) => ScanResult` | Fast first-pass scan: test definitions + die count, no die accumulation |
| `atdf_test_names` | `(bytes: Uint8Array) => ScanResult` | Same first-pass scan for ATDF |
| `parse_stdf_filtered` | `(bytes: Uint8Array, selected: number[]) => ParsedStdf` | Full parse, skipping per-site accumulation for test numbers not in `selected` |
| `parse_atdf_filtered` | `(bytes: Uint8Array, selected: number[]) => ParsedStdf` | Same filtered parse for ATDF |

### Two-pass parsing (STDF/ATDF)

STDF and ATDF files can be large and contain far more tests than a caller wants to hold in memory. The intended flow:

1. **`stdf_test_names`/`atdf_test_names`** — a fast scan (PTR/FTR records only) that returns every test definition and the die count, without accumulating per-site test values.
2. Caller lets the user (or some policy) choose a subset of test numbers.
3. **`parse_stdf_filtered`/`parse_atdf_filtered`** — a full parse that still walks every record (so bin/wafer/lot data is complete) but only accumulates test values for the `selected` test numbers, bounding memory for wide files.

`test_defs` in the filtered result only includes tests seen in the second pass; a test that only appears on an early stop-on-fail die may be pruned from a truncated re-scan. Callers doing two-pass filtering should merge in the `test_defs` from the first-pass `ScanResult` to avoid losing that metadata (this is what tsmap's `testDefs` backfill does).

### CsvMapping

`parse_csv` and `parse_json` require an explicit mapping — there's no header auto-detection. Column mapping fields (all are source column names, matched against the file's header row):

```ts
interface CsvMapping {
  x: string;                 // die X coordinate column
  y: string;                 // die Y coordinate column
  hbin?: string;              // hardware bin column
  sbin?: string;              // software bin column
  wafer?: string;             // wafer ID column (groups rows into WaferData[])
  lot?: string;               // lot ID column
  site?: string;              // test site number column (numeric; non-numeric -> no site)
  tests: CsvTestCol[];        // one entry per fixed test-value column
  meta: string[];             // extra columns to surface as generic per-row metadata
  splitBy: string[];          // columns to additionally facet wafers by (beyond `wafer`)
  testnameCol?: string;       // for "tall" CSVs: column holding the test name per row
  testvalueCol?: string;      // for "tall" CSVs: column holding the test value per row
  loLimitCol?: string;
  hiLimitCol?: string;
  unitsCol?: string;
  passBins: number[];         // hbin/sbin values treated as a pass for pass/fail summary
}

interface CsvTestCol {
  col: string;         // source column name
  testNumber: number;  // assigned test number
  name: string;        // display name
}
```

Two ways to describe test columns are supported: a **fixed set** of `tests` (one column per test, "wide" format), or a **tall** layout (`testnameCol`/`testvalueCol` — one row per die×test, with the test identity read from a column rather than the header).

### Return shape — `ParsedStdf`

```ts
interface ParsedStdf {
  meta: LotMeta;
  wafers: WaferData[];
  testDefs: Record<string, TestDef>; // keyed by test number as a string
  sites: SiteInfo[];
  warnings?: string[]; // non-fatal advisories, e.g. fabricated soft bins; omitted if empty
}

interface WaferData {
  waferId: string;
  results: DieResult[];
  partCount?: number;
  goodCount?: number;
  failCount?: number;
  fields?: MetaField[]; // per-wafer metadata (STDF/ATDF WIR/WRR); empty for formats without it
}

interface DieResult {
  x: number;
  y: number;
  hbin?: number;
  sbin?: number;
  siteNum?: number;
  partId?: number;
  testValues?: Record<string, number>; // keyed by test number as a string
}

interface TestDef {
  name: string;
  testType: string; // "P" (parametric) or "F" (functional)
  loLimit?: number;
  hiLimit?: number;
  units?: string;
}

interface LotMeta {
  fields: MetaField[]; // every non-empty field from the source's lot record (STDF/ATDF MIR)
}

interface MetaField {
  key: string;   // source field name, e.g. "lotId", "tstTemp", "startT"
  value: string; // always a string; timestamps are ISO 8601
}

interface SiteInfo {
  headNum: number;
  siteNum: number;
}
```

`testDefs` and `testValues` are both keyed by **test number**, not test name — test numbers are the unique identity in STDF/ATDF; names are not guaranteed unique.

`meta`/`fields` are intentionally generic key/value pairs rather than a fixed struct: new metadata fields flow through from the source format with no type or crate change, and it's up to the host application to decide which fields to surface and how to label them.

### Return shape — `ScanResult`

```ts
interface ScanResult {
  testDefs: Record<string, TestDef>;
  dieCount: number;
}
```

## Native (non-WASM) usage

The crate also builds as a native Rust library (used directly by tsmap's Tauri commands, bypassing WASM entirely). Native-only entry points read from a file path instead of a byte buffer and are synchronous:

| Function | Module |
| --- | --- |
| `parse_stdf_sync(path: String) -> Result<ParsedStdf, String>` | `parse_stdf` |
| `parse_atdf_sync(path: String) -> Result<ParsedStdf, String>` | `parse_atdf` |
| `csv_headers_inner(path) -> Result<CsvHeadersResult, String>` | `parse_csv` |
| `parse_csv_inner(path, mapping) -> Result<ParsedStdf, String>` | `parse_csv` |
| `json_headers_sync(path) -> Result<Vec<String>, String>` | `parse_json` |

Enable the `native` feature (default) for these; the `wasm` feature gates the `wasm-bindgen` exports above. See `Cargo.toml` for the full feature list, including `bench` (enables a timed parse variant used by the perf benchmarks).

## Design notes

- **Byte readers are panic-free.** STDF/ATDF field readers are bounds-checked and return `Option`/`Result` rather than panicking on truncated input — a panic inside WASM aborts the whole module with no recovery, so this is a hard requirement, not a style preference.
- **Big-endian and little-endian STDF** are both supported (detected from the FAR record's `CPU_TYPE`).
- **Gzip is transparent** — every entry point decompresses `.gz` input automatically by sniffing the magic bytes; callers don't need to branch on compression.

## Versioning

This crate has its own release lifecycle, independent of any consuming application's version. See the parent repository's `CLAUDE.md` for the bump/build/publish steps.
