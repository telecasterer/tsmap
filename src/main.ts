declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

import { buildWaferMap } from '@paulrobins/wafermap';
import { renderWaferMap, renderWaferGallery } from '@paulrobins/wafermap/render';
import { analyzeWaferMap, analyzeWaferLot, setReportOpener } from '@paulrobins/wafermap/stats';
import type { LotStatsSummary } from '@paulrobins/wafermap/stats';
import { createPlatform, isTauri } from './platform';
import type { FileHandle, StdfTestNames, ScanResult } from './platform';
import { basename, rustToLocal, toWmapTestDefs, autoPlotMode, applyTestSelection, makeWaferSource, toWmapWaferMeta, toWaferData } from './lib';
import { showMappingOverlay } from './mappingUI';
import { showRenameOverlay, showAppendConfirm } from './multiFileUI';
import { showTestSelectorOverlay } from './testSelectorUI';
import { USER_GUIDE_HTML } from './userGuideHtml';
import type { CsvMapping } from './mappingUI';
import type { FileWaferEntry, RenamedWafer } from './multiFileUI';
import type { ParsedFile, WaferData, TestDef } from './types';
import { ICONS } from './charts/icons';
import { renderChartGrid, renderBoxplotPanel, renderHistogramPanel, renderCorrelationPanel, renderScatterPanel, renderBinClusterPanel, disconnectAllObservers } from './charts/render';
import type { ChartPanel } from './charts/render';
import { buildYieldData, buildYieldDataCombined, buildBinParetoData, buildBinClusterData, buildTestBoxplotData, buildTestBoxplotDataCombined, buildTestHistogramData, buildTestHistogramSeries, buildCorrelationMatrix, filterCorrelationMatrix, buildScatterData, buildScatterDataGrouped, listNumericTests } from './charts/aggregate';
import { buildFacetTable, facetValueOf, NONE_VALUE } from './metadata';
import type { BinType, ChartDatum, YieldSortBy } from './charts/types';
import { getColorScheme, listColorSchemes } from '@paulrobins/wafermap/renderer';


const platform = createPlatform();

// ── DOM refs ──────────────────────────────────────────────────────────────────

const container       = document.getElementById('map-container')!;
const openBtn         = document.getElementById('open-btn')!;
const addBtn          = document.getElementById('add-btn') as HTMLButtonElement;
const chartsBtn       = document.getElementById('charts-btn') as HTMLButtonElement;
const filterTestsBtn    = document.getElementById('filter-tests-btn') as HTMLButtonElement;
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


// ── Chart mode state ──────────────────────────────────────────────────────────

type ViewMode = 'map' | 'charts';

let viewMode: ViewMode = 'map';
let yieldSortBy: YieldSortBy = 'yield';
let binType: BinType = 'hbin';
let chartColorScheme = 'default';
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

/**
 * The "Value findings" toggle only feeds the summary panel, which is part of the
 * map view — it has no effect on the charts page. Disable (not hide) it in charts
 * view so the lack of effect is explicit rather than a mystery, restoring it on
 * the map. Call whenever `viewMode` changes.
 */
function syncValueFindingsBtn() {
  const inCharts = viewMode === 'charts';
  valueFindingsBtn.disabled = inCharts;
  valueFindingsBtn.style.opacity = inCharts ? '0.4' : '';
  valueFindingsBtn.style.cursor = inCharts ? 'default' : '';
  valueFindingsBtn.title = inCharts
    ? 'Value findings apply to the wafer map summary panel, not the charts page. Switch to Maps to use it.'
    : 'Toggle: adds regional test-value findings to the summary panel\'s Findings list — wafer areas (edge, quadrants, sites) that read unusually high or low on a test, or fail spec more there than elsewhere (e.g. "edge ring reads 8% high on VDD"). This is the only thing it changes: the panel\'s per-test stats, value maps, and the Charts page are unaffected, and regional yield/bin findings are always on. Slower on large lots, so off by default. Recomputes in place — no reload.';
}
// Faceting: which WaferSource field charts combine by ('' = none). Page-level
// control populated from buildFacetTable; a change re-renders the charts view.
// Selecting a field pools each group's dies into one aggregate series per group
// (combined yield bar, boxplot, histogram overlay, clustered pareto).
let chartGroupBy = '';
// Boxplot test selector (independent)
let selectedTestNumber: number | null = null;
let boxplotLogScale = false;
let boxplotAxisIncludesLimits = false;
let boxplotShowTrend = false;
// Histogram has its own test selector and wafer selector
let histogramTestNumber: number | null = null;
let histogramWaferIndex: number | null = null;
let histogramAxisIncludesLimits = false;
// Scatter has independent X and Y test selectors
let scatterXTest: number | null = null;
let scatterYTest: number | null = null;
// Correlation matrix — limit controls how many tests are shown (top N by mean |r|)
let correlationMatrixLimit = 25;

