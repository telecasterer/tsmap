# UX/Feature Backlog

Ideas from a full app review (2026-07-09), from a user's point of view — what would make
tsmap easier to use, more intuitive, and more useful. Not all of these are committed; several
need more discussion before scoping. Check items off (`[x]`) and add an implementation note
or a link to the PR/commit when done, rather than deleting the entry — keep the history like
`WMAP_ISSUES.md` does.

## Quick wins (low effort, real friction removed)

- [x] **Recent-files (MRU) list.** No way to reopen a recently-loaded file/lot without a fresh
      file-picker trip. Show last 5–10 on the empty state and under "Open file".
      Implemented 2026-07-09: `src/recentFiles.ts` + empty-state list and a toolbar **Recent**
      dropdown in `main.ts`, both sharing `buildRecentRows`. Desktop only (Tauri paths required
      to reopen without the picker); last 8 entries with last-loaded timestamps, `localStorage`.
      Fixed same day: entry tooltips were using the native `title` attribute, which left ghost
      rendering artifacts on WebKitGTK when a row was removed while hovered — switched to the
      shared themed `attachTooltip`. Also added the toolbar button so Recent stays reachable
      once a file is loaded, not just from the empty state. Reopening is replace-only (matches
      "Open file" semantics) — no append-from-recent yet, a deliberate v1 scope call.
      Second fix same day: the row tooltip rendered behind the Recent dropdown itself — root
      cause was a latent bug in the shared `tooltip.ts` singleton (only re-appended to `<body>`
      on its first-ever show, so any later-appended overlay at the same z-tier silently
      out-ranked it in DOM paint order). Fixed at the source in `tooltip.ts` — always
      re-appends on every show — so it can't recur for any future overlay either.
