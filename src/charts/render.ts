import { getColorScheme } from '@paulrobins/wafermap/renderer';
import type { BoxplotDatum, ChartDatum, ChartKind, HistogramBucket, TestOption } from './types';

const activeObservers: ResizeObserver[] = [];

function trackObserver(ro: ResizeObserver): ResizeObserver {
  activeObservers.push(ro);
  return ro;
}

export function disconnectAllObservers() {
  for (const ro of activeObservers) ro.disconnect();
  activeObservers.length = 0;
}


export interface ChartPanel {
  kind: ChartKind;
  title: string;
  data: ChartDatum[];
  controls?: HTMLElement[];
  /** Per-bar color override — e.g. wmap's hardBinColor/softBinColor for bin panels. */
  barColor?: (datum: ChartDatum, index: number) => string;
  /** Override the trailing value annotation text. Default: "value (percent%)". */
  valueLabel?: (datum: ChartDatum) => string;
}

export interface RenderChartsOptions {
  /** Fired immediately on a plain click of a single bar — opens that bar's wafer(s). */
  onOpen: (waferIndices: number[], datum: ChartDatum) => void;
  /**
   * Fired when a multi-selection (built via shift/ctrl-click, then confirmed via the
   * "Open N selected" button) should be opened. Always called with 2+ bars' worth of data.
   */
  onOpenSelection: (waferIndices: number[], data: ChartDatum[]) => void;
}

const ROW_HEIGHT = 24;
const ROW_GAP = 5;
const LABEL_WIDTH = 110;
const VALUE_WIDTH = 100;
const PADDING = 12;
const MAX_VISIBLE_ROWS = 12;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? `${v}` : v.toFixed(2);
}

