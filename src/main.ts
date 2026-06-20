declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

import { buildWaferMap } from '@paulrobins/wafermap';
import { renderWaferMap, renderWaferGallery } from '@paulrobins/wafermap/render';
import { analyzeWaferMap, analyzeWaferLot, setReportOpener } from '@paulrobins/wafermap/stats';
import type { LotStatsSummary } from '@paulrobins/wafermap/stats';
import { createPlatform, isTauri } from './platform';
import type { FileHandle, StdfTestNames, ScanResult } from './platform';
import { basename, rustToLocal, toWmapTestDefs, autoPlotMode, applyTestSelection } from './lib';
import { showMappingOverlay } from './mappingUI';
import { showRenameOverlay, showAppendConfirm } from './multiFileUI';
import { showTestSelectorOverlay } from './testSelectorUI';
import { USER_GUIDE_HTML } from './userGuideHtml';
import type { CsvMapping } from './mappingUI';
import type { FileWaferEntry, RenamedWafer } from './multiFileUI';
import type { ParsedFile, WaferData, TestDef } from './types';
import { renderChartGrid, renderBoxplotPanel, renderHistogramPanel, renderCorrelationPanel, renderScatterPanel, disconnectAllObservers } from './charts/render';
import type { ChartPanel } from './charts/render';
import { buildYieldData, buildBinParetoData, buildTestBoxplotData, buildTestHistogramData, buildCorrelationMatrix, filterCorrelationMatrix, buildScatterData, listNumericTests } from './charts/aggregate';
import type { BinType, ChartDatum, YieldSortBy } from './charts/types';
import { getColorScheme, listColorSchemes } from '@paulrobins/wafermap/renderer';


const platform = createPlatform();

// ── DOM refs ──────────────────────────────────────────────────────────────────

const container       = document.getElementById('map-container')!;
const openBtn         = document.getElementById('open-btn')!;
const addBtn          = document.getElementById('add-btn') as HTMLButtonElement;
const chartsBtn       = document.getElementById('charts-btn') as HTMLButtonElement;
const filterTestsBtn    = document.getElementById('filter-tests-btn') as HTMLButtonElement;
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


// ── Chart mode state ──────────────────────────────────────────────────────────

type ViewMode = 'map' | 'charts';

let viewMode: ViewMode = 'map';
let yieldSortBy: YieldSortBy = 'yield';
let binType: BinType = 'hbin';
let chartColorScheme = 'default';
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
const cachedBoxplotData: Map<number, ReturnType<typeof buildTestBoxplotData>> = new Map();
const cachedHistogramData: Map<string, ReturnType<typeof buildTestHistogramData>> = new Map();
// Full N×N matrix cached once per file load; display matrix recomputed when limit changes.
let cachedCorrelationMatrix: ReturnType<typeof buildCorrelationMatrix> | null = null;
const cachedScatterData: Map<string, ReturnType<typeof buildScatterData>> = new Map();

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
    const waferMap = buildWaferMap({ results: w.results, testDefs });
    for (const warning of waferMap.warnings) {
      const conf = warning.confidence !== undefined ? ` (confidence ${(warning.confidence * 100).toFixed(0)}%)` : '';
      log('warn', `Wafer ${w.waferId}: ${warning.message}${conf}`);
    }
    const statsSummary = analyzeWaferMap(waferMap);
    return { ...waferMap, label: w.waferId, statsSummary };
  });
  const perWaferSummaries = items.map(i => i.statsSummary);
  const lotStatsSummary = analyzeWaferLot(items, { perWaferSummaries });
  return { items, lotStatsSummary };
}

