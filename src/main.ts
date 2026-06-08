import { buildWaferMap } from '@paulrobins/wafermap';
import type { PlotMode } from '@paulrobins/wafermap';
import { renderWaferMap, renderWaferGallery } from '@paulrobins/wafermap/render';
import { analyzeWaferMap, analyzeWaferLot, setReportOpener } from '@paulrobins/wafermap/stats';
import type { LotStatsSummary } from '@paulrobins/wafermap/stats';
import { createPlatform, isTauri } from './platform';
import type { FileHandle, RustParsedFile } from './platform';
import { showMappingOverlay } from './mappingUI';
import { showRenameOverlay, showAppendConfirm } from './multiFileUI';
import type { CsvMapping } from './mappingUI';
import type { FileWaferEntry, RenamedWafer } from './multiFileUI';
import type { ParsedFile, WaferData, TestDef } from './types';
import { renderChartGrid, renderBoxplotPanel, renderHistogramPanel, disconnectAllObservers } from './charts/render';
import type { ChartPanel } from './charts/render';
import { buildYieldData, buildBinParetoData, buildTestBoxplotData, buildTestHistogramData, listNumericTests } from './charts/aggregate';
import type { BinType, ChartDatum, YieldSortBy } from './charts/types';
import { getColorScheme, listColorSchemes } from '@paulrobins/wafermap/renderer';
import type { TestDef as WmapTestDef } from '@paulrobins/wafermap';

const platform = createPlatform();

// ── Utilities ─────────────────────────────────────────────────────────────────

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

// ── Rust command return shape ─────────────────────────────────────────────────

function rustToLocal(r: RustParsedFile, fileName: string): ParsedFile {
  return { fileName, meta: r.meta, wafers: r.wafers, testDefs: r.testDefs };
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const container  = document.getElementById('map-container')!;
const openBtn    = document.getElementById('open-btn')!;
const addBtn     = document.getElementById('add-btn') as HTMLButtonElement;
const chartsBtn  = document.getElementById('charts-btn') as HTMLButtonElement;
const resetBtn   = document.getElementById('reset-btn') as HTMLButtonElement;
const helpBtn    = document.getElementById('help-btn') as HTMLButtonElement;
const fileLabel  = document.getElementById('file-label')!;
const busySpinner = document.getElementById('busy-spinner')!;
const logList    = document.getElementById('log-list')!;
const logToggle  = document.getElementById('log-toggle')!;
const logPanel   = document.getElementById('log-panel')!;

// ── State ─────────────────────────────────────────────────────────────────────

let currentWafers: WaferData[] = [];
let currentFileName = 'wafermap';
let currentTestDefs: Record<string, TestDef> = {};

// ── Chart mode state ──────────────────────────────────────────────────────────

type ViewMode = 'map' | 'charts';

let viewMode: ViewMode = 'map';
let yieldSortBy: YieldSortBy = 'yield';
let binType: BinType = 'hbin';
let chartColorScheme = 'default';
let selectedTestNumber: number | null = null;
let boxplotLogScale = false;
let histogramWaferIndex: number | null = null;

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

logToggle.addEventListener('click', () => logPanel.classList.toggle('open'));

// ── Platform intercepts ───────────────────────────────────────────────────────

if (isTauri) {
  // PNG save — wmap uses a detached <a download> never in the DOM; intercept in Tauri
  // because window.open and native download are suppressed in WebKitGTK / WebView2.
  const _nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download && this.href.startsWith('blob:')) {
      const href = this.href;
      const stem = currentFileName.replace(/\.[^.]+$/, '');
      fetch(href)
        .then(r => r.blob())
        .then(blob => platform.savePng(blob, stem))
        .then(() => log('info', `PNG saved: ${stem}.png`))
        .catch(err => log('error', `PNG save failed: ${err}`));
      return;
    }
    _nativeClick.call(this);
  };

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

/** Convert tsmap's `Record<string, TestDef>` (loLimit/hiLimit/units) to wmap's `TestDef[]` (limitLow/limitHigh/unit). */
function toWmapTestDefs(testDefs: Record<string, TestDef>): WmapTestDef[] {
  return Object.entries(testDefs).map(([key, def]) => ({
    testNumber: Number(key),
    name: def.name,
    unit: def.units,
    limitLow: def.loLimit,
    limitHigh: def.hiLimit,
  }));
}