function renderPanel(panel: ChartPanel, options: RenderChartsOptions): HTMLElement {
  const { title, data, controls, barColor, valueLabel } = panel;

  const card = document.createElement('div');
  card.className = 'chart-card';
  card.style.cssText = `display:flex;flex-direction:column;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:6px;padding:12px;min-width:0;`;

  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.cssText = `color:${cssVar('--text-primary')};font-size:13px;font-weight:600;margin-bottom:6px;`;
  card.appendChild(heading);

  if (controls?.length) {
    const controlsRow = document.createElement('div');
    controlsRow.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;';
    for (const control of controls) controlsRow.appendChild(control);
    card.appendChild(controlsRow);
  }

  const hint = document.createElement('div');
  hint.textContent = 'Click a bar to open it · shift-click to select several';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:6px;`;
  card.appendChild(hint);

  const scrollArea = document.createElement('div');
  const visibleAreaHeight = PADDING * 2 + Math.min(data.length, MAX_VISIBLE_ROWS) * (ROW_HEIGHT + ROW_GAP);
  scrollArea.style.cssText = `overflow-y:auto;min-height:0;max-height:${visibleAreaHeight}px;`;
  card.appendChild(scrollArea);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;cursor:default;';
  scrollArea.appendChild(canvas);

  const selectionBar = document.createElement('div');
  selectionBar.style.cssText = 'display:none;align-items:center;gap:8px;margin-top:8px;';
  const selectionLabel = document.createElement('span');
  selectionLabel.style.cssText = `color:${cssVar('--text-secondary')};font-size:12px;`;
  const openSelectionBtn = document.createElement('button');
  openSelectionBtn.textContent = 'Open selected';
  openSelectionBtn.style.cssText = `font-size:12px;padding:3px 10px;border-radius:4px;border:1px solid ${cssVar('--accent')};background:none;color:${cssVar('--accent')};cursor:pointer;`;
  const clearSelectionBtn = document.createElement('button');
  clearSelectionBtn.textContent = 'Clear';
  clearSelectionBtn.style.cssText = `font-size:12px;padding:3px 10px;border-radius:4px;border:1px solid ${cssVar('--border-muted')};background:none;color:${cssVar('--text-muted')};cursor:pointer;`;
  selectionBar.append(selectionLabel, openSelectionBtn, clearSelectionBtn);
  card.appendChild(selectionBar);

  const selected = new Set<number>();
  let hovered = -1;
  const dpr = window.devicePixelRatio || 1;
  const maxValue = Math.max(1, ...data.map(d => d.value));

  const defaultBarColor = cssVar('--accent') || '#6af';
  const selectedColor = cssVar('--btn-primary-bg') || '#1a5aad';
  const trackColor = cssVar('--bg-input') || '#222';
  const textColor = cssVar('--text-secondary') || '#ccc';
  const hoverBg = cssVar('--bg-hover-row') || '#1d1d1d';

  function updateSelectionBar() {
    if (selected.size >= 2) {
      selectionBar.style.display = 'flex';
      selectionLabel.textContent = `${selected.size} selected`;
    } else {
      selectionBar.style.display = 'none';
    }
  }

  function rowRect(index: number) {
    const y = PADDING + index * (ROW_HEIGHT + ROW_GAP);
    const barX = PADDING + LABEL_WIDTH;
    const barMaxWidth = canvas.clientWidth - barX - VALUE_WIDTH - PADDING;
    return { y, barX, barMaxWidth: Math.max(10, barMaxWidth) };
  }

  function draw() {
    const width = card.clientWidth - 24;
    const height = PADDING * 2 + data.length * (ROW_HEIGHT + ROW_GAP);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    data.forEach((datum, i) => {
      const { y, barX, barMaxWidth } = rowRect(i);

      if (i === hovered) {
        ctx.fillStyle = hoverBg;
        ctx.fillRect(0, y - ROW_GAP / 2, width, ROW_HEIGHT + ROW_GAP);
      }

      ctx.fillStyle = textColor;
      ctx.textAlign = 'right';
      const label = datum.label.length > 16 ? `${datum.label.slice(0, 15)}…` : datum.label;
      ctx.fillText(label, PADDING + LABEL_WIDTH - 8, y + ROW_HEIGHT / 2);

      ctx.fillStyle = trackColor;
      ctx.fillRect(barX, y, barMaxWidth, ROW_HEIGHT);

      const barWidth = Math.max(1, (datum.value / maxValue) * barMaxWidth);
      ctx.fillStyle = barColor ? barColor(datum, i) : defaultBarColor;
      ctx.fillRect(barX, y, barWidth, ROW_HEIGHT);

      if (selected.has(i)) {
        ctx.strokeStyle = selectedColor;
        ctx.lineWidth = 2;
        ctx.strokeRect(barX + 1, y + 1, barWidth - 2, ROW_HEIGHT - 2);
      }

      ctx.fillStyle = textColor;
      ctx.textAlign = 'right';
      const valueText = valueLabel ? valueLabel(datum) : `${formatValue(datum.value)} (${datum.percent.toFixed(1)}%)`;
      ctx.fillText(valueText, barX + barMaxWidth + VALUE_WIDTH, y + ROW_HEIGHT / 2);
    });
  }

  function rowAt(offsetY: number): number {
    const index = Math.floor((offsetY - PADDING + ROW_GAP / 2) / (ROW_HEIGHT + ROW_GAP));
    return index >= 0 && index < data.length ? index : -1;
  }

  function waferIndicesFor(indices: Iterable<number>): number[] {
    return Array.from(new Set(Array.from(indices).flatMap(i => data[i].waferIndices))).sort((a, b) => a - b);
  }

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const row = rowAt(e.clientY - rect.top);
    if (row !== hovered) {
      hovered = row;
      canvas.style.cursor = row >= 0 ? 'pointer' : 'default';
      draw();
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (hovered !== -1) {
      hovered = -1;
      draw();
    }
  });

  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const row = rowAt(e.clientY - rect.top);
    if (row === -1) return;

    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (selected.has(row)) selected.delete(row);
      else selected.add(row);
      draw();
      updateSelectionBar();
      return;
    }

    if (selected.size > 0) {
      selected.clear();
      draw();
      updateSelectionBar();
    }
    options.onOpen(data[row].waferIndices, data[row]);
  });

  openSelectionBtn.addEventListener('click', () => {
    if (selected.size < 2) return;
    const indices = Array.from(selected);
    options.onOpenSelection(waferIndicesFor(indices), indices.map(i => data[i]));
  });

  clearSelectionBtn.addEventListener('click', () => {
    selected.clear();
    draw();
    updateSelectionBar();
  });

  const resizeObserver = trackObserver(new ResizeObserver(() => draw()));
  resizeObserver.observe(card);

  draw();
  return card;
}

const BOX_ROW_HEIGHT = 24;
const BOX_ROW_GAP = 5;
const BOX_LABEL_WIDTH = 110;
const BOX_MAX_VISIBLE_ROWS = 12;

export interface BoxplotPanelOptions {
  title: string;
  testOptions: TestOption[];
  selectedTestNumber: number | null;
  unit?: string;
  data: BoxplotDatum[];
  logScale: boolean;
  /** Name of a registered wmap colour scheme — drives the box fill via `forValue(normalizedMedian)`. */
  colorScheme: string;
  /** Lower/upper spec limits for the active test, drawn as vertical reference lines. */
  limitLow?: number;
  limitHigh?: number;
  onSelectTest: (testNumber: number) => void;
  onToggleLogScale: () => void;
  onOpen: (waferIndex: number) => void;
}

const AXIS_HEIGHT = 20;

function cardShell(title: string): { card: HTMLElement; controlsRow: HTMLElement; body: HTMLElement } {
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.style.cssText = `display:flex;flex-direction:column;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:6px;padding:12px;min-width:0;`;

  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.cssText = `color:${cssVar('--text-primary')};font-size:13px;font-weight:600;margin-bottom:6px;`;
  card.appendChild(heading);

  const controlsRow = document.createElement('div');
  controlsRow.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;';
  card.appendChild(controlsRow);

  const body = document.createElement('div');
  body.style.cssText = 'overflow-y:auto;min-height:0;';
  card.appendChild(body);

  return { card, controlsRow, body };
}

export function renderBoxplotPanel(options: BoxplotPanelOptions): HTMLElement {
  const { title, testOptions, selectedTestNumber, unit, data, logScale, colorScheme, limitLow, limitHigh, onSelectTest, onToggleLogScale, onOpen } = options;
  const { card, controlsRow, body } = cardShell(title);

  const select = document.createElement('select');
  select.style.cssText = 'font-size:12px;padding:2px 6px;background:var(--bg-input);color:var(--text-secondary);border:1px solid var(--border-mid);border-radius:4px;color-scheme:light dark;max-width:280px;';
  if (testOptions.length === 0) {
    select.disabled = true;
    const opt = document.createElement('option');
    opt.textContent = 'No parametric tests';
    select.appendChild(opt);
  } else {
    for (const t of testOptions) {
      const opt = document.createElement('option');
      opt.value = String(t.testNumber);
      opt.textContent = t.label;
      if (t.testNumber === selectedTestNumber) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => onSelectTest(Number(select.value)));
  }
  controlsRow.appendChild(select);

  const logLabel = document.createElement('label');
  logLabel.style.cssText = `display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${cssVar('--text-muted')};cursor:pointer;user-select:none;`;
  const logCheckbox = document.createElement('input');
  logCheckbox.type = 'checkbox';
  logCheckbox.checked = logScale;
  logCheckbox.style.cssText = 'margin:0;cursor:pointer;';
  logCheckbox.addEventListener('change', () => onToggleLogScale());
  logLabel.append(logCheckbox, document.createTextNode('Log scale'));
  controlsRow.appendChild(logLabel);

  const hint = document.createElement('div');
  hint.textContent = 'Click a wafer’s box to open it · box = Q1–Q3, line = median, whiskers = min/max';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:6px;`;
  card.insertBefore(hint, body);

  if (testOptions.length === 0 || data.every(d => d.count === 0)) {
    const empty = document.createElement('div');
    empty.textContent = 'No parametric test data available for box plots.';
    empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
    body.appendChild(empty);
    return card;
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;cursor:default;';
  body.appendChild(canvas);

  const visibleAreaHeight = PADDING * 2 + Math.min(data.length, BOX_MAX_VISIBLE_ROWS) * (BOX_ROW_HEIGHT + BOX_ROW_GAP) + AXIS_HEIGHT;
  body.style.maxHeight = `${visibleAreaHeight}px`;

  let hovered = -1;
  const dpr = window.devicePixelRatio || 1;

  const finite = data.filter(d => d.count > 0);
  const globalMin = Math.min(...finite.map(d => d.min));
  const globalMax = Math.max(...finite.map(d => d.max));
  const span = globalMax - globalMin || 1;

  // Log scale only makes sense when every value is strictly positive — fall back to linear otherwise (mirrors wmap's own logScale behaviour).
  const useLog = logScale && globalMin > 0;
  const logMin = useLog ? Math.log10(globalMin) : 0;
  const logMax = useLog ? Math.log10(globalMax) : 0;
  const logSpan = logMax - logMin || 1;

  const forValue = getColorScheme(colorScheme).forValue;
  const whiskerColor = cssVar('--text-muted') || '#888';
  const textColor = cssVar('--text-secondary') || '#ccc';
  const hoverBg = cssVar('--bg-hover-row') || '#1d1d1d';
  const medianColor = cssVar('--text-primary') || '#fff';
  const axisColor = cssVar('--border-mid') || '#444';

  function plotRect() {
    const plotX = PADDING + BOX_LABEL_WIDTH;
    const plotMaxWidth = canvas.clientWidth - plotX - VALUE_WIDTH - PADDING;
    return { plotX, plotMaxWidth: Math.max(10, plotMaxWidth) };
  }

  function xFor(value: number, plotX: number, plotMaxWidth: number): number {
    if (useLog) {
      return plotX + ((Math.log10(value) - logMin) / logSpan) * plotMaxWidth;
    }
    return plotX + ((value - globalMin) / span) * plotMaxWidth;
  }

  const AXIS_TICKS = 4;
  function axisTickValues(): number[] {
    const ticks: number[] = [];
    for (let i = 0; i <= AXIS_TICKS; i++) {
      ticks.push(useLog ? Math.pow(10, logMin + (logSpan * i) / AXIS_TICKS) : globalMin + (span * i) / AXIS_TICKS);
    }
    return ticks;
  }

  function draw() {
    const width = card.clientWidth - 24;
    const height = PADDING * 2 + data.length * (BOX_ROW_HEIGHT + BOX_ROW_GAP) + AXIS_HEIGHT;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    const { plotX, plotMaxWidth } = plotRect();

    data.forEach((datum, i) => {
      const y = PADDING + i * (BOX_ROW_HEIGHT + BOX_ROW_GAP);
      const midY = y + BOX_ROW_HEIGHT / 2;

      if (i === hovered) {
        ctx.fillStyle = hoverBg;
        ctx.fillRect(0, y - BOX_ROW_GAP / 2, width, BOX_ROW_HEIGHT + BOX_ROW_GAP);
      }

      ctx.fillStyle = textColor;
      ctx.textAlign = 'right';
      const label = datum.label.length > 16 ? `${datum.label.slice(0, 15)}…` : datum.label;
      ctx.fillText(label, PADDING + BOX_LABEL_WIDTH - 8, midY);

      if (datum.count === 0) {
        ctx.fillStyle = textColor;
        ctx.textAlign = 'left';
        ctx.fillText('no data', plotX, midY);
        return;
      }

      const xMin = xFor(datum.min, plotX, plotMaxWidth);
      const xQ1 = xFor(datum.q1, plotX, plotMaxWidth);
      const xMedian = xFor(datum.median, plotX, plotMaxWidth);
      const xQ3 = xFor(datum.q3, plotX, plotMaxWidth);
      const xMax = xFor(datum.max, plotX, plotMaxWidth);
      const boxTop = y + 3;
      const boxBottom = y + BOX_ROW_HEIGHT - 3;

      ctx.strokeStyle = whiskerColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xMin, midY); ctx.lineTo(xQ1, midY);
      ctx.moveTo(xQ3, midY); ctx.lineTo(xMax, midY);
      ctx.moveTo(xMin, boxTop); ctx.lineTo(xMin, boxBottom);
      ctx.moveTo(xMax, boxTop); ctx.lineTo(xMax, boxBottom);
      ctx.stroke();

      const normalizedMedian = useLog
        ? (Math.log10(datum.median) - logMin) / logSpan
        : (datum.median - globalMin) / span;
      const boxColor = forValue(Math.max(0, Math.min(1, normalizedMedian)));

      ctx.fillStyle = boxColor;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(xQ1, boxTop, Math.max(1, xQ3 - xQ1), boxBottom - boxTop);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = boxColor;
      ctx.strokeRect(xQ1, boxTop, Math.max(1, xQ3 - xQ1), boxBottom - boxTop);

      ctx.strokeStyle = medianColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xMedian, boxTop);
      ctx.lineTo(xMedian, boxBottom);
      ctx.stroke();
      ctx.lineWidth = 1;

      ctx.fillStyle = textColor;
      ctx.textAlign = 'left';
      const valueText = `med ${formatValue(datum.median)}${unit ? ` ${unit}` : ''}`;
      ctx.fillText(valueText, plotX + plotMaxWidth + 10, midY);
    });

    const axisY = PADDING + data.length * (BOX_ROW_HEIGHT + BOX_ROW_GAP);

    ctx.font = '10px system-ui, sans-serif';
    for (const [limit, limLabel] of [[limitLow, 'LSL'], [limitHigh, 'USL']] as const) {
      if (limit === undefined || limit < globalMin || limit > globalMax) continue;
      const x = xFor(limit, plotX, plotMaxWidth);
      ctx.strokeStyle = textColor;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, axisY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(limLabel, x, axisY - 1);
    }
    ctx.font = '11px system-ui, sans-serif';

    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, axisY);
    ctx.lineTo(plotX + plotMaxWidth, axisY);
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const tick of axisTickValues()) {
      const x = xFor(tick, plotX, plotMaxWidth);
      ctx.beginPath();
      ctx.moveTo(x, axisY);
      ctx.lineTo(x, axisY + 4);
      ctx.stroke();
      ctx.fillText(formatValue(tick), x, axisY + 6);
    }
    ctx.textBaseline = 'middle';
  }

  function rowAt(offsetY: number): number {
    const index = Math.floor((offsetY - PADDING + BOX_ROW_GAP / 2) / (BOX_ROW_HEIGHT + BOX_ROW_GAP));
    return index >= 0 && index < data.length ? index : -1;
  }

  card.style.position = 'relative';
  const tooltip = document.createElement('div');
  tooltip.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:50;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:4px;padding:4px 8px;font-size:11px;font-family:system-ui, sans-serif;color:${textColor};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
  card.appendChild(tooltip);

  function fmt(v: number): string {
    return `${formatValue(v)}${unit ? ` ${unit}` : ''}`;
  }

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const row = rowAt(e.clientY - rect.top);
    if (row !== hovered) {
      hovered = row;
      canvas.style.cursor = row >= 0 && data[row].count > 0 ? 'pointer' : 'default';
      draw();
    }
    if (row >= 0 && data[row].count > 0) {
      const d = data[row];
      const cardRect = card.getBoundingClientRect();
      tooltip.innerHTML = `<strong>${d.label}</strong> (${d.count} dies)<br>` +
        `max ${fmt(d.max)}<br>q3 ${fmt(d.q3)}<br>median ${fmt(d.median)}<br>q1 ${fmt(d.q1)}<br>min ${fmt(d.min)}`;
      tooltip.style.display = 'block';
      tooltip.style.left = `${e.clientX - cardRect.left + 14}px`;
      tooltip.style.top = `${e.clientY - cardRect.top + 14}px`;
    } else {
      tooltip.style.display = 'none';
    }
  });
  canvas.addEventListener('mouseleave', () => {
    if (hovered !== -1) { hovered = -1; draw(); }
    tooltip.style.display = 'none';
  });
  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const row = rowAt(e.clientY - rect.top);
    if (row === -1 || data[row].count === 0) return;
    onOpen(data[row].waferIndex);
  });

  const resizeObserver = trackObserver(new ResizeObserver(() => draw()));
  resizeObserver.observe(card);

  draw();
  return card;
}