let cachedLotStats: ReturnType<typeof buildLotStatsSummary> | null = null;
const cachedBinData: Map<BinType, ReturnType<typeof buildBinParetoData>> = new Map();
// Keyed by `${testNumber}:${groupBy}` so faceting changes invalidate the entry.
const cachedBoxplotData: Map<string, ReturnType<typeof buildTestBoxplotData>> = new Map();
const cachedHistogramData: Map<string, ReturnType<typeof buildTestHistogramData>> = new Map();
const cachedHistogramSeries: Map<string, ReturnType<typeof buildTestHistogramSeries>> = new Map();
// Full N×N matrix cached once per file load; display matrix recomputed when limit changes.
let cachedCorrelationMatrix: ReturnType<typeof buildCorrelationMatrix> | null = null;
const cachedScatterData: Map<string, ReturnType<typeof buildScatterData>> = new Map();

/** Invalidate every memoised chart aggregate. Call whenever the loaded wafer set changes. */
function clearChartCaches() {
  cachedLotStats = null;
  cachedBinData.clear();
  cachedBoxplotData.clear();
  cachedHistogramData.clear();
  cachedHistogramSeries.clear();
  cachedCorrelationMatrix = null;
  cachedScatterData.clear();
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
  if (level === 'error') logPanel.classList.add('open');
  const errors = logList.querySelectorAll('.log-error').length;
  logToggle.textContent = errors > 0 ? `Log (${errors} error${errors > 1 ? 's' : ''})` : 'Log';
}

/** Surface any non-fatal parser advisories (e.g. fabricated soft bins) in the log. */
function logWarnings(parsed: ParsedFile) {
  for (const w of parsed.warnings ?? []) log('warn', `${parsed.fileName}: ${w}`);
}

logToggle.addEventListener('click', () => logPanel.classList.toggle('open'));

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

function makeHeavyChartPlaceholder(title: string, message: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'chart-card';
  const heading = document.createElement('div');
  heading.className = 'chart-card-title';
  heading.textContent = title;
  const body = document.createElement('div');
  body.style.cssText = 'padding:16px 0;color:var(--text-muted);font-size:12px;line-height:1.5;';
  body.textContent = message;
  card.appendChild(heading);
  card.appendChild(body);
  return card;
}

function buildLotStatsSummary(wafers: WaferData[]): { items: ReturnType<typeof buildWaferMap>[]; lotStatsSummary: LotStatsSummary } {
  const testDefs = toWmapTestDefs(currentTestDefs);
  const items = wafers.map(w => {
    const waferMap = buildWaferMap({ results: w.results, testDefs, waferConfig: { metadata: toWmapWaferMeta(w.source, w.waferId) } });
    for (const warning of waferMap.warnings) {
      const conf = warning.confidence !== undefined ? ` (confidence ${(warning.confidence * 100).toFixed(0)}%)` : '';
      log('warn', `Wafer ${w.waferId}: ${warning.message}${conf}`);
    }
    const statsSummary = analyzeWaferMap(waferMap, analyzeOpts());
    return { ...waferMap, label: w.waferId, statsSummary };
  });
  const perWaferSummaries = items.map(i => i.statsSummary);
  const lotStatsSummary = analyzeWaferLot(items, { perWaferSummaries, ...analyzeOpts() });
  return { items, lotStatsSummary };
}

function renderWafers(wafers: WaferData[], label: string, testDefs: Record<string, TestDef> = {}) {
  currentWafers = wafers;
  currentFileName = label;
  currentTestDefs = testDefs;
  clearChartCaches();
  addBtn.disabled = wafers.length === 0;
  resetBtn.style.display = '';
  chartsBtn.style.display = wafers.length > 0 ? '' : 'none';
  filterTestsBtn.style.display = Object.keys(currentTestDefs).length > 0 ? '' : 'none';
  // Value findings are only meaningful when there are test values. Reset
  // it off on every new load so a fresh (possibly large) lot starts on the fast path.
  const hasTestValues = wafers.some(w => w.results.some(d => d.testValues && Object.keys(d.testValues).length > 0));
  valueFindings = false;
  valueFindingsBtn.classList.remove('active');
  valueFindingsBtn.setAttribute('aria-checked', 'false');
  valueFindingsBtn.style.display = hasTestValues ? '' : 'none';
  chartsBtn.textContent = 'Charts';
  chartsBtn.classList.remove('active');
  viewMode = 'map';

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
  disconnectAllObservers();
  syncValueFindingsBtn();
  container.innerHTML = '';
  const stem = label.replace(/\.[^.]+$/, '');

  const plotMode = autoPlotMode(wafers);
  const wmapTestDefs = toWmapTestDefs(currentTestDefs);
  if (wafers.length === 1) {
    container.classList.remove('gallery', 'charts');
    const waferMap = buildWaferMap({ results: wafers[0].results, testDefs: wmapTestDefs, waferConfig: { metadata: toWmapWaferMeta(wafers[0].source, wafers[0].waferId) } });
    const statsSummary = analyzeWaferMap(waferMap, analyzeOpts());
    renderWaferMap(container, waferMap, {
      statsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
      showHelpButton: true,
      downloadFilename: stem,
      onSaveImage,
      viewOptions: { plotMode },
    });
  } else {
    container.classList.add('gallery');
    cachedLotStats ??= buildLotStatsSummary(wafers);
    const { items, lotStatsSummary } = cachedLotStats;
    renderWaferGallery(container, items, {
      lotStatsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
      showHelpButton: true,
      downloadFilename: stem,
      onSaveImage,
      viewOptions: { plotMode },
    });
  }
}

