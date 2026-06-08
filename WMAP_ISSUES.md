# wmap Issues Found via tsmap

This file tracks wmap library issues discovered while building tsmap.
At some point these will be converted into an implementation plan for wmap.

## Version tracking

| Field | Value |
|-------|-------|
| wmap version in use | 0.13.3 |
| Latest wmap release | check [github.com/telecasterer/wafermap/releases](https://github.com/telecasterer/wafermap/releases) |
| Last updated | 2026-06-08 (session: issue 9 fixed, issue 10 Tier 1 shipped) |

## Rust Backend Notes

### ~~`rust-stdf` ATDF feature is unusable~~ (resolved — own parser written)

`rust-stdf` v0.3.1 has an `atdf` feature flag but the implementation is
incomplete. `AtdfRecord` has a private `data_map` field with no public
accessors — the only public method is `to_atdf_string()`. The
`From<&AtdfRecord> for StdfRecord` conversion is a TODO stub that returns an
empty record.

**Current workaround:** ATDF is parsed in TypeScript (`atdfParser.ts`). This
works but means ATDF cannot benefit from Rust performance for large files.

**Options when we add a `parse_atdf` Rust command:**

1. Wait for `rust-stdf` to complete its ATDF implementation
2. Write our own ATDF parser in Rust — ATDF is ASCII line-by-line, the format
   is well-specified, and the field layouts are already documented in
   `atdfParser.ts`. A Rust implementation would be ~200 lines.

Option 2 is likely faster than waiting. The field positions are already mapped
in `atdfParser.ts` — porting to Rust is mechanical.

## API Issues

### ~~1. `renderWaferMap` missing `downloadFilename` option~~ (fixed in v0.12.8)

`renderWaferGallery` accepts `options.downloadFilename` to customise the PNG
save filename. `renderWaferMap` hardcodes `a.download = 'wafermap.png'`
regardless of context. The host has no way to suggest a meaningful filename
(e.g. the loaded file's stem).

**Fix applied:** `downloadFilename?: string` added to `RenderOptions` in both
`renderWaferMap` and `renderWaferGallery`. tsmap now passes `stem` to both.

### ~~2. `openHtmlReport` uses `window.open` — not embeddable~~ (fixed in v0.12.8)

`openHtmlReport(html)` calls `window.open('', '_blank')` then writes HTML into
the popup. In Tauri (and any non-browser host), `window.open` is blocked and
returns `null`, silently doing nothing. The "Open Report" and "Summary report"
buttons in the summary panel are therefore broken in tsmap without a workaround.

**Fix applied:** `setReportOpener(opener)` added to the wmap stats API. tsmap
now calls it at startup instead of patching `window.__openHtmlReport`.

### ~~3. `wrapWithSummaryPanel` uses `height: 100%` on a flex child — broken on WebView2~~ (fixed)

`summaryPanel.ts: wrapWithSummaryPanel()` set `height: '100%'` on the wrapper
div, which is a flex child of whatever container the caller provides. In a pure
flexbox layout, `height: 100%` on a flex child only resolves correctly if the
parent has an explicit declared height — not a flex-given height. WebKitGTK is
lenient; WebView2 (Windows) is strict and collapses the wrapper to zero height,
breaking the summary panel layout.

**Fix applied:** Replaced `height: '100%'` with `flex: '1 1 0'` and added
`minHeight: '0'` on the wrapper, matching the pattern already used on the
content element.

### ~~5. Toolbar and menus use `z-index: 9998`/`9999` — overrides host app overlays~~ (fixed in v0.12.8)

`toolbar.ts` assigns `zIndex: '9998'` to menus and dropdowns and `zIndex: '9999'` to the hover tooltip, all via `position: fixed` on `document.body`. These values compete globally with any host application overlay (modals, mapping panels, help dialogs). Hosts are forced to use `z-index ≥ 10000` to stay above the toolbar.

**Fix applied:** CSS custom property `--wmap-z` (default `100`) replaces all hardcoded z-index values. tsmap overlays remain at `z-index: 200` and now correctly appear above the toolbar.

### ~~4. Die tooltip freezes visible after pointer leaves canvas during a drag~~ (fixed)

`setPointerCapture` in `onPointerDown` routes all pointer events to the canvas
while a button is held, which suppresses `pointerleave`. If the user releases
the mouse button outside the canvas bounds, `onPointerLeave` never fires and
the tooltip remains visible.

**Fix applied:** `onPointerUp` now checks if the release point is outside the
canvas bounds and hides the tooltip if so.

### ~~6. `analyzeWaferMap` per-test stats lack quartiles (median/Q1/Q3)~~ (fixed in v0.13.3)

**Where:** `packages/stats/analyzeWaferMap.ts` — the per-test statistics
computed into `StatsSummary` (currently `mean`, `stddev`, `count`, `min`, `max`
per test/region).

**Problem:** tsmap is considering adding box-plot charts of test values per
test/wafer. A box plot needs median, Q1, and Q3 (and typically whisker bounds
derived from the IQR) in addition to min/max. `analyzeWaferMap` already walks
every test's `testValues` to compute mean/stddev/min/max, so quartiles are a
natural extension of that existing pass rather than a new computation tsmap
would have to duplicate — and any other consumer of `StatsSummary` wanting
distribution shape would benefit too.

**Suggested fix:** During the existing per-test aggregation in
`analyzeWaferMap`, sort (or use a selection algorithm on) the collected test
values once and add `median`, `q1`, `q3` fields to the per-test stats shape
(e.g. alongside `mean`/`stddev`/`min`/`max`). Whisker bounds (e.g.
`q1 - 1.5*iqr`, `q3 + 1.5*iqr`) can be derived by the chart consumer from
`q1`/`q3`, so they don't need to be stored.

**Fix applied:** `StatsSummary.stats.perTestStats` now includes `median`, `q1`, `q3` (plus `mean`, `stddev`, `min`, `max`, `count`) for each test. Note: `perTestStats` aggregates across the whole lot; `buildTestBoxplotData` in tsmap computes per-wafer boxes for a selected test and is not replaced by this change.

### ~~7. `yieldPercent` fields hold a 0–1 fraction despite the name~~ (fixed in v0.13.3)

**Where:** `packages/renderer/buildWaferMap.ts` (`YieldSummary.yieldPercent`,
`yieldPercentGross`) and `packages/stats/types.ts`
(`StatsSummary.stats.yieldPercent`, `LotStatsSummary.lotYieldSeries[].yieldPercent`,
`testSpecYield[].yieldPercent`).

**Problem:** Despite the `*Percent` naming, every one of these fields is a
0–1 fraction (`passDies / totalDies`), not a 0–100 percentage — wmap's own
`summaryPanel.ts` has to multiply by 100 before display
(`` `${(yieldSummary.yieldPercent * 100).toFixed(1)}%` ``). tsmap's first
chart implementation passed `yieldPercent` straight into a 0–100 colour
gradient, so every wafer landed near 0% and rendered red regardless of actual
yield — a naming trap any new consumer is likely to fall into.

**Suggested fix:** Either rename the fields to `yieldFraction`/`yieldRatio`
(breaking change, needs a major version bump) or document prominently in the
TSDoc comment on each field that the value is a 0–1 fraction and must be
multiplied by 100 for display — the current comment on `YieldSummary.yieldPercent`
explains the *formula* but never states the *range*.

**Fix applied:** All `yieldPercent` fields now hold values in [0, 100]. Remove the `* 100` multiply in `src/charts/aggregate.ts` (`buildYieldData`).

### ~~8. `softBinColor` defaults `maxBin` to 6 — clamps lots with higher soft-bin codes to one colour~~ (fixed in v0.13.3)

**Where:** `packages/renderer/colorMap.ts` — `softBinColor(bin, maxBin = 6)`
maps `bin / maxBin` onto the Viridis scale via `valueToViridis`, which clamps
its input to `[0, 1]`.

**Problem:** Soft bin codes commonly exceed 6 (STDF V4 allows 0–32767, and
multi-category test programs routinely define a dozen or more). Any bin
`>= maxBin` clamps to `t = 1` and renders identically — the same end-of-scale
colour — making `softBinColor(bin)` useless for distinguishing bins in a
typical lot unless the caller already knows to pass the lot's actual maximum
soft-bin code as `maxBin`. This is easy to miss since the function compiles
and runs fine; it just silently produces indistinguishable colours.

**Suggested fix:** Either derive a sensible default from the bin value itself
(e.g. round up to the next power-of-two-ish ceiling), or — better — make
`maxBin` a required parameter so callers can't omit it without thinking about
their data's bin range. At minimum, the TSDoc should call out that omitting
`maxBin` silently clamps high bin codes to the same colour.

**Fix applied:** `softBinColor(bin)` now uses a discrete categorical palette (same as `hardBinColor`) — no `maxBin` parameter, no gradient. Remove the `maxSoftBin` computation in `src/main.ts` and call `softBinColor(bin)` directly.

### ~~9. `analyzeWaferMap` lacks per-wafer test statistics — tsmap must re-walk results for box plots~~ (fixed in Unreleased)

**Where:** `packages/stats/analyzeWaferMap.ts` — `computePerTestStats` aggregates test values across all dies into a single lot-level entry per test (`StatsSummary.stats.perTestStats`). There is no per-wafer breakdown.

**Problem:** tsmap's box-plot chart shows one box per wafer for a selected test (min/Q1/median/Q3/max). To build this, tsmap re-walks `wafer.results` itself in `buildTestBoxplotData` (`src/charts/aggregate.ts`), duplicating the value-extraction and quantile logic that `analyzeWaferMap` already performs. This was originally logged as issue 6 requesting quartiles on `perTestStats`, but that was the wrong ask — `perTestStats` is lot-level; what tsmap needs is a per-wafer × per-test five-number summary.

**Fix applied:** `perWaferTestStats` added to `LotStatsSummary` (not `StatsSummary`) — projected from `perWafer[i].summary.stats.perTestStats` in `analyzeWaferLot`. Shape matches the proposal above plus a `label` field. Only present when `enableTestValueAnalysis: true`. tsmap can drop `buildTestBoxplotData` and read `lotSummary.perWaferTestStats` directly.

### 11. Die hover tooltip has no row cap — becomes taller than the viewport with many tests

**Where:** wmap die tooltip renderer (wherever per-die `testValues` are listed in the hover popup).

**Problem:** When a die has many `testValues` (e.g. 30+ selected tests after filtering), the tooltip grows to match, easily exceeding the viewport height. There is no cap on the number of rows shown and no scrolling or truncation.

**Suggested fix:** Cap tooltip test rows at a sensible limit (e.g. 10–15), add a "…and N more" overflow line, or make the tooltip scrollable with a `max-height` and `overflow-y: auto`. The cap should be configurable via a render option.

**Current workaround in tsmap:** None — the host has no access to the tooltip DOM. The test selector limits which tests are imported, so users can reduce the count manually, but there is no automatic cap.

---

### 10. IPC data transfer and wmap input format are not designed for large test counts — investigation ongoing

**Where:** tsmap `src-tauri/src/commands/` (all parsers), wmap `packages/renderer/buildWaferMap.ts` (`DieResult` input type).

**Problem:** The current data path is:

1. Rust parser → JSON serialisation (serde) → Tauri IPC bridge → JS JSON.parse → `DieResult[]` objects → `buildWaferMap`

At production scale — 50,000 dies × hundreds of parametric tests per wafer — this becomes a significant bottleneck at every step: JSON text volume, serialisation/deserialisation cost, per-object heap allocation in JS, and GC pressure. The `DieResult` format is also row-oriented (one object per die, with a `testValues` map), which is cache-unfriendly for the column-oriented access patterns that rendering and statistics use (e.g. "all values for test #42 across all dies").

Die-level metadata (arbitrary string/number fields attached to each die, e.g. site ID, temperature, serial number) compounds the problem further — it currently travels in the same per-die object and is not used by wmap's rendering at all.

**Suggested directions:**

1. **Columnar typed-array input to `buildWaferMap`** — instead of `DieResult[]`, accept a columnar structure: `{ x: Int32Array, y: Int32Array, hbin?: Uint16Array, sbin?: Uint16Array, testValues?: { [testNumber: string]: Float64Array }, metadata?: Record<string, unknown[]> }`. This maps directly to how rendering and stats consume the data, eliminates per-die object allocation, and transfers as raw binary over the IPC bridge. Metadata can be separated into a parallel array structure that wmap stores but does not process.

2. **Rust → WASM for data processing** — since both tsmap and wmap are owned projects, moving wmap's `buildWaferMap` (geometry inference, grid construction, retest policy) to a Rust/WASM module is viable. The Rust parser would produce the typed arrays directly in WASM-shared memory, bypassing the IPC bridge and JSON entirely for the hot path. Analysis (`analyzeWaferMap`) could also move to WASM. This is a larger undertaking but eliminates the serialisation round-trip completely.

**Investigation completed (2026-06-08):** Full pipeline analysis and benchmarking done. Key findings:

- **Tier 1 fixes shipped** (no API breakage): merged `buildView` min/max scans, replaced per-die object spread with `Float64Array` coord table (1.9 MB → 314 KB per rotated view at 20k dies), merged bin-count loop, replaced O(D) hover scan with uniform-grid spatial index (48× faster at 20k dies). See `scripts/bench-buildview.mjs` for the canonical benchmark.
- **Synthetic scale dataset** generated: `site/data/large-parametric.csv` — 5 wafers × 2709 dies × 200 tests (~24 MB) for future profiling.
- **Remaining bottleneck in `buildView`** is `pushDieRectangles` loop itself — irreducible O(D), ~2–3 ms at 20k dies. Memoising the ViewRect array (Tier 2) would help for pan/zoom-only redraws.
- **IPC/columnar redesign** (Tier 3): still requires profiling with a real large STDF file to confirm the IPC boundary is actually the bottleneck. Columnar input to `buildWaferMap` is a breaking API change; Rust/WASM is viable but large effort. Do not start without profiling data.
- **Recommended next step:** Load a real production STDF (50k+ dies, 100+ tests) in tsmap with DevTools performance timeline open. Measure Rust parse, IPC transfer, JS JSON.parse, `buildWaferMap`, `analyzeWaferMap` separately before designing Tier 2/3 changes.
- **Parser throughput benchmark (2026-06-08):** Synthetic STDF files — `packages/parsers/examples/bench_stdf.rs` measures native `parse_stdf_from_bytes` in isolation. Results: 663 dies × 4 tests → 68ms; 5,585 dies × 11 tests → 720ms; 266,325 dies × 51 tests → 34.7s. Throughput is ~7,700 dies/sec regardless of scale, confirming the bottleneck is per-record iteration cost in `rust-stdf`'s `StdfRecord` enum (HashMap allocation per PTR). WASM would be ~50–70% of this. For typical production files (1–3 wafers, 10–20 tests, <5k dies) native parse is under 1s and WASM under 2s — acceptable. For very large sweeps (25 wafers × 50 tests × 10k dies) Rust parse alone takes 35s, making a re-implementation that avoids per-record allocation worthwhile.
