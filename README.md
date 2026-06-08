# tsmap

A desktop application for loading and visualising semiconductor wafer map data. Built with [Tauri v2](https://tauri.app/) (Rust backend) and [wmap](https://github.com/telecasterer/wafermap) (canvas rendering).

## Features

- **Open** CSV, JSON, ATDF, and STDF wafer map files
- **Multi-wafer** — all formats support multiple wafers; renders as a gallery automatically
- **Stats & findings** — yield, bin breakdown, ring/quadrant analysis, and spatial findings via `analyzeWaferMap`
- **PNG export** — save any wafer map from the toolbar
- **Cross-platform** — Linux (Wayland/X11), macOS, Windows 11

## Supported formats

| Format | Parsing | Notes |
|--------|---------|-------|
| STDF | Rust | Binary V4; handles MIR/WIR/WRR/SDR/PIR/PRR/PTR/FTR |
| ATDF | Rust | ASCII; handles MIR/WIR/WRR/SDR/PIR/PRR/PTR/FTR |
| CSV | Rust | Column mapping step before render; supports wide and long (pivot) formats |
| JSON | Rust | Flat array or nested `[{ wafer fields, results: [{die}] }]`; same mapping step as CSV |

## Development

```bash
npm install
npm run tauri dev       # full Tauri app (Rust + frontend)
npx vite --port 5300    # frontend only (no file parsing — all parsers need Tauri)
cargo check             # type-check Rust (run from src-tauri/)
npx tsc --noEmit        # type-check TypeScript
```

### Generating test files

```bash
python3 scripts/generate_stdf.py /tmp/test.stdf   # synthetic STDF — 3 wafers, 4 tests
python3 scripts/generate_atdf.py /tmp/test.atdf   # synthetic ATDF — same structure
```

## Architecture

```
src/
  main.ts          — app entry: file open, PNG save intercept, renderWafers
  fileLoader.ts    — loadStdfPath() for STDF
  types.ts         — shared types: ParsedFile, WaferData, TestDef, LotMeta

src-tauri/src/commands/
  parse_stdf.rs    — parse_stdf(path) → ParsedStdf — STDF V4 binary
  parse_atdf.rs    — parse_atdf(path) → ParsedStdf — ATDF ASCII
  parse_csv.rs     — parse_csv(path, mapping) → ParsedStdf — CSV/TSV/DAT
  parse_json.rs    — parse_json(path, mapping) → ParsedStdf — JSON array
  pick_file.rs     — pick_file() / pick_files() — zenity on Linux, rfd on macOS/Windows
  save_file.rs     — save_file(bytes, defaultName) — zenity --save on Linux, rfd elsewhere
  write_temp_html.rs — write_temp_html(html) — opens wmap HTML reports in the system browser

scripts/
  generate_stdf.py — generates a valid binary STDF V4 test file
  generate_atdf.py — generates a valid ASCII ATDF test file
```

## Dependencies

- [`@paulrobins/wafermap`](https://www.npmjs.com/package/@paulrobins/wafermap) — wafer map rendering and analysis
- [`@tauri-apps/api`](https://www.npmjs.com/package/@tauri-apps/api) — Tauri IPC
- [`rust-stdf`](https://crates.io/crates/rust-stdf) — STDF V4 binary parser (Rust)
- `zenity` — native file dialogs on Linux (system dependency; pre-installed on GNOME desktops)
