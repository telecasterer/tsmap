declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

import { buildWaferMap } from '@paulrobins/wafermap';
import { renderWaferMap, renderWaferGallery } from '@paulrobins/wafermap/render';
import { analyzeWaferMap, analyzeWaferLot, setReportOpener } from '@paulrobins/wafermap/stats';
import { createPlatform, isTauri } from './platform';
import type { FileHandle, StdfTestNames, ScanResult } from './platform';
import { basename, rustToLocal, toWmapTestDefs, autoPlotMode, applyTestSelection, makeWaferSource, toWmapWaferMeta, toWaferData, errMsg } from './lib';
import { showMappingOverlay } from './mappingUI';
import { showRenameOverlay, showAppendConfirm } from './multiFileUI';
import { showTestSelectorOverlay } from './testSelectorUI';
import type { CsvMapping } from './mappingUI';
import type { FileWaferEntry, RenamedWafer } from './multiFileUI';
import type { ParsedFile, WaferData, TestDef } from './types';
import { attachTooltip, upgradeTitleTooltips } from './tooltip';
import { initTheme, onThemeChange, getTheme, setTheme, THEME_GROUPS, type Theme } from './theme';
import { makeMenuSelect } from './menuSelect';
import { showSplitsModal } from './splitsUI';
import { getSplitLabel, setSplitLabel, waferDisplayLabel, splitsFingerprint, parseSplitsCsv } from './splits';
import { getRecentFiles, addRecentFiles, removeRecentFile, formatRecentTime } from './recentFiles';


const platform = createPlatform();

// ── DOM refs ──────────────────────────────────────────────────────────────────

const container       = document.getElementById('map-container')!;
const openBtn         = document.getElementById('open-btn')!;
const addBtn          = document.getElementById('add-btn') as HTMLButtonElement;
const recentBtn       = document.getElementById('recent-btn') as HTMLButtonElement;
const filterTestsBtn    = document.getElementById('filter-tests-btn') as HTMLButtonElement;
const splitsBtn        = document.getElementById('splits-btn') as HTMLButtonElement;
const valueFindingsBtn  = document.getElementById('value-findings-btn') as HTMLButtonElement;
const resetBtn        = document.getElementById('reset-btn') as HTMLButtonElement;
const helpBtn         = document.getElementById('help-btn') as HTMLButtonElement;
const fileLabel       = document.getElementById('file-label')!;
const busySpinner     = document.getElementById('busy-spinner')!;
const logList         = document.getElementById('log-list')!;
const logToggle       = document.getElementById('log-toggle')!;
const logPanel        = document.getElementById('log-panel')!;

// ── State ─────────────────────────────────────────────────────────────────────

let currentWafers: WaferData[] = [];
let currentFileName = 'wafermap';
let currentTestDefs: Record<string, TestDef> = {};

// Tracks the most recently loaded STDF/ATDF files so "Filter tests…" can re-parse them.
let currentBinaryFiles: FileHandle[] = [];
let currentBinaryExt = ''; // 'stdf' | 'std' | 'atdf' | 'atd'
let currentTestNames: StdfTestNames | null = null; // first-pass scan result, reused by "Filter tests…"
// Whether the current test list came from the largest file only or all files —
// so "Filter tests…" can still offer to widen the scan if it wasn't already.
let binaryScanScope: 'largest' | 'all' = 'largest';


// ── App-wide state ────────────────────────────────────────────────────────────

// "Value findings" toggle: when on, wmap's regional parametric test-value
// pass runs (edge/quadrant/site "reads high/low on test X" + spec-region findings).
// This gates ONLY the test-value (Welch) findings — regional yield and bin findings
// are separate wmap analyses (enableHard/SoftBinAnalysis, default on) and run
// regardless of this toggle. Off by default since wmap 0.16.0 — the test-value pass
// scales with regions × tests × dies and is the dominant cost of analysis. Affects
// only analyzeWaferMap/Lot, never parsing, so toggling re-renders the in-memory
// data with no reload (see analyzeOpts).
let valueFindings = false;
const analyzeOpts = () => ({ enableTestValueAnalysis: valueFindings });

// Whether wafer map/gallery titles, cards, and summary panels show a wafer's
// split as a " · <split>" suffix (toggled in the splits modal). On by default
// so assigning a split is immediately visible.
let showSplitSuffix = true;

let cachedLotStats: ReturnType<typeof buildLotStatsSummary> | null = null;
// The wmap controller for the map currently rendered into the main `container`
// (full-window map/gallery view). Destroyed before the container is cleared so
// wmap's observers/listeners are disconnected deterministically (see
// WMAP_ISSUES.md #21). The modal drilldown owns its own controller separately.
let mainViewController: { destroy(): void; openUserGuide(): void } | null = null;
function destroyMainView() {
  mainViewController?.destroy();
  mainViewController = null;
}
/** Invalidate the memoised lot-stats cache. Call whenever the loaded wafer set changes. */
function clearLotStatsCache() {
  cachedLotStats = null;
}

// ── Log panel ─────────────────────────────────────────────────────────────────

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, msg: string) {
  const time = new Date().toLocaleTimeString();
  const el = document.createElement('div');
  el.className = `log-entry log-${level}`;
  el.textContent = `${time}  ${msg}`;
  logList.appendChild(el);
  logList.scrollTop = logList.scrollHeight;
  if (level === 'error') { logPanel.classList.add('open'); syncLogToggle(); }
  const errors = logList.querySelectorAll('.log-error').length;
  logToggle.textContent = errors > 0 ? `Log (${errors} error${errors > 1 ? 's' : ''})` : 'Log';
}

/** Surface any non-fatal parser advisories (e.g. fabricated soft bins) in the log. */
function logWarnings(parsed: ParsedFile) {
  for (const w of parsed.warnings ?? []) log('warn', `${parsed.fileName}: ${w}`);
}

/** Reflect the log panel's open state on the toggle (aria). Tooltip text is a
 *  getter (logToggleTip) so it tracks the open state without a native title. */
function syncLogToggle() {
  logToggle.setAttribute('aria-expanded', String(logPanel.classList.contains('open')));
}
function logToggleTip(): string {
  return logPanel.classList.contains('open') ? 'Hide the log panel' : 'Show the log panel';
}
logToggle.addEventListener('click', () => {
  logPanel.classList.toggle('open');
  syncLogToggle();
});

log('info', `tsmap v${__APP_VERSION__} (${__BUILD_DATE__})`);

// ── Platform intercepts ───────────────────────────────────────────────────────

