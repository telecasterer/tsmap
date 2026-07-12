/**
 * Capture definitions for the tsmap user guide screenshots.
 *
 * All demo data files live in testdata/ — no generation needed.
 *
 * File → what it's used for:
 *   testdata/small.stdf         3 wafers, 20 PTR tests — general loading / map flow
 *   testdata/medium.stdf        10 wafers, 100 PTR tests — gallery view
 *   testdata/correlated.stdf    5 wafers, 30 correlated PTR tests — charts
 *   testdata/many_tests.stdf    5 wafers, 250 PTR tests — triggers test selector (>200)
 *   testdata/small.csv          wide-format CSV — column mapping overlay
 *   testdata/correlated_long.csv  long-format CSV — long-format column mapping
 *
 * Each entry:
 *   file         — output filename in docs/images/ (no extension)
 *   group        — logical group name (for --only <group> filtering)
 *   description  — shown in --list output
 *   selector     — CSS selector to screenshot (omit for full viewport)
 *   viewport     — { width, height } override (default 1280×800)
 *   wait         — extra ms after networkidle, before setup runs
 *   setup        — declarative step array; see capture-screenshots.mjs for reference
 *   screenshotFn — async (page, outFile) => {} for fully custom capture logic
 */

import { resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
// TD() returns an absolute path — the capture runner maps /testdata/<name> on the
// server. testdata/ is gitignored, generated fixtures (`npm run screenshots:data`).
const TD   = (f) => `${ROOT}/testdata/${f}`;
// SD() is the same for sample_data/ — small, git-committed fixtures (Rust parser
// tests also read from here). Used for anything the generic testdata/ suite
// doesn't cover, e.g. the corner-lot wafer-splits demo.
const SD   = (f) => `${ROOT}/sample_data/${f}`;

// ─── Shared helpers used in screenshotFn entries ──────────────────────────────
// screenshotFn receives (page, outFile, baseUrl) — baseUrl is the static server origin.

async function injectFileAndWaitForSelector(page, filePath, selector, baseUrl, timeout = 20000) {
  const name     = filePath.split('/').pop();
  const urlPrefix = filePath.startsWith(`${ROOT}/sample_data/`) ? '/sample_data/' : '/testdata/';
  const fetchUrl = `${baseUrl}${urlPrefix}${name}`;

  await page.waitForFunction(() => !!document.getElementById('open-btn'), { timeout: 10000 });
  await page.evaluate(async ([url, n]) => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${url}`);
    const blob = await resp.blob();
    const file = new File([blob], n);
    const dt   = new DataTransfer();
    dt.items.add(file);
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [fetchUrl, name]);

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = await page.$(selector);
    if (el) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timeout waiting for ${selector} after loading ${name}`);
}

async function dismissSelector(page) {
  // Click "Select all" first — default selection is empty, need tests loaded
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#tsmap-test-selector-overlay button')];
    btns.find(b => b.textContent?.trim() === 'Select all')?.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#tsmap-test-selector-overlay button')];
    const b = btns.find(b => b.textContent?.includes('Import'));
    if (b) { b.id = '__import-btn__'; }
  });
  await page.click('#__import-btn__');
  // Wait for canvas to appear
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const el = await page.$('#map-container canvas');
    if (el) { await page.waitForTimeout(800); return; }
    await page.waitForTimeout(200);
  }
}

async function dismissSelectorNone(page) {
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#tsmap-test-selector-overlay button')];
    btns.find(b => b.textContent?.trim() === 'Select none')?.click();
  });
  await page.waitForTimeout(200);
  await dismissSelector(page);
}

async function pinToolbar(page) {
  await page.evaluate(() => {
    const tb = document.querySelector('#map-container [data-wmap-toolbar]');
    if (tb) { tb.style.opacity = '1'; tb.style.visibility = 'visible'; }
  });
}

// ─── Captures ─────────────────────────────────────────────────────────────────

