# Changelog

## [Unreleased]

## [0.1.12] — 2026-06-21

### Added

- **Self-contained "Matrix size" control on the correlation matrix** — the panel now owns a Matrix size selector (5–100 tests) that re-filters the full matrix and redraws in place, without rebuilding the charts grid. The caller persists the chosen limit; the panel reports strong/moderate/hidden pair counts and the strongest pair back through a summary line.
- **User guide modal gains a top header** — the in-app `?` guide now has a top header bar with **fullscreen** (toggle with the button or `F`) and **close** (`Esc`, backdrop click, or the icon) buttons, matching the chart expand-modal chrome. The old bottom-only "Close" button is gone. The guide content is capped to a readable 760px column so it doesn't stretch edge-to-edge when fullscreen.

### Changed

- **wafermap updated to 0.14.2** — picks up on-canvas map titles for every plot mode, a legend for `colorBySpec` (Spec pass/fail) mode, value-mode spec controls in the gallery toolbar, and a clearer log-scale colorbar note (`linear — log n/a` when log can't apply). Purely additive; no breaking changes.

### Fixed

- **CI type check failed on a clean checkout** — `src/userGuideHtml.ts` is generated (gitignored) by `npm run build:guide`, normally run by the `predev`/`prebuild` hooks. The `Test` job's `npm run check` had no such hook, so `tsc` couldn't resolve the import and both the Test and Deploy workflows failed. Added a `Build user guide` step before the type check in `test.yml`.

## [0.1.9] — 2026-06-10

### Added

- **Spec limit lines on scatter plot** — when the selected X or Y test has spec limits (LSL/USL), dashed vertical lines (X limits) and horizontal lines (Y limits) are drawn on the scatter canvas. Together they form a pass-region rectangle when both tests have both limits.
- **"Axis includes limits" toggle on boxplot and histogram** — checkbox in each panel's controls row. When on, the axis range expands to include LSL/USL so limit lines are always visible even when they fall outside the data range. Default off (axis fits data only).
- **wmap geometry warnings in log panel** — `WaferMapResult.warnings` (new in wafermap 0.13.5) is now surfaced in the tsmap log panel. The `partial-coverage` advisory fires when inferred wafer geometry may be wrong due to partial data; it now appears as a visible warning instead of a silent `console.warn`.
- **Long-format CSV test data** — `scripts/generate_test_suite.py` generates `*_long.csv` files (one row per die per test with `test_name`, `test_val`, `lo_limit`, `hi_limit`, `units` columns). The mapping UI auto-detects these columns so limits are imported automatically.

### Fixed

- **Chart card PNG save broken** — removing the `HTMLAnchorElement.prototype.click` monkey-patch (see Changed below) also broke the ⤓ save buttons on chart cards (boxplot, histogram, correlation matrix, scatter). Fixed by threading `savePng` through `RenderChartsOptions` and all panel options interfaces down to `cardShell`, so each card's save button calls `platform.savePng` in Tauri and does a proper `document.body`-anchored browser download on web.

### Changed

- **wafermap updated to 0.13.5** — picks up performance improvements (`buildView` scan merges, `getDieAtPoint` spatial index), accessibility improvements (keyboard navigation, ARIA roles), and two new features used by tsmap (see above).
- **PNG save hook replaces DOM monkey-patch** — `renderWaferMap` / `renderWaferGallery` now receive `onSaveImage` (new in wafermap 0.13.5) instead of the previous `HTMLAnchorElement.prototype.click` global override. Cleaner, host-agnostic, no longer affects every anchor on the page. Logged as WMAP_ISSUES.md #12; now resolved.
- **`dev:web` now binds to all interfaces** (`--host` flag added) so the web build is reachable from other devices on the local network (e.g. a Chromebook at `http://<host-ip>:5301`).
- **Lazy boxplot/trend quartile computation** — reverted `enableTestValueAnalysis: true` which caused a 5–8× slowdown on map load (wmap was running five Welch t-test region passes per wafer, per test, up-front — work tsmap never uses). Quartiles are now computed directly from die data in `buildTestBoxplotData` / `buildTrendData`, lazily on panel interaction. Logged as WMAP_ISSUES.md #14.

### Added

- **Web parsing runs in a Worker** — the browser build now parses STDF/ATDF/CSV/JSON in a dedicated module worker (`parserWorker.ts`) instead of on the UI thread, so large files no longer freeze the page. The `platform.ts` web branch routes all eight WASM entry points through the worker (id-correlated messages, bytes transferred, errors/traps reject the pending promise). Tauri is unaffected (it already parses off-thread via `spawn_blocking`).
- **Parser warnings channel** — parsers now return a `warnings: string[]` array (Rust `ParsedStdf.warnings`, TS `ParsedFile.warnings`). Soft-bin fabrication (the 65535 "no soft bin" sentinel mirrored onto the hard bin) is reported here and shown in the log panel instead of being silent. `@paulrobins/testdata-parser` 0.2.2.
- **CSV column mapping UI** — overlay shown after opening a CSV file. Detects column roles automatically (exact name, regex, and token-based fuzzy matching across 30+ naming conventions). User can reassign roles, rename test columns, mark metadata columns, set pass bins, and choose which metadata columns split the gallery into separate wafer cards. Mapping is saved to `localStorage` keyed by header fingerprint and pre-filled on next open of the same schema.
- **Long-format CSV support** — files where each row is one test result for one die (test_name / result columns with repeating X/Y) are detected automatically. A confirmation modal is shown; on confirm the data is pivoted to wide format in Rust before rendering.
- **Rust CSV parser** (`csv_headers` + `parse_csv` commands) — replaces the TypeScript parser. Uses the `csv` crate: streaming, handles quoted fields, BOM, `\r\n`, `#` comment lines, and any file size. Long-format pivot and wafer/split-by grouping run in Rust.
- **Lot-level analysis** — `analyzeWaferLot` is called for multi-wafer renders. The lot summary panel opens by default alongside the gallery, showing cross-wafer yield trends, bin aggregates, ring and quadrant summaries, and lot-level findings.
- **File drop** — files can now be dropped anywhere on the Tauri window. Uses `tauri://drag-drop` event (WebKitGTK intercepts OS drops before the browser sees them; `dragDropEnabled: true` in `tauri.conf.json`).
- **Log panel** — collapsible bar at the bottom of the window. All load events, warnings, and errors are timestamped and shown here. Auto-opens on error. Error count shown in the toggle label.
- **`read_text_file` Rust command** — reads any user-selected path without hitting `tauri-plugin-fs` scope restrictions (which only allow app-specific dirs by default).
- **Empty state** — clean startup screen with a wafer icon and "Open a file to get started" prompt. Replaces the confusing random demo data.

### Fixed

- **PNG save** — wmap creates a detached `<a download>` element that is never added to the DOM, so `document` capture listeners never fire. Fixed by patching `HTMLAnchorElement.prototype.click` in Tauri context.
- **PNG save filename** — zenity on Wayland ignores `--filename` when given a bare name. Pre-seed with `$HOME/<name>.png` so the dialog opens in the home directory with the filename populated.
- **Parser panic-safety on malformed files** — the STDF byte readers now bounds-check (return `Option`) instead of slicing raw, and an off-by-one guard in `parse_prr` was corrected. A truncated or corrupt file now returns an error rather than panicking — in WASM a panic aborted the whole module (blank page, no message). A `console_error_panic_hook` is installed in the WASM build so any residual panic surfaces as a console error. Covered by truncated-input regression tests.
- **STDF soft bin sentinel** — `PRR.soft_bin = 65535` means "not set" in STDF V4. Now falls back to `hard_bin` instead of passing `65535` to the frontend as a spurious soft bin value, and emits a log-panel warning when it does so (see the warnings channel above).
- **CSV/ATDF silent failures** — `tauri-plugin-fs` `fs:default` only allows access to app-specific directories. Text files selected via zenity can be anywhere; now read via `read_text_file` Rust command instead.
- **Column mapping overlay covering gallery toolbar** — overlay changed from `position: absolute` (inside `#map-container`) to `position: fixed; z-index: 200`, covering the entire app window including the wmap toolbar.
- **Gallery not scrollable** — added `overflow-y: auto` to the container in gallery mode.
- **Dark mode form elements** — Ubuntu GTK / WebKitGTK imposes the system light theme on `select` and `input` elements regardless of CSS background. Fixed with `color-scheme: dark`, `-webkit-appearance: none`, and `!important` colour overrides.
- **ATDF and JSON not loading** — these now read via `read_text_file` Rust command, bypassing the `tauri-plugin-fs` scope restriction.
- **ATDF missing from non-Linux file picker** — `tauri-plugin-dialog` filters on macOS/Windows now include `.atdf` and `.atd`.

### Changed

- **Map fills window on resize** — removed the constraining `display: flex; align-items: center` wrapper. wmap's internal `ResizeObserver` re-fits the canvas automatically when the container resizes.
- **Default window size** — increased from 800×600 to 1200×800.
- **TypeScript CSV parser removed** — all CSV parsing now goes through Rust.
- **Charts split into per-chart modules** — the 1,700-line `charts/render.ts` is now one module per chart (`boxplot.ts`, `histogram.ts`, `correlation.ts`, `trend.ts`, `scatter.ts`) sharing chrome from `charts/chartShell.ts`. `render.ts` keeps the bar-chart panel + grid and re-exports the rest, so importers are unchanged. No behaviour change.