if (isTauri) {
  // Route wmap HTML reports through Tauri — window.open is blocked in WebKitGTK.
  setReportOpener((html: string) => platform.openReport(html));

  // File drop
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen<{ paths: string[] }>('tauri://drag-drop', event => {
      const paths = event.payload.paths ?? [];
      if (paths.length > 0) {
        const files: FileHandle[] = paths.map(p => ({
          name: basename(p),
          bytes: new Uint8Array(0),
          path: p,
        }));
        handleFiles(files, false);
      }
    }).catch(e => log('warn', `File drop listener failed: ${e}`));
  });
} else {
  // Web drag-drop
  document.body.addEventListener('dragover', e => { e.preventDefault(); });
  document.body.addEventListener('drop', async e => {
    e.preventDefault();
    if (busy) return;
    const items = Array.from(e.dataTransfer?.files ?? []);
    if (items.length === 0) return;
    const files = await Promise.all(items.map(async f => ({
      name: f.name,
      bytes: new Uint8Array(await f.arrayBuffer()),
    })));
    handleFiles(files, false);
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

// Return type is inferred (not annotated) so `items[i].label`/`.statsSummary`
// stay visible to TS — they're real fields (spread from `waferMap` plus both
// added below), but an explicit `{ items: ReturnType<typeof buildWaferMap>[] }`
// annotation here would narrow them away for every caller, including the
// Analysis tab (via `lotStatsSummary`) and wmap's own summary-panel report
// button, which reads `.label`/`.statsSummary` off the same items.
function buildLotStatsSummary(wafers: WaferData[]) {
  const testDefs = toWmapTestDefs(currentTestDefs);
  const items = wafers.map(w => {
    const displayId = waferDisplayLabel(w, showSplitSuffix);
    const waferMap = buildWaferMap({ results: w.results, testDefs, waferConfig: { metadata: toWmapWaferMeta(w.source, displayId, w.fields) } });
    for (const warning of waferMap.warnings) {
      const conf = warning.confidence !== undefined ? ` (confidence ${(warning.confidence * 100).toFixed(0)}%)` : '';
      log('warn', `Wafer ${w.waferId}: ${warning.message}${conf}`);
    }
    const statsSummary = analyzeWaferMap(waferMap, analyzeOpts());
    return { ...waferMap, label: displayId, statsSummary };
  });
  const perWaferSummaries = items.map(i => i.statsSummary);
  const lotStatsSummary = analyzeWaferLot(items, { perWaferSummaries, ...analyzeOpts() });
  return { items, lotStatsSummary };
}

// ── Wafer split persistence ──────────────────────────────────────────────────
// Splits are just a per-wafer metadata field (see splits.ts) that CSV
// save/load already round-trips explicitly. This is a convenience layer on
// top: re-opening the SAME lot restores prior in-app assignments without the
// user re-loading a CSV every time. Keyed by splitsFingerprint (splits.ts) —
// lot ID + wafer ID, not the source file — so a different lot never inherits
// stale assignments.

const SPLITS_LS_KEY = 'tsmap:wafer-splits';

/**
 * Set by the "Load sample data" flow just before calling handleFiles, since
 * the demo lot's matching splits (waferId → split label, from the bundled
 * PVT-LOT-05_splits.csv) can't be written into SPLITS_LS_KEY until the
 * fingerprint is computable, which needs parsed wafers — not available yet at
 * click time. `loadSavedSplits` below seeds the store from this the moment
 * wafers exist, then defers entirely to the existing restore path (auto-open
 * dialog, log message, etc.) — no separate apply/UI logic duplicated.
 */
let pendingSampleSplitSeed: Map<string, string> | null = null;

/** Applies any saved splits for this exact wafer set and reports whether it
 * applied anything — callers must surface that (never apply silently), since
 * a previous session's splits reappearing with no visible cause is confusing. */
function loadSavedSplits(wafers: WaferData[]): boolean {
  try {
    const store = JSON.parse(localStorage.getItem(SPLITS_LS_KEY) ?? '{}');
    if (pendingSampleSplitSeed) {
      store[splitsFingerprint(wafers)] = Object.fromEntries(pendingSampleSplitSeed);
      localStorage.setItem(SPLITS_LS_KEY, JSON.stringify(store));
      pendingSampleSplitSeed = null;
    }
    const saved: Record<string, string> | undefined = store[splitsFingerprint(wafers)];
    if (!saved) return false;
    let applied = false;
    for (const w of wafers) {
      if (getSplitLabel(w) === undefined && saved[w.waferId]) { setSplitLabel(w, saved[w.waferId]); applied = true; }
    }
    return applied;
  } catch { return false; }
}

function saveSplits(wafers: WaferData[]): void {
  try {
    const store = JSON.parse(localStorage.getItem(SPLITS_LS_KEY) ?? '{}');
    const assignments: Record<string, string> = {};
    for (const w of wafers) {
      const v = getSplitLabel(w);
      if (v) assignments[w.waferId] = v;
    }
    store[splitsFingerprint(wafers)] = assignments;
    localStorage.setItem(SPLITS_LS_KEY, JSON.stringify(store));
  } catch { /* quota exceeded — silently skip */ }
}

function renderWafers(wafers: WaferData[], label: string, testDefs: Record<string, TestDef> = {}) {
  currentWafers = wafers;
  currentFileName = label;
  currentTestDefs = testDefs;
  const restoredSplits = loadSavedSplits(wafers);
  clearLotStatsCache();
  addBtn.disabled = wafers.length === 0;
  resetBtn.style.display = '';
  filterTestsBtn.style.display = Object.keys(currentTestDefs).length > 0 ? '' : 'none';
  splitsBtn.style.display = wafers.length > 0 ? '' : 'none';
  // Value findings are only meaningful when there are test values. Reset
  // it off on every new load so a fresh (possibly large) lot starts on the fast path.
  const hasTestValues = wafers.some(w => w.results.some(d => d.testValues && Object.keys(d.testValues).length > 0));
  valueFindings = false;
  valueFindingsBtn.classList.remove('active');
  valueFindingsBtn.setAttribute('aria-checked', 'false');
  valueFindingsBtn.style.display = hasTestValues ? '' : 'none';

  const totalDies = wafers.reduce((n, w) => n + w.results.length, 0);
  const loadedMsg = `${label} — ${wafers.length} wafer${wafers.length !== 1 ? 's' : ''}, ${totalDies} dies`;

  // buildWaferMap/renderWaferMap run synchronously and can take real time on
  // large lots — show the spinner then defer via double-rAF so the first
  // frame actually paints the spinner before the heavy render blocks the
  // main thread (single setTimeout(0) is not reliable in WebKitGTK).
  setBusy(`Rendering ${loadedMsg}…`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    renderWaferView(wafers, label);
    setIdle(loadedMsg);
    // Splits carried over from a previous session on this exact wafer set —
    // never apply that silently. Open the dialog so it's obvious what
    // happened and the user can review, edit, or "Clear all" it.
    if (restoredSplits) {
      log('info', 'Restored wafer splits from a previous session — review in the Splits dialog.');
      openSplitsDialog();
    }
  }));
}


// Route wmap PNG saves through the native dialog in Tauri; undefined on web uses the default download.
const onSaveImage = isTauri
  ? (blob: Blob, suggestedName: string) => {
      const stem = suggestedName.replace(/\.png$/i, '');
      platform.savePng(blob, stem)
        .then(() => log('info', `PNG saved: ${suggestedName}`))
        .catch((err: unknown) => log('error', `PNG save failed: ${err}`));
    }
  : undefined;

function renderWaferView(wafers: WaferData[], label: string) {
  destroyMainView();
  container.innerHTML = '';
  const stem = label.replace(/\.[^.]+$/, '');

  const plotMode = autoPlotMode(wafers);
  const wmapTestDefs = toWmapTestDefs(currentTestDefs);
  if (wafers.length === 1) {
    container.classList.remove('gallery');
    const waferMap = buildWaferMap({ results: wafers[0].results, testDefs: wmapTestDefs, waferConfig: { metadata: toWmapWaferMeta(wafers[0].source, waferDisplayLabel(wafers[0], showSplitSuffix), wafers[0].fields) } });
    const statsSummary = analyzeWaferMap(waferMap, analyzeOpts());
    mainViewController = renderWaferMap(container, waferMap, {
      statsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
      // No visible wmap help button — tsmap's own Help menu (openHelpMenu)
      // triggers wmap's guide via the controller's openUserGuide(), not a
      // button click. See WMAP_ISSUES.md #32.
      showHelpButton: false,
      downloadFilename: stem,
      onSaveImage,
      viewOptions: { plotMode },
      // Single-wafer counterpart to the gallery's analysisEnabled below —
      // closes the gap that blocked removing tsmap's own Charts page (see
      // WMAP_ISSUES.md): single-wafer loads had no chart access at all
      // without this.
      analysisEnabled: true,
    });
  } else {
    container.classList.add('gallery');
    cachedLotStats ??= buildLotStatsSummary(wafers);
    const { items, lotStatsSummary } = cachedLotStats;
    mainViewController = renderWaferGallery(container, items, {
      lotStatsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
      // No visible wmap help button — tsmap's own Help menu (openHelpMenu)
      // triggers wmap's guide via the controller's openUserGuide(), not a
      // button click. See WMAP_ISSUES.md #32.
      showHelpButton: false,
      downloadFilename: stem,
      onSaveImage,
      viewOptions: { plotMode },
      // wmap-owned Analysis tab (see WMAP_ISSUES.md #31) — the only chart
      // access now that tsmap's own Charts page has been removed.
      analysisEnabled: true,
    });
  }
}

/**
 * Tear down the current maps/charts view for a fresh (non-append) load that has
 * been committed but may take a while to parse. Unlike `showEmptyState` this does
 * NOT reset load state (`currentBinaryFiles`, `currentTestNames`, button
 * visibility) — those are mid-load and still needed; it only blanks the visible
 * container so the user doesn't see stale data while the new file parses.
 * `renderWafers` replaces this placeholder once the parse completes.
 */
function showLoadingState(msg: string) {
  destroyMainView();
  container.classList.remove('gallery');
  container.innerHTML = '';
  const placeholder = document.createElement('div');
  placeholder.style.cssText =
    'display:flex;align-items:center;justify-content:center;position:absolute;inset:0;' +
    'color:var(--text-faint);font-size:14px;user-select:none;';
  placeholder.textContent = msg;  // textContent: file names are untrusted
  container.appendChild(placeholder);
}


function showEmptyState() {
  currentWafers = [];
  currentTestDefs = {};
  currentBinaryFiles = [];
  currentBinaryExt = '';
  currentTestNames = null;
  binaryScanScope = 'largest';
  clearLotStatsCache();
  addBtn.disabled = true;
  resetBtn.style.display = 'none';
  filterTestsBtn.style.display = 'none';
  splitsBtn.style.display = 'none';
  valueFindingsBtn.style.display = 'none';
  destroyMainView();
  container.classList.remove('gallery');
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                position:absolute;inset:0;gap:16px;color:var(--text-faint);user-select:none;">
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="28" stroke="var(--border-mid)" stroke-width="2"/>
        <circle cx="32" cy="32" r="18" stroke="var(--border-mid)" stroke-width="1.5" stroke-dasharray="3 3"/>
        <circle cx="32" cy="32" r="8"  stroke="var(--border-mid)" stroke-width="1.5"/>
        <line x1="32" y1="4"  x2="32" y2="10" stroke="var(--border-mid)" stroke-width="2" stroke-linecap="round"/>
        <line x1="32" y1="54" x2="32" y2="60" stroke="var(--border-mid)" stroke-width="2" stroke-linecap="round"/>
        <line x1="4"  y1="32" x2="10" y2="32" stroke="var(--border-mid)" stroke-width="2" stroke-linecap="round"/>
        <line x1="54" y1="32" x2="60" y2="32" stroke="var(--border-mid)" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <div style="font-size:15px;color:var(--text-dim);">Open a file to get started</div>
      <div style="font-size:12px;color:var(--text-veryfaint);">Supports STDF, ATDF, CSV and JSON</div>
    </div>`;

  const column = container.firstElementChild as HTMLElement;

  // Loads a bundled synthetic lot through the normal load pipeline (test
  // selector, etc.) so a first-time user — or an evaluator getting past the
  // unsigned-installer security warning — can see the app work before
  // trusting it with their own files. Works on both platforms: desktop reads
  // it as a real bundled resource path, web fetches it as a static asset.
  const sampleBtn = document.createElement('button');
  sampleBtn.type = 'button';
  sampleBtn.style.cssText = 'margin-top:4px;background:none;border:1px solid var(--border-dim);' +
    'border-radius:4px;color:var(--text-muted);font-size:12px;padding:4px 12px;cursor:pointer;';
  sampleBtn.textContent = 'Load sample data';
  sampleBtn.addEventListener('click', async () => {
    if (busy) return;
    try {
      const file = await platform.getSampleFile();
      // Best-effort: a missing/failed splits fetch shouldn't block the load
      // itself, so this deliberately doesn't throw — the lot is still a
      // perfectly good demo without its splits.
      const splitsCsv = await platform.getSampleSplitsCsv().catch(() => null);
      if (splitsCsv) pendingSampleSplitSeed = parseSplitsCsv(splitsCsv);
      handleFiles([file], false);
    } catch (e) {
      log('error', `Failed to load sample data: ${errMsg(e)}`);
    }
  });
  column.appendChild(sampleBtn);

  // Recent files needs a persistent native path to reopen without the picker —
  // only available on desktop (webPlatform's File objects have no path). Also
  // reachable from the toolbar's Recent button once data is loaded (openRecentMenu).
  if (isTauri && getRecentFiles().length > 0) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:4px;width:320px;';
    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:11px;color:var(--text-veryfaint);text-transform:uppercase;' +
      'letter-spacing:.04em;margin-bottom:2px;text-align:center;';
    heading.textContent = 'Recent';
    wrap.appendChild(heading);
    wrap.appendChild(buildRecentRows(() => {}, () => { showEmptyState(); }));
    column.appendChild(wrap);
  }
}

/**
 * Builds the recent-files row list (open + remove per entry), shared by the
 * empty-state panel and the toolbar's Recent dropdown (openRecentMenu). Each
 * row's open action is a fresh load (`isAppend: false`), matching "Open file"'s
 * existing replace-current-data behaviour — there is no append-from-recent yet.
 * `onOpen` fires just before a reopen starts (the toolbar menu uses it to close
 * itself); `onRemove` fires after a row is deleted so the caller can re-render.
 */
function buildRecentRows(onOpen: () => void, onRemove: () => void): HTMLElement {
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

  for (const entry of getRecentFiles()) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;';

    const rowOpenBtn = document.createElement('button');
    rowOpenBtn.type = 'button';
    rowOpenBtn.style.cssText = 'flex:1;min-width:0;text-align:left;background:none;' +
      'border:1px solid var(--border-dim);border-radius:4px;color:var(--text-secondary);' +
      'font-size:12px;padding:4px 8px;cursor:pointer;display:flex;flex-direction:column;gap:1px;overflow:hidden;';
    const nameLine = document.createElement('div');
    nameLine.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nameLine.textContent = entry.label;  // textContent: file names are untrusted
    const timeLine = document.createElement('div');
    timeLine.style.cssText = 'font-size:10px;color:var(--text-veryfaint);';
    timeLine.textContent = formatRecentTime(entry.time);
    rowOpenBtn.append(nameLine, timeLine);
    // Dynamically-created element — upgradeTitleTooltips only runs once at
    // startup over the static toolbar, so this needs the themed tooltip
    // wired explicitly (a plain `title` here leaves ghost rendering
    // artifacts on WebKitGTK when the row is removed while it's showing).
    attachTooltip(rowOpenBtn, entry.paths.join('\n'));
    rowOpenBtn.addEventListener('click', () => {
      if (busy) return;
      const files: FileHandle[] = entry.paths.map(p => ({ name: basename(p), bytes: new Uint8Array(0), path: p }));
      onOpen();
      handleFiles(files, false);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', `Remove ${entry.label} from recent files`);
    removeBtn.style.cssText = 'flex-shrink:0;background:none;border:none;color:var(--text-veryfaint);' +
      'cursor:pointer;font-size:14px;line-height:1;padding:4px 6px;';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecentFile(entry.paths);
      syncRecentBtn();
      onRemove();
    });

    row.append(rowOpenBtn, removeBtn);
    list.appendChild(row);
  }
  return list;
}

/** Shows/hides the toolbar's Recent button based on whether any entries exist —
 *  independent of load state, so it stays available once data is loaded (the
 *  gap this closes: the recent list previously only appeared on the empty
 *  state, which disappears the moment a file is open). */
function syncRecentBtn() {
  if (!isTauri) return;
  recentBtn.style.display = getRecentFiles().length > 0 ? '' : 'none';
}

let closeRecentMenu: (() => void) | null = null;

/** Opens (or closes, if already open) a themed dropdown of recent files
 *  anchored under `anchor`, reusing buildRecentRows for the row UI. */
function openRecentMenu(anchor: HTMLElement) {
  if (closeRecentMenu) { closeRecentMenu(); return; }

  const popup = document.createElement('div');
  popup.style.cssText = [
    'position:fixed', 'z-index:var(--z-tooltip)',
    'background:var(--bg-overlay)', 'color:var(--text-secondary)',
    'border:1px solid var(--border-mid)', 'border-radius:6px',
    'box-shadow:0 6px 20px rgba(0,0,0,0.35)',
    'padding:8px', 'min-width:260px', 'max-width:360px',
    'font-size:12px', 'font-family:system-ui,sans-serif',
  ].join(';');

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:11px;color:var(--text-veryfaint);text-transform:uppercase;' +
    'letter-spacing:.04em;margin-bottom:6px;';
  heading.textContent = 'Recent';
  popup.appendChild(heading);

  const rebuild = () => {
    popup.querySelector('.recent-rows')?.remove();
    if (getRecentFiles().length === 0) { close(); return; }
    const rows = buildRecentRows(close, rebuild);
    rows.classList.add('recent-rows');
    popup.appendChild(rows);
  };
  rebuild();

  document.body.appendChild(popup);
  const r = anchor.getBoundingClientRect();
  const margin = 8;
  popup.style.top = `${r.bottom + 4}px`;
  popup.style.left = `${r.left}px`;
  requestAnimationFrame(() => {
    const pw = popup.offsetWidth;
    let left = r.left;
    if (left + pw + margin > window.innerWidth) left = window.innerWidth - pw - margin;
    popup.style.left = `${Math.max(margin, left)}px`;
  });

  function onOutside(e: PointerEvent) {
    const t = e.target as Node;
    if (!popup.contains(t) && !anchor.contains(t)) close();
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }

  function close() {
    popup.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    closeRecentMenu = null;
  }
  closeRecentMenu = close;

  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
}

// ── Multi-file load flow ──────────────────────────────────────────────────────

let busy = false;

function setBusy(msg: string) {
  busy = true;
  fileLabel.textContent = msg;
  busySpinner.classList.add('active');
  openBtn.style.pointerEvents = 'none';
  openBtn.style.opacity = '0.5';
  addBtn.disabled = true;
}

function setIdle(msg = '') {
  busy = false;
  fileLabel.textContent = msg;
  busySpinner.classList.remove('active');
  openBtn.style.pointerEvents = '';
  openBtn.style.opacity = '';
  if (currentWafers.length > 0) addBtn.disabled = false;
}

/**
 * Fast first-pass scan (PTR/FTR names, no die accumulation) across one or more
 * binary files, merging their test definitions into a single map. Used both for
 * the default largest-file scan and for the selector's "scan all files" toggle.
 * `dieCount` is the exact sum of dies across the scanned files. Returns null only
 * if every scan failed; a per-file failure is logged and skipped. Relies on
 * `currentBinaryExt` for the format (all binary files in a load share it).
 */
async function scanBinaryTests(filesToScan: FileHandle[]): Promise<{ testDefs: StdfTestNames; dieCount: number } | null> {
  const isAtdf = currentBinaryExt === 'atdf' || currentBinaryExt === 'atd';
  const merged: StdfTestNames = {};
  let dieCount = 0;
  let anyOk = false;
  for (const file of filesToScan) {
    setBusy(`Scanning ${file.name} for tests…`);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const result: ScanResult = isAtdf
        ? await platform.atdfTestNames(file)
        : await platform.stdfTestNames(file);
      Object.assign(merged, result.testDefs); // test numbers are the identity key
      dieCount += result.dieCount;
      anyOk = true;
      log('info', `${file.name}: ${Object.keys(result.testDefs).length} tests found, ${result.dieCount.toLocaleString()} dies`);
    } catch (e) {
      log('warn', `Test name scan failed for ${file.name}: ${errMsg(e)}`);
    }
  }
  if (!anyOk) {
    log('warn', 'Test name scan failed — parsing all tests');
    return null;
  }
  return { testDefs: merged, dieCount };
}

async function handleFiles(files: FileHandle[], isAppend: boolean) {
  if (files.length === 0) return;
  if (busy) return;

  // Captured before archive expansion/reassignment below, so a reopened .zip
  // records (and re-expands) its own path rather than its extracted contents.
  const originalPaths = files.every(f => f.path) ? files.map(f => f.path as string) : null;

  setBusy(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`);
  // Yield two animation frames so the spinner actually paints before the
  // first platform call (WebKitGTK may not repaint on setTimeout(0) alone).
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Expand archives — .gz and .zip handled per-platform
  let needsCleanup = false;
  const anyZip = files.some(f => f.name.toLowerCase().endsWith('.zip'));
  if (anyZip) {
    setBusy(`Extracting archive…`);
    needsCleanup = isTauri && anyZip;
  }
  files = await platform.expandArchives(files).catch(e => {
    log('error', `Archive extraction failed: ${e}`);
    return files;
  });

  if (files.length === 0) {
    setIdle('Error: no files after extraction');
    return;
  }

  // Determine effective extension — strip .gz wrapper to get inner format
  const effectiveExt = (name: string) => {
    const parts = name.split('.');
    const ext = parts.pop()?.toLowerCase() ?? '';
    return ext === 'gz' ? (parts.pop()?.toLowerCase() ?? ext) : ext;
  };

  // Validate all files have the same extension (relaxed for mixed-format zips)
  const exts = [...new Set(files.map(f => effectiveExt(f.name)))];
  if (exts.length > 1 && !needsCleanup) {
    log('error', `Mixed formats not supported: ${exts.join(', ')} — please select files of the same type`);
    setIdle('Error: mixed formats');
    return;
  }

  // For CSV/JSON: show mapping overlay once for the first such file, apply to all
  const needsMapping = (e: string) => e === 'csv' || e === 'txt' || e === 'dat' || e === 'json';
  const firstMappable = files.find(f => needsMapping(effectiveExt(f.name)));

  let mappingPromise: Promise<CsvMapping | null> = Promise.resolve(null);

  if (firstMappable) {
    const firstExt = effectiveExt(firstMappable.name);
    setBusy(`Reading ${firstMappable.name}…`);
    const headersResult = await (firstExt === 'json'
      ? platform.jsonHeaders(firstMappable)
      : platform.csvHeaders(firstMappable)
    ).catch(e => { log('error', `Failed to read headers: ${e}`); return null; });

    if (!headersResult) {
      if (needsCleanup) platform.expandArchives([]).catch(() => {});
      setIdle();
      return;
    }

    const mappableFiles = files.filter(f => needsMapping(effectiveExt(f.name)));
    const note = mappableFiles.length > 1 ? ` — mapping applied to all ${mappableFiles.length} CSV/JSON files` : '';
    log('info', `${firstMappable.name}: ${headersResult.rowCount} rows, ${headersResult.headers.length} columns${note}`);

    mappingPromise = new Promise(resolve => {
      showMappingOverlay(headersResult,
        (mapping) => resolve(mapping),
        () => { setIdle(); resolve(null); }
      );
    });
  }

  const mapping = await mappingPromise;
  if (mapping === null && firstMappable) {
    return; // cancelled
  }

  // ── Parse phase ──────────────────────────────────────────────────────────
  // For STDF/ATDF: first-pass scan to get testDefs cheaply, then filtered parse.
  // For CSV/JSON: parse fully now (fast), use parsed testDefs for the selector.
  const isBinaryExt = (e: string) => e === 'stdf' || e === 'std' || e === 'atdf' || e === 'atd';
  const binaryFiles = files.filter(f => isBinaryExt(effectiveExt(f.name)));

  // firstPassTestDefs: merged testDefs from first-pass scan (STDF/ATDF) and/or full parse (CSV/JSON).
  let firstPassTestDefs: StdfTestNames | null = null;
  // Pre-parsed CSV/JSON results — reused after the selector so we don't parse twice.
  const preParsed = new Map<string, ParsedFile>();
  // Die count from the binary scan (PIR count × file count approximation).
  let binaryScanDieCount = 0;

  if (binaryFiles.length > 0) {
    const largestBinary = binaryFiles.reduce((a, b) => {
      const aSize = a.size ?? a.bytes.length;
      const bSize = b.size ?? b.bytes.length;
      return aSize >= bSize ? a : b;
    });
    currentBinaryFiles = binaryFiles;
    currentBinaryExt = effectiveExt(largestBinary.name);
    binaryScanScope = 'largest';

    // Default scan scope: the largest file only — a fast, representative test
    // list. The selector offers a "scan all files" toggle to widen this when a
    // test only appears in a smaller file (see scanBinaryTests / onScanAll).
    const scan = await scanBinaryTests([largestBinary]);
    if (scan) {
      currentTestNames = scan.testDefs;
      firstPassTestDefs = scan.testDefs;
      // Largest-file die count extrapolated across all files (exact totals come
      // from a "scan all"). Only used for the selector's memory advisory.
      binaryScanDieCount = scan.dieCount * binaryFiles.length;
    }
  }

  // Parse CSV/JSON files now; collect their testDefs for the selector.
  const nonBinaryFiles = files.filter(f => !isBinaryExt(effectiveExt(f.name)));
  for (const file of nonBinaryFiles) {
    const fileExt = effectiveExt(file.name);
    setBusy(`Parsing ${file.name}…`);
    try {
      const parsed: ParsedFile = fileExt === 'json'
        ? rustToLocal(await platform.parseJson(file, mapping!), file.name)
        : rustToLocal(await platform.parseCsv(file, mapping!), file.name);
      preParsed.set(file.name, parsed);
      log('info', `Parsed ${file.name}: ${parsed.wafers.length} wafer${parsed.wafers.length !== 1 ? 's' : ''}`);
      logWarnings(parsed);
      // Merge testDefs from this file into firstPassTestDefs for the selector.
      if (Object.keys(parsed.testDefs).length > 0) {
        firstPassTestDefs = { ...(firstPassTestDefs ?? {}), ...parsed.testDefs };
      }
    } catch (e) {
      log('error', `Failed to parse ${file.name}: ${errMsg(e)}`);
    }
  }

  // ── Test selector ─────────────────────────────────────────────────────────
  // Always shown when any file has test data (non-empty merged testDefs).
  let testSelection: number[] | null = null;
  let overlayNameOverrides: Map<number, string> = new Map();

  if (firstPassTestDefs && Object.keys(firstPassTestDefs).length > 0) {
    const csvDieCount = Array.from(preParsed.values())
      .reduce((s, p) => s + p.wafers.reduce((ws, w) => ws + w.results.length, 0), 0);

    // The selector can be re-entered when the user clicks "scan all files": we
    // widen the scope, re-scan, merge, and re-open with the same selection +
    // name overrides preserved. `scanScope` tracks whether we're still on the
    // largest file only (so the toggle is offered) or have scanned everything.
    let scanScope: 'largest' | 'all' = 'largest';
    let scopedDefs = firstPassTestDefs;
    let carrySelection: number[] = [];
    let carryNames = new Map<number, string>();

    selector: for (;;) {
      const allTestNums = new Set(Object.keys(scopedDefs).map(Number));
      const totalDieCount = binaryScanDieCount + csvDieCount;
      // Offer "scan all" only with >1 binary file and while still scoped to largest.
      const canScanAll = binaryFiles.length > 1 && scanScope === 'largest';

      const result = await new Promise<{ kind: 'confirm'; selection: number[]; names: Map<number, string> }
                                     | { kind: 'cancel' }
                                     | { kind: 'scanAll'; selection: number[]; names: Map<number, string> }>(resolve => {
        showTestSelectorOverlay(
          scopedDefs,
          (sel, names) => resolve({ kind: 'confirm', selection: sel, names }),
          () => resolve({ kind: 'cancel' }),
          {
            scanScope: binaryFiles.length > 1 ? scanScope : undefined,
            scanFileCount: binaryFiles.length,
            onScanAll: canScanAll ? (sel, names) => resolve({ kind: 'scanAll', selection: sel, names }) : undefined,
            initialSelection: carrySelection,
            nameOverrides: carryNames,
            capacity: totalDieCount > 0 ? { dieCount: totalDieCount, totalTests: allTestNums.size } : undefined,
            onSave: async (saveEntries) => {
              const lines = [
                '# tsmap test list',
                `# Saved: ${new Date().toISOString()}`,
                ...saveEntries.map(e => `${e.num},${e.name}`),
              ];
              await platform.saveTextFile(lines.join('\n'), 'test-list.csv');
            },
            onLoad: async () => (await platform.pickTextFile())?.content ?? null,
            onLog: log,
            onAsk: (msg) => platform.confirm(msg),
          },
        );
      });

      if (result.kind === 'cancel') { setIdle(); return; }

      if (result.kind === 'scanAll') {
        // Preserve the user's in-progress selection/renames across the re-scan.
        carrySelection = result.selection;
        carryNames = result.names;
        const scan = await scanBinaryTests(binaryFiles);
        if (scan) {
          scopedDefs = scan.testDefs;
          firstPassTestDefs = scan.testDefs;   // so the full parse below sees every test
          currentTestNames = scan.testDefs;    // so "Filter tests…" re-uses the widened list
          binaryScanDieCount = scan.dieCount;  // exact total now, not extrapolated
          binaryScanScope = 'all';
          scanScope = 'all';
          log('info', `Scanned all ${binaryFiles.length} files: ${Object.keys(scan.testDefs).length} tests total`);
        }
        continue selector; // re-open the selector with the merged list
      }

      // confirm
      overlayNameOverrides = result.names;
      testSelection = result.selection;
      log('info', `Test filter: ${testSelection.length} of ${allTestNums.size} tests selected`);
      break;
    }
  }

  // The load is now committed (the cancellable mapping/test-selector gates have
  // resolved) and the full parse below can be slow. For a fresh load (not an
  // "add"), clear the previous maps/charts now so the user isn't left looking at
  // stale data from the old file while the new one parses. An append keeps the
  // current view, since the new wafers are added to it. NOTE: the rename overlay
  // (further down) can still be cancelled — `abortFreshLoad()` resets to the empty
  // state on any post-clear bail-out so the user is never stranded on a blank view
  // showing nothing while the old data is silently still in `currentWafers`.
  const clearedForFreshLoad = !isAppend;
  if (clearedForFreshLoad) showLoadingState(`Loading ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
  // Return to a clean empty state if a committed fresh load bails out (parse error
  // or rename cancel); for an append the old view is intact, so just go idle.
  const abortFreshLoad = (msg?: string) => {
    if (clearedForFreshLoad) showEmptyState();
    setIdle(msg);
  };

  // ── Full parse for STDF/ATDF, prune/backfill pre-parsed CSV/JSON ──────────
  const entries: FileWaferEntry[] = [];

  try {
    // Finalise pre-parsed CSV/JSON entries — prune to selection.
    for (const [, parsed] of preParsed) {
      applyTestSelection(parsed, testSelection ?? [], null, overlayNameOverrides);
    }

    for (const file of files) {
      const fileExt = effectiveExt(file.name);

      // CSV/JSON already parsed above — just collect.
      if (!isBinaryExt(fileExt)) {
        const pre = preParsed.get(file.name);
        if (pre) entries.push({ filePath: file.path ?? file.name, fileName: file.name, parsed: pre });
        continue;
      }

      setBusy(`Parsing ${file.name}…`);
      try {
        // If scan failed (firstPassTestDefs null), fall back to unfiltered parse.
        const raw = firstPassTestDefs === null
          ? (fileExt === 'atdf' || fileExt === 'atd'
            ? await platform.parseAtdf(file)
            : await platform.parseStdf(file))
          : (fileExt === 'atdf' || fileExt === 'atd'
            ? await platform.parseAtdfFiltered(file, testSelection ?? [])
            : await platform.parseStdfFiltered(file, testSelection ?? []));
        const parsed = rustToLocal(raw, file.name);
        applyTestSelection(parsed, testSelection ?? [], firstPassTestDefs, overlayNameOverrides);
        entries.push({ filePath: file.path ?? file.name, fileName: file.name, parsed });
        log('info', `Parsed ${file.name}: ${parsed.wafers.length} wafer${parsed.wafers.length !== 1 ? 's' : ''}`);
        logWarnings(parsed);
      } catch (e) {
        log('error', `Failed to parse ${file.name}: ${errMsg(e)}`);
      }
    }
  } catch (e) {
    const msg = errMsg(e);
    log('error', `Parse failed: ${msg}. Try selecting fewer tests.`);
    abortFreshLoad('Out of memory — reduce test selection and try again');
    return;
  }

  if (entries.length === 0) {
    abortFreshLoad('Error: no files parsed successfully');
    return;
  }

  // Rename step — always shown for multi-file, or single file with generic wafer ID
  const allWafers = entries.flatMap(e => e.parsed.wafers);
  const needsRename = entries.length > 1 || (allWafers.length === 1 && /^W\d+$/.test(allWafers[0].waferId));

  const getRenamed = (): Promise<RenamedWafer[] | null> => {
    if (!needsRename) {
      // needsRename is false only for a single entry, so all wafers share its source.
      const source = makeWaferSource(entries[0].parsed.meta, entries[0].fileName);
      return Promise.resolve(allWafers.map(w => ({
        waferId: w.waferId,
        results: w.results,
        partCount: w.partCount,
        goodCount: w.goodCount,
        failCount: w.failCount,
        fields: w.fields,
        source,
      })));
    }
    return new Promise(resolve => {
      showRenameOverlay(entries,
        (renamed) => resolve(renamed),
        () => { abortFreshLoad(); resolve(null); }
      );
    });
  };

  const renamed = await getRenamed();
  if (!renamed) return;

  if (isAppend && currentWafers.length > 0) {
    await new Promise<void>(resolve => {
      showAppendConfirm({
        incoming: renamed,
        existing: currentWafers,
        onConfirm: () => {
          // Shallow spread preserves each wafer's shared `source` reference — do
          // NOT deep-clone or serialize a stamped wafer (e.g. through the parser
          // worker), or reference identity breaks and grouping by source fails.
          const merged = [
            ...currentWafers,
            ...renamed.map(toWaferData),
          ];
          renderWafers(merged, currentFileName, { ...currentTestDefs, ...Object.assign({}, ...entries.map(e => e.parsed.testDefs)) });
          log('info', `Added ${renamed.length} wafer${renamed.length !== 1 ? 's' : ''} — gallery now has ${merged.length}`);
          resolve();
        },
        onCancel: () => { setIdle(`${currentWafers.length} wafers loaded`); resolve(); },
      });
    });
  } else {
    renderWafers(
      renamed.map(toWaferData),
      entries.length === 1 ? entries[0].fileName : `${entries.length} files`,
      Object.assign({}, ...entries.map(e => e.parsed.testDefs))
    );
    if (originalPaths) { addRecentFiles(originalPaths); syncRecentBtn(); }
  }
}

// ── Open / Add buttons ────────────────────────────────────────────────────────

async function pickAndHandle(isAppend: boolean) {
  if (busy) return;
  const prevLabel = fileLabel.textContent ?? '';
  setBusy('Waiting for file selection…');
  let files: FileHandle[];
  try {
    files = await platform.pickFiles();
  } catch (e) {
    log('error', `File picker failed: ${errMsg(e)}`);
    setIdle(prevLabel);
    return;
  }
  if (files.length === 0) {
    setIdle(prevLabel);
    return;
  }
  busy = false;
  handleFiles(files, isAppend);
}

if (isTauri) {
  openBtn.addEventListener('click', () => pickAndHandle(false));
  addBtn.addEventListener('click', () => pickAndHandle(true));
  recentBtn.addEventListener('click', () => openRecentMenu(recentBtn));
  syncRecentBtn();
} else {
  // On web, trigger the native file input synchronously from the click event
  // so the browser treats it as a user gesture (async calls block the picker).
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  let appendOnPick = false;
  // Captured in the click handler, BEFORE setBusy overwrites fileLabel — by
  // the time `change`/`cancel` fire, fileLabel already reads the busy message,
  // so reading it there would restore the wrong text.
  let prevLabelOnPick = '';

  fileInput.addEventListener('change', async () => {
    const rawFiles = Array.from(fileInput.files ?? []);
    fileInput.value = '';  // reset so same file can be re-picked
    if (rawFiles.length === 0) { setIdle(prevLabelOnPick); return; }
    busy = false;
    const files = await Promise.all(rawFiles.map(async f => ({
      name: f.name,
      bytes: new Uint8Array(await f.arrayBuffer()),
    })));
    handleFiles(files, appendOnPick);
  });

  // Unlike `change`, the native file input fires no event at all when the
  // dialog is dismissed without picking a file (Cancel / Esc / the dialog's
  // own close button) — without this listener, `busy` stays true forever and
  // the toolbar is stuck showing "Waiting for file selection…". `cancel`
  // (Chrome 113+, Firefox 121+, Safari 16.4+) fires in exactly that case.
  fileInput.addEventListener('cancel', () => setIdle(prevLabelOnPick));

  openBtn.addEventListener('click', () => {
    if (busy) return;
    appendOnPick = false;
    prevLabelOnPick = fileLabel.textContent ?? '';
    setBusy('Waiting for file selection…');
    fileInput.click();
  });

  addBtn.addEventListener('click', () => {
    if (busy) return;
    appendOnPick = true;
    prevLabelOnPick = fileLabel.textContent ?? '';
    setBusy('Waiting for file selection…');
    fileInput.click();
  });
}

valueFindingsBtn.addEventListener('click', () => {
  if (busy || currentWafers.length === 0) return;
  valueFindings = !valueFindings;
  valueFindingsBtn.classList.toggle('active', valueFindings);
  valueFindingsBtn.setAttribute('aria-checked', String(valueFindings));
  // Analysis results are cached; the toggle changes what they contain, so drop
  // them. Re-render the current map view (gallery/single) with the new setting —
  // the raw dies are already in memory, so this is a re-analyse, not a reload.
  cachedLotStats = null;
  log('info', `Value findings ${valueFindings ? 'on — recomputing regional test-value findings' : 'off'}`);
  const label = currentFileName;
  setBusy(`${valueFindings ? 'Analysing' : 'Rendering'} ${label}…`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    renderWaferView(currentWafers, label);
    setIdle(`${label} — ${currentWafers.length} wafer${currentWafers.length !== 1 ? 's' : ''}, ${currentWafers.reduce((n, w) => n + w.results.length, 0)} dies`);
  }));
});

resetBtn.addEventListener('click', () => {
  if (currentWafers.length === 0) return;
  setIdle();
  showEmptyState();
});

filterTestsBtn.addEventListener('click', async () => {
  if (busy || Object.keys(currentTestDefs).length === 0) return;
  // For CSV/JSON (no binary files), we only support in-memory filtering — no re-parse available.
  // For STDF/ATDF we use currentTestNames from the first-pass scan (may re-parse if user adds tests).
  const selectorTestDefs: StdfTestNames = currentTestNames ?? currentTestDefs;

  let filterOverrideNames: Map<number, string> = new Map();
  let scopedDefs = selectorTestDefs;
  let carrySelection: number[] = Object.keys(currentTestDefs).map(Number);
  // Seed with any renames already baked into currentTestDefs (from the
  // initial load's rename/Load-list) but not reflected in selectorTestDefs
  // (the original first-pass scan) — otherwise a rename applied earlier
  // would appear to have silently reverted when the selector reopens here.
  let carryNames = new Map<number, string>();
  for (const [key, def] of Object.entries(currentTestDefs)) {
    const scanned = selectorTestDefs[key];
    if (scanned && def.name !== scanned.name) carryNames.set(Number(key), def.name);
  }
  let testSelection: number[] | null = null;

  filterLoop: for (;;) {
    // Offer "scan all" only if this is a multi-file binary load not already widened.
    const canScanAll = currentBinaryFiles.length > 1 && binaryScanScope === 'largest';
    const result = await new Promise<{ kind: 'confirm'; selection: number[]; names: Map<number, string> }
                                   | { kind: 'cancel' }
                                   | { kind: 'scanAll'; selection: number[]; names: Map<number, string> }>(resolve => {
      showTestSelectorOverlay(
        scopedDefs,
        (sel, names) => resolve({ kind: 'confirm', selection: sel, names }),
        () => resolve({ kind: 'cancel' }),
        {
          scanScope: currentBinaryFiles.length > 1 ? binaryScanScope : undefined,
          scanFileCount: currentBinaryFiles.length,
          onScanAll: canScanAll ? (sel, names) => resolve({ kind: 'scanAll', selection: sel, names }) : undefined,
          initialSelection: carrySelection,
          nameOverrides: carryNames,
          onSave: async (entries) => {
            const lines = [
              '# tsmap test list',
              `# Saved: ${new Date().toISOString()}`,
              ...entries.map(e => `${e.num},${e.name}`),
            ];
            await platform.saveTextFile(lines.join('\n'), 'test-list.csv');
          },
          onLoad: async () => (await platform.pickTextFile())?.content ?? null,
          onLog: log,
        },
      );
    });

    if (result.kind === 'cancel') return;

    if (result.kind === 'scanAll') {
      carrySelection = result.selection;
      carryNames = result.names;
      const scan = await scanBinaryTests(currentBinaryFiles);
      if (scan) {
        scopedDefs = scan.testDefs;
        currentTestNames = scan.testDefs;
        binaryScanScope = 'all';
        log('info', `Scanned all ${currentBinaryFiles.length} files: ${Object.keys(scan.testDefs).length} tests total`);
      }
      setIdle();
      continue filterLoop;
    }

    filterOverrideNames = result.names;
    testSelection = result.selection;
    break;
  }

  if (testSelection === null) return;

  // If the new selection is a subset of already-loaded tests, filter in memory —
  // no re-parse needed. CSV/JSON always use in-memory path (no re-parse available).
  const loadedTestNumbers = new Set(Object.keys(currentTestDefs).map(Number));
  const needsReparse = currentBinaryFiles.length > 0 && testSelection.some(n => !loadedTestNumbers.has(n));

  if (!needsReparse) {
    const keepSet = new Set(testSelection);
    const filteredWafers = currentWafers.map(w => ({
      ...w,
      results: w.results.map(d => {
        if (!d.testValues) return d;
        const testValues: typeof d.testValues = {};
        for (const [k, v] of Object.entries(d.testValues)) {
          if (keepSet.has(Number(k))) testValues[Number(k)] = v;
        }
        return { ...d, testValues };
      }),
    }));
    const filteredDefs: Record<string, TestDef> = {};
    for (const key of Object.keys(currentTestDefs)) {
      if (keepSet.has(Number(key))) filteredDefs[key] = currentTestDefs[key];
    }
    for (const [num, name] of filterOverrideNames) {
      if (String(num) in filteredDefs) {
        filteredDefs[String(num)] = { ...filteredDefs[String(num)], name };
      }
    }
    log('info', `Test filter: ${testSelection.length} of ${Object.keys(selectorTestDefs).length} tests (in-memory)`);
    renderWafers(
      filteredWafers,
      currentFileName,
      filteredDefs,
    );
    return;
  }

  // New selection adds tests not in the current load — must re-parse.
  const entries: FileWaferEntry[] = [];
  for (const file of currentBinaryFiles) {
    const parts = file.name.split('.');
    const ext = parts.pop()?.toLowerCase() ?? '';
    const fileExt = ext === 'gz' ? (parts.pop()?.toLowerCase() ?? ext) : ext;
    setBusy(`Parsing ${file.name}…`);
    try {
      const raw = fileExt === 'atdf' || fileExt === 'atd'
        ? await platform.parseAtdfFiltered(file, testSelection)
        : await platform.parseStdfFiltered(file, testSelection);
      const parsed = rustToLocal(raw, file.name);
      applyTestSelection(parsed, testSelection, currentTestNames, filterOverrideNames);
      entries.push({ filePath: file.path ?? file.name, fileName: file.name, parsed });
      log('info', `Re-parsed ${file.name}: ${parsed.wafers.length} wafer${parsed.wafers.length !== 1 ? 's' : ''} (${testSelection.length} tests)`);
      logWarnings(parsed);
    } catch (e) {
      log('error', `Failed to re-parse ${file.name}: ${errMsg(e)}`);
    }
  }

  if (entries.length === 0) {
    setIdle(`${currentWafers.length} wafers loaded`);
    return;
  }

  const allWafers = entries.flatMap(e => e.parsed.wafers);
  const mergedDefs = Object.assign({}, ...entries.map(e => e.parsed.testDefs));
  renderWafers(
    allWafers,
    entries.length === 1 ? entries[0].fileName : `${entries.length} files`,
    mergedDefs,
  );
});