const HIST_HEIGHT = 220;
const HIST_AXIS_HEIGHT = 32;
const HIST_TOP_MARGIN = 18;

export interface HistogramPanelOptions {
  title: string;
  unit?: string;
  buckets: HistogramBucket[];
  /** Name of a registered wmap colour scheme — drives bar fill via `forValue(normalizedRange)`. */
  colorScheme: string;
  /** Per-wafer labels, in wafer order — used to build the "show one wafer" selector. */
  waferLabels: string[];
  /** `null` shows the whole-lot histogram; an index restricts it to that wafer. */
  selectedWafer: number | null;
  onSelectWafer: (waferIndex: number | null) => void;
  /** Lower/upper spec limits for the active test, drawn as vertical reference lines. */
  limitLow?: number;
  limitHigh?: number;
}

const HISTOGRAM_LOT_VALUE = 'lot';

export function renderHistogramPanel(options: HistogramPanelOptions): HTMLElement {
  const { title, unit, buckets, colorScheme, waferLabels, selectedWafer, onSelectWafer, limitLow, limitHigh } = options;
  const { card, controlsRow, body } = cardShell(title);

  const waferSelect = document.createElement('select');
  waferSelect.style.cssText = 'font-size:12px;padding:2px 6px;background:var(--bg-input);color:var(--text-secondary);border:1px solid var(--border-mid);border-radius:4px;color-scheme:light dark;max-width:220px;';
  const lotOpt = document.createElement('option');
  lotOpt.value = HISTOGRAM_LOT_VALUE;
  lotOpt.textContent = 'All wafers (whole lot)';
  if (selectedWafer === null) lotOpt.selected = true;
  waferSelect.appendChild(lotOpt);
  waferLabels.forEach((label, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = label;
    if (selectedWafer === i) opt.selected = true;
    waferSelect.appendChild(opt);
  });
  waferSelect.addEventListener('change', () => {
    onSelectWafer(waferSelect.value === HISTOGRAM_LOT_VALUE ? null : Number(waferSelect.value));
  });
  controlsRow.appendChild(waferSelect);

  if (buckets.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No parametric test data available for a histogram.';
    empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
    body.appendChild(empty);
    return card;
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;cursor:default;';
  body.appendChild(canvas);

  let hovered = -1;
  const dpr = window.devicePixelRatio || 1;
  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  const forValue = getColorScheme(colorScheme).forValue;
  const bucketMin = buckets[0].rangeLow;
  const bucketSpan = buckets[buckets.length - 1].rangeHigh - bucketMin || 1;
  const textColor = cssVar('--text-secondary') || '#ccc';
  const hoverColor = cssVar('--text-primary') || '#fff';
  const axisColor = cssVar('--border-mid') || '#444';

  function plotRect() {
    const plotX = PADDING + 36;
    const plotMaxWidth = canvas.clientWidth - plotX - PADDING;
    const plotMaxHeight = HIST_HEIGHT - HIST_AXIS_HEIGHT - HIST_TOP_MARGIN;
    return { plotX, plotMaxWidth: Math.max(10, plotMaxWidth), plotMaxHeight, plotTop: HIST_TOP_MARGIN };
  }

  function barAt(offsetX: number): number {
    const { plotX, plotMaxWidth } = plotRect();
    if (offsetX < plotX || offsetX > plotX + plotMaxWidth) return -1;
    const index = Math.floor(((offsetX - plotX) / plotMaxWidth) * buckets.length);
    return index >= 0 && index < buckets.length ? index : -1;
  }

  function draw() {
    const width = card.clientWidth - 24;
    const height = HIST_HEIGHT;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px system-ui, sans-serif';

    const { plotX, plotMaxWidth, plotMaxHeight, plotTop } = plotRect();
    const plotBottom = plotTop + plotMaxHeight;
    const barWidth = plotMaxWidth / buckets.length;

    buckets.forEach((bucket, i) => {
      const barHeight = (bucket.count / maxCount) * plotMaxHeight;
      const x = plotX + i * barWidth;
      const y = plotBottom - barHeight;
      const center = (bucket.rangeLow + bucket.rangeHigh) / 2;
      const barColor = forValue(Math.max(0, Math.min(1, (center - bucketMin) / bucketSpan)));

      ctx.fillStyle = i === hovered ? hoverColor : barColor;
      ctx.globalAlpha = i === hovered ? 1 : 0.7;
      ctx.fillRect(x + 1, y, Math.max(1, barWidth - 2), barHeight);
      ctx.globalAlpha = 1;

      if (i === hovered) {
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${bucket.count}`, x + barWidth / 2, y - 2);
      }
    });

    // Spec limit reference lines, drawn over the bars.
    const xForValue = (v: number) => plotX + ((v - bucketMin) / bucketSpan) * plotMaxWidth;
    ctx.font = '10px system-ui, sans-serif';
    for (const [limit, label] of [[limitLow, 'LSL'], [limitHigh, 'USL']] as const) {
      if (limit === undefined || limit < bucketMin || limit > bucketMin + bucketSpan) continue;
      const x = xForValue(limit);
      ctx.strokeStyle = textColor;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, x, plotTop - 2);
    }
    ctx.font = '11px system-ui, sans-serif';

    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, plotBottom);
    ctx.lineTo(plotX + plotMaxWidth, plotBottom);
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelStep = Math.max(1, Math.ceil(buckets.length / 8));
    for (let i = 0; i <= buckets.length; i += labelStep) {
      const value = i < buckets.length ? buckets[i].rangeLow : buckets[buckets.length - 1].rangeHigh;
      const x = plotX + i * barWidth;
      ctx.beginPath();
      ctx.moveTo(x, plotBottom);
      ctx.lineTo(x, plotBottom + 4);
      ctx.stroke();
      ctx.fillText(`${formatValue(value)}${unit ? ` ${unit}` : ''}`, x, plotBottom + 6);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = textColor;
    ctx.fillText(`max ${maxCount} dies/bucket${unit ? ` · ${unit}` : ''}`, plotX, 2);
  }

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const bar = barAt(e.clientX - rect.left);
    if (bar !== hovered) {
      hovered = bar;
      draw();
    }
  });
  canvas.addEventListener('mouseleave', () => {
    if (hovered !== -1) { hovered = -1; draw(); }
  });

  const resizeObserver = trackObserver(new ResizeObserver(() => draw()));
  resizeObserver.observe(card);

  draw();
  return card;
}

export function renderChartGrid(container: HTMLElement, cards: Array<ChartPanel | HTMLElement>, options: RenderChartsOptions, pageControls?: HTMLElement[]): void {
  container.innerHTML = '';

  if (pageControls?.length) {
    const toolbar = document.createElement('div');
    toolbar.style.cssText = `display:flex;align-items:center;gap:8px;padding:12px 16px 0;flex-wrap:wrap;`;
    for (const control of pageControls) toolbar.appendChild(control);
    container.appendChild(toolbar);
  }

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit, minmax(360px, 1fr));gap:16px;flex:1;min-height:0;overflow:auto;padding:16px;box-sizing:border-box;align-content:start;';

  for (const card of cards) {
    grid.appendChild(card instanceof HTMLElement ? card : renderPanel(card, options));
  }

  container.appendChild(grid);
}