function renderWafers(wafers: WaferData[], label: string, testDefs: Record<string, TestDef> = {}) {
  currentWafers = wafers;
  currentFileName = label;
  currentTestDefs = testDefs;
  cachedLotStats = null;
  cachedBinData.clear();
  cachedBoxplotData.clear();
  cachedHistogramData.clear();
  cachedCorrelationMatrix = null;
  cachedScatterData.clear();
  addBtn.disabled = wafers.length === 0;
  resetBtn.style.display = '';
  chartsBtn.style.display = wafers.length > 0 ? '' : 'none';
  filterTestsBtn.style.display = Object.keys(currentTestDefs).length > 0 ? '' : 'none';
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
  container.innerHTML = '';
  const stem = label.replace(/\.[^.]+$/, '');

  const plotMode = autoPlotMode(wafers);
  const wmapTestDefs = toWmapTestDefs(currentTestDefs);
  if (wafers.length === 1) {
    container.classList.remove('gallery', 'charts');
    const waferMap = buildWaferMap({ results: wafers[0].results, testDefs: wmapTestDefs });
    const statsSummary = analyzeWaferMap(waferMap);
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
  chartsBtn.textContent = '← Back to charts';
  const stackedWafers = waferIndices.map(i => currentWafers[i].waferId).join(', ');
  const label = `${currentFileName} — stacked ${datum.label} across ${waferIndices.length} wafer${waferIndices.length !== 1 ? 's' : ''}: ${stackedWafers}`;

  setBusy(`Rendering ${label}…`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.innerHTML = '';
    container.classList.remove('gallery', 'charts');
    const stem = currentFileName.replace(/\.[^.]+$/, '');
    const waferMap = buildWaferMap({
      lotStack: {
        results: waferIndices.map(i => currentWafers[i].results),
        method: 'countBin',
        targetBin: datum.binCode,
      },
    });
    const statsSummary = analyzeWaferMap(waferMap);
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
      { results: wafer.results, testDefs: wmapTestDefs },
      { plotMode: 'value', activeTest: testNumber, logScale: boxplotLogScale },
    );
    const statsSummary = analyzeWaferMap(waferMap);
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

  // Each chart has its own independent test selection — default to first test.
  if (selectedTestNumber === null || !testOptions.some(t => t.testNumber === selectedTestNumber)) selectedTestNumber = firstTest;
  if (histogramTestNumber === null || !testOptions.some(t => t.testNumber === histogramTestNumber)) histogramTestNumber = firstTest;
  if (scatterXTest === null || !testOptions.some(t => t.testNumber === scatterXTest)) scatterXTest = firstTest;
  if (scatterYTest === null || !testOptions.some(t => t.testNumber === scatterYTest)) scatterYTest = testOptions[1]?.testNumber ?? firstTest;

  // ── Yield ──────────────────────────────────────────────────────────────────
  const yieldData = buildYieldData(currentWafers, lotStatsSummary, yieldSortBy);

  // ── Bin pareto ─────────────────────────────────────────────────────────────
  if (!cachedBinData.has(binType)) cachedBinData.set(binType, buildBinParetoData(currentWafers, binType));
  const binData = cachedBinData.get(binType)!;

  // ── Callbacks for self-contained panels ───────────────────────────────────
  function getBoxplotData(testNumber: number) {
    if (!cachedBoxplotData.has(testNumber)) {
      cachedBoxplotData.set(testNumber, buildTestBoxplotData(currentWafers, testNumber));
    }
    return cachedBoxplotData.get(testNumber)!;
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

  function getHistogramTestMeta(testNumber: number) {
    const def = currentTestDefs[String(testNumber)];
    const opt = testOptions.find(t => t.testNumber === testNumber);
    return { unit: opt?.unit, limitLow: def?.loLimit, limitHigh: def?.hiLimit };
  }

  function getScatterPoints(xTest: number, yTest: number) {
    const key = `${xTest}:${yTest}`;
    if (!cachedScatterData.has(key)) {
      cachedScatterData.set(key, buildScatterData(currentWafers, xTest, yTest));
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

  const panels: ChartPanel[] = [
    {
      kind: 'yield',
      title: 'Yield by wafer',
      data: yieldData,
      controls: [makeSelect(
        [['yield', 'Sort: yield'], ['waferId', 'Sort: wafer ID']],
        yieldSortBy,
        v => { yieldSortBy = v as YieldSortBy; renderChartsView(); },
      )],
      barColor: datum => scheme.forValue(Math.max(0, Math.min(100, datum.percent)) / 100),
      valueLabel: datum => `${datum.percent.toFixed(1)}%`,
    },
    {
      kind: 'binPareto',
      title: `${binType === 'hbin' ? 'Hard' : 'Soft'} bin pareto`,
      data: binData,
      controls: [makeSelect(
        [['hbin', 'Hard bins'], ['sbin', 'Soft bins']],
        binType,
        v => { binType = v as BinType; renderChartsView(); },
      )],
      barColor: datum => datum.binCode === undefined ? scheme.forValue(0) : binColorFn(datum.binCode),
    },
  ];

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
    const { matrix: trimmedMatrix, ...correlationSummary } = filterCorrelationMatrix(cachedCorrelationMatrix, {
      minTests: 6, maxTests: correlationMatrixLimit,
    });

    const scatterResult = renderScatterPanel({
      title: 'Test correlation',
      testOptions,
      xTestNumber: scatterXTest,
      yTestNumber: scatterYTest,
      getPoints: getScatterPoints,
      getTestMeta: getBoxplotTestMeta,
      colorScheme: chartColorScheme,
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

    correlationCard = renderCorrelationPanel({
      title: 'Test correlation matrix',
      matrix: trimmedMatrix,
      colorScheme: chartColorScheme,
      summary: correlationSummary,
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

  const matrixLimitLabel = document.createElement('label');
  matrixLimitLabel.textContent = 'Matrix size:';
  matrixLimitLabel.style.cssText = 'color:var(--text-muted);font-size:12px;display:flex;align-items:center;gap:4px;';
  const matrixLimitInput = document.createElement('input');
  matrixLimitInput.type = 'number';
  matrixLimitInput.min = '5';
  matrixLimitInput.max = '100';
  matrixLimitInput.value = String(correlationMatrixLimit);
  matrixLimitInput.style.cssText = 'width:52px;font-size:12px;padding:2px 4px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-mid);border-radius:3px;color-scheme:light dark;';
  matrixLimitInput.addEventListener('change', () => {
    const v = Math.max(5, Math.min(100, parseInt(matrixLimitInput.value, 10) || 25));
    matrixLimitInput.value = String(v);
    if (v !== correlationMatrixLimit) { correlationMatrixLimit = v; renderChartsView(); }
  });
  matrixLimitLabel.appendChild(matrixLimitInput);

  const scrollTop = container.scrollTop;
  renderChartGrid(container, [...panels, boxplotCard, histogramCard, correlationCard, scatterCard], {
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
  }, [colorSchemeLabel, colorSchemeSelect, matrixLimitLabel]);
  container.scrollTop = scrollTop;

  setIdle(loadedMsg);
}


function showEmptyState() {
  currentWafers = [];
  currentTestDefs = {};
  currentBinaryFiles = [];
  currentBinaryExt = '';
  currentTestNames = null;
  cachedLotStats = null;
  cachedBinData.clear();
  cachedBoxplotData.clear();
  cachedHistogramData.clear();
  cachedCorrelationMatrix = null;
  cachedScatterData.clear();
  addBtn.disabled = true;
  resetBtn.style.display = 'none';
  chartsBtn.style.display = 'none';
  filterTestsBtn.style.display = 'none';
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

    setBusy(`Scanning ${largestBinary.name} for tests…`);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      const scanResult: ScanResult = currentBinaryExt === 'atdf' || currentBinaryExt === 'atd'
        ? await platform.atdfTestNames(largestBinary)
        : await platform.stdfTestNames(largestBinary);
      currentTestNames = scanResult.testDefs;
      firstPassTestDefs = scanResult.testDefs;
      binaryScanDieCount = scanResult.dieCount * binaryFiles.length;
      log('info', `${largestBinary.name}: ${Object.keys(scanResult.testDefs).length} tests found, ${scanResult.dieCount.toLocaleString()} dies`);
    } catch (e) {
      log('warn', `Test name scan failed: ${(e as Error).message} — parsing all tests`);
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
    const allTestNums = new Set(Object.keys(firstPassTestDefs).map(Number));
    const initialSelection: number[] = [];
    let nameOverrides: Map<number, string> | undefined;

    // Compute capacity info for the memory advisory in the selector.
    const csvDieCount = Array.from(preParsed.values())
      .reduce((s, p) => s + p.wafers.reduce((ws, w) => ws + w.results.length, 0), 0);
    const totalDieCount = binaryScanDieCount + csvDieCount;

    testSelection = await new Promise<number[] | null>(resolve => {
      showTestSelectorOverlay(
        firstPassTestDefs!,
        (sel, names) => { overlayNameOverrides = names; resolve(sel); },
        () => resolve(null),
        {
          fromLargestFile: binaryFiles.length > 1,
          initialSelection,
          nameOverrides,
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
    if (testSelection === null) {
      setIdle();
      return;
    }
    log('info', `Test filter: ${testSelection.length} of ${allTestNums.size} tests selected`);
  }

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
    setIdle('Out of memory — reduce test selection and try again');
    return;
  }

  if (entries.length === 0) {
    setIdle('Error: no files parsed successfully');
    return;
  }

  // Rename step — always shown for multi-file, or single file with generic wafer ID
  const allWafers = entries.flatMap(e => e.parsed.wafers);
  const needsRename = entries.length > 1 || (allWafers.length === 1 && /^W\d+$/.test(allWafers[0].waferId));

  const getRenamed = (): Promise<RenamedWafer[] | null> => {
    if (!needsRename) {
      return Promise.resolve(allWafers.map(w => ({
        waferId: w.waferId,
        results: w.results,
        partCount: w.partCount,
        goodCount: w.goodCount,
        failCount: w.failCount,
      })));
    }
    return new Promise(resolve => {
      showRenameOverlay(entries,
        (renamed) => resolve(renamed),
        () => { setIdle(); resolve(null); }
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
          const merged = [
            ...currentWafers,
            ...renamed.map(r => ({ waferId: r.waferId, results: r.results, partCount: r.partCount, goodCount: r.goodCount, failCount: r.failCount })),
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
      renamed.map(r => ({ waferId: r.waferId, results: r.results, partCount: r.partCount, goodCount: r.goodCount, failCount: r.failCount })),
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
  const testSelection = await new Promise<number[] | null>(resolve => {
    showTestSelectorOverlay(
      selectorTestDefs,
      (sel, names) => { filterOverrideNames = names; resolve(sel); },
      () => resolve(null),
      {
        fromLargestFile: currentBinaryFiles.length > 1,
        initialSelection: Object.keys(currentTestDefs).map(Number),
        nameOverrides: new Map(),
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
  inner.innerHTML = USER_GUIDE_HTML;
  const closeRow = document.createElement('div');
  closeRow.className = 'help-close-row';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-primary';
  closeBtn.textContent = 'Close';
  closeRow.appendChild(closeBtn);
  inner.appendChild(closeRow);
  modal.appendChild(inner);
  document.body.appendChild(modal);
  inner.focus();
  const close = () => {
    document.removeEventListener('keydown', onKeyDown);
    modal.remove();
  };
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKeyDown);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
});

showEmptyState();