// ── Chart view ────────────────────────────────────────────────────────────────

function makeSelect(optionLabels: Array<[string, string]>, current: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = document.createElement('select');
  select.style.cssText = 'font-size:12px;padding:2px 6px;background:var(--bg-input);color:var(--text-secondary);border:1px solid var(--border-mid);border-radius:4px;color-scheme:light dark;';
  for (const [value, text] of optionLabels) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (value === current) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function openSingleWafer(waferIndices: number[]) {
  const filtered = waferIndices.map(i => currentWafers[i]);
  viewMode = 'map';
  chartsBtn.textContent = '← Back to charts';

  const label = filtered.length === 1
    ? `${currentFileName} — wafer ${filtered[0].waferId}`
    : `${currentFileName} — ${filtered.length} wafers: ${filtered.map(w => w.waferId).join(', ')}`;

  setBusy(`Rendering ${label}…`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    renderWaferView(filtered, currentFileName);
    if (filtered.length === 1) injectMapBanner(container, `Wafer ${filtered[0].waferId}`);
    setIdle(label);
  }));
}

function openStackedBin(waferIndices: number[], datum: ChartDatum) {
  if (datum.binCode === undefined) { openSingleWafer(waferIndices); return; }

  viewMode = 'map';
  syncValueFindingsBtn();
  chartsBtn.textContent = '← Back to charts';
  const stackedWafers = waferIndices.map(i => currentWafers[i].waferId).join(', ');
  const label = `${currentFileName} — stacked ${datum.label} across ${waferIndices.length} wafer${waferIndices.length !== 1 ? 's' : ''}: ${stackedWafers}`;

  setBusy(`Rendering ${label}…`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.innerHTML = '';
    container.classList.remove('gallery', 'charts');
    const stem = currentFileName.replace(/\.[^.]+$/, '');
    // Stack metadata is meaningful only when every stacked wafer shares one
    // source (same lot/program). Shared-by-reference makes that an identity check.
    const stackWafers = waferIndices.map(i => currentWafers[i]);
    const sharedSource = stackWafers.every(w => w.source === stackWafers[0].source) ? stackWafers[0].source : undefined;
    const waferMap = buildWaferMap({
      lotStack: {
        results: stackWafers.map(w => w.results),
        method: 'countBin',
        targetBin: datum.binCode,
      },
      waferConfig: { metadata: toWmapWaferMeta(sharedSource, `${stackWafers.length} wafers`) },
    });
    const statsSummary = analyzeWaferMap(waferMap, analyzeOpts());
    renderWaferMap(container, waferMap, {
      statsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
      showHelpButton: true,
      downloadFilename: stem,
      onSaveImage,
      viewOptions: { plotMode: 'value' },
    });
    setIdle(label);
  }));
}

function openTestValueWafer(waferIndex: number, testNumber: number) {
  const wafer = currentWafers[waferIndex];
  if (!wafer) return;

  viewMode = 'map';
  syncValueFindingsBtn();
  chartsBtn.textContent = '← Back to charts';
  const testDef = currentTestDefs[String(testNumber)];
  const testLabel = testDef?.name ? `${testDef.name} (#${testNumber})` : `test #${testNumber}`;
  const label = `${currentFileName} — wafer ${wafer.waferId} — ${testLabel} value map`;

  setBusy(`Rendering ${label}…`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.innerHTML = '';
    container.classList.remove('gallery', 'charts');
    const stem = currentFileName.replace(/\.[^.]+$/, '');
    const wmapTestDefs = toWmapTestDefs(currentTestDefs);
    const waferMap = buildWaferMap(
      { results: wafer.results, testDefs: wmapTestDefs, waferConfig: { metadata: toWmapWaferMeta(wafer.source, wafer.waferId) } },
      { plotMode: 'value', activeTest: testNumber, logScale: boxplotLogScale },
    );
    const statsSummary = analyzeWaferMap(waferMap, analyzeOpts());
    renderWaferMap(container, waferMap, {
      statsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
      showHelpButton: true,
      downloadFilename: stem,
      onSaveImage,
      viewOptions: { plotMode: 'value', activeTest: testNumber, logScale: boxplotLogScale },
    });
    injectMapBanner(container, `${wafer.waferId} — ${testLabel}`);
    setIdle(label);
  }));
}

