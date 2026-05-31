# tsmap

A desktop application for loading and visualising semiconductor wafer map data. Built with [Tauri v2](https://tauri.app/) (Rust backend) and [wmap](https://www.npmjs.com/package/@paulrobins/wafermap) (canvas rendering).

## Features

- **Open** CSV, JSON, ATDF, and STDF wafer map files
- **Multi-wafer** — all formats support multiple wafers; renders as a gallery automatically
- **Stats & findings** — yield, bin breakdown, ring/quadrant analysis, and spatial findings via `analyzeWaferMap`
- **PNG export** — save any wafer map from the toolbar
- **Cross-platform** — Linux (Wayland/X11), macOS, Windows 11

## Supported formats

| Format | Parsing | Notes |
|--------|---------|-------|
| CSV | TypeScript (frontend) | Columns: `x, y, hbin, sbin`, optional `wafer`, optional test columns |
| JSON | TypeScript (frontend) | Array of `DieResult`, or `{ wafers, meta, testDefs }` |
| ATDF | TypeScript (frontend) | ASCII, handles MIR/WIR/WRR/PIR/PRR/PTR/FTR |
| STDF | Rust (backend) | Binary V4, handles MIR/WIR/WRR/SDR/PIR/PRR/PTR/FTR |

## Development

```bash
npm install
npm run tauri dev       # full Tauri app (Rust + frontend)
npx vite --port 5300    # frontend only (CSV/JSON/ATDF work; STDF needs Tauri)
```

### Generating test files

```bash
python3 scripts/generate_stdf.py /tmp/test.stdf   # synthetic STDF — 3 wafers, 4 tests
python3 scripts/generate_atdf.py /tmp/test.atdf   # synthetic ATDF — same structure
```

## Architecture

```
src/
  main.ts          — app entry: file open, PNG save intercept, renderParsed
  fileLoader.ts    — loadFile() dispatcher: CSV/JSON/ATDF parsed in JS, STDF via Tauri invoke
  atdfParser.ts    — ATDF text parser (MIR, WIR, WRR, PIR, PRR, PTR, FTR)
  types.ts         — shared types: ParsedFile, WaferData, TestDef, LotMeta

src-tauri/src/commands/
  parse_stdf.rs    — #[tauri::command] parse_stdf(path) → ParsedStdf
  pick_file.rs     — #[tauri::command] pick_file() — zenity on Linux, rfd on macOS/Windows
  save_file.rs     — #[tauri::command] save_file(bytes, defaultName) — zenity --save / rfd

scripts/
  generate_stdf.py — generates a valid binary STDF V4 test file
  generate_atdf.py — generates a valid ASCII ATDF test file
```

## Dependencies

- [`@paulrobins/wafermap`](https://www.npmjs.com/package/@paulrobins/wafermap) — wafer map rendering and analysis
- [`@tauri-apps/api`](https://www.npmjs.com/package/@tauri-apps/api) — Tauri IPC
- [`rust-stdf`](https://crates.io/crates/rust-stdf) — STDF V4 binary parser (Rust)
- `zenity` — native file dialogs on Linux (system dependency; pre-installed on GNOME desktops)