function buildLotStatsSummary(wafers: WaferData[]): { items: ReturnType<typeof buildWaferMap>[]; lotStatsSummary: LotStatsSummary } {
  const items = wafers.map(w => {
    const waferMap = buildWaferMap({ results: w.results });
    const statsSummary = analyzeWaferMap(waferMap);
    return { ...waferMap, label: w.waferId, statsSummary };
  });
  const lotStatsSummary = analyzeWaferLot(items, { perWaferSummaries: items.map(i => i.statsSummary) });
  return { items, lotStatsSummary };
}

function renderWafers(wafers: WaferData[], label: string, testDefs: Record<string, TestDef> = {}) {
  currentWafers = wafers;
  currentFileName = label;
  currentTestDefs = testDefs;
  addBtn.disabled = wafers.length === 0;
  resetBtn.style.display = '';
  chartsBtn.style.display = wafers.length > 0 ? '' : 'none';
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

function autoPlotMode(wafers: WaferData[]): PlotMode {
  const sample = wafers[0]?.results ?? [];
  const hasHbin = sample.some(d => d.hbin !== undefined);
  const hasSbin = sample.some(d => d.sbin !== undefined);
  const hasValues = sample.some(d => d.testValues && Object.keys(d.testValues).length > 0);
  return hasHbin ? 'hardBin' : hasSbin ? 'softBin' : hasValues ? 'value' : 'hardBin';
}

function renderWaferView(wafers: WaferData[], label: string) {
  disconnectAllObservers();
  container.innerHTML = '';
  const stem = label.replace(/\.[^.]+$/, '');

  const plotMode = autoPlotMode(wafers);
  if (wafers.length === 1) {
    container.classList.remove('gallery', 'charts');
    const waferMap = buildWaferMap({ results: wafers[0].results });
    const statsSummary = analyzeWaferMap(waferMap);
    renderWaferMap(container, waferMap, {
      statsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
      downloadFilename: stem,
      viewOptions: { plotMode },
    });
  } else {
    container.classList.add('gallery');
    const { items, lotStatsSummary } = buildLotStatsSummary(wafers);
    renderWaferGallery(container, items, {
      lotStatsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
      downloadFilename: stem,
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
      downloadFilename: stem,
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
      downloadFilename: stem,
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
  const { lotStatsSummary } = buildLotStatsSummary(currentWafers);

  const yieldData = buildYieldData(currentWafers, lotStatsSummary, yieldSortBy);
  const binData = buildBinParetoData(currentWafers, binType);

  const testOptions = listNumericTests(currentTestDefs);
  if (selectedTestNumber === null || !testOptions.some(t => t.testNumber === selectedTestNumber)) {
    selectedTestNumber = testOptions[0]?.testNumber ?? null;
  }
  const selectedTest = testOptions.find(t => t.testNumber === selectedTestNumber);
  const boxplotData = selectedTestNumber !== null ? buildTestBoxplotData(currentWafers, selectedTestNumber) : [];

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
      controls: [
        makeSelect(
          [['hbin', 'Hard bins'], ['sbin', 'Soft bins']],
          binType,
          v => { binType = v as BinType; renderChartsView(); },
        ),
      ],
      barColor: datum => datum.binCode === undefined ? scheme.forValue(0) : binColorFn(datum.binCode),
    },
  ];

  const boxplotCard = renderBoxplotPanel({
    title: 'Test value distribution by wafer',
    testOptions,
    selectedTestNumber,
    unit: selectedTest?.unit,
    data: boxplotData,
    logScale: boxplotLogScale,
    colorScheme: chartColorScheme,
    onSelectTest: (testNumber) => { selectedTestNumber = testNumber; renderChartsView(); },
    onToggleLogScale: () => { boxplotLogScale = !boxplotLogScale; renderChartsView(); },
    onOpen: (waferIndex) => { if (selectedTestNumber !== null) openTestValueWafer(waferIndex, selectedTestNumber); },
  });

  if (histogramWaferIndex !== null && histogramWaferIndex >= currentWafers.length) histogramWaferIndex = null;
  const histogramWafers = histogramWaferIndex !== null ? [currentWafers[histogramWaferIndex]] : currentWafers;
  const histogramData = selectedTestNumber !== null ? buildTestHistogramData(histogramWafers, selectedTestNumber) : [];
  const histogramScope = histogramWaferIndex !== null ? currentWafers[histogramWaferIndex]?.waferId ?? `#${histogramWaferIndex}` : 'whole lot';
  const testDef = selectedTestNumber !== null ? currentTestDefs[String(selectedTestNumber)] : undefined;
  const histogramCard = renderHistogramPanel({
    title: selectedTest ? `${selectedTest.label} — value histogram (${histogramScope})` : 'Test value histogram',
    unit: selectedTest?.unit,
    buckets: histogramData,
    colorScheme: chartColorScheme,
    waferLabels: currentWafers.map(w => w.waferId),
    selectedWafer: histogramWaferIndex,
    onSelectWafer: (waferIndex) => { histogramWaferIndex = waferIndex; renderChartsView(); },
    limitLow: testDef?.loLimit,
    limitHigh: testDef?.hiLimit,
  });

  const colorSchemeLabel = document.createElement('span');
  colorSchemeLabel.textContent = 'Chart colour scheme:';
  colorSchemeLabel.style.cssText = 'color:var(--text-muted);font-size:12px;';
  const colorSchemeSelect = makeSelect(
    listColorSchemes().map(s => [s.name, s.label] as [string, string]),
    chartColorScheme,
    v => { chartColorScheme = v; renderChartsView(); },
  );

  renderChartGrid(container, [...panels, boxplotCard, histogramCard], {
    onOpen: (waferIndices, datum) => {
      if (waferIndices.length === 0) return;
      if (datum.binCode !== undefined) openStackedBin(currentWafers.map((_, i) => i), datum);
      else openSingleWafer(waferIndices);
    },
    onOpenSelection: (waferIndices, _data) => {
      if (waferIndices.length === 0) return;
      openSingleWafer(waferIndices);
    },
  }, [colorSchemeLabel, colorSchemeSelect]);

  setIdle(loadedMsg);
}


function showEmptyState() {
  currentWafers = [];
  currentTestDefs = {};
  addBtn.disabled = true;
  resetBtn.style.display = 'none';
  chartsBtn.style.display = 'none';
  chartsBtn.textContent = 'Charts';
  chartsBtn.classList.remove('active');
  viewMode = 'map';
  container.classList.remove('gallery', 'charts');
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                position:absolute;inset:0;gap:16px;color:#555;user-select:none;">
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="28" stroke="#3a3a3a" stroke-width="2"/>
        <circle cx="32" cy="32" r="18" stroke="#3a3a3a" stroke-width="1.5" stroke-dasharray="3 3"/>
        <circle cx="32" cy="32" r="8"  stroke="#3a3a3a" stroke-width="1.5"/>
        <line x1="32" y1="4"  x2="32" y2="10" stroke="#3a3a3a" stroke-width="2" stroke-linecap="round"/>
        <line x1="32" y1="54" x2="32" y2="60" stroke="#3a3a3a" stroke-width="2" stroke-linecap="round"/>
        <line x1="4"  y1="32" x2="10" y2="32" stroke="#3a3a3a" stroke-width="2" stroke-linecap="round"/>
        <line x1="54" y1="32" x2="60" y2="32" stroke="#3a3a3a" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <div style="font-size:15px;color:#666;">Open a file to get started</div>
      <div style="font-size:12px;color:#444;">Supports STDF, ATDF, CSV and JSON</div>
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

  // Parse all files
  const entries: FileWaferEntry[] = [];
  for (const file of files) {
    const fileExt = effectiveExt(file.name);
    setBusy(`Parsing ${file.name}…`);
    try {
      let parsed: ParsedFile;
      if (fileExt === 'stdf' || fileExt === 'std') {
        parsed = rustToLocal(await platform.parseStdf(file), file.name);
      } else if (fileExt === 'atdf' || fileExt === 'atd') {
        parsed = rustToLocal(await platform.parseAtdf(file), file.name);
      } else if (fileExt === 'json') {
        parsed = rustToLocal(await platform.parseJson(file, mapping!), file.name);
      } else {
        parsed = rustToLocal(await platform.parseCsv(file, mapping!), file.name);
      }
      entries.push({ filePath: file.path ?? file.name, fileName: file.name, parsed });
      log('info', `Parsed ${file.name}: ${parsed.wafers.length} wafer${parsed.wafers.length !== 1 ? 's' : ''}`);
    } catch (e) {
      log('error', `Failed to parse ${file.name}: ${(e as Error).message}`);
    }
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

helpBtn.addEventListener('click', () => {
  const modal = document.createElement('div');
  modal.className = 'tsmap-modal-backdrop';
  modal.innerHTML = `
    <div class="help-modal">
      <h2>tsmap help</h2>

      <h3>Opening files</h3>
      <p>Click <strong>Open file</strong> to pick one or more files, or drag and drop files
         anywhere in the window. Once a file is loaded, <strong>Add files</strong> appends
         additional wafers to the current gallery. <strong>Clear</strong> unloads the
         current map.</p>

      <h3>Supported formats</h3>
      <ul>
        <li><code>.stdf</code> / <code>.std</code> — STDF v4 binary. Handles multi-wafer lots,
            parametric (PTR) and functional (FTR) tests.</li>
        <li><code>.atdf</code> / <code>.atd</code> — ATDF ASCII. Same data as STDF in
            text form; pipe-delimited records.</li>
        <li><code>.csv</code> / <code>.txt</code> / <code>.dat</code> — Comma-separated.
            A column mapping step lets you assign roles to each column before rendering.</li>
        <li><code>.json</code> — JSON array of die objects, or nested wafer objects with a
            <code>results</code> array. Same mapping step as CSV.</li>
        <li><code>.gz</code> — Gzip-compressed version of any of the above (e.g.
            <code>lot.stdf.gz</code>). Decompressed in memory; no temp files.</li>
        <li><code>.zip</code> — Zip archive containing any supported files. All files are
            extracted and loaded as a batch; mixed formats within a single zip are supported.</li>
      </ul>

      <h3>Column mapping (CSV / JSON)</h3>
      <p>When you open a CSV or JSON file, a mapping overlay appears before the map renders.
         Assign a role to each column:</p>
      <ul>
        <li><strong>X / Y position</strong> — die grid coordinates (required).</li>
        <li><strong>Hard bin / Soft bin</strong> — bin number per die.</li>
        <li><strong>Wafer ID / Lot ID</strong> — groups dies into separate wafers.</li>
        <li><strong>Test value</strong> — numeric parametric result; give it a name in the
            Test name column.</li>
        <li><strong>Display info</strong> — metadata shown in tooltips. Check
            <em>Split gallery</em> to create a separate wafer per unique value of that column.</li>
        <li><strong>— ignore —</strong> — column is excluded from the render.</li>
      </ul>
      <p>Mappings are saved per file and restored automatically next time you open the same
         column layout.</p>

      <h3>Viewing maps</h3>
      <p>Scroll to zoom, drag to pan. The toolbar provides zoom controls, plot mode switching
         (hard bin / soft bin / test value), box selection, and PNG download. The summary
         panel on the right shows yield, bin counts, test statistics, and spatial findings.
         Click a finding to highlight the affected dies or wafers in the gallery.</p>

      <h3>Charts</h3>
      <p>Click <strong>Charts</strong> to switch from the map view to the charts panel.
         Available charts:</p>
      <ul>
        <li><strong>Yield by wafer</strong> — bar chart of pass yield per wafer, sortable
            by yield or wafer ID.</li>
        <li><strong>Bin pareto</strong> — failure count by hard or soft bin across the lot.</li>
        <li><strong>Test value distribution</strong> — box plot showing spread, median, and
            outliers per wafer for the selected parametric test.</li>
        <li><strong>Value histogram</strong> — distribution of a test value across the whole
            lot or a single wafer.</li>
      </ul>
      <p>Click a bar or box to jump to the corresponding wafer map. Click a stacked bin bar
         to open a lot-stacked map showing where that bin lands spatially.</p>

      <div class="help-close-row">
        <button class="btn-primary" id="help-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#help-close')!.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
});

showEmptyState();