- [x] **Sample/demo data on first run.** Installers are unsigned and trigger OS security
      warnings (first-impression cost). A "Load sample data" button on the empty state lets an
      evaluator get past that and see the app work before trusting their own files.
      Implemented 2026-07-09: reused the existing `sample_data/PVT-LOT-05.stdf` fixture
      (13 wafers, 5 process corners) rather than bundling anything new — gzipped to 106 KB
      (`sample_data/sample-lot.stdf.gz`) and loaded through the normal pipeline via a new
      `Platform.getSampleFile()`. Desktop: shipped as a Tauri `bundle.resources` entry,
      resolved at runtime with `resolveResource()` to a real path — reuses the native parse
      commands' existing transparent `.gz` decompression, no new Rust code. Web: fetched as a
      Vite-resolved static asset (`new URL(..., import.meta.url)`), decompressed by the
      existing `expandArchives()` `.gz` handling — also no new code. Sizing (measured against
      real bundles): +14.3% raw / +2.2% gzipped on the `.deb`; +0.9%/+0.14% on the AppImage
      (dominated by its bundled webview runtime). Verified: web path end-to-end via `curl`
      against the dev server (exact byte match); desktop verified by config/code inspection
      and `cargo check` only, since a GUI smoke test needs a display this environment doesn't
      have — caught two real bugs on the user's manual `tauri dev` test that inspection alone
      missed. (1) The desktop path 404'd (ENOENT): `bundle.resources` was the bare string-array
      form, and Tauri rewrites `..` segments to a literal `_up_` in the resource tree for that
      form (the source lives outside `src-tauri`) — so the real key was
      `_up_/sample_data/sample-lot.stdf.gz`, not `sample-lot.stdf.gz`. Fixed by switching to
      the `{ "source": "target" }` object form, which pins the target name explicitly. (2) The
      error surfaced as unhelpful "undefined" — a separate, codebase-wide bug where
      `(e as Error).message` on a Tauri `invoke()` rejection (a plain string, not an `Error`)
      silently reads as `undefined`; fixed at the source with a new `errMsg()` helper in
      `lib.ts`, applied to all 7 call sites in `main.ts`. Confirmed fixed against a real
      `tauri dev` run.
      Follow-up 2026-07-09: bundled the matching `PVT-LOT-05_splits.csv` alongside (same
      resource/fetch pattern as the STDF — one more `bundle.resources` entry, one more
      `Platform.getSampleSplitsCsv()`) so the demo shows off wafer splits too, with no new UI.
      Rather than a second load flow, it seeds the *existing* splits auto-restore store
      (`SPLITS_LS_KEY` in `main.ts`, `loadSavedSplits`) just before the fingerprint becomes
      computable — via a small `pendingSampleSplitSeed` module variable consumed inside
      `loadSavedSplits` itself — so the already-built "never silent, logs + opens the dialog"
      restore UX picks it up for free. Splits fetch failure degrades gracefully (logs, doesn't
      block the STDF load). Verified: web assets confirmed via `curl` against the dev server
      (exact byte match for both files); wafer-ID match between the CSV and STDF confirmed by
      reading `scripts/generate_stdf_corner_lot.py` (both are generated from the same
      `WAFER_CORNERS` list, so they can't drift); the `renderWafers`-side seeding logic itself
      not run live (same environment constraint as above) — worth a manual check alongside the
      sample-file fix.
- [ ] **Pin/favorite tests.** With hundreds of tests, the boxplot/histogram/scatter/correlation
      dropdowns are flat lists. A pinned/favorites section (separate from the existing rename
      feature) cuts repeated searching during a debug session focused on a handful of tests.
- [ ] **Keyboard-shortcut cheat sheet.** Esc/F etc. exist but are documented only in guide
      prose. A `?`-triggered overlay would surface them in-context.

## Chart/analysis additions (highest-value category — needs discussion on scope)

**2026-07-11 ownership shift:** tsmap's own Charts page (`src/charts/*`, ~2000 lines) was
deleted entirely as part of the wmap↔tsmap boundary rework — every chart/analysis panel (yield,
bin pareto/cluster, capability, boxplot, histogram, correlation, scatter) now lives in wmap
itself as its **Insights tab** (opt-in via `insights: { enabled: true }` on
`renderWaferMap`/`renderWaferGallery`), available to any wmap host, not just tsmap. tsmap has no
chart-rendering code of its own left. See `WMAP_ISSUES.md` #31 for the full migration history.
Any new chart idea below would now be scoped and built as a **wmap** contribution, not a tsmap
change — noted per item.

- [x] **Cpk/Ppk (process capability).** Biggest functional gap for this audience. Boxplot and
      histogram already have mean/stddev/limits in scope — natural home for Cp/Cpk/Pp/Ppk.
      Implemented 2026-07-10 as a new **Process capability** chart panel (`src/charts/capability.ts`,
      `buildCapabilityData` in `charts/aggregate.ts`), merged with the "parametric worst
      offenders" idea below into one visual per user discussion: a normalized boxplot per
      test (LSL→0, USL→1, only tests with *both* limits — a real-world fab audience often has
      few or no limits set, so the panel reports how many tests were excluded rather than
      guessing) sorted worst-Ppk-first, colour-coded by Ppk band. Cp/Cpk use pooled
      within-wafer stddev (ANOVA-style pooling, wafer = the natural short-term subgroup);
      Pp/Ppk use the plain overall stddev — both shown on hover. Respects the existing "Group
      by" via a `Group:` selector mirroring the correlation matrix's restrict-to-group pattern
      (subgroup for Cp/Cpk stays per-wafer regardless of grouping; only the pooled population
      changes). Clicking a test's box sets the boxplot/histogram panels to that test in place,
      the same cross-panel-link pattern as the correlation matrix → scatter (`onSelectPair`),
      required adding `setTest` handles to `renderBoxplotPanel`/`renderHistogramPanel`'s return
      values. Verified with Playwright against `dev:web` (headless — no display in this
      environment) using the `PVT-LOT-05`-style corner-lot fixture: normalized boxes render
      correctly, hover tooltip shows Cp/Cpk/Pp/Ppk, click-to-drive-boxplot confirmed, and the
      grouped `Group:` selector correctly restricts to one split's wafers.
      Follow-up 2026-07-10: three issues found by the user in first review, all fixed. (1) The
      panel's canvas didn't grow to fill the expand modal — it drew at a fixed size regardless
      of the modal's available space, unlike boxplot/histogram/scatter. Fixed by adopting the
      same `applyCanvasFlow`/`chartFillHeight` fill-canvas pattern for height, and by lifting the
      per-column pixel cap only inside the modal (`isInModal(card)`) so columns stretch to use
      the full width instead of leaving it empty. (2) Capability was placed after boxplot/
      histogram in the card order even though it's effectively a selector for them (click a
      test's box to drive their selection) — reordered to lead. (3) The charts page was one
      flat 2-column grid; an odd card count in one logical group (e.g. 3 distribution panels)
      staggered the row alignment of unrelated cards after it (correlation matrix landing
      before the scatter it's paired with). Fixed by splitting `renderChartGrid` into labeled
      sections (`ChartSection[]`, `render.ts`), each with its own sub-grid — "Yield & bins",
      "Distributions", "Correlation" — so one section's odd count can no longer bleed into the
      next section's layout. Deliberately not collapsible yet (agreed with the user to hold off
      until the remaining 3 chart ideas below actually make the page unwieldy, rather than
      building that complexity preemptively).
      **Superseded 2026-07-11**: `src/charts/capability.ts` (and the rest of tsmap's Charts
      page) was deleted as part of the wmap↔tsmap boundary rework. Cp/Cpk/Pp/Ppk now live in
      wmap itself (`stats/capability.ts` + `packages/charts/capability.ts`) as part of its
      Insights tab's Distributions section, ported with the same normalized-boxplot/Group-by/
      cross-link design described above, and available to every wmap host, not just tsmap. See
      `WMAP_ISSUES.md` #31.
- [x] **Parametric "worst offenders" Pareto.** Bin pareto ranks hard-bin failures; nothing
      ranks *parametric tests* by out-of-spec rate or Cpk. Users currently click through tests
      one at a time to find the yield-loss driver. Mirrors the correlation matrix's existing
      "rank by |r|" pattern.
      Folded into the Process capability panel above (2026-07-10) rather than built as a
      separate pareto bar chart — the normalized-boxplot-sorted-by-worst-Ppk view covers the
      same "which test is the problem" workflow while also showing distribution shape, not
      just a single ranking number. Migrated into wmap along with that panel — see the note
      above.
- [ ] **Cross-lot SPC/run chart.** Boxplot's "Trend line" only connects per-wafer medians
      *within one load*. No run chart of a test's mean/median across lots/dates with control
      limits, despite faceting already supporting multi-lot loads.
      Note (2026-07-11): the "Trend line" toggle this idea builds on no longer exists at all —
      it was deliberately trimmed (not carried over) when boxplot was ported into wmap's
      Insights tab (`WMAP_ISSUES.md` #31). This would need to be built fresh in wmap, not layered
      onto an existing feature. Still unimplemented either way.
- [ ] **Wafer-to-wafer bin/value diff.** No overlay/diff view between two selected wafer maps
      (e.g. tool A vs tool B edge-ring pattern). Splits/grouping already segment wafers this
      way; a direct compare view closes the loop.
      Note (2026-07-11): tsmap has no chart code of its own left — this would now be a wmap
      Insights-tab addition, not a tsmap change. Still unimplemented.
- [ ] **Site-level analysis view.** Test site is captured (tooltip + grouping dimension) but
      has no dedicated chart. Boxplot-by-site or site-vs-site comparison is the standard way to
      catch a miscalibrated test head on multi-site testers. Mostly reuses existing grouping
      infrastructure.
      Note (2026-07-11): checked wmap's `buildFacetTable`/facet curation — site is not currently
      exposed as a groupable wafer-level facet (it's per-die, not per-wafer metadata), so "mostly
      reuses existing grouping infrastructure" is optimistic as written; would need its own
      aggregation. Would now be a wmap addition. Still unimplemented.

## Workflow/report gaps

- [x] **Exportable lot-level report.** PNG export is per-chart only. `write_temp_html.rs`
      already exists for the guide's print flow — extend that pattern to bundle current charts
      + a stats table into one HTML/PDF for handoff (customer, management, lot disposition).
      Implemented 2026-07-10 as a new toolbar **Report…** button (shown once wafers are
      loaded, same visibility rule as Splits…). Major mid-implementation pivot: while
      researching a from-scratch design (tables + embedded chart-image PNGs), found that
      `@paulrobins/wafermap/stats` (the currently-linked wmap 0.18.0) already ships a complete,
      unused, undocumented-in-tsmap `renderLotSummaryReportHtml` + `openHtmlReport` — a
      standalone-HTML lot report generator (per-wafer yield, bin breakdown, **ring/quadrant
      regional yield** — a bonus not in the original design, per-test min/mean/max, findings
      with severity badges) already routed through tsmap's own `platform.openReport` via the
      `setReportOpener` call every session already makes at startup (`main.ts:222`). Even the
      input shape matched for free: `buildLotStatsSummary`'s existing `items` (`main.ts`) are
      already `{label, wafer, dies}` per wafer — spread straight from `buildWaferMap`'s result —
      exactly what wmap's report wants, no conversion needed. Discussed with the user and
      pivoted to **wrap, not duplicate**: `src/reportHtml.ts`'s `buildLotReportHtml` calls
      wmap's function for the bundled yield/bins/regions/findings content, then appends two
      tsmap-specific sections wmap has no concept of — **Process Capability** (Cp/Cpk/Pp/Ppk,
      reusing `buildCapabilityData` from the capability panel work above) and **Splits** — as
      plain HTML strings using wmap's own `report-table`/`report-section` class names, so they
      inherit that document's stylesheet with zero new CSS (verified visually — the appended
      sections are indistinguishable in styling from wmap's native ones). `src/reportUI.ts` is
      a small picker modal (mirrors `showSplitsModal`'s structure) with just two checkboxes —
      Capability and Splits — since everything else comes bundled as one unit from wmap's
      function with no per-section toggle available without forking it (a deliberate v1 scope
      cut, not an oversight). Both checkboxes auto-disable when there's nothing to show (no
      limits set / no splits assigned), same pattern as `valueFindingsBtn`. Chart images
      (yield/bin/capability visuals) were explicitly cut from v1 given the reused report is
      tables-only — numbers are what actually gets read/acted on in a disposition doc; revisit
      later if wanted, either as a wmap addition or a tsmap-side capture. Also fixed a latent
      type-narrowing bug found along the way: `buildLotStatsSummary`'s explicit return-type
      annotation declared `items: ReturnType<typeof buildWaferMap>[]`, silently hiding the
      `label`/`statsSummary` fields the function actually returns (never caught before because
      nothing had needed `.label` off that type until the report builder did) — fixed by
      letting the return type infer instead of narrowing it by hand. Verified end-to-end with
      Playwright against `dev:web`: loaded the corner-lot fixture, assigned a split, generated
      the report, confirmed via screenshot that Capability and Splits render correctly
      alongside wmap's native sections in one consistently-styled document, and confirmed zero
      console errors. 11 new Vitest cases for the pure row/section-builder functions in
      `reportHtml.ts`; full suite green (208 tests); `tsc --noEmit` clean.
      Also relabeled/extended wmap's own Lot Summary metrics (edited `../wmap` directly under
      the link-dev workflow, uncommitted there — see WMAP_ISSUES.md's version-tracking table):
      "Mean yield" → "Mean wafer yield" (it was an unweighted per-wafer average, easily
      confused with a true total), plus new Total dies/Good dies/Bad dies/Partial dies/Total
      yield (die-count-weighted) — small-lot/characterization workflows need the exact good/bad
      part counts, not just a percentage.
      Follow-up fix 2026-07-10, found by the user testing a multi-file ("Add files") load: the
      report only showed the *first* loaded lot's identity (Lot/Product/Tester/Program) while
      silently pooling yield/bins/findings/capability across every loaded lot underneath — root
      cause was wmap's `analyzeWaferLot` deriving lot identity from the first wafer only,
      unverified against the rest (logged as wmap issue #30). Fixed by having tsmap check its
      own faceting (`buildFacetTable`) for whether Lot/Part type/Temperature/Test program vary
      across the loaded wafers *before* generating, and if so, partitioning into groups and
      generating one correctly-scoped `renderLotSummaryReportHtml` + Capability/Splits section
      per group, all spliced into one document (one shared stylesheet, a banner explaining the
      split, one open/print/PDF) rather than one call pooling everything —
      `reportSplitFacets`/`reportGroupsOf` in `main.ts`, `LotReportGroup`/multi-group assembly
      in `reportHtml.ts`. Deliberately a short curated identity-field list (not every splittable
      facet) so an incidental column can't fragment the report into dozens of sections — chosen
      with the user via AskUserQuestion (Lot, Part type, Temperature, Test program). The
      single-group path (the common case) is byte-identical to before this fix — verified by a
      dedicated test. Also caught and fixed in the same pass: the report title fell back to
      `currentFileName`, which isn't updated by the append flow and would have kept showing only
      the first file's name even for a correctly-split multi-group report — now uses an honest
      "N wafers, M groups" title whenever `groups.length > 1`. 3 new Vitest cases covering
      single-group passthrough, multi-group section assembly, and per-group section scoping;
      verified end-to-end with Playwright against a real two-lot merged load (13-wafer
      corner-lot + a separate 3-wafer synthetic lot) — confirmed fully independent per-group
      stats (2873 vs 663 dies, no cross-contamination) and zero console errors.
      **Superseded 2026-07-11**: this entire tsmap-side implementation (`src/reportHtml.ts`,
      `src/reportUI.ts`, and tsmap's own toolbar **Report…** button) was deleted as part of the
      wmap↔tsmap boundary rework — wmap's own Summary panel already had a fully-wired, always-
      visible **"Summary report"** button doing the identical thing, and the Capability/Splits
      sections tsmap used to splice on by hand are now native section builders inside wmap
      itself (`packages/stats/renderSummaryReport.ts`). tsmap no longer builds report HTML of
      any kind — report generation is now wmap's Summary panel button only, for both
      single-wafer and gallery views. Numeric parity (incl. the multi-group split fix above) was
      verified byte-identical before/after the move. See `WMAP_ISSUES.md` #29/#30.
- [ ] **Raw data export.** No path out of the app for selected test data besides re-parsing the
      original file. Even a simple "export selected tests as CSV" from the test selector would
      let users take data into Excel/JMP/Python.
      Note (2026-07-11): not the same as wmap's Insights/Summary panel "Export CSV" button —
      that exports per-test **summary statistics** (min/max/mean/median/stddev/spec-yield), not
      raw per-die values. This idea (raw die-level export) remains a distinct, unaddressed gap.
- [ ] **Annotation/notes on a wafer or lot.** Splits set a precedent for lightweight per-wafer
      metadata the user assigns and the app persists/restores. A free-text note field (e.g.
      "retested — probe card swap") using the same persistence pattern gives engineers a trail
      without a separate tracking system.

## Data ingestion (needs validated demand before scoping)

- [ ] **"Open from URL" — REST-pull JSON ingestion.** Today tsmap only ingests local files; many
      companies keep test data behind a database or internal data-analysis app instead, reachable
      as a REST/HTTP endpoint. Explored 2026-07-19: a "tsmap pulls" design where the user enters an
      endpoint (+ optional Bearer/API-key auth) and tsmap fetches JSON via a new Rust command
      (never the webview, to avoid CORS/credential exposure), reusing the *existing* column-mapping
      overlay unchanged — a generic bring-your-own-JSON-API connector, not a named-vendor
      integration (no public REST API found for KLA Klarity, Synopsys YieldManager/SiliconDash, or
      PDF Solutions Exensio). Estimated ~700-900 lines touched, medium-small since it reuses the
      JSON parser/mapping overlay/modal chrome almost entirely; main risk is a refactor of
      `main.ts`'s shared file-load path. Not started — full design, cost breakdown, and researched
      tradeoffs (incl. why `tauri-plugin-http` was rejected in favor of a hand-rolled `reqwest`
      command) are in [docs/plans/open-from-url-ingestion.md](docs/plans/open-from-url-ingestion.md).

## Smaller polish items

- [ ] **Toolbar overflow.** Already busy (Open, Add, Charts, Filter tests, Splits, Value
      findings, Clear, theme picker, help). Watch whether it needs an overflow/"more" menu as
      more features land — re-check the z-index lesson (see CLAUDE.md "Stacking order") if any
      new overflow menu is itself an overlay.
      Note (2026-07-11): the **Charts** button no longer exists (tsmap's Charts page was removed
      — see the chart/analysis section above), and a short-lived toolbar **Report…** button was
      added and then also removed (report generation moved into wmap's own Summary panel).
      Current buttons: Open, Add, Recent, Filter tests, Splits, Value findings, Clear, theme
      picker, help. Net roughly the same count as originally described, but the immediate
      pressure that motivated this idea is lower now that Charts is gone. Still unimplemented.
- [ ] **Accessibility for canvas charts.** Charts are canvas-only with no text/table
      alternative. Not urgent for this audience but worth tracking.
      Note (2026-07-11): tsmap has no canvas chart code of its own left (moved into wmap's
      Insights tab). wmap has since made real accessibility investments elsewhere — keyboard-
      navigable toolbar/menu roles (`role="menu"`, arrow/Home/End/Enter/Escape), a 63-entry
      colourblind-safe "Accessible" colour scheme — but no text/table alternative for the chart
      canvases themselves exists yet. If pursued, this is now a wmap-side idea, not tsmap's.

## Prioritization (if picking three to start)

1. Cpk/Ppk — closes the biggest functional gap for the target audience. **Done** 2026-07-10
   (later migrated into wmap, 2026-07-11 — see above).
2. Parametric worst-offenders ranking — speeds up the most common workflow (finding *which*
   test is the problem). **Done**, folded into Cpk/Ppk above (same migration).
3. Recent-files list — cheap, removes daily friction. **Done** 2026-07-09.

All three original picks have shipped — revisit this list next time priorities are discussed.