function renderChartsView() {
  viewMode = 'charts';
  syncValueFindingsBtn();
  chartsBtn.textContent = 'Maps';
  chartsBtn.classList.add('active');
  container.classList.remove('gallery');
  container.classList.add('charts');

  const totalDies = currentWafers.reduce((n, w) => n + w.results.length, 0);
  const loadedMsg = `${currentFileName} — ${currentWafers.length} wafer${currentWafers.length !== 1 ? 's' : ''}, ${totalDies} dies`;

  // buildLotStatsSummary/renderChartGrid run synchronously and can take real
  // time on large lots — show the spinner and yield a tick so it actually
  // paints before the heavy work blocks the main thread.
  setBusy(`Building charts for ${loadedMsg}…`);
  requestAnimationFrame(() => requestAnimationFrame(() => { renderChartsViewWork(loadedMsg); }));
}

function renderChartsViewWork(loadedMsg: string) {
  disconnectAllObservers();
  cachedLotStats ??= buildLotStatsSummary(currentWafers);
  const { lotStatsSummary } = cachedLotStats;

  function makeHeaderLines(panelTitle: string, testName?: string): { title: string; subtitle: string } {
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const parts: string[] = [loadedMsg];
    if (testName) parts.push(testName);
    parts.push(ts);
    return { title: panelTitle, subtitle: parts.join(' · ') };
  }

  const testOptions = listNumericTests(currentTestDefs);
  const firstTest = testOptions[0]?.testNumber ?? null;

  // ── Faceting ─────────────────────────────────────────────────────────────────
  // The distinct-values table drives the "Group by" page control. Only splittable
  // fields (>1 distinct value) are offered. If the persisted choice is no longer
  // valid (different file loaded), drop it.
  const facetTable = buildFacetTable(currentWafers);
  const splittableFacets = facetTable.filter(f => f.splittable);
  if (chartGroupBy && !splittableFacets.some(f => f.key === chartGroupBy)) chartGroupBy = '';

  // Resolve the active group-by into a (wafer)=>key function, applying a top-K cap:
  // the K largest groups (by wafer count) keep their value; the rest fold into one
  // "… N more" bucket so a many-lot load can't explode the chart.
  const GROUP_TOP_K = 12;
  const activeFacet = chartGroupBy ? splittableFacets.find(f => f.key === chartGroupBy) : undefined;
  const topGroupValues = activeFacet ? new Set(activeFacet.values.slice(0, GROUP_TOP_K).map(v => v.value)) : null;
  const foldedGroupCount = activeFacet ? Math.max(0, activeFacet.values.length - GROUP_TOP_K) : 0;
  const groupBy = activeFacet
    ? (wafer: WaferData): string | undefined => {
        // Missing/empty values fold into the explicit `(none)` group (matching the
        // facet table) rather than being dropped from the grouped chart.
        const v = facetValueOf(wafer, activeFacet.key) ?? NONE_VALUE;
        return topGroupValues!.has(v) ? v : `… ${foldedGroupCount} more`;
      }
    : undefined;
  // A selected group field always means "combine by it" (one aggregate per group).
  const combined = !!groupBy;

  // Partition wafers into ordered groups (first-seen order), honouring the top-K
  // fold. Used by scatter (colour-by-group) and correlation (restrict-to-group),
  // where pooling across groups is misleading rather than a clean aggregate.
  function groupedWafers(): Array<{ key: string; wafers: WaferData[] }> {
    if (!groupBy) return [];
    const map = new Map<string, WaferData[]>();
    const order: string[] = [];
    for (const w of currentWafers) {
      const k = groupBy(w);
      if (k === undefined) continue;
      if (!map.has(k)) { map.set(k, []); order.push(k); }
      map.get(k)!.push(w);
    }
    return order.map(key => ({ key, wafers: map.get(key)! }));
  }

  // Each chart has its own independent test selection — default to first test.
  if (selectedTestNumber === null || !testOptions.some(t => t.testNumber === selectedTestNumber)) selectedTestNumber = firstTest;
  if (histogramTestNumber === null || !testOptions.some(t => t.testNumber === histogramTestNumber)) histogramTestNumber = firstTest;
  if (scatterXTest === null || !testOptions.some(t => t.testNumber === scatterXTest)) scatterXTest = firstTest;
  if (scatterYTest === null || !testOptions.some(t => t.testNumber === scatterYTest)) scatterYTest = testOptions[1]?.testNumber ?? firstTest;

  // ── Yield ──────────────────────────────────────────────────────────────────
  const makeYieldData = () => combined
    ? buildYieldDataCombined(currentWafers, lotStatsSummary, yieldSortBy, groupBy!)
    : buildYieldData(currentWafers, lotStatsSummary, yieldSortBy);
  const yieldData = makeYieldData();

  // ── Bin pareto ─────────────────────────────────────────────────────────────
  // Plain (ungrouped / per-wafer) pareto data. Combined mode uses a separate
  // clustered-bar card instead (built below), so this is the non-combined path.
  const makeBinData = () => {
    if (!cachedBinData.has(binType)) cachedBinData.set(binType, buildBinParetoData(currentWafers, binType));
    return cachedBinData.get(binType)!;
  };
  const binData = makeBinData();

  // ── Callbacks for self-contained panels ───────────────────────────────────
  function getBoxplotData(testNumber: number) {
    const key = `${testNumber}:${chartGroupBy}`;
    if (!cachedBoxplotData.has(key)) {
      const data = combined
        ? buildTestBoxplotDataCombined(currentWafers, testNumber, groupBy!)
        : buildTestBoxplotData(currentWafers, testNumber);
      cachedBoxplotData.set(key, data);
    }
    return cachedBoxplotData.get(key)!;
  }

  function getBoxplotTestMeta(testNumber: number) {
    const def = currentTestDefs[String(testNumber)];
    const opt = testOptions.find(t => t.testNumber === testNumber);
    return { unit: opt?.unit, limitLow: def?.loLimit, limitHigh: def?.hiLimit };
  }

  function getHistogramData(testNumber: number, waferIndex: number | null, axisIncludesLimits: boolean) {
    const key = `${testNumber}:${waferIndex}:${axisIncludesLimits}`;
    if (!cachedHistogramData.has(key)) {
      const wafers = waferIndex !== null ? [currentWafers[waferIndex]] : currentWafers;
      const def = currentTestDefs[String(testNumber)];
      const limitLow  = axisIncludesLimits ? def?.loLimit  : undefined;
      const limitHigh = axisIncludesLimits ? def?.hiLimit : undefined;
      cachedHistogramData.set(key, buildTestHistogramData(wafers, testNumber, 16, limitLow, limitHigh));
    }
    return cachedHistogramData.get(key)!;
  }

  function getHistogramSeries(testNumber: number, axisIncludesLimits: boolean) {
    const key = `${testNumber}:${axisIncludesLimits}:${chartGroupBy}`;
    if (!cachedHistogramSeries.has(key)) {
      const def = currentTestDefs[String(testNumber)];
      const limitLow  = axisIncludesLimits ? def?.loLimit  : undefined;
      const limitHigh = axisIncludesLimits ? def?.hiLimit : undefined;
      cachedHistogramSeries.set(key, buildTestHistogramSeries(currentWafers, testNumber, groupBy!, 16, limitLow, limitHigh));
    }
    return cachedHistogramSeries.get(key)!;
  }

  function getHistogramTestMeta(testNumber: number) {
    const def = currentTestDefs[String(testNumber)];
    const opt = testOptions.find(t => t.testNumber === testNumber);
    return { unit: opt?.unit, limitLow: def?.loLimit, limitHigh: def?.hiLimit };
  }

  function getScatterPoints(xTest: number, yTest: number) {
    // When a facet is active, tag points with their group (colour-by-group);
    // otherwise plain points coloured by hard bin. Cache key includes the facet.
    const key = `${xTest}:${yTest}:${chartGroupBy}`;
    if (!cachedScatterData.has(key)) {
      const data = combined
        ? buildScatterDataGrouped(currentWafers, xTest, yTest, groupBy!)
        : buildScatterData(currentWafers, xTest, yTest);
      cachedScatterData.set(key, data);
    }
    return cachedScatterData.get(key)!;
  }

  // Die count threshold above which per-die-per-test charts (correlation matrix, scatter)
  // are skipped — walking N tests × D dies for N up to 400 and D up to 250k is feasible,
  // but the in-memory parsed representation itself can be several GB at that scale.
  // 500k is a conservative ceiling; users hitting it should use test-selector filtering.
  const totalDies = currentWafers.reduce((s, w) => s + w.results.length, 0);
  const HEAVY_CHART_DIE_LIMIT = 500_000;
  const tooManyDies = totalDies > HEAVY_CHART_DIE_LIMIT;

  // ── Render ─────────────────────────────────────────────────────────────────
  const scheme = getColorScheme(chartColorScheme);
  const binColorFn = scheme.forBin;

  const yieldPanel: ChartPanel = {
    kind: 'yield',
    title: 'Yield by wafer',
    data: yieldData,
    selfControl: {
      current: yieldSortBy,
      options: [['yield', 'Sort: yield'], ['waferId', 'Sort: wafer ID']],
      onChange: v => {
        yieldSortBy = v as YieldSortBy;
        return { data: makeYieldData() };
      },
    },
    barColor: datum => scheme.forValue(Math.max(0, Math.min(100, datum.percent)) / 100),
    valueLabel: datum => `${datum.percent.toFixed(1)}%`,
  };

  // Bin pareto: combined mode uses a dedicated clustered-bar card (sub-bar per
  // group within each bin); otherwise the generic ungrouped pareto panel.
  const binParetoPanel: ChartPanel = {
    kind: 'binPareto',
    title: `${binType === 'hbin' ? 'Hard' : 'Soft'} bin pareto`,
    data: binData,
    selfControl: {
      current: binType,
      options: [['hbin', 'Hard bins'], ['sbin', 'Soft bins']],
      onChange: v => {
        binType = v as BinType;
        return {
          data: makeBinData(),
          title: `${binType === 'hbin' ? 'Hard' : 'Soft'} bin pareto`,
        };
      },
    },
    barColor: datum => datum.binCode === undefined ? scheme.forValue(0) : binColorFn(datum.binCode),
  };

  const binClusterCard = combined
    ? renderBinClusterPanel({
        title: `${binType === 'hbin' ? 'Hard' : 'Soft'} bin pareto`,
        binType,
        getData: (bt) => buildBinClusterData(currentWafers, bt, groupBy!),
        colorScheme: chartColorScheme,
        onToggleBinType: (bt) => { binType = bt; },
        onOpen: (waferIndices) => { if (waferIndices.length > 0) openSingleWafer(waferIndices); },
        savePng: onSaveImage,
        getHeaderLines: () => makeHeaderLines(`${binType === 'hbin' ? 'Hard' : 'Soft'} bin pareto`),
      })
    : null;

  const panels: ChartPanel[] = combined ? [yieldPanel] : [yieldPanel, binParetoPanel];

  const boxplotCard = renderBoxplotPanel({
    title: 'Test value distribution by wafer',
    testOptions,
    selectedTestNumber,
    getData: getBoxplotData,
    getTestMeta: getBoxplotTestMeta,
    logScale: boxplotLogScale,
    axisIncludesLimits: boxplotAxisIncludesLimits,
    showTrend: boxplotShowTrend,
    colorScheme: chartColorScheme,
    onStateChange: (n) => { selectedTestNumber = n; },
    onToggleLogScale: () => { boxplotLogScale = !boxplotLogScale; },
    onToggleAxisIncludesLimits: () => { boxplotAxisIncludesLimits = !boxplotAxisIncludesLimits; },
    onToggleShowTrend: () => { boxplotShowTrend = !boxplotShowTrend; },
    onOpen: (waferIndex) => { if (selectedTestNumber !== null) openTestValueWafer(waferIndex, selectedTestNumber); },
    savePng: onSaveImage,
    getHeaderLines: () => makeHeaderLines('Test value distribution by wafer', testOptions.find(t => t.testNumber === selectedTestNumber)?.label),
  });

  const histogramCard = renderHistogramPanel({
    title: 'Value histogram',
    testOptions,
    selectedTestNumber: histogramTestNumber,
    getData: getHistogramData,
    getSeriesData: combined ? getHistogramSeries : undefined,
    getTestMeta: getHistogramTestMeta,
    colorScheme: chartColorScheme,
    waferLabels: currentWafers.map(w => w.waferId),
    selectedWafer: histogramWaferIndex,
    axisIncludesLimits: histogramAxisIncludesLimits,
    onStateChange: (n, waferIndex) => { histogramTestNumber = n; histogramWaferIndex = waferIndex; },
    onToggleAxisIncludesLimits: () => { histogramAxisIncludesLimits = !histogramAxisIncludesLimits; },
    savePng: onSaveImage,
    getHeaderLines: () => makeHeaderLines('Value histogram', testOptions.find(t => t.testNumber === histogramTestNumber)?.label),
  });

  let correlationCard: HTMLElement;
  let scatterCard: HTMLElement;

  if (tooManyDies) {
    const msg = `Correlation matrix and scatter charts are unavailable for lots with more than ${HEAVY_CHART_DIE_LIMIT.toLocaleString()} dies (this lot has ${totalDies.toLocaleString()}). Use "Filter tests…" to reduce the dataset first.`;
    correlationCard = makeHeavyChartPlaceholder('Test correlation matrix', msg);
    scatterCard = makeHeavyChartPlaceholder('Test correlation', msg);
  } else {
    cachedCorrelationMatrix ??= buildCorrelationMatrix(currentWafers, testOptions);

    const scatterResult = renderScatterPanel({
      title: 'Test correlation',
      testOptions,
      xTestNumber: scatterXTest,
      yTestNumber: scatterYTest,
      getPoints: getScatterPoints,
      getTestMeta: getBoxplotTestMeta,
      colorScheme: chartColorScheme,
      groups: combined ? groupedWafers().map(g => g.key) : undefined,
      onStateChange: (x, y) => { scatterXTest = x; scatterYTest = y; },
      savePng: onSaveImage,
      getHeaderLines: () => {
        const xLabel = testOptions.find(t => t.testNumber === scatterXTest)?.label;
        const yLabel = testOptions.find(t => t.testNumber === scatterYTest)?.label;
        const testName = xLabel && yLabel ? `${xLabel} vs ${yLabel}` : (xLabel ?? yLabel);
        return makeHeaderLines('Test correlation', testName);
      },
    });
    scatterCard = scatterResult.card;

    // Per-group correlation matrices (built lazily, cached) — pooling across
    // groups would be misleading, so when grouping is active the matrix is
    // restricted to one group, chosen via the panel's group selector.
    const corrGroups = combined ? groupedWafers() : [];
    const corrGroupMatrices = new Map<string, ReturnType<typeof buildCorrelationMatrix>>();
    const matrixForGroup = (groupKey?: string) => {
      if (!groupKey) return (cachedCorrelationMatrix ??= buildCorrelationMatrix(currentWafers, testOptions));
      if (!corrGroupMatrices.has(groupKey)) {
        const g = corrGroups.find(x => x.key === groupKey);
        corrGroupMatrices.set(groupKey, buildCorrelationMatrix(g ? g.wafers : [], testOptions));
      }
      return corrGroupMatrices.get(groupKey)!;
    };

    correlationCard = renderCorrelationPanel({
      title: 'Test correlation matrix',
      groupKeys: corrGroups.map(g => g.key),
      filter: (maxTests, groupKey) => {
        const { matrix, ...summary } = filterCorrelationMatrix(matrixForGroup(groupKey), { minTests: 6, maxTests });
        return { matrix, summary };
      },
      initialLimit: correlationMatrixLimit,
      onLimitChange: (limit) => { correlationMatrixLimit = limit; },
      colorScheme: chartColorScheme,
      onSelectPair: (x, y) => { scatterXTest = x; scatterYTest = y; scatterResult.setXY(x, y); },
      savePng: onSaveImage,
      getHeaderLines: () => makeHeaderLines('Test correlation matrix'),
    });
  }

  const colorSchemeLabel = document.createElement('span');
  colorSchemeLabel.textContent = 'Chart colour scheme:';
  colorSchemeLabel.style.cssText = 'color:var(--text-muted);font-size:12px;';
  const colorSchemeSelect = makeSelect(
    listColorSchemes().map(s => [s.name, s.label] as [string, string]),
    chartColorScheme,
    v => { chartColorScheme = v; renderChartsView(); },
  );

  // "Group by" page control — populated from the splittable facets. Hidden
  // entirely when there is nothing to split on (single lot, no metadata).
  const groupByControls: HTMLElement[] = [];
  if (splittableFacets.length > 0) {
    const groupByLabel = document.createElement('span');
    groupByLabel.textContent = 'Group by:';
    groupByLabel.style.cssText = 'color:var(--text-muted);font-size:12px;';
    const groupBySelect = makeSelect(
      [['', 'None'], ...splittableFacets.map(f => [f.key, `${f.label} (${f.values.length})`] as [string, string])],
      chartGroupBy,
      v => { chartGroupBy = v; renderChartsView(); },
    );
    groupByControls.push(groupByLabel, groupBySelect);
  }

  const scrollTop = container.scrollTop;
  const binCard = binClusterCard ? [binClusterCard] : [];
  renderChartGrid(container, [...panels, ...binCard, boxplotCard, histogramCard, correlationCard, scatterCard], {
    onOpen: (waferIndices, datum) => {
      if (waferIndices.length === 0) return;
      if (datum.binCode !== undefined) openStackedBin(currentWafers.map((_, i) => i), datum);
      else openSingleWafer(waferIndices);
    },
    onOpenSelection: (waferIndices, _data) => {
      if (waferIndices.length === 0) return;
      openSingleWafer(waferIndices);
    },
    savePng: onSaveImage,
    getHeaderLines: (panelTitle) => makeHeaderLines(panelTitle),
  }, [colorSchemeLabel, colorSchemeSelect, ...groupByControls]);
  container.scrollTop = scrollTop;

  setIdle(loadedMsg);
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
  disconnectAllObservers();
  container.classList.remove('gallery', 'charts');
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
  clearChartCaches();
  addBtn.disabled = true;
  resetBtn.style.display = 'none';
  chartsBtn.style.display = 'none';
  filterTestsBtn.style.display = 'none';
  valueFindingsBtn.style.display = 'none';
  chartsBtn.textContent = 'Charts';
  chartsBtn.classList.remove('active');
  viewMode = 'map';
  container.classList.remove('gallery', 'charts');
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

/** Injects a small floating label at the top-left of the map container
 *  showing which wafer (and test) is currently displayed. Workaround for
 *  wmap lacking a label/title option on renderWaferMap — see WMAP_ISSUES.md. */
function injectMapBanner(container: HTMLElement, text: string) {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:absolute;top:8px;left:8px;z-index:10;' +
    'background:var(--bg-overlay);border:1px solid var(--border-subtle);' +
    'border-radius:4px;padding:3px 10px;font-size:12px;' +
    'color:var(--text-secondary);pointer-events:none;white-space:nowrap;' +
    'box-shadow:0 1px 4px rgba(0,0,0,0.3);';
  banner.textContent = text;
  container.appendChild(banner);
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
      log('warn', `Test name scan failed for ${file.name}: ${(e as Error).message}`);
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
      log('error', `Failed to parse ${file.name}: ${(e as Error).message}`);
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
        log('error', `Failed to parse ${file.name}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
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
    log('error', `File picker failed: ${(e as Error).message}`);
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
} else {
  // On web, trigger the native file input synchronously from the click event
  // so the browser treats it as a user gesture (async calls block the picker).
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  let appendOnPick = false;

  fileInput.addEventListener('change', async () => {
    const prevLabel = fileLabel.textContent ?? '';
    const rawFiles = Array.from(fileInput.files ?? []);
    fileInput.value = '';  // reset so same file can be re-picked
    if (rawFiles.length === 0) { setIdle(prevLabel); return; }
    busy = false;
    const files = await Promise.all(rawFiles.map(async f => ({
      name: f.name,
      bytes: new Uint8Array(await f.arrayBuffer()),
    })));
    handleFiles(files, appendOnPick);
  });

  openBtn.addEventListener('click', () => {
    if (busy) return;
    appendOnPick = false;
    setBusy('Waiting for file selection…');
    fileInput.click();
  });

  addBtn.addEventListener('click', () => {
    if (busy) return;
    appendOnPick = true;
    setBusy('Waiting for file selection…');
    fileInput.click();
  });
}

chartsBtn.addEventListener('click', () => {
  if (currentWafers.length < 1) return;
  if (viewMode === 'charts') {
    chartsBtn.classList.remove('active');
    chartsBtn.textContent = 'Charts';
    viewMode = 'map';
    const totalDies = currentWafers.reduce((n, w) => n + w.results.length, 0);
    const loadedMsg = `${currentFileName} — ${currentWafers.length} wafer${currentWafers.length !== 1 ? 's' : ''}, ${totalDies} dies`;
    setBusy(`Rendering ${loadedMsg}…`);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      renderWaferView(currentWafers, currentFileName);
      setIdle(loadedMsg);
    }));
  } else {
    renderChartsView();
  }
});

valueFindingsBtn.addEventListener('click', () => {
  // No-op in charts view (button is disabled there) — guard defensively anyway.
  if (busy || currentWafers.length === 0 || viewMode === 'charts') return;
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
  let carryNames = new Map<number, string>();
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
      log('error', `Failed to re-parse ${file.name}: ${(e as Error).message}`);
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


helpBtn.addEventListener('click', () => {
  const modal = document.createElement('div');
  modal.className = 'tsmap-modal-backdrop';
  const inner = document.createElement('div');
  inner.className = 'help-modal';
  inner.setAttribute('role', 'dialog');
  inner.setAttribute('aria-modal', 'true');
  inner.setAttribute('aria-label', 'Help');
  inner.tabIndex = -1;

  // Top header: title + fullscreen + close, matching the charts expand modal chrome.
  const header = document.createElement('div');
  header.className = 'help-header';
  const titleEl = document.createElement('span');
  titleEl.className = 'help-title';
  titleEl.textContent = 'User guide';

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.className = 'help-icon-btn';
  fullscreenBtn.innerHTML = ICONS.maximize;
  fullscreenBtn.title = 'Maximize (F)';
  fullscreenBtn.setAttribute('aria-label', 'Maximize');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'help-icon-btn';
  closeBtn.innerHTML = ICONS.close;
  closeBtn.title = 'Close (Esc)';
  closeBtn.setAttribute('aria-label', 'Close');
  header.append(titleEl, fullscreenBtn, closeBtn);

  const body = document.createElement('div');
  body.className = 'help-body';
  body.innerHTML = USER_GUIDE_HTML;

  inner.append(header, body);
  modal.appendChild(inner);
  document.body.appendChild(modal);
  inner.focus();

  const close = () => {
    document.removeEventListener('keydown', onKeyDown);
    modal.remove();
  };
  // CSS maximize — see the charts expand modal for why we avoid the real
  // Fullscreen API (WKWebView on macOS Tauri disables it without private API).
  const toggleFullscreen = () => {
    const maxed = inner.classList.toggle('maximized');
    fullscreenBtn.innerHTML = maxed ? ICONS.shrink : ICONS.maximize;
    fullscreenBtn.title = maxed ? 'Restore (F)' : 'Maximize (F)';
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    if ((e.key === 'f' || e.key === 'F')) toggleFullscreen();
  };
  document.addEventListener('keydown', onKeyDown);
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
});

showEmptyState();
