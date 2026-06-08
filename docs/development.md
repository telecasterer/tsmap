# Development

## Prerequisites

- Node 22+
- Rust (stable) + `cargo`
- Tauri CLI v2 (`npm install` installs it as a dev dependency)
- For the desktop app on Linux: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`
- For rebuilding the WASM parser: `wasm-pack` and the `wasm32-unknown-unknown` target

```bash
cargo install wasm-pack
rustup target add wasm32-unknown-unknown
```

## Running

```bash
npm install

npm run tauri dev    # desktop app — Rust + frontend hot-reload
npm run dev:web      # browser version at http://localhost:5301
```

## Type checking

```bash
npx tsc --noEmit     # TypeScript
cargo check          # Rust (run from src-tauri/)
cargo test           # parser tests (run from packages/parsers/)
```

## Generating test files

```bash
python3 scripts/generate_stdf.py /tmp/test.stdf         # synthetic STDF — 3 wafers, 4 tests
python3 scripts/generate_stdf_large.py /tmp/large.stdf  # large STDF — 25 wafers, 50 tests, ~10k dies/wafer
python3 scripts/generate_atdf.py /tmp/test.atdf         # synthetic ATDF — same structure
```

## Architecture

```
src/
  main.ts          — app entry: file open, two-pass test selector, renderWafers, chart view
  platform.ts      — platform adapter: Tauri IPC (desktop) or WASM (browser)
  mappingUI.ts     — CSV/JSON column mapping overlay
  multiFileUI.ts   — multi-file rename and append confirmation
  testSelectorUI.ts — test selector overlay for large STDF/ATDF files
  charts/          — yield heatmap, bin pareto, box plot, histogram charts
  types.ts         — shared types: ParsedFile, WaferData, TestDef, LotMeta

packages/parsers/  — shared Rust crate, compiles for native Tauri and WASM
  src/types.rs     — DieResult, WaferData, ParsedStdf, LotMeta, TestDef
  src/parse_stdf.rs — STDF V4 binary parser; includes first-pass scan and filtered parse
  src/parse_atdf.rs — ATDF ASCII parser; includes first-pass scan and filtered parse
  src/parse_csv.rs  — CSV/TSV parser with column mapping
  src/parse_json.rs — JSON array parser with column mapping
  src/read_file.rs  — read_bytes / read_text with transparent .gz decompression

src-tauri/src/commands/  — thin Tauri async wrappers over packages/parsers
  parse_stdf.rs      — parse_stdf(path)
  parse_atdf.rs      — parse_atdf(path)
  parse_csv.rs       — csv_headers(path), parse_csv(path, mapping)
  parse_json.rs      — json_headers(path), parse_json(path, mapping)
  stdf_test_names.rs — stdf_test_names(path) — first-pass test name scan
  atdf_test_names.rs — atdf_test_names(path) — first-pass test name scan
  parse_stdf_filtered.rs — parse_stdf_filtered(path, selected) — filtered parse
  parse_atdf_filtered.rs — parse_atdf_filtered(path, selected) — filtered parse
  extract_archive.rs — extract_archive(path), cleanup_extract()
  write_temp_html.rs — write_temp_html(html)
```

## Building and publishing the WASM parser

The parsers compile to `@paulrobins/testdata-parser` on npm. The package is consumed by
both the tsmap web version and can be used independently.

```bash
cd packages/parsers

# Build
wasm-pack build --target web -s paulrobins --no-default-features --features wasm

# Publish
cd pkg
npm publish --access public
```

After publishing a new version:

```bash
# from repo root
npm install @paulrobins/testdata-parser@latest
npx tsc --noEmit
```

## Building for deployment

```bash
npm run build:web   # outputs to dist/ — deploy to any static host
```

The CI workflow (`.github/workflows/deploy.yml`) builds and deploys to GitHub Pages
automatically on every push to `main`.
