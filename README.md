# tsmap

A desktop and web application for loading and visualising semiconductor wafer map data. Built with [Tauri v2](https://tauri.app/) (Rust backend), a WASM parser for the browser, and [wmap](https://github.com/telecasterer/wafermap) (canvas rendering).

**[Documentation & web app →](https://telecasterer.github.io/tsmap/)**

## Features

- **Open** CSV, JSON, ATDF, and STDF wafer map files
- **Multi-wafer** — all formats support multiple wafers; renders as a gallery automatically
- **Stats & findings** — yield, bin breakdown, ring/quadrant analysis, and spatial findings
- **Charts** — yield by wafer, bin pareto, per-test box plots and histograms
- **PNG export** — save any wafer map from the toolbar
- **Cross-platform** — Linux (Wayland/X11), macOS, Windows 11; also runs in the browser via WASM

## Supported formats

| Format | Parsing | Notes |
| ------ | ------- | ----- |
| STDF | Rust | Binary V4; handles MIR/WIR/WRR/SDR/PIR/PRR/PTR/FTR |
| ATDF | Rust | ASCII; handles MIR/WIR/WRR/SDR/PIR/PRR/PTR/FTR |
| CSV | Rust | Column mapping step before render; supports wide and long (pivot) formats |
| JSON | Rust | Flat array or nested `[{ wafer fields, results: [{die}] }]`; same mapping step as CSV |

## Development

```bash
npm install
npm run tauri dev       # full Tauri app (Rust + frontend)
npm run dev:web         # web version at http://localhost:5301 (uses WASM parser)
cargo check             # type-check Rust (run from src-tauri/)
npx tsc --noEmit        # type-check TypeScript
cargo test              # run parser tests (run from packages/parsers/)
```

### Generating test files

```bash
python3 scripts/generate_stdf.py /tmp/test.stdf   # synthetic STDF — 3 wafers, 4 tests
python3 scripts/generate_atdf.py /tmp/test.atdf   # synthetic ATDF — same structure
```

### Building and publishing the WASM parser package

The parsers compile to a shared crate (`packages/parsers`) that targets both native Tauri and WASM. The published npm package is [`@paulrobins/testdata-parser`](https://www.npmjs.com/package/@paulrobins/testdata-parser).

Prerequisites: `wasm-pack` (`cargo install wasm-pack`) and the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`).

```bash
cd packages/parsers

# Build
wasm-pack build --target web -s paulrobins --no-default-features --features wasm

# Publish
cd pkg
npm publish --access public
```

After publishing a new version, update tsmap to use it:

```bash
# from repo root
npm install @paulrobins/testdata-parser@latest
npx tsc --noEmit   # verify types still resolve
```

## Architecture

```text
src/
  main.ts          — app entry: file open, renderWafers, chart view
  platform.ts      — platform adapter: Tauri IPC (desktop) or WASM (browser)
  mappingUI.ts     — CSV/JSON column mapping overlay
  multiFileUI.ts   — multi-file rename and append confirmation
  charts/          — yield heatmap, bin pareto, box plot, histogram charts
  types.ts         — shared types: ParsedFile, WaferData, TestDef, LotMeta

packages/parsers/  — shared Rust crate (native + WASM targets)
  src/types.rs     — DieResult, WaferData, ParsedStdf, LotMeta, TestDef
  src/parse_stdf.rs — STDF V4 binary parser
  src/parse_atdf.rs — ATDF ASCII parser
  src/parse_csv.rs  — CSV/TSV parser with column mapping
  src/parse_json.rs — JSON array parser with column mapping
  src/read_file.rs  — read_bytes / read_text with transparent .gz decompression

src-tauri/src/commands/  — thin Tauri async wrappers over packages/parsers
  parse_stdf.rs    — parse_stdf(path)
  parse_atdf.rs    — parse_atdf(path)
  parse_csv.rs     — csv_headers(path), parse_csv(path, mapping)
  parse_json.rs    — json_headers(path), parse_json(path, mapping)
  extract_archive.rs — extract_archive(path), cleanup_extract()
  write_temp_html.rs — write_temp_html(html) — opens wmap HTML reports

scripts/
  generate_stdf.py — generates a valid binary STDF V4 test file
  generate_atdf.py — generates a valid ASCII ATDF test file
```

## Dependencies

- [`@paulrobins/wafermap`](https://www.npmjs.com/package/@paulrobins/wafermap) — wafer map rendering and analysis
- [`@tauri-apps/api`](https://www.npmjs.com/package/@tauri-apps/api) — Tauri IPC
- [`rust-stdf`](https://crates.io/crates/rust-stdf) — STDF V4 binary parser (Rust)
- `zenity` — native file dialogs on Linux (system dependency; pre-installed on GNOME desktops)
