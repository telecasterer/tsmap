# wmap Issues Found via tsmap

This file tracks wmap library issues discovered while building tsmap.
At some point these will be converted into an implementation plan for wmap.

## Version tracking

| Field | Value |
|-------|-------|
| wmap version in use | 0.16.1 |
| Latest wmap release | 0.16.1 — check [github.com/telecasterer/wafermap/releases](https://github.com/telecasterer/wafermap/releases) |
| testdata-parser version | 0.4.0 — published to npm and adopted (root pins `^0.4.0`, lockfile + `node_modules` resolve 0.4.0). Crate `Cargo.toml` clean at 0.4.0. |
| Last updated | 2026-06-26 (wmap **0.16.1** installed + adopted: issues #22/#23 fixed — first-class `zIndex` render option + safe-by-default overlay stacking, default `--wmap-z` raised `100`→`6000` (logged as Changed, not breaking). tsmap `openWaferModal` now passes `zIndex: WAFER_MODAL_OVERLAY_Z` to all four renders and the global `--wmap-z` mutation/save-restore is removed. `npm run check` clean. testdata-parser 0.4.0: removed the `rust-stdf` dependency — own the STDF record framing + endianness; **added big-endian STDF support** (FAR CPU_TYPE 1=BE/2=LE), parser ~13% faster (148 MB/s), CSV parser 3.4× faster, ATDF parser 2.8× faster + SDR→sites parity, filtered-parse WRR-metadata parity fix. 91 Rust + 168 JS tests green, WASM + native build clean. **Published to npm and adopted** (root pins `^0.4.0`).) |

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

### ~~9. `analyzeWaferMap` lacks per-wafer test statistics — tsmap must re-walk results for box plots~~ (fixed in v0.13.4)

**Where:** `packages/stats/analyzeWaferMap.ts` — `computePerTestStats` aggregates test values across all dies into a single lot-level entry per test (`StatsSummary.stats.perTestStats`). There is no per-wafer breakdown.

**Problem:** tsmap's box-plot chart shows one box per wafer for a selected test (min/Q1/median/Q3/max). To build this, tsmap re-walks `wafer.results` itself in `buildTestBoxplotData` (`src/charts/aggregate.ts`), duplicating the value-extraction and quantile logic that `analyzeWaferMap` already performs. This was originally logged as issue 6 requesting quartiles on `perTestStats`, but that was the wrong ask — `perTestStats` is lot-level; what tsmap needs is a per-wafer × per-test five-number summary.

**Fix applied:** `perWaferTestStats` added to `LotStatsSummary` (not `StatsSummary`) — projected from `perWafer[i].summary.stats.perTestStats` in `analyzeWaferLot`. Shape matches the proposal above plus a `label` field. Only present when `enableTestValueAnalysis: true`. tsmap can drop `buildTestBoxplotData` and read `lotSummary.perWaferTestStats` directly.

> **Update (2026-06-24, wmap 0.16.0):** still not consolidated, and the calculus
> changed. 0.16.0 made `enableTestValueAnalysis` opt-in (default off) for
> performance, and tsmap took that default — so `perWaferTestStats` is no longer
> populated in tsmap's render path, and `buildTestBoxplotData`/`buildTestHistogramData`
> remain the source of box-plot/histogram stats. **However** 0.16.0 also added the
> *cheap* `computePerTestStats: true` option (the changelog explicitly recommends it
> for "box-plot / histogram panels that need distribution shape but not spatial
> findings") — but it produces **lot-level** `perTestStats`, not the **per-wafer ×
> per-test** five-number summary tsmap's per-wafer boxplot needs, and it is implied
> by `enableTestValueAnalysis` so there's still no cheap *per-wafer* path.
> **Suggested fix:** have `computePerTestStats: true` also populate
> `LotStatsSummary.perWaferTestStats` (per-wafer five-number summaries) *without*
> requiring the expensive `enableTestValueAnalysis` Welch pass. Then tsmap can
> finally retire its duplicated quantile logic in `aggregate.ts` and read per-wafer
> box-plot data straight from the cheap analysis path. Until then, tsmap's own
> raw-die computation stays — and is correct to keep.

### ~~11. Die hover tooltip has no row cap — becomes taller than the viewport with many tests~~ (fixed in v0.13.4)

**Where:** wmap die tooltip renderer (wherever per-die `testValues` are listed in the hover popup).

**Problem:** When a die has many `testValues` (e.g. 30+ selected tests after filtering), the tooltip grows to match, easily exceeding the viewport height. There is no cap on the number of rows shown and no scrolling or truncation.

**Fix applied:** `buildHoverText` now accepts a `testLimit` parameter (default 12). When the die has more tests than the limit, the remainder are replaced with `…and N more`. `RenderOptions.tooltipTestLimit` threads the value through from `renderWaferMap`. tsmap can pass `tooltipTestLimit` if it needs a different cap.

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

---

### ~~12. No save/download hook in the render API — host must monkey-patch the DOM~~ (fixed in 0.13.5)

**Where:** wmap canvas-adapter toolbar (the PNG download button in `renderWaferMap` / `renderWaferGallery`). It triggers a download with `<a download href="blob:…">.click()`.

**Problem:** A host that needs to redirect the save (Tauri desktop, where `<a download>` is suppressed and the file must go through a native dialog) has no API to intercept it. tsmap currently monkey-patches `HTMLAnchorElement.prototype.click` globally (`src/main.ts`, capture-phase guard for `download && href.startsWith('blob:')`) to grab the blob and route it to `platform.savePng`. This is a fragile global hack: it affects every anchor on the page and breaks if wmap changes its download mechanism.

**Suggested fix:** Add an optional `onSaveImage?(blob: Blob, suggestedName: string): void | Promise<void>` to the render options. When provided, the toolbar calls it instead of performing the `<a download>` click; when absent, behaviour is unchanged. Hosts then handle persistence (native dialog, server upload, etc.) without touching global prototypes.

---

### ~~14. `enableTestValueAnalysis` computation model doesn't match tsmap's usage pattern~~ (fixed in 0.16.0)

**Where:** `analyzeWaferMap` / `analyzeWaferLot` in wmap stats.

**Problem:** When `enableTestValueAnalysis: true` is passed, wmap eagerly computes per-test quartiles **and** five additional Welch t-test region-family passes (edge/corner/center/quadrant/half-wafer) for every test, on every wafer, up-front. This is 5–8× slower than `false` (benchmarked: ~32ms vs ~160ms per wafer at 1w × 2k dies × 50 tests). tsmap used this flag to get `perWaferTestStats` for its boxplot panels, but only ever needs the quartiles — never the regional Welch findings. The eager all-tests all-regions model caused severe UI hangs on large lots (25w × 10k dies × 400 tests).

**Workaround in tsmap:** Reverted to computing boxplot quartiles directly from die data in tsmap's own `buildTestBoxplotData` / `buildTrendData` functions (lazy, one test at a time, only on panel interaction). `analyzeWaferMap` is now called without the flag.

**Suggested fix in wmap:** Split the flag into two independent options: (a) `computePerTestStats: true` — only the quartile scan, no region passes, cheap; (b) `enableTestValueAnalysis: true` — full regional Welch t-tests, expensive, opt-in separately. This lets hosts get lightweight quartiles without paying for spatial analysis they don't use.

**Fix applied (wmap, pending release):** Both parts done.
1. **The flag was split exactly as suggested.** `computePerTestStats: true` runs only the per-test quartile scan (→ `StatsSummary.stats.perTestStats` / `LotStatsSummary.perWaferTestStats`); `enableTestValueAnalysis: true` runs the full regional Welch findings pass (and implies `perTestStats`). Both now **default to `false`** — the old default-`true` on `enableTestValueAnalysis` was the root cause: any caller not opting out paid the expensive pass. This is a breaking default change (wmap minor bump).
2. **The expensive pass itself was rewritten** to be allocation-light (columnar single-pass running sums per region; "rest of wafer" derived by subtraction, never materialised). ~2–2.3× faster with byte-identical findings (p-values exact; effect sizes within ~1e-12). Profiling had shown ~95% of analysis cost was array/GC churn around the Welch math, not the math — so WASM was considered and rejected (it would only touch the ~2% that is arithmetic and reintroduce the IPC marshalling of issue #10).

**Net effect for tsmap:** tsmap already calls `analyzeWaferMap(waferMap)` with no options and reads only the panel's yield/bin/ring sections (never the test-value findings or `perTestStats`), so under the new default it **automatically gets the fast path with no code change** — analysis drops from ≈285–867 ms/wafer to ≈23–31 ms/wafer, and a 10-wafer lot from multiple seconds to ≈293 ms. If tsmap later wants wmap-computed box-plot quartiles instead of its own `buildTestBoxplotData`, it can now pass `computePerTestStats: true` (≈149 ms at 2.8k × 200 tests) without triggering the Welch pass. **Adoption note:** because tsmap calls `analyzeWaferMap` with no options, bumping the wmap dependency to 0.16.0 *automatically* picks up the fast default — no tsmap code change required, but it is a behaviour change (the panel no longer carries regional test-value findings, which tsmap never displayed).

### ~~15. `stdf_test_names` / `atdf_test_names` WASM functions return wrong shape~~ (fixed in testdata-parser 0.2.3)

**Where:** `packages/parsers/src/lib.rs` WASM exports; published `@paulrobins/testdata-parser`.

**Problem:** The Rust source for `parse_stdf_test_names` returns `ScanResult { test_defs, die_count }` which should serialise as `{ testDefs: {...}, dieCount: N }`. However the published WASM package (≤ 0.2.2) returned just the raw `HashMap<String, TestDef>` — a flat object keyed by test number with no `dieCount` field. This meant in the browser/WASM path, `scanResult.testDefs` was `undefined` and `scanResult.dieCount` was `undefined`.

**Impact:** In the web app, `stdfTestNames` / `atdfTestNames` always threw "Cannot convert undefined or null to object". The scan fell back to unfiltered parse and the test selector overlay never appeared in the browser. The desktop (native Rust) path was unaffected.

**Fix:** Rebuilt and republished `@paulrobins/testdata-parser` 0.2.3 with the correct `ScanResult` struct. A temporary `normaliseScanResult` shim was used in `platform.ts` during the window between the Rust fix and the WASM publish; the shim has been removed in 0.2.3.

---

### ~~13. No structured warnings channel on `WaferMapResult` / `analyzeWaferMap`~~ (fixed in 0.13.5)

**Where:** wmap `buildWaferMap` and `analyzeWaferMap` return shapes.

**Problem:** wmap performs silent inference (pitch/center/flat-notch) and `llms.txt` documents principles like hbin/sbin independence and "do not fabricate missing bins". When the host *does* fabricate (e.g. tsmap mirrors hard bin onto a 65535 soft-bin sentinel), there is nowhere in wmap's own pipeline to surface that — tsmap added a `warnings: string[]` field to its parser output (`ParsedStdf.warnings`, `testdata-parser` ≥ 0.2.2) and logs them, but wmap's inference decisions still go to `console.warn` only. Mirrors the reviewer's "add a `warnings: []` array" suggestion.

**Suggested fix:** Add `warnings: string[]` to `WaferMapResult` (and/or `StatsSummary`) carrying inference advisories ("pitch inferred at confidence 0.6", "partial wafer — center inferred from bounding box midpoint"). Hosts can then display these instead of losing them to the console.

### 16. Toolbar icon set is internal — host cannot import it to match wmap's iconography

**Where:** wmap `packages/canvas-adapter/icons.ts` (the `ICONS` map) and the gallery-card expand SVG in `renderWaferGallery.ts`.

**Problem:** tsmap renders its own chart-card and overlay chrome (PNG save, expand, fullscreen, close, help) alongside embedded wmap wafer maps, so the user sees both UIs at once. To keep them visually consistent, tsmap's icon buttons should use the *same* icons as wmap. But `icons.ts` is marked "Internal shared module. Do not re-export from index.ts." and is not exported from the package, so tsmap cannot import the SVGs. tsmap currently **copies** the SVG strings verbatim into its own `src/charts/icons.ts` (`download`/camera, gallery-card `expand`, Lucide `x`/`minimize`, `help`). This couples the two repos by copy-paste: if wmap redesigns its icons, tsmap silently drifts.

**Suggested fix in wmap:** Export the icon set (or a curated subset) as a public API — e.g. `export const ICONS` from a stable entry point, or a small `getIcon(name)` helper — so host apps can import the exact same SVGs and stay in sync automatically. Document which icon keys are stable/public. This generalises beyond tsmap to any host wanting to match wmap's look.

### ~~17. Expand-modal fullscreen button uses the real Fullscreen API — dead in macOS WKWebView~~ (fixed in 0.16.0)

**Where:** `packages/canvas-adapter/toolbar.ts` — the modal opened by `openModal`. The fullscreen button click handler (line ~848), the `F`/`Esc` key handler in `onKeyDown` (~902–910), the `onFsChange` handler (~864), and the `document.addEventListener('fullscreenchange', onFsChange)` registration (~939). Also `getMenuParent`-style `document.fullscreenElement` reads at ~170 and ~333.

**Problem:** The modal toggles fullscreen with the **unprefixed** Fullscreen API — `box.requestFullscreen()`, `document.exitFullscreen()`, `document.fullscreenElement`, and the `fullscreenchange` event. macOS Tauri runs on WKWebView (WebKit), which:

1. Only exposes the **`webkit`-prefixed** variants (`webkitRequestFullscreen`, `webkitFullscreenElement`, `webkitfullscreenchange`) — the unprefixed names are `undefined`, so `box.requestFullscreen` throws/no-ops and the button does nothing; and
2. Has **element fullscreen disabled at the native level** unless the host sets WKWebView's `isElementFullscreenEnabled` / `fullScreenEnabled` preference. In Tauri that requires `app.macOSPrivateApi: true`, which uses Apple **private API** and blocks Mac App Store distribution.

So even a prefixed shim isn't enough on macOS Tauri without opting into private API. The `onFullscreenChange(isFs, box)` callback also never fires there, so consumers that reparent the tooltip into the fullscreen box (`renderWaferMap.ts` ~846, `renderWaferGallery.ts` ~1518) silently break too.

**Discovered in tsmap:** tsmap's own expand/help modals had the identical bug. Fixed there by **dropping the real Fullscreen API entirely** in favour of a CSS maximize — the modal box grows to `100vw/100vh` via a toggled class/inline style. This behaves identically on every target (Linux/Windows/macOS Tauri + all web browsers incl. Safari) with no native config and no private API. See `src/charts/chartShell.ts` (`toggleFullscreen` → `applyMaximize`) and `index.html` `.help-modal.maximized`.

**Suggested fix in wmap:** Replace the Fullscreen API in `openModal` with a CSS maximize toggle (size the box to fill its `position: fixed; inset: 0` backdrop). Keep the existing `onFullscreenChange(isFs, box)` callback firing on the synthetic toggle so tooltip-reparenting consumers keep working. Keep the close button visible while maximized (no OS chrome to escape) and let `Esc` always close. This removes the macOS dependency on `macOSPrivateApi` and the prefixed-API portability problem in one move.

**Fix applied:** `openModal` in `packages/canvas-adapter/toolbar.ts` now maximizes via a CSS toggle (`setMaximized` sizes the box to `100vw`/`100vh`) — the real Fullscreen API (`requestFullscreen`/`exitFullscreen`/`fullscreenchange`) is gone entirely. `onFullscreenChange(isMaximized, box)` still fires on the synthetic toggle, so the tooltip-reparenting consumers in `renderWaferMap.ts`/`renderWaferGallery.ts` are unchanged. `Esc` always closes; the close button stays visible while maximized. The `document.fullscreenElement` reads that routed menus/submenus into the fullscreen element were dropped (`menuRootFor` already walks up to `.wmap-modal-box`; the value-mode cascade submenu now appends into its parent menu's stacking root).

### ~~18. Hover tooltips require per-die duplication of wafer-level metadata~~ (fixed in v0.15.0)

**Where:** wmap `packages/renderer/buildView.ts` `buildHoverText` (read provenance only from `die.metadata`) and `packages/core/metadata.ts` `DieMetadata` (named wafer-level fields `lotId`/`waferId`/`deviceType`/`testProgram`/`temperature`).

**Problem:** Provenance appeared in die hover tooltips only when set per-die on `DieMetadata`. But lot/program/temperature/product are wafer-level facts — a die cannot differ from its wafer on them. tsmap knows them at the wafer level (`WaferSource`), so to get tooltips it would have had to copy identical values onto every `DieResult` (up to ~500k per lot), bloating memory and mutating the wmap-bound `results` array (which threatens tsmap's shared-`WaferSource`-by-reference invariant). The tooltip already had the wafer's `WaferMetadata` (`view.metadata`) in scope but ignored it.

**Suggested fix in wmap:** Tooltip should read wafer-level metadata from `waferConfig.metadata` as the base and let any per-die key override it; drop the redundant wafer-level named fields from `DieMetadata`.

**Fix applied (0.15.0):** `buildHoverText` gained a trailing `waferMeta?` parameter; it now merges `{ ...waferMeta, ...die.metadata }` (wafer base, die override), omitting `waferId`. `renderWaferMap` passes `result.metadata` automatically, so gallery cards benefit too. The wafer-level named fields were removed from `DieMetadata` (open index signature retained for genuinely per-die annotations). tsmap now supplies wafer metadata once via `toWmapWaferMeta(source, waferId)` and gets full tooltips with no per-die cost.

### ~~19. `WaferMetadata`/`DieMetadata` types not re-exported from `/renderer`~~ (fixed in v0.15.0)

**Where:** wmap `packages/renderer/index.ts`.

**Problem:** `WaferMetadata` (used to build `WaferConfig.metadata`) and `DieMetadata` are renderer-input concepts but were re-exported only from `/core`, so a consumer building renderer input had to import the renderer functions from `/renderer` and these types from `/core`.

**Fix applied (0.15.0):** `packages/renderer/index.ts` now `export type { WaferMetadata, DieMetadata } from '../core/metadata.js'`.

### ~~20. tsmap/wmap capability boundary — charts ↔ summary-panel redundancy~~ (decided 2026-06-24)

**Context:** tsmap has become a proving-ground for analysis/visualisation ideas. Several now overlap what wmap's summary panel already does, and the strategic question is *where each capability should ultimately live* — tsmap-only, or promoted into wmap so every wmap host benefits. The owner is not against moving more into wmap when that's the best home; the point of this entry is to make the boundary a deliberate, logged decision rather than drift.

**The redundancy (centred on the gallery LOT panel, which is at the same scope as tsmap's charts page):**

| Metric | wmap gallery lot panel (`renderLotSummaryContent`) | tsmap charts page | Overlap |
|--------|---------------------------------------------------|-------------------|---------|
| Per-wafer yield | "Per-wafer yield" list | "Yield by wafer" bars | direct duplication |
| Lot bin breakdown | "Lot bin" (pooled) | "Bin pareto" (pooled) | direct duplication |
| Per-test value stats | "Lot test value" numbers | Boxplot + Histogram | strong (numbers vs. distribution) |
| Ring / quadrant / site / findings | yes | — | panel only |
| Trend, correlation, scatter, **metadata/lot faceting** | — | yes | charts only |

**Clean split:** the **panel** uniquely owns spatial + significance *findings* (always beside the maps); the **charts** uniquely own trends, correlation, scatter, and **group/compare by metadata or lot** (tsmap's faceting work). The middle band (per-wafer yield, bin pareto, per-test summary) is duplicated.

**Capabilities tsmap built that are wmap-promotion candidates** (each: does every wmap host want this? if yes, it likely belongs in wmap):
- **Faceting / group-compare** by lot/program/temperature/date — combined yield-per-group, boxplot-per-group, overlaid histograms, clustered bin pareto, scatter-coloured-by-group, correlation restricted-to-group. (tsmap `src/charts/`.)
- **Generic metadata model** — `{key,value}` fields with host-side curation (already partly in wmap via `WaferMetadata`'s open index; the *faceting* on top is tsmap's).
- **Interactive distribution charts** (boxplot, histogram, correlation matrix, scatter) vs. the panel's numeric summaries.

**Decision (2026-06-24) — option (a), boundary drawn by data scope, not widget type:**

- **wmap panel owns** single-population summaries (per-wafer yield, pooled bin pareto, per-test value numbers, ring/quadrant) **and** spatial + significance *findings*. These are one-lot, no-grouping facts that belong beside the maps. No change to the panel.
- **tsmap charts own** faceting / group-compare / split-by (yield-per-group, boxplot-per-group, overlaid histograms, clustered pareto, scatter/correlation coloured-by-group) **and** interactive distributions (boxplot, histogram, correlation, scatter). This is a cross-population analytics surface.
- **The middle-band duplication stays — it is intentional.** The panel gives the engineer the exact pooled figure beside the wafer; the chart gives distribution shape and lets them split by lot/program/temperature. Same fact, two reading modes. Not trimmed.

**Faceting is NOT promoted into wmap.** It depends on three things wmap's panel deliberately does not carry: the generic `{key,value}` metadata model (the *storage* already exists in wmap via `WaferMetadata`'s open index — but the *faceting on top* does not), a host-curated label/which-to-facet table (tsmap `src/metadata.ts` `FIELD_META`), and a charting runtime. Promoting it would force every wmap host onto tsmap's curation conventions and pull a chart engine into the renderer-agnostic, DOM-light panel. Faceting stays host-side.

No code change in either repo — this entry records the boundary so future work doesn't grow faceting into the panel by drift. See the tsmap plan file "Phase 8" section for the fuller analysis.

### ~~21. No render teardown — wmap's internal observers leak when its container is removed~~ (already provided — `controller.destroy()`)

**Where:** wmap `renderWaferMap` / `renderWaferGallery` (`packages/renderer`). They attach internal `ResizeObserver`s (and likely other listeners) to elements inside the host-provided container, but return nothing and expose no `dispose()` / cleanup handle.

**Problem:** tsmap now renders maps into a **transient modal** (charts drilldown — `openWaferModal` in `src/main.ts`). When the modal closes we `backdrop.remove()`, which detaches the wmap-rendered subtree. wmap's observers/listeners are never explicitly disconnected; they linger on the detached nodes until GC. The same latent leak exists on every `container.innerHTML = ''` swap in `renderWaferView`, but the modal makes it frequent (open/close per drilldown). tsmap can't clean this up itself because the observers live inside wmap and aren't registered in tsmap's own `trackObserver` registry (and that registry must NOT be flushed on modal close — it holds the live charts grid's observers).

**Suggested fix:** have `renderWaferMap` / `renderWaferGallery` return a disposer (e.g. `{ dispose(): void }`) that disconnects every observer/listener they created, so a host embedding maps in modals/tabs can tear down cleanly on close. Alternatively, observe container detachment internally and self-disconnect. Until then the leak is benign (detached nodes are GC-eligible once the host drops its refs) but real.

**Resolution — no wmap change needed; the API already exists.** The premise that the
controllers "return nothing and expose no `dispose()`" is incorrect for the current
library. Both `renderWaferMap` and `renderWaferGallery` already return a controller with
a public, typed `destroy(): void` ("Remove all event listeners and DOM elements") that
performs exactly the teardown requested:

- `renderWaferMap().destroy()` (`packages/canvas-adapter/renderWaferMap.ts`) calls
  `resizeObserver.disconnect()`, removes every canvas pointer/wheel/key/click listener,
  removes the `window` `blur` listener and the DPR `matchMedia` `change` listener,
  removes the document-level menu-close capture listener, closes any open modal/menu,
  hides (never destroys) the shared singleton tooltip, and removes all DOM it appended
  (`canvasWrap`, toolbar, summary-panel wrappers).
- `renderWaferGallery().destroy()` (`packages/canvas-adapter/renderWaferGallery.ts`)
  cascades `destroy()` to every card controller, disconnects the grid `ResizeObserver`,
  removes its document/window listeners, closes the modal, and removes its DOM.

**Adoption in tsmap (done 2026-06-26):** every wmap render now captures its controller and
destroys it before its container is detached/cleared:
- `openWaferModal` (`src/main.ts`) — `render` returns the controller; `close()` calls
  `controller.destroy()` before `backdrop.remove()`.
- `renderWaferView` (full-window map/gallery) — stores the controller in module-level
  `mainViewController`; `destroyMainView()` is called before every `container.innerHTML = ''`
  / view swap (`renderWaferView` itself, `renderChartsViewWork`, `showLoadingState`,
  `showEmptyState`).
This disconnects wmap's observers/listeners deterministically — no need to register them in
tsmap's `trackObserver` registry, and the charts-grid observers are untouched. No library
change required.

### ~~22. Toolbar menus/tooltips are unreachable when wmap renders inside a host modal that isn't a `.wmap-modal-box`~~ (fixed in wmap — pending release)

**Where:** wmap `packages/canvas-adapter/toolbar.js` — `menuRootFor(anchor)` (walks ancestors for a `.wmap-modal-box`, else falls back to `document.body`) and the tooltip reparenting in `renderWaferMap.js`. All menus/tooltips are positioned `position: fixed` with `z-index: var(--wmap-z, 100)` (menus) / `calc(var(--wmap-z, 100) + 1)` (tooltips).

**Problem:** tsmap renders a wafer map into its **own** modal (`openWaferModal` in `src/main.ts`) — opened from a chart drilldown (pareto bar → stack map, yield bar → bin map). That modal is a plain host `<div>`, not wmap's `openModal` box, so it has neither the `wmap-modal-box` class nor a `--wmap-z` custom property. Consequences:

- `menuRootFor()` finds no `.wmap-modal-box` ancestor and appends the plot-mode dropdown (and other menus) to `document.body` at `z-index: 100`.
- tsmap's modal backdrop is `z-index: 200` and its box `z-index: 201`, so every wmap menu renders **behind** the modal. The toolbar buttons fire correctly but their menus (and tooltips) are hidden underneath — the toolbar appears completely dead to the user.

This is the inverse of resolved issue #5: #5 handed stacking control to the host via `--wmap-z`, but wmap only sets that variable and the `wmap-modal-box` hook on **its own** modal. A host embedding a wmap render in a host-owned modal has no documented contract for making toolbar menus land above it.

**Suggested fix (any one):**

1. Document the contract: "to embed a wmap render inside your own modal, give the modal element `class="wmap-modal-box"` and set `--wmap-z` above your modal's z-index." (Cheapest; this is what tsmap now relies on.)
2. Add a render option (e.g. `menuRoot?: HTMLElement` or `zIndex?: number`) so the host can pass the container/stacking value explicitly instead of relying on an undocumented class name.
3. Have `menuRootFor` fall back to the wmap render container (or the toolbar's offset parent) rather than `document.body`, so menus inherit the host modal's stacking context automatically.

**Workaround in tsmap (2026-06-26):** two parts in `openWaferModal` (`src/main.ts`):

1. The box carries `class="wmap-modal-box"` so `menuRootFor` reparents the plot-mode dropdown *into* the box.
2. `--wmap-z:300` is set on **`document.documentElement`** (not the box) for the modal's lifetime, restored on close.

Part 2 is essential and was missed on the first attempt: setting `--wmap-z` on the box only fixes overlays wmap appends inside the box (the plot-mode menu). But several wmap overlays append to **`document.body`**, outside the box, and read `--wmap-z` from `:root` — the singleton **die tooltip** (`createTooltip` → `document.body.appendChild`), the **user-guide modal** (help button), and the **expand modal** (`openModal` → `document.body.appendChild(backdrop)`, which also *reparents the canvas into its box*, so a too-low z made the canvas appear to blank). All of these stayed at z 100 behind the tsmap modal until `--wmap-z` was raised on the root. This whole dance depends on the undocumented `wmap-modal-box` class and the `--wmap-z` variable — options 1/2 above would make it a supported contract.

**Fix applied (wmap, pending release) — see issue #23 for the unified resolution.** Both the per-render `zIndex` option and the safe-by-default stacking landed together; this addresses #22 and #23 as one design fix.

### ~~23. Overlay stacking has no first-class host API — z-index issues keep recurring (design recommendation)~~ (fixed in wmap — pending release)

**Why this is its own entry:** stacking has bitten us repeatedly — issue #5 (toolbar at `z 9998/9999` overriding host overlays), then issue #22 (toolbar menus/tooltips/expand-modal *behind* a host modal). #5 and #22 are the two opposite failure directions of the *same* missing abstraction. This entry records the root cause and the recommended API change so the wmap implementation plan treats it as a deliberate design fix, not a third one-off patch.

**Root cause — two uncoupled axes the host must align by hand.** Every wmap transient overlay (toolbar dropdowns, die tooltip, expand modal backdrop/box, user-guide modal) is positioned by two independent decisions made in different places:

1. **Stacking value** — a CSS variable `--wmap-z` (default `100`), read from wherever the element sits in the cascade.
2. **DOM attach point** — `menuRootFor()` attaches to the nearest `.wmap-modal-box` ancestor, *else* falls back to `document.body`.

Because some overlays attach inside a wmap box and others escape to `document.body`, "set the stacking correctly" really means "enumerate every escape-to-body overlay and ensure the `--wmap-z` it inherits is high enough" — which is exactly the bug hit twice in #22. Two structural traps make it worse:

- **The default `100` is unsafe.** It sits *below* almost any app's own modal layer (200, 1000, 9999…), and the failure mode is silent: the overlay renders *behind* the host UI with no error. An embedder gets a "dead toolbar" / "blank canvas" with nothing in the console.
- **The host's only lever is a global, undocumented CSS variable.** Controlling stacking means mutating `--wmap-z` on `document.documentElement` (so escape-to-body overlays inherit it) and remembering to restore it — global mutation for what should be a per-render concern, keyed off internal names (`--wmap-z`, `.wmap-modal-box`) reverse-engineered from the dist.

**Recommended fix (in priority order):**

1. **First-class per-render stacking input.** Add `renderWaferMap(el, map, { zIndex })` (and the gallery equivalent). wmap writes that value onto *its own* overlay elements directly rather than reading an inherited `:root` variable, so the attach-point axis stops mattering — an overlay appended to `document.body` and one appended inside a box both stack at the host-specified value. This is the real fix and removes the entire "which ancestor do I inherit from" failure class.
2. **Safe-by-default stacking.** If no `zIndex` is given, default wmap transient overlays to the top of the stacking order (a very high constant, or an explicit "wmap renders transient overlays above app content" contract) instead of `100`. Most embedders expect overlays to "just appear on top" with no configuration.
3. **Document the embedding contract** for the interim: to embed a wmap render inside a host-owned modal, set `--wmap-z` (above the host modal's z-index) on an ancestor that *all* wmap overlays inherit from — in practice `document.documentElement`, because several overlays append to `document.body`. Name `--wmap-z` and `.wmap-modal-box` as the supported public hooks.

**tsmap status:** working today via the issue #22 workaround (`--wmap-z:300` on `document.documentElement` for the modal's lifetime). That is a host-side patch over a missing API; options 1–2 here would let tsmap drop the global-variable mutation entirely and just pass a `zIndex` per render.

**Fix applied (wmap, pending release):** options 1 and 2 both done; option 3 documented.

1. **Per-render `zIndex`** added to `RenderOptions` (`renderWaferMap`) and `GalleryOptions` (`renderWaferGallery`). wmap applies it for the render's lifetime and restores the previous stacking on `controller.destroy()`. Implemented via `applyOverlayZ(zIndex)` in `packages/canvas-adapter/toolbar.ts` — it writes `--wmap-z` onto `document.documentElement` so the body-escaping overlays (tooltip, expand/help modal backdrops) inherit it, returning a disposer the controller calls on teardown. (wmap kept the CSS-variable mechanism rather than writing inline z-index onto every overlay element; the host-facing result is the same — one `zIndex` value per render, no manual global mutation.)
2. **Safe-by-default stacking:** the `--wmap-z` fallback changed from `100` to `6000` (a single `DEFAULT_OVERLAY_Z` constant, surfaced as the `Z_BASE`/`Z_ABOVE`/`Z_ABOVE2` z-index strings used across `toolbar.ts`/`renderWaferMap.ts`). Overlays now appear above typical app modal layers with no configuration. Logged as a default change (CHANGELOG `### Changed`), not breaking — the only way to regress is to have *deliberately* placed a host overlay between `100` and `6000` to cover wmap's own menus, which is not a sensible config; any host that already set `--wmap-z` is unaffected.
3. **Embedding contract documented** in `docs/api.md` §5.4 "Overlay z-index", naming `zIndex` and `--wmap-z` as the supported public hooks.

**Net effect for tsmap:** the issue #22 workaround in `openWaferModal` (`--wmap-z:300` on `document.documentElement` + `class="wmap-modal-box"`) can be replaced with a single `zIndex` passed to the wmap render (set above tsmap's modal box z-index, e.g. `zIndex: 300`). The `wmap-modal-box` class hint is still useful for reparenting menus *into* the host box, but the global-variable mutation and its save/restore dance can be dropped once tsmap bumps to the release carrying this fix. With no change at all, tsmap's modal-embedded maps also stop rendering behind the modal by default (safe-by-default), though tsmap should still pass `zIndex` if its own overlays exceed `6000`.

**Adopted in tsmap (2026-06-26, wmap 0.16.1):** `openWaferModal` now passes `zIndex: WAFER_MODAL_OVERLAY_Z` (= 300, a module constant clearing the modal box's z 201) to all four wmap renders (`renderWaferMap` ×3, `renderWaferGallery` ×1). The `--wmap-z` mutation on `document.documentElement` and its save/restore in `close()` are deleted — the controller's `destroy()` restores wmap's stacking. The `class="wmap-modal-box"` on the box is kept (still reparents the plot-mode menu into the box). `npm run check` clean.
