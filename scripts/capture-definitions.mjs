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
// TD() returns an absolute path — the capture runner maps /testdata/<name> on the server.
const TD   = (f) => `${ROOT}/testdata/${f}`;

// ─── Shared helpers used in screenshotFn entries ──────────────────────────────
// screenshotFn receives (page, outFile, baseUrl) — baseUrl is the static server origin.

async function injectFileAndWaitForSelector(page, filePath, selector, baseUrl, timeout = 20000) {
  const name     = filePath.split('/').pop();
  const fetchUrl = `${baseUrl}/testdata/${name}`;

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

  // ── §2 Empty state ────────────────────────────────────────────────────────
  {
    file: 'empty-state',
    group: 'loading',
    description: 'App before any file is loaded — empty state with icon and prompt',
  },

  // ── §2 Gallery overview after load ────────────────────────────────────────
  {
    file: 'overview',
    group: 'loading',
    description: 'App with small.stdf loaded — 3-wafer gallery, toolbar visible',
    setup: [
      ['loadFile', TD('small.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelectorSelectNone'],
      ['wait', 400],
      ['hoverMapCard', 0],
    ],
  },

  // ── §3 Column mapping: wide-format CSV ────────────────────────────────────
  {
    file: 'column-mapping',
    group: 'loading',
    description: 'CSV column mapping overlay (wide format) — small.csv',
    selector: '#tsmap-mapping-overlay',
    setup: [
      ['loadFile', TD('small.csv')],
      ['waitForOverlay', '#tsmap-mapping-overlay'],
      ['wait', 200],
    ],
  },

  // ── §3 Column mapping: long-format CSV ────────────────────────────────────
  {
    file: 'column-mapping-long',
    group: 'loading',
    description: 'CSV column mapping overlay showing long-format roles — correlated_long.csv',
    selector: '#tsmap-mapping-overlay',
    setup: [
      ['loadFile', TD('correlated_long.csv')],
      ['waitForOverlay', '#tsmap-mapping-overlay'],
      ['wait', 200],
    ],
  },

  // ── §4 Test selector: full overlay ────────────────────────────────────────
  {
    file: 'test-selector',
    group: 'loading',
    description: 'Test selector overlay — many_tests.stdf (250 tests, >200 threshold)',
    selector: '#tsmap-test-selector-overlay',
    setup: [
      ['loadFile', TD('many_tests.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['wait', 400],
    ],
  },

  // ── §4 Test selector: search active ───────────────────────────────────────
  {
    file: 'test-selector-search',
    group: 'loading',
    description: 'Test selector with search text filtering the list',
    screenshotFn: async (page, outFile, baseUrl) => {
      await injectFileAndWaitForSelector(page, TD('many_tests.stdf'), '#tsmap-test-selector-overlay', baseUrl);
      await page.waitForTimeout(400);
      const searchInput = await page.$('#tsmap-test-selector-overlay input[type="text"]');
      if (searchInput) { await searchInput.click(); await page.keyboard.type('test_01'); }
      await page.waitForTimeout(400);
      const el = await page.$('#tsmap-test-selector-overlay');
      await el.screenshot({ path: outFile });
    },
  },

  // ── §4 Test selector: range input in use ──────────────────────────────────
  {
    file: 'test-selector-range',
    group: 'loading',
    description: 'Test selector with a numeric range typed in the range input',
    screenshotFn: async (page, outFile, baseUrl) => {
      await injectFileAndWaitForSelector(page, TD('many_tests.stdf'), '#tsmap-test-selector-overlay', baseUrl);
      await page.waitForTimeout(400);
      const inputs = await page.$$('#tsmap-test-selector-overlay input[type="text"]');
      if (inputs[1]) { await inputs[1].click(); await page.keyboard.type('1000-1049'); }
      await page.waitForTimeout(300);
      const el = await page.$('#tsmap-test-selector-overlay');
      await el.screenshot({ path: outFile });
    },
  },

  // ── §5 Wafer rename overlay ────────────────────────────────────────────────
  {
    file: 'rename-overlay',
    group: 'loading',
    description: 'Wafer rename overlay — shown after small.stdf load (W01/W02/W03 auto-IDs)',
    screenshotFn: async (page, outFile, baseUrl) => {
      await injectFileAndWaitForSelector(page, TD('small.stdf'), '#tsmap-test-selector-overlay', baseUrl);
      await page.waitForTimeout(400);
      await dismissSelector(page);
      const renameEl = await page.$('#tsmap-rename-overlay');
      if (renameEl) {
        await page.waitForTimeout(200);
        await renameEl.screenshot({ path: outFile });
      } else {
        await page.screenshot({ path: outFile, fullPage: false });
      }
    },
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

  // ── §6 Charts overview — all 6 panels visible ─────────────────────────────
  {
    file: 'charts-overview',
    group: 'charts',
    description: 'Charts view — correlated.stdf, full 6-panel grid',
    viewport: { width: 1280, height: 1800 },
    fullPage: true,
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['scroll', 0, 0],
    ],
  },

  // ── §6.1 Yield by wafer — expand modal ───────────────────────────────────
  {
    file: 'chart-yield',
    group: 'charts',
    description: 'Yield by wafer — expanded modal, correlated.stdf',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 0],
    ],
  },

  // ── §6.2 Bin pareto — expand modal ───────────────────────────────────────
  {
    file: 'chart-pareto',
    group: 'charts',
    description: 'Bin pareto — expanded modal, correlated.stdf',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 1],
    ],
  },

  // ── §6.3 Boxplot — expand modal ──────────────────────────────────────────
  {
    file: 'boxplot',
    group: 'charts',
    description: 'Test value distribution boxplot — expanded modal, correlated.stdf',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 2],
    ],
  },

  // ── §6.4 Histogram — expand modal ────────────────────────────────────────
  {
    file: 'histogram',
    group: 'charts',
    description: 'Value histogram — expanded modal, correlated.stdf',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 3],
    ],
  },

  // ── §6.5 Correlation matrix — expand modal ───────────────────────────────
  {
    file: 'correlation',
    group: 'charts',
    description: 'Test correlation matrix — expanded modal, correlated.stdf',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 4],
    ],
  },

  // ── §6.6 Scatter — expand modal ──────────────────────────────────────────
  {
    file: 'scatter',
    group: 'charts',
    description: 'Scatter plot — expanded modal, correlated.stdf',
    setup: [
      ['loadFile', TD('correlated.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelector'],
      ['openCharts'],
      ['expandChartCard', 5],
    ],
  },

  // ── §8 Log panel ──────────────────────────────────────────────────────────
  {
    file: 'log-panel',
    group: 'ui',
    description: 'Log panel expanded — showing parse info messages from small.stdf',
    selector: '#log-bar',
    setup: [
      ['loadFile', TD('small.stdf')],
      ['waitForOverlay', '#tsmap-test-selector-overlay'],
      ['dismissSelectorSelectNone'],
      ['expandLogPanel'],
      ['wait', 200],
    ],
  },

];