export const CAPTURES = [

  // ── §2 Empty-state toolbar ────────────────────────────────────────────────
  // Replaces the hand-authored toolbar mockup — real empty-state screenshot,
  // no data loaded. (Re-added 2026-07-12: the guide's in-app modal used to
  // strip all images and rely on mockups instead — see WMAP_ISSUES.md #32 —
  // that constraint is gone now that the guide bundles real image files.)
  {
    file: 'empty-toolbar',
    group: 'ui',
    description: 'Empty-state toolbar — Open file / Add files / Recent / theme / help',
    selector: '#toolbar',
  },

  // ── §2 Add files → append-confirm dialog ──────────────────────────────────
  {
    file: 'append-confirm',
    group: 'ui',
    description: 'Append-confirm dialog — die-count mismatch warning (small.stdf + medium.stdf)',
    setup: [
      ['loadFile', TD('small.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['addFiles', TD('medium.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['waitForOverlay', '.tsmap-modal-backdrop'],
    ],
    selector: '.tsmap-modal',
  },

  // ── §2.1 Wafer rename overlay ──────────────────────────────────────────────
  {
    file: 'wafer-rename',
    group: 'ui',
    description: 'Wafer rename overlay — loading small.stdf + medium.stdf together',
    setup: [
      ['loadFiles', [TD('small.stdf'), TD('medium.stdf')]],
      ['dismissSelectorThenRename'],
      ['shrinkPanelToContent'],
    ],
    selector: '.mapping-panel',
  },

  // ── §3 Column mapping overlay ──────────────────────────────────────────────
  {
    file: 'column-mapping',
    group: 'ui',
    description: 'Column mapping overlay — small_long.csv (long-format, 10 columns)',
    setup: [
      ['loadFile', TD('small_long.csv')],
      ['waitForOverlay', '#tsmap-mapping-overlay'],
      ['shrinkPanelToContent'],
    ],
    selector: '.mapping-panel',
  },

  // ── §4 Test selector overlay ────────────────────────────────────────────────
  {
    file: 'test-selector',
    group: 'ui',
    description: 'Test selector overlay — many_tests.stdf (250 tests)',
    setup: [
      ['loadFile', TD('many_tests.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
    ],
    selector: '#tsmap-test-selector-overlay div[role="dialog"]',
  },

  // ── §9 Log panel ─────────────────────────────────────────────────────────────
  {
    file: 'log-panel',
    group: 'ui',
    description: 'Log panel expanded, after a normal load',
    setup: [
      ['loadFile', TD('small.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['expandLogPanel'],
    ],
    selector: '#log-bar',
  },

  // ── §5.1 Single wafer map — hard bin, summary panel open ─────────────────
  // Use correlated.stdf (W01..W05 IDs don't trigger rename overlay)
  {
    file: 'wafer-map-single',
    group: 'maps',
    description: 'Single-wafer map — hard bin, summary panel open',
    screenshotFn: async (page, outFile, baseUrl) => {
      await injectFileAndWaitForSelector(page, TD('correlated.stdf'), '#tsmap-test-selector-overlay', baseUrl);
      await page.waitForTimeout(400);
      await dismissSelectorNone(page);
      // Open the summary panel
      await page.evaluate(() => {
        const root = document.querySelector('#map-container') ?? document;
        const btn = [...root.querySelectorAll('button')].find(b => b.ariaLabel === 'Summary panel');
        if (btn && !btn.dataset.active) btn.click();
      });
      await page.waitForTimeout(600);
      await pinToolbar(page);
      await page.screenshot({ path: outFile, fullPage: false });
    },
  },

  // ── §5.2 Toolbar: plot mode dropdown open ─────────────────────────────────
  {
    file: 'wafer-map-toolbar',
    group: 'maps',
    description: 'Map toolbar with Plot mode dropdown open — Hard Bin highlighted',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelectorSelectNone'],
      ['hoverMapCard', 0],
      ['openWmapDropdown', 'Plot mode', 'Hard Bin'],
    ],
  },

  // ── §5.2 Soft Bin map ─────────────────────────────────────────────────────
  {
    file: 'wafer-map-softbin',
    group: 'maps',
    description: 'Map in Soft Bin mode — correlated.stdf gallery',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelectorSelectNone'],
      ['hoverMapCard', 0],
      ['selectWmapMode', 'Soft Bin'],
      ['wait', 600],
      ['hoverMapCard', 0],
    ],
  },

  // ── §5.2 Test value heatmap ────────────────────────────────────────────────
  {
    file: 'wafer-map-testvalue',
    group: 'maps',
    description: 'Map in Test Value mode — correlated.stdf gallery, parametric heatmap',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['hoverMapCard', 0],
      ['selectWmapMode', 'Test Value'],
      ['wait', 600],
      ['hoverMapCard', 0],
    ],
  },

  // ── §5.4 Gallery (medium lot) ─────────────────────────────────────────────
  {
    file: 'gallery',
    group: 'maps',
    description: 'Multi-wafer gallery — medium.stdf, 10 wafers, first card hovered',
    setup: [
      ['loadFile', TD('medium.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelectorSelectNone'],
      ['wait', 600],
      ['hoverMapCard', 0],
    ],
  },

  // ── §7 Charts overview — all 6 panels visible ─────────────────────────────
  {
    file: 'charts-overview',
    group: 'charts',
    description: 'Charts view — correlated.stdf, full 6-panel grid',
    // #map-container.charts scrolls internally (overflow-y: auto), not the
    // document — Playwright's fullPage:true only extends a real document
    // scroll, so it silently no-ops here. Use a fixed viewport tall enough to
    // fit all 6 panels without scrolling instead (found empirically: a taller
    // wafer count needs more — see the splits-group definitions below, which
    // use 2300 for a 13-wafer lot).
    viewport: { width: 1600, height: 2000 },
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['scroll', 0, 0],
    ],
  },

  // ── §7.1 Yield by wafer — expand modal ───────────────────────────────────
  {
    file: 'chart-yield',
    group: 'charts',
    description: 'Yield by wafer — expanded modal, correlated.stdf',
    selector: '.wmap-modal-box',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 0],
    ],
  },

  // ── §7.2 Bin pareto — expand modal ───────────────────────────────────────
  {
    file: 'chart-pareto',
    group: 'charts',
    description: 'Bin pareto — expanded modal, correlated.stdf',
    selector: '.wmap-modal-box',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 1],
    ],
  },

  // ── §7.3 Boxplot — expand modal ──────────────────────────────────────────
  {
    file: 'boxplot',
    group: 'charts',
    description: 'Test value distribution boxplot — expanded modal, correlated.stdf',
    selector: '.wmap-modal-box',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 2],
    ],
  },

  // ── §7.4 Histogram — expand modal ────────────────────────────────────────
  {
    file: 'histogram',
    group: 'charts',
    description: 'Value histogram — expanded modal, correlated.stdf',
    selector: '.wmap-modal-box',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 3],
    ],
  },

  // ── §7.5 Correlation matrix — expand modal ───────────────────────────────
  {
    file: 'correlation',
    group: 'charts',
    description: 'Test correlation matrix — expanded modal, correlated.stdf',
    selector: '.wmap-modal-box',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 4],
    ],
  },

  // ── §7.6 Scatter — expand modal ──────────────────────────────────────────
  {
    file: 'scatter',
    group: 'charts',
    description: 'Scatter plot — expanded modal, correlated.stdf',
    selector: '.wmap-modal-box',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 5],
    ],
  },

  // ── §6 Wafer splits ────────────────────────────────────────────────────────
  // Uses sample_data/PVT-LOT-05.stdf (a 13-wafer PVT corner lot generated by
  // scripts/generate_stdf_corner_lot.py) + its companion _splits.csv — the
  // testdata/ suite has no split-relevant fixture, and this one is small and
  // git-committed already (see SD() above).

  {
    file: 'splits-modal',
    group: 'splits',
    description: 'Splits dialog just opened — no assignments yet',
    viewport: { width: 1600, height: 1000 },
    selector: 'div[role="dialog"]',
    setup: [
      ['loadFile', SD('PVT-LOT-05.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openSplitsDialog'],
    ],
  },

  {
    file: 'splits-modal-loaded',
    group: 'splits',
    description: 'Splits dialog after loading PVT-LOT-05_splits.csv — TT/FF/SS/FS/SF assigned',
    viewport: { width: 1600, height: 1000 },
    selector: 'div[role="dialog"]',
    setup: [
      ['loadFile', SD('PVT-LOT-05.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openSplitsDialog'],
      ['loadSplitsFile', SD('PVT-LOT-05_splits.csv')],
    ],
  },

  {
    file: 'gallery-splits',
    group: 'splits',
    description: 'Gallery with split suffixes shown on every card (" · TT" etc.)',
    viewport: { width: 1600, height: 1300 },
    setup: [
      ['loadFile', SD('PVT-LOT-05.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openSplitsDialog'],
      ['loadSplitsFile', SD('PVT-LOT-05_splits.csv')],
      ['closeSplitsDialog'],
      ['wait', 500],
    ],
  },

  {
    file: 'charts-grouped-by-split',
    group: 'splits',
    description: 'Charts view grouped by Split — all 6 panels, TT/FF/SS/FS/SF corners',
    viewport: { width: 1600, height: 2300 },
    setup: [
      ['loadFile', SD('PVT-LOT-05.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openSplitsDialog'],
      ['loadSplitsFile', SD('PVT-LOT-05_splits.csv')],
      ['closeSplitsDialog'],
      ['openCharts'],
      ['setGroupBy', 'Split'],
      ['scroll', 0, 0],
    ],
  },

  {
    file: 'yield-group-drilldown',
    group: 'splits',
    description: 'Yield panel drilled into a single Split — per-wafer bars + ← Back',
    viewport: { width: 1600, height: 1000 },
    setup: [
      ['loadFile', SD('PVT-LOT-05.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openSplitsDialog'],
      ['loadSplitsFile', SD('PVT-LOT-05_splits.csv')],
      ['closeSplitsDialog'],
      ['openCharts'],
      ['setGroupBy', 'Split'],
      ['clickChartRow', 0, 0],
    ],
  },

];