function openSplitsDialog() {
  if (currentWafers.length === 0) return;
  showSplitsModal(currentWafers, {
    onSave: (csv) => platform.saveTextFile(csv, 'wafer-splits.csv'),
    onLoad: () => platform.pickTextFile().then(f => f?.content ?? null),
    onLog: log,
    onAsk: (msg) => platform.confirm(msg),
    showSplitSuffix,
    onToggleSuffix: (show) => { showSplitSuffix = show; },
    onChange: () => {
      saveSplits(currentWafers);
      clearLotStatsCache();
      const label = currentFileName;
      setBusy(`Rendering ${label}…`);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        renderWaferView(currentWafers, label);
        setIdle(`${label} — ${currentWafers.length} wafer${currentWafers.length !== 1 ? 's' : ''}, ${currentWafers.reduce((n, w) => n + w.results.length, 0)} dies`);
      }));
    },
  });
}

splitsBtn.addEventListener('click', openSplitsDialog);


let closeHelpMenu: (() => void) | null = null;

/**
 * A single Help entry point with two destinations: tsmap's own guide (always
 * available) and wmap's built-in wafer-map reference (only reachable once a
 * map/gallery is rendered, via mainViewController.openUserGuide() — wmap's
 * own help button is disabled entirely (showHelpButton: false) since this
 * menu is now the only entry point; see WMAP_ISSUES.md #32, resolved in wmap
 * v0.18.1+ by exporting openUserGuide() on both controllers). Mirrors
 * openRecentMenu's anchored-popup pattern.
 */
