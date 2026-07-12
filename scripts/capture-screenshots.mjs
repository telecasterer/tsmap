/**
 * Captures screenshots of the tsmap web app for use in the user guide.
 *
 * Usage:
 *   node scripts/capture-screenshots.mjs
 *   node scripts/capture-screenshots.mjs --only loading     # run a named group
 *   node scripts/capture-screenshots.mjs --only empty-state # run a single image by file name
 *   node scripts/capture-screenshots.mjs --list             # print all capture targets
 *
 * The script:
 *   1. Starts a local static file server serving the built dist/ directory
 *   2. Opens the app in headless Chromium
 *   3. For captures that need data, injects a file via DataTransfer drop simulation
 *   4. Runs the declarative setup step sequence
 *   5. Screenshots the target element (or full viewport)
 *   6. Saves to docs/images/<name>.png
 *
 * Prerequisites:
 *   npm run build:web          — builds the app to dist/
 *   npm run screenshots:data   — generates demo STDF/CSV files in /tmp/
 *
 * ─── Setup step reference ─────────────────────────────────────────────────────
 *
 * setup is an array of steps. Each step is an array: [stepName, ...args].
 *
 *   ['loadFile', '/tmp/tsmap-demo.stdf']
 *     Inject a file into the app via simulated drop. Waits for parse to complete.
 *
 *   ['loadFiles', ['/tmp/a.stdf', '/tmp/b.stdf']]
 *     Inject multiple files in one drop (triggers the wafer rename overlay —
 *     see multiFileUI.ts's needsRename, which requires entries.length > 1).
 *
 *   ['addFiles', '/tmp/tsmap-demo2.stdf']
 *     Click the "Add files" toolbar button and pick a file via Playwright's
 *     filechooser interception (real button + native input, not a drop — only
 *     this path sets isAppend=true, needed to reach append-confirm).
 *
 *   ['waitForWafers']
 *     Poll until a canvas element appears inside #map-container.
 *
 *   ['waitForOverlay', '#tsmap-test-selector-overlay']
 *     Poll until the given overlay selector appears in the DOM.
 *
 *   ['dismissSelector']
 *     Click "Import" in the test selector overlay (imports all tests).
 *
 *   ['dismissSelectorSelectNone']
 *     Click "Select none" then "Import" (imports bin data only, skips selector screenshot).
 *
 *   ['dismissSelectorThenRename']
 *     Like dismissSelector, but waits for the rename overlay instead of a
 *     wafer canvas afterward — needed when loading multiple files together,
 *     where the rename overlay appears before anything renders (see
 *     multiFileUI.ts's needsRename: entries.length > 1).
 *
 *   ['openCharts']
 *     Click the "Charts" toolbar button; waits for chart panels to render.
 *
 *   ['hoverMap']
 *     Hover the wafer map canvas to pin the wmap toolbar visible.
 *
 *   ['hoverMapCard', N]
 *     Hover the Nth canvas in the gallery (0-based).
 *
 *   ['clickToolbarBtn', 'aria-label']
 *     Click a button in the wmap toolbar by aria-label (pins toolbar first).
 *
 *   ['openWmapDropdown', 'Plot mode']
 *     Open a wmap toolbar dropdown and leave it open.
 *
 *   ['selectWmapMode', 'Soft Bin']
 *     Pick an item from the wmap Plot mode dropdown.
 *
 *   ['openSummaryPanel']
 *     Open the wmap summary/findings panel.
 *
 *   ['clickFindingByText', 'edge']
 *     Click the first finding whose text contains the given string.
 *
 *   ['expandChartCard', N]
 *     Click the Expand icon button on the Nth .chart-card (0-based index).
 *     Leaves the modal open for screenshotting.
 *
 *   ['expandLogPanel']
 *     Click the log toggle button to open the log panel.
 *
 *   ['openSplitsDialog']
 *     Click the "Splits…" toolbar button and wait for the dialog.
 *
 *   ['closeSplitsDialog']
 *     Click "Done" in the splits dialog.
 *
 *   ['loadSplitsFile', '/abs/path/to/splits.csv']
 *     Click "Load splits…" in the splits dialog and pick the given file via
 *     Playwright's filechooser interception.
 *
 *   ['setGroupBy', 'Split']
 *     Select an option (by visible-label prefix) in the charts view's
 *     "Group by" dropdown.
 *
 *   ['clickChartRow', cardIdx, rowIdx]
 *     Click a specific row (0-based) inside the Nth .chart-card's canvas —
 *     for the yield/boxplot in-place group drilldown.
 *
 *   ['showCursorOn', '#selector', offsetX, offsetY]
 *     Inject a fake SVG cursor centred on the element (optional pixel nudge).
 *
 *   ['hideCursor']
 *     Remove the fake cursor.
 *
 *   ['shrinkPanelToContent']
 *     For the mapping/rename overlays: `.mapping-panel` is `flex:1` inside a
 *     `position:fixed;inset:0` overlay by design (a real full-screen dialog,
 *     content scrolls inside it) — so it always fills the whole viewport
 *     regardless of how little content there is, leaving a large empty gap in
 *     a screenshot. Overrides flex-sizing so the panel and its scroll
 *     container shrink-wrap their actual content instead, for a tight crop.
 *     Capture-only cosmetic tweak; doesn't reflect real app behaviour.
 *
 *   ['wait', 400]
 *     Extra delay in ms.
 *
 *   ['scroll', 0, 500]
 *     window.scrollTo(x, y).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { CAPTURES } from './capture-definitions.mjs';

const ROOT       = resolve(fileURLToPath(import.meta.url), '../../');
const DIST       = join(ROOT, 'dist');
const TESTDATA   = join(ROOT, 'testdata');
const SAMPLEDATA = join(ROOT, 'sample_data');
const OUT        = join(ROOT, 'docs', 'images');

// ─── MIME types ───────────────────────────────────────────────────────────────

const MIME = {
  '.html':  'text/html',
  '.js':    'application/javascript',
  '.mjs':   'application/javascript',
  '.css':   'text/css',
  '.json':  'application/json',
  '.wasm':  'application/wasm',
  '.png':   'image/png',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
  '.stdf':  'application/octet-stream',
  '.std':   'application/octet-stream',
  '.atdf':  'text/plain',
  '.atd':   'text/plain',
  '.csv':   'text/csv',
  '.txt':   'text/plain',
};

// ─── Static server ────────────────────────────────────────────────────────────
// Serves dist/ at /, testdata/ (gitignored, generated fixtures) at /testdata/,
// and sample_data/ (committed fixtures, e.g. the corner-lot splits demo) at
// /sample_data/. Using these routes lets the page fetch files without streaming
// bytes through CDP.

function startServer() {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

      let fsPath;
      if (urlPath.startsWith('/testdata/')) {
        fsPath = join(TESTDATA, urlPath.slice('/testdata/'.length));
      } else if (urlPath.startsWith('/sample_data/')) {
        fsPath = join(SAMPLEDATA, urlPath.slice('/sample_data/'.length));
      } else {
        fsPath = join(DIST, urlPath);
      }

      if (!existsSync(fsPath)) {
        resp.writeHead(404); resp.end('Not found: ' + fsPath); return;
      }
      const ext = extname(fsPath);
      const mime = MIME[ext] ?? 'application/octet-stream';
      resp.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
      resp.end(readFileSync(fsPath));
    });
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

// ─── Cursor helper ────────────────────────────────────────────────────────────

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="22" viewBox="0 0 18 22"><path d="M1 1 L1 18 L5.2 13.8 L8.6 21 L11 19.8 L7.6 12.5 L14 12.5 Z" fill="white" stroke="#333" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

async function injectCursor(page, x, y) {
  await page.evaluate(([svg, cx, cy]) => {
    const el = document.getElementById('__fake-cursor__');
    if (el) el.remove();
    const div = document.createElement('div');
    div.id = '__fake-cursor__';
    Object.assign(div.style, { position: 'fixed', left: `${cx}px`, top: `${cy}px`, width: '18px', height: '22px', pointerEvents: 'none', zIndex: '999999' });
    div.innerHTML = svg;
    document.body.appendChild(div);
  }, [CURSOR_SVG, x, y]);
}

async function removeCursor(page) {
  await page.evaluate(() => { document.getElementById('__fake-cursor__')?.remove(); });
}

// ─── File injection ───────────────────────────────────────────────────────────
//
// The tsmap web app listens for a 'drop' event on document.body.
// We inject files by having the PAGE fetch them from the static server's /testdata/
// route — no bytes ever cross the CDP bridge, so large files don't OOM Node.
//
// filePath is an absolute path under ROOT/testdata/; the server exposes it at /testdata/<name>.
// baseUrl is passed in so the page knows where to fetch from.

async function injectFile(page, filePath, baseUrl) {
  await injectFiles(page, [filePath], baseUrl);
}

// Same as injectFile but drops every path in filePaths as one multi-item
// DataTransfer — needed for the "loading multiple files together" state
// (triggers the wafer rename overlay; see multiFileUI.ts's needsRename).
async function injectFiles(page, filePaths, baseUrl) {
  const items = filePaths.map(filePath => {
    if (!existsSync(filePath)) throw new Error(`Demo data file not found: ${filePath}`);
    const fileName = filePath.split('/').pop();
    const urlPrefix = filePath.startsWith(SAMPLEDATA) ? '/sample_data/' : '/testdata/';
    return { fetchUrl: `${baseUrl}${urlPrefix}${fileName}`, fileName };
  });

  // Wait until the app's drop listener is registered (open-btn is present and the
  // page script has run). The listener is added synchronously in main.ts on DOMContentLoaded,
  // so waiting for networkidle (done before setup) is sufficient — but add a small
  // extra guard to avoid a race on slower machines.
  await page.waitForFunction(() => !!document.getElementById('open-btn'), { timeout: 10000 });

  await page.evaluate(async (fetchItems) => {
    const dt = new DataTransfer();
    for (const { fetchUrl, fileName } of fetchItems) {
      const resp = await fetch(fetchUrl);
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${fetchUrl}`);
      const blob = await resp.blob();
      dt.items.add(new File([blob], fileName));
    }
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, items);
}

// Clicks the "Add files" toolbar button and picks filePath via Playwright's
// filechooser interception — unlike a drop (always a fresh load), only the
// real button + native <input type=file> path sets main.ts's `appendOnPick`
// flag, which is what's needed to reach the append-confirm dialog.
async function addFile(page, filePath) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#add-btn'),
  ]);
  await chooser.setFiles(filePath);
}

// ─── Wait helpers ─────────────────────────────────────────────────────────────

async function waitForSelector(page, selector, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = await page.$(selector);
    if (el) return el;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

async function waitForWmapCanvas(page) {
  // WASM parse in headless Chromium can be slow — allow up to 60s for large files
  await waitForSelector(page, '#map-container canvas', 60000);
  // Extra settle time for wmap to finish rendering
  await page.waitForTimeout(800);
}

// ─── wmap toolbar helpers (borrowed from wmap capture-screenshots.mjs) ────────

async function pinWmapToolbar(page, containerSel = '#map-container') {
  await page.evaluate((sel) => {
    const tb = document.querySelector(`${sel} [data-wmap-toolbar]`);
    if (tb) { tb.style.opacity = '1'; tb.style.visibility = 'visible'; }
  }, containerSel);
}

async function hoverMapCanvas(page, containerSel = '#map-container') {
  const canvas = await page.$(`${containerSel} canvas`);
  if (!canvas) return;
  const box = await canvas.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.35);
  await page.waitForTimeout(400);
  await pinWmapToolbar(page, containerSel);
}

async function openSummaryPanel(page, containerSel = '#map-container') {
  await page.evaluate((sel) => {
    const root = document.querySelector(sel) ?? document;
    const btn = [...root.querySelectorAll('button')].find(b => b.ariaLabel === 'Summary panel');
    if (btn && !btn.dataset.active) btn.click();
  }, containerSel);
  await page.waitForTimeout(600);
  await hoverMapCanvas(page, containerSel);
}

async function clickFindingByText(page, textFragment, containerSel = '#map-container') {
  const found = await page.evaluate(([sel, filter]) => {
    const root = document.querySelector(sel) ?? document;
    const rows = [...root.querySelectorAll('[data-wmap-finding]')];
    const row = rows.find(r => {
      if (filter && !r.textContent?.includes(filter)) return false;
      let el = r.parentElement;
      while (el && el !== root) { if (el.style.display === 'none') return false; el = el.parentElement; }
      return true;
    });
    if (!row) return false;
    let panel = row.parentElement;
    while (panel) { const oy = getComputedStyle(panel).overflowY; if (oy === 'auto' || oy === 'scroll') break; panel = panel.parentElement; }
    if (panel) panel.scrollTop = Math.max(0, row.offsetTop - 40);
    row.dataset.wmapFindingTarget = 'pending';
    return true;
  }, [containerSel, textFragment]);
  if (!found) return;
  await page.click('[data-wmap-finding-target="pending"]');
  await page.evaluate(() => { delete document.querySelector('[data-wmap-finding-target="pending"]')?.dataset.wmapFindingTarget; });
  await page.waitForTimeout(400);
}

async function selectWmapDropdownItem(page, btnAriaLabel, itemLabel) {
  await page.evaluate((label) => {
    const btn = [...document.querySelectorAll('button')].find(b => b.ariaLabel === label);
    if (!btn) return;
    let el = btn.parentElement;
    while (el) { if (el.hasAttribute('data-wmap-toolbar')) { el.style.opacity = '1'; el.style.visibility = 'visible'; break; } el = el.parentElement; }
  }, btnAriaLabel);
  await page.click(`button[aria-label="${btnAriaLabel}"]`);
  await page.waitForTimeout(300);
  const clicked = await page.evaluate((label) => {
    const menus = [...document.body.children].filter(el => el.tagName === 'DIV' && el.style.position === 'fixed');
    for (const menu of menus) {
      // Use startsWith to handle items with trailing decoration like ' ▶'
      const row = [...menu.querySelectorAll('div')].find(d => d.textContent?.trim().startsWith(label));
      if (row) { row.click(); return true; }
    }
    return false;
  }, itemLabel);
  if (!clicked) throw new Error(`Dropdown item not found: "${itemLabel}" in "${btnAriaLabel}"`);
  await page.waitForTimeout(200);
}

async function openWmapDropdown(page, btnAriaLabel, highlightItem = null) {
  await page.evaluate((label) => {
    const btn = [...document.querySelectorAll('button')].find(b => b.ariaLabel === label);
    if (btn) { let el = btn.parentElement; while (el) { if (el.hasAttribute('data-wmap-toolbar')) { el.style.opacity = '1'; el.style.visibility = 'visible'; break; } el = el.parentElement; } btn.click(); }
  }, btnAriaLabel);
  await page.waitForTimeout(150);
  if (highlightItem) {
    await page.evaluate((label) => {
      const menus = [...document.body.children].filter(el => el.tagName === 'DIV' && el.style.position === 'fixed' && el.offsetParent !== null);
      for (const menu of menus) {
        const div = [...menu.querySelectorAll('div')].find(d => d.textContent?.trim() === label);
        if (div) { div.style.fontWeight = 'bold'; return; }
      }
    }, highlightItem);
  }
  await pinWmapToolbar(page);
  await page.waitForTimeout(100);
}

// ─── Step runner ──────────────────────────────────────────────────────────────

async function runSetup(page, steps, baseUrl) {
  for (const step of steps) {
    const [name, ...args] = step;
    switch (name) {

      case 'loadFile': {
        await injectFile(page, args[0], baseUrl);
        // After drop the app starts parsing; wait for overlay or wafer canvas
        await page.waitForTimeout(500);
        break;
      }

      case 'loadFiles': {
        await injectFiles(page, args[0], baseUrl);
        await page.waitForTimeout(500);
        break;
      }

      case 'addFiles': {
        await addFile(page, args[0]);
        await page.waitForTimeout(500);
        break;
      }

      case 'waitForWafers':
        await waitForWmapCanvas(page);
        break;

      case 'waitForOverlay':
        await waitForSelector(page, args[0] ?? '#tsmap-test-selector-overlay');
        await page.waitForTimeout(300);
        break;

      case 'dismissSelector': {
        // Click "Select all" then Import so tests are loaded (default selection is empty)
        await waitForSelector(page, '#tsmap-test-selector-overlay');
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
        await waitForWmapCanvas(page);
        break;
      }

      case 'dismissSelectorThenRename': {
        await waitForSelector(page, '#tsmap-test-selector-overlay');
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
        await waitForSelector(page, '#tsmap-rename-overlay');
        await page.waitForTimeout(300);
        break;
      }

      case 'dismissSelectorSelectNone': {
        await waitForSelector(page, '#tsmap-test-selector-overlay');
        // Click "Select none"
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('#tsmap-test-selector-overlay button')];
          btns.find(b => b.textContent?.trim() === 'Select none')?.click();
        });
        await page.waitForTimeout(200);
        // Click Import
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('#tsmap-test-selector-overlay button')];
          const b = btns.find(b => b.textContent?.includes('Import'));
          if (b) b.id = '__import-btn__';
        });
        await page.click('#__import-btn__');
        await waitForWmapCanvas(page);
        break;
      }

      case 'openCharts': {
        await page.evaluate(() => {
          const btn = document.getElementById('charts-btn');
          if (btn) btn.click();
        });
        // Wait for chart panels to render
        await page.waitForTimeout(1200);
        break;
      }

      case 'expandChartCard': {
        // Click the Expand icon button on the Nth .chart-card (0-based). The
        // button is an SVG icon (chartShell.ts makeIconBtn), not a text glyph —
        // it carries no textContent, so match on its aria-label instead (set to
        // the tooltip title, "Expand (E)"). A previous version of this matched
        // on textContent === '⛶', which never matched post-SVG-icon-refactor and
        // silently no-opped every capture using this step (chart-yield.png,
        // chart-pareto.png, boxplot.png, histogram.png, correlation.png,
        // scatter.png were all byte-identical screenshots of the unexpanded grid
        // as a result — found and fixed 2026-07-08).
        const idx = args[0] ?? 0;
        await page.evaluate((n) => {
          const cards = [...document.querySelectorAll('.chart-card')];
          if (!cards[n]) return;
          const btn = cards[n].querySelector('button[aria-label^="Expand"]');
          if (btn) btn.click();
        }, idx);
        // Wait for modal backdrop to appear
        await page.waitForTimeout(800);
        break;
      }

      case 'hoverMap':
        await hoverMapCanvas(page, args[0] ?? '#map-container');
        break;

      case 'hoverMapCard': {
        const idx = args[0] ?? 0;
        const cards = await page.$$('#map-container canvas');
        if (cards[idx]) {
          const box = await cards[idx].boundingBox();
          if (box) await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
        }
        await page.waitForTimeout(400);
        await pinWmapToolbar(page);
        break;
      }

      case 'clickToolbarBtn': {
        const label = args[0];
        await page.evaluate((lbl) => {
          const btn = [...document.querySelectorAll('button')].find(b => b.ariaLabel === lbl);
          if (!btn) return;
          let el = btn.parentElement;
          while (el) { if (el.hasAttribute('data-wmap-toolbar')) { el.style.opacity = '1'; el.style.visibility = 'visible'; break; } el = el.parentElement; }
        }, label);
        await page.click(`button[aria-label="${label}"]`);
        await page.waitForTimeout(300);
        break;
      }

      case 'openWmapDropdown':
        await openWmapDropdown(page, args[0], args[1] ?? null);
        break;

      case 'selectWmapMode':
        await selectWmapDropdownItem(page, 'Plot mode', args[0]);
        break;

      case 'openSummaryPanel':
        await openSummaryPanel(page, args[0] ?? '#map-container');
        break;

      case 'clickFindingByText':
        await clickFindingByText(page, args[0], args[1] ?? '#map-container');
        break;

      case 'openSplitsDialog': {
        await page.click('#splits-btn');
        await waitForSelector(page, 'div[role="dialog"]');
        await page.waitForTimeout(300);
        break;
      }

      case 'closeSplitsDialog': {
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('div[role="dialog"] button')];
          const b = btns.find(b => b.textContent?.trim() === 'Done');
          if (b) b.click();
        });
        await page.waitForTimeout(400);
        break;
      }

      case 'loadSplitsFile': {
        // Splits are loaded via a real file picker (platform.pickTextFile), so
        // this must arm Playwright's filechooser listener before the click,
        // same pattern as a real user gesture — page.evaluate()-driven clicks
        // are not reliably treated as one.
        const filePath = args[0];
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('div[role="dialog"] button', { hasText: 'Load splits…' }).click(),
        ]);
        await chooser.setFiles(filePath);
        await page.waitForTimeout(500);
        break;
      }

      case 'setGroupBy': {
        // The "Group by" <select> has no id/aria-label (main.ts makeSelect) —
        // find it via its preceding "Group by:" label span, a stable sibling
        // relationship set up at construction (groupByControls.push(label, select)).
        const label = args[0];
        await page.evaluate((optionLabel) => {
          const spans = [...document.querySelectorAll('span')];
          const groupBySpan = spans.find(s => s.textContent?.trim() === 'Group by:');
          if (!groupBySpan) return;
          const select = groupBySpan.nextElementSibling;
          if (!select || select.tagName !== 'SELECT') return;
          const opt = [...select.options].find(o => o.textContent?.trim().startsWith(optionLabel));
          if (opt) { select.value = opt.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
        }, label);
        await page.waitForTimeout(600);
        break;
      }

      case 'clickChartRow': {
        // Click a specific row inside the Nth .chart-card's canvas — used for
        // the yield/boxplot in-place group drilldown (row geometry matches
        // chartShell.ts PADDING=12 and render.ts ROW_HEIGHT=24/ROW_GAP=5).
        const cardIdx = args[0] ?? 0;
        const rowIdx = args[1] ?? 0;
        const cards = await page.$$('.chart-card');
        if (!cards[cardIdx]) break;
        const canvas = await cards[cardIdx].$('canvas');
        if (!canvas) break;
        const box = await canvas.boundingBox();
        if (!box) break;
        const PADDING = 12, ROW_HEIGHT = 24, ROW_GAP = 5;
        const y = box.y + PADDING + rowIdx * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;
        const x = box.x + box.width / 2;
        await page.mouse.click(x, y);
        await page.waitForTimeout(500);
        break;
      }

      case 'expandLogPanel':
        await page.click('#log-toggle');
        await page.waitForTimeout(300);
        break;

      case 'showCursorOn': {
        const target = args[0];
        const ox = args[1] ?? 0;
        const oy = args[2] ?? 0;
        const isSel = /^[.#\[a-z]/i.test(target) && !/\s/.test(target.split('[')[0]);
        const el = isSel ? await page.$(target) : (await page.$(`[aria-label="${target}"]`) ?? await page.$(target));
        if (el) {
          const box = await el.boundingBox();
          if (box) await injectCursor(page, box.x + box.width / 2 + ox, box.y + box.height / 2 + oy);
        }
        break;
      }

      case 'hideCursor':
        await removeCursor(page);
        break;

      case 'shrinkPanelToContent': {
        await page.evaluate(() => {
          const panel = document.querySelector('.mapping-panel');
          if (panel) { panel.style.flex = 'none'; panel.style.maxHeight = 'none'; }
          const scroll = document.querySelector('.mapping-scroll');
          if (scroll) { scroll.style.flex = 'none'; scroll.style.overflow = 'visible'; scroll.style.maxHeight = 'none'; }
        });
        await page.waitForTimeout(100);
        break;
      }

      case 'wait':
        await page.waitForTimeout(args[0] ?? 300);
        break;

      case 'scroll':
        await page.evaluate(([x, y]) => window.scrollTo(x, y), [args[0] ?? 0, args[1] ?? 0]);
        break;

      default:
        throw new Error(`Unknown setup step: "${name}"`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Verify the dist directory exists
  if (!existsSync(DIST)) {
    console.error('\n✗  dist/ not found. Run: npm run build:web\n');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const listOnly  = args.includes('--list');
  const onlyIdx   = args.indexOf('--only');
  const onlyVal   = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  const targets = onlyVal
    ? CAPTURES.filter(c => c.group === onlyVal || c.file === onlyVal)
    : CAPTURES;

  if (listOnly) {
    console.log('\nCapture targets:\n');
    for (const c of CAPTURES) {
      console.log(`  [${c.group.padEnd(12)}]  ${(c.file + '.png').padEnd(26)}  ${c.description ?? ''}`);
    }
    console.log(`\n${CAPTURES.length} total\n`);
    return;
  }

  if (targets.length === 0) {
    console.error(`No targets matched "${onlyVal}". Use --list to see groups and file names.`);
    process.exit(1);
  }

  console.log(`\n▸ Capturing ${targets.length} screenshot(s)${onlyVal ? ` (--only ${onlyVal})` : ''}…\n`);

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  let ok = 0, fail = 0;

  for (const cap of targets) {
    const outFile = join(OUT, cap.file + '.png');
    const label = cap.file + '.png';
    process.stdout.write(`  ${label.padEnd(28)} `);

    try {
      const ctx  = await browser.newContext({ viewport: cap.viewport ?? { width: 1280, height: 800 }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();

      page.on('console', () => {});
      page.on('pageerror', () => {});
      // window.confirm() in headless Chromium returns false; auto-accept so the
      // "bin data only" confirmation in showTestSelectorOverlay doesn't block.
      page.on('dialog', d => d.accept());

      await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 30_000 });

      if (cap.wait) await page.waitForTimeout(cap.wait);
      if (cap.setup) await runSetup(page, cap.setup, base);

      if (cap.screenshotFn) {
        await cap.screenshotFn(page, outFile, base);
      } else if (cap.selector) {
        const el = await page.$(cap.selector);
        if (!el) throw new Error(`selector not found: ${cap.selector}`);
        await el.screenshot({ path: outFile });
      } else {
        await page.screenshot({ path: outFile, fullPage: cap.fullPage ?? false });
      }

      await ctx.close();
      console.log('✓');
      ok++;
    } catch (err) {
      console.log(`✗  ${err.message}`);
      fail++;
    }
  }

  await browser.close();
  server.close();

  console.log(`\n${ok} captured, ${fail} failed — saved to docs/images/\n`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