function openHelpMenu(anchor: HTMLElement) {
  if (closeHelpMenu) { closeHelpMenu(); return; }

  const popup = document.createElement('div');
  popup.style.cssText = [
    'position:fixed', 'z-index:var(--z-tooltip)',
    'background:var(--bg-overlay)', 'color:var(--text-secondary)',
    'border:1px solid var(--border-mid)', 'border-radius:6px',
    'box-shadow:0 6px 20px rgba(0,0,0,0.35)',
    'padding:6px', 'min-width:200px',
    'font-size:13px', 'font-family:system-ui,sans-serif',
    'display:flex', 'flex-direction:column', 'gap:2px',
  ].join(';');

  const makeRow = (label: string, hint: string, enabled: boolean, onClick: () => void) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.textContent = label;
    row.disabled = !enabled;
    row.style.cssText = 'text-align:left;background:none;border:none;border-radius:4px;' +
      `padding:6px 10px;font-size:13px;color:${enabled ? 'var(--text-secondary)' : 'var(--text-veryfaint)'};` +
      `cursor:${enabled ? 'pointer' : 'default'};`;
    if (enabled) {
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover-row)'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'none'; });
      row.addEventListener('click', () => { close(); onClick(); });
    }
    attachTooltip(row, hint);
    popup.appendChild(row);
  };

  makeRow('tsmap guide', 'File loading, mapping, splits, test selector, and more', true, () => platform.openGuide());

  makeRow(
    'Wafer map reference',
    mainViewController ? 'Wafer map/gallery controls, Analysis tab panels, and more (wmap’s own guide)' : 'Load a file first to access the wafer map reference',
    !!mainViewController,
    () => mainViewController?.openUserGuide(),
  );

  document.body.appendChild(popup);
  const r = anchor.getBoundingClientRect();
  const margin = 8;
  popup.style.top = `${r.bottom + 4}px`;
  popup.style.left = `${r.left}px`;
  requestAnimationFrame(() => {
    const pw = popup.offsetWidth;
    let left = r.left;
    if (left + pw + margin > window.innerWidth) left = window.innerWidth - pw - margin;
    popup.style.left = `${Math.max(margin, left)}px`;
  });

  function onOutside(e: PointerEvent) {
    const t = e.target as Node;
    if (!popup.contains(t) && !anchor.contains(t)) close();
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }

  function close() {
    popup.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    closeHelpMenu = null;
  }
  closeHelpMenu = close;

  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
}

helpBtn.addEventListener('click', () => openHelpMenu(helpBtn));

// Replace the native `title` tooltips on tsmap's top-toolbar chrome with the
// themed, instant tooltip (see tooltip.ts) so they match the wmap map toolbar
// rather than the OS's slow black hint. Static-text buttons are upgraded from
// their existing `title` markup; the log toggle has runtime-varying text so
// it's wired with a getter instead. Run at the end of module init: the getter
// reads state (logPanel) that is declared above, so wiring earlier would hit
// a temporal-dead-zone ReferenceError and abort the module — killing every
// button handler registered after it.
upgradeTitleTooltips(document.getElementById('toolbar') ?? document);
attachTooltip(valueFindingsBtn, 'Add regional test-value findings to the summary panel (slower on large lots)');
attachTooltip(logToggle, logToggleTip);

// ── Theme picker ──────────────────────────────────────────────────────────
// Apply the persisted theme, add the toolbar dropdown, and re-render the
// current view on change so the wmap canvas re-resolves its colours (canvas
// colours are read from CSS at draw time, not live-bound — a CSS var flip alone
// won't repaint the wafer). Empty state is pure CSS and needs no re-render.
initTheme();

function refreshCurrentView(): void {
  if (currentWafers.length === 0) return; // empty state: CSS-only, nothing to redraw
  renderWaferView(currentWafers, currentFileName);
}

// Grouped theme picker. Uses the custom menuSelect (not a native <select>):
// with 8 themes it sits top-right where the native GTK popup clips off-screen
// on the Linux WebView, and that popup ignores the theme's color-scheme. The
// custom menu flips/scrolls to fit and is fully themed. See menuSelect.ts.
const themeSelect = makeMenuSelect(
  THEME_GROUPS.map(g => ({ group: g.group, options: g.themes.map(t => ({ value: t.value, label: t.label })) })),
  getTheme(),
  v => setTheme(v as Theme),
  { ariaLabel: 'Colour theme' },
);
themeSelect.id = 'theme-select';
attachTooltip(themeSelect, 'Colour theme (Auto follows your system)');
// Pin the theme picker + help button to the right end of the toolbar: the theme
// picker carries `margin-left:auto` so it starts the right-aligned group.
themeSelect.style.marginLeft = 'auto';
helpBtn.style.marginLeft = '';
helpBtn.before(themeSelect);

onThemeChange(refreshCurrentView);

showEmptyState();
