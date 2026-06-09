import { getColorScheme } from '@paulrobins/wafermap/renderer';
import type { BoxplotDatum, ChartDatum, ChartKind, CorrelationMatrix, HistogramBucket, ScatterPoint, TestOption, TrendDatum } from './types';

const activeObservers: ResizeObserver[] = [];

function trackObserver(ro: ResizeObserver): ResizeObserver {
  activeObservers.push(ro);
  return ro;
}

export function disconnectAllObservers() {
  for (const ro of activeObservers) ro.disconnect();
  activeObservers.length = 0;
}

// ── Expand modal ──────────────────────────────────────────────────────────────

/**
 * Open a card in a fullscreen resizable modal. The card element is reparented
 * into the modal; closing it returns the card to its original position.
 */
function openExpandModal(card: HTMLElement, title: string) {
  // Guard: don't open a second modal if the card is already in one
  if (card.dataset.inModal === '1') return;
  card.dataset.inModal = '1';

  const savedOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  const backdrop = document.createElement('div');
  Object.assign(backdrop.style, {
    position: 'fixed', inset: '0',
    background: 'rgba(0,0,0,0.65)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: '200',
    backdropFilter: 'blur(3px)',
  });

  const box = document.createElement('div');
  Object.assign(box.style, {
    background: cssVar('--bg-overlay'),
    border: `1px solid ${cssVar('--border-subtle')}`,
    borderRadius: '10px',
    overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
    width: 'min(92vw, 1100px)', height: 'min(88vh, 800px)',
    boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
    resize: 'both', minWidth: '400px', minHeight: '300px',
    maxWidth: '100vw', maxHeight: '100vh',
    zIndex: '201',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex', alignItems: 'center', gap: '4px',
    padding: '10px 14px', flexShrink: '0',
    borderBottom: `1px solid ${cssVar('--border-subtle')}`,
  });
  const titleEl = document.createElement('span');
  titleEl.textContent = title;
  Object.assign(titleEl.style, { flex: '1', fontWeight: '600', fontSize: '13px', color: cssVar('--text-primary') });

  const modalBtnStyle: Partial<CSSStyleDeclaration> = {
    border: 'none', background: 'none', cursor: 'pointer',
    color: cssVar('--text-muted'), fontSize: '15px', padding: '0 4px', lineHeight: '1',
    display: 'flex', alignItems: 'center',
  };
  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.innerHTML = '&#x26F6;';
  fullscreenBtn.title = 'Fullscreen (F)';
  Object.assign(fullscreenBtn.style, modalBtnStyle);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close (Esc)';
  Object.assign(closeBtn.style, { ...modalBtnStyle, fontSize: '18px' });
  header.append(titleEl, fullscreenBtn, closeBtn);

  const originalParent = card.parentElement;
  const originalNext = card.nextSibling;

  // Strip the card's own border/radius while in modal — the modal box provides chrome.
  const savedCardStyle = card.getAttribute('style') ?? '';
  card.style.cssText = card.style.cssText
    .replace(/border:[^;]+;/g, '')
    .replace(/border-radius:[^;]+;/g, '');
  card.style.flex = '1';
  card.style.minHeight = '0';
  card.style.borderRadius = '0';
  card.style.border = 'none';

  box.append(header, card);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);

  function close() {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('fullscreenchange', onFsChange);
    delete card.dataset.inModal;
    document.body.style.overflow = savedOverflow;
    card.setAttribute('style', savedCardStyle);
    if (originalParent) {
      originalParent.insertBefore(card, originalNext);
    }
    backdrop.remove();
  }

  const onFsChange = () => {
    const isFs = document.fullscreenElement === box;
    fullscreenBtn.innerHTML = isFs ? '&#x2922;' : '&#x26F6;';
    fullscreenBtn.title = isFs ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
    closeBtn.style.display = isFs ? 'none' : '';
    if (isFs) {
      box.style.borderRadius = '0'; box.style.resize = 'none';
      box.style.width = '100%'; box.style.height = '100%';
    } else {
      box.style.borderRadius = '10px'; box.style.resize = 'both';
      box.style.width = 'min(92vw, 1100px)'; box.style.height = 'min(88vh, 800px)';
    }
  };
  document.addEventListener('fullscreenchange', onFsChange);

  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) box.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  });

  function onKeyDown(e: KeyboardEvent) {
    const active = document.activeElement;
    const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA');
    if (e.key === 'Escape' && !document.fullscreenElement) { close(); return; }
    if ((e.key === 'f' || e.key === 'F') && !inInput) {
      if (!document.fullscreenElement) box.requestFullscreen().catch(() => {});
      else document.exitFullscreen();
    }
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKeyDown);
}

// ── Shared utilities ──────────────────────────────────────────────────────────

export interface ChartPanel {
  kind: ChartKind;
  title: string;
  data: ChartDatum[];
  controls?: HTMLElement[];
  barColor?: (datum: ChartDatum, index: number) => string;
  valueLabel?: (datum: ChartDatum) => string;
}

export interface RenderChartsOptions {
  onOpen: (waferIndices: number[], datum: ChartDatum) => void;
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
  if (!Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? `${v}` : v.toFixed(2);
}

/** Draw a unit label once at the far end of an axis. */
function drawAxisUnit(ctx: CanvasRenderingContext2D, unit: string, x: number, y: number) {
  const prev = { textAlign: ctx.textAlign, textBaseline: ctx.textBaseline, fillStyle: ctx.fillStyle, font: ctx.font };
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = cssVar('--text-muted') || '#888';
  ctx.fillText(`(${unit})`, x, y);
  Object.assign(ctx, prev);
}

/** Trigger a PNG download of a canvas element. Uses a blob: URL so the Tauri download intercept fires. */
function saveCanvasPng(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, 'image/png');
}

function makeIconBtn(icon: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.title = title;
  btn.textContent = icon;
  Object.assign(btn.style, {
    border: 'none', background: 'none', cursor: 'pointer',
    color: cssVar('--text-muted'), fontSize: '14px', padding: '0 2px', lineHeight: '1',
    flexShrink: '0',
  });
  return btn;
}

function makeExpandBtn(card: HTMLElement, title: string): HTMLElement {
  const btn = makeIconBtn('⛶', 'Expand (E)');
  btn.addEventListener('click', e => { e.stopPropagation(); openExpandModal(card, title); });
  card.addEventListener('keydown', e => {
    if (e.key === 'e' || e.key === 'E') {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return;
      openExpandModal(card, title);
    }
  });
  return btn;
}

function cardShell(title: string): { card: HTMLElement; heading: HTMLElement; controlsRow: HTMLElement; body: HTMLElement; saveCanvas: (filename: string) => void } {
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.style.cssText = `display:flex;flex-direction:column;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:6px;padding:12px;min-width:0;`;

  const headingRow = document.createElement('div');
  headingRow.style.cssText = 'display:flex;align-items:center;margin-bottom:6px;';
  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.cssText = `color:${cssVar('--text-primary')};font-size:13px;font-weight:600;flex:1;`;
  headingRow.appendChild(heading);

  const saveBtn = makeIconBtn('⤓', 'Save as PNG');
  headingRow.appendChild(saveBtn);
  const expandBtn = makeExpandBtn(card, title);
  headingRow.appendChild(expandBtn);
  card.appendChild(headingRow);

  const controlsRow = document.createElement('div');
  controlsRow.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;align-items:center;';
  card.appendChild(controlsRow);

  const body = document.createElement('div');
  body.style.cssText = 'overflow-y:auto;min-height:0;flex:1;';
  card.appendChild(body);

  function saveCanvas(filename: string) {
    const canvas = card.querySelector<HTMLCanvasElement>('canvas');
    if (canvas) saveCanvasPng(canvas, filename);
  }

  saveBtn.addEventListener('click', e => { e.stopPropagation(); saveCanvas(`${title}.png`); });

  return { card, heading, controlsRow, body, saveCanvas };
}

// ── Bar chart panel ───────────────────────────────────────────────────────────

function renderPanel(panel: ChartPanel, options: RenderChartsOptions): HTMLElement {
  const { title, data, controls, barColor, valueLabel } = panel;
  const { card, controlsRow, body } = cardShell(title);

  if (controls?.length) {
    for (const control of controls) controlsRow.appendChild(control);
  }

  const hint = document.createElement('div');
  hint.textContent = 'Click a bar to open it · shift-click to select several';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:6px;`;
  card.insertBefore(hint, body);

  const scrollArea = document.createElement('div');
  const visibleAreaHeight = PADDING * 2 + Math.min(data.length, MAX_VISIBLE_ROWS) * (ROW_HEIGHT + ROW_GAP);
  scrollArea.style.cssText = `overflow-y:auto;min-height:0;max-height:${visibleAreaHeight}px;`;
  body.appendChild(scrollArea);

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
    if (row !== hovered) { hovered = row; canvas.style.cursor = row >= 0 ? 'pointer' : 'default'; draw(); }
  });
  canvas.addEventListener('mouseleave', () => { if (hovered !== -1) { hovered = -1; draw(); } });
  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const row = rowAt(e.clientY - rect.top);
    if (row === -1) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (selected.has(row)) selected.delete(row); else selected.add(row);
      draw(); updateSelectionBar(); return;
    }
    if (selected.size > 0) { selected.clear(); draw(); updateSelectionBar(); }
    options.onOpen(data[row].waferIndices, data[row]);
  });
  openSelectionBtn.addEventListener('click', () => {
    if (selected.size < 2) return;
    const indices = Array.from(selected);
    options.onOpenSelection(waferIndicesFor(indices), indices.map(i => data[i]));
  });
  clearSelectionBtn.addEventListener('click', () => { selected.clear(); draw(); updateSelectionBar(); });

  trackObserver(new ResizeObserver(() => draw())).observe(card);
  draw();
  return card;
}

// ── Boxplot panel ─────────────────────────────────────────────────────────────

const BOX_ROW_HEIGHT = 24;
const BOX_ROW_GAP = 5;
const BOX_LABEL_WIDTH = 110;
const BOX_MAX_VISIBLE_ROWS = 12;
const AXIS_HEIGHT = 20;

export interface BoxplotPanelOptions {
  title: string;
  testOptions: TestOption[];
  selectedTestNumber: number | null;
  getData: (testNumber: number) => BoxplotDatum[];
  getTestMeta: (testNumber: number) => { unit?: string; limitLow?: number; limitHigh?: number };
  logScale: boolean;
  colorScheme: string;
  onStateChange: (testNumber: number) => void;
  onToggleLogScale: () => void;
  onOpen: (waferIndex: number) => void;
}

export function renderBoxplotPanel(options: BoxplotPanelOptions): HTMLElement {
  const { title, testOptions, colorScheme, getData, getTestMeta, onStateChange, onToggleLogScale, onOpen } = options;
  const { card, controlsRow, body } = cardShell(title);

  let activeTest = options.selectedTestNumber ?? testOptions[0]?.testNumber ?? null;
  let logScale = options.logScale;

  const select = document.createElement('select');
  select.style.cssText = 'font-size:12px;padding:2px 6px;background:var(--bg-input);color:var(--text-secondary);border:1px solid var(--border-mid);border-radius:4px;color-scheme:light dark;max-width:240px;';
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
      if (t.testNumber === activeTest) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      activeTest = Number(select.value);
      onStateChange(activeTest);
      rebuildBody();
    });
  }
  controlsRow.appendChild(select);

  const logLabel = document.createElement('label');
  logLabel.style.cssText = `display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${cssVar('--text-muted')};cursor:pointer;user-select:none;`;
  const logCheckbox = document.createElement('input');
  logCheckbox.type = 'checkbox';
  logCheckbox.checked = logScale;
  logCheckbox.style.cssText = 'margin:0;cursor:pointer;';
  logCheckbox.addEventListener('change', () => {
    logScale = logCheckbox.checked;
    onToggleLogScale();
    rebuildBody();
  });
  logLabel.append(logCheckbox, document.createTextNode('Log scale'));
  controlsRow.appendChild(logLabel);

  const hint = document.createElement('div');
  hint.textContent = 'Click a wafer\'s box to open it · box = Q1–Q3, line = median, whiskers = min/max';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:6px;`;
  card.insertBefore(hint, body);

  function rebuildBody() {
    body.innerHTML = '';
    if (testOptions.length === 0 || activeTest === null) {
      const empty = document.createElement('div');
      empty.textContent = 'No parametric test data available for box plots.';
      empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
      body.appendChild(empty);
      return;
    }

    const data = getData(activeTest);
    const { unit, limitLow, limitHigh } = getTestMeta(activeTest);

    if (data.every(d => d.count === 0)) {
      const empty = document.createElement('div');
      empty.textContent = 'No parametric test data available for box plots.';
      empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
      body.appendChild(empty);
      return;
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
      if (useLog) return plotX + ((Math.log10(value) - logMin) / logSpan) * plotMaxWidth;
      return plotX + ((value - globalMin) / span) * plotMaxWidth;
    }

    function axisTickValues(): number[] {
      const ticks: number[] = [];
      for (let i = 0; i <= 4; i++) {
        ticks.push(useLog ? Math.pow(10, logMin + (logSpan * i) / 4) : globalMin + (span * i) / 4);
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
        ctx.moveTo(xMedian, boxTop); ctx.lineTo(xMedian, boxBottom);
        ctx.stroke();
        ctx.lineWidth = 1;

        ctx.fillStyle = textColor;
        ctx.textAlign = 'left';
        ctx.fillText(`med ${formatValue(datum.median)}${unit ? ` ${unit}` : ''}`, plotX + plotMaxWidth + 10, midY);
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
        ctx.moveTo(x, 0); ctx.lineTo(x, axisY);
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
      ctx.moveTo(plotX, axisY); ctx.lineTo(plotX + plotMaxWidth, axisY);
      ctx.stroke();

      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const tick of axisTickValues()) {
        const x = xFor(tick, plotX, plotMaxWidth);
        ctx.beginPath();
        ctx.moveTo(x, axisY); ctx.lineTo(x, axisY + 4);
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
    let tooltip = card.querySelector<HTMLElement>('.bp-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'bp-tooltip';
      tooltip.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:50;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:4px;padding:4px 8px;font-size:11px;font-family:system-ui,sans-serif;color:${textColor};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
      card.appendChild(tooltip);
    }
    const tt = tooltip;

    function fmt(v: number): string { return `${formatValue(v)}${unit ? ` ${unit}` : ''}`; }

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const row = rowAt(e.clientY - rect.top);
      if (row !== hovered) { hovered = row; canvas.style.cursor = row >= 0 && data[row].count > 0 ? 'pointer' : 'default'; draw(); }
      if (row >= 0 && data[row].count > 0) {
        const d = data[row];
        const cardRect = card.getBoundingClientRect();
        tt.innerHTML = `<strong>${d.label}</strong> (${d.count} dies)<br>max ${fmt(d.max)}<br>q3 ${fmt(d.q3)}<br>median ${fmt(d.median)}<br>q1 ${fmt(d.q1)}<br>min ${fmt(d.min)}`;
        tt.style.display = 'block';
        tt.style.left = `${e.clientX - cardRect.left + 14}px`;
        tt.style.top = `${e.clientY - cardRect.top + 14}px`;
      } else { tt.style.display = 'none'; }
    });
    canvas.addEventListener('mouseleave', () => { if (hovered !== -1) { hovered = -1; draw(); } tt.style.display = 'none'; });
    canvas.addEventListener('click', e => {
      const rect = canvas.getBoundingClientRect();
      const row = rowAt(e.clientY - rect.top);
      if (row === -1 || data[row].count === 0) return;
      onOpen(data[row].waferIndex);
    });

    trackObserver(new ResizeObserver(() => draw())).observe(card);
    draw();
  }

  rebuildBody();
  return card;
}

// ── Histogram panel ───────────────────────────────────────────────────────────

const HIST_HEIGHT = 230;
const HIST_AXIS_HEIGHT = 36;
const HIST_TOP_MARGIN = 18;

export interface HistogramPanelOptions {
  title: string;
  testOptions: TestOption[];
  selectedTestNumber: number | null;
  getData: (testNumber: number, waferIndex: number | null) => HistogramBucket[];
  getTestMeta: (testNumber: number) => { unit?: string; limitLow?: number; limitHigh?: number };
  colorScheme: string;
  waferLabels: string[];
  selectedWafer: number | null;
  onStateChange: (testNumber: number, waferIndex: number | null) => void;
}

const HISTOGRAM_LOT_VALUE = 'lot';

export function renderHistogramPanel(options: HistogramPanelOptions): HTMLElement {
  const { title, testOptions, colorScheme, getData, getTestMeta, waferLabels, onStateChange } = options;
  const { card, controlsRow, body } = cardShell(title);

  let activeTest = options.selectedTestNumber ?? testOptions[0]?.testNumber ?? null;
  let activeWafer = options.selectedWafer;

  // Test selector
  const testSelect = document.createElement('select');
  testSelect.style.cssText = 'font-size:12px;padding:2px 6px;background:var(--bg-input);color:var(--text-secondary);border:1px solid var(--border-mid);border-radius:4px;color-scheme:light dark;max-width:200px;';
  if (testOptions.length === 0) {
    testSelect.disabled = true;
    const opt = document.createElement('option');
    opt.textContent = 'No parametric tests';
    testSelect.appendChild(opt);
  } else {
    for (const t of testOptions) {
      const opt = document.createElement('option');
      opt.value = String(t.testNumber);
      opt.textContent = t.label;
      if (t.testNumber === activeTest) opt.selected = true;
      testSelect.appendChild(opt);
    }
    testSelect.addEventListener('change', () => {
      activeTest = Number(testSelect.value);
      if (activeTest !== null) onStateChange(activeTest, activeWafer);
      rebuildBody();
    });
  }
  controlsRow.appendChild(testSelect);

  // Wafer selector
  const waferSelect = document.createElement('select');
  waferSelect.style.cssText = 'font-size:12px;padding:2px 6px;background:var(--bg-input);color:var(--text-secondary);border:1px solid var(--border-mid);border-radius:4px;color-scheme:light dark;max-width:160px;';
  const lotOpt = document.createElement('option');
  lotOpt.value = HISTOGRAM_LOT_VALUE;
  lotOpt.textContent = 'All wafers';
  if (activeWafer === null) lotOpt.selected = true;
  waferSelect.appendChild(lotOpt);
  waferLabels.forEach((label, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = label;
    if (activeWafer === i) opt.selected = true;
    waferSelect.appendChild(opt);
  });
  waferSelect.addEventListener('change', () => {
    activeWafer = waferSelect.value === HISTOGRAM_LOT_VALUE ? null : Number(waferSelect.value);
    if (activeTest !== null) onStateChange(activeTest, activeWafer);
    rebuildBody();
  });
  controlsRow.appendChild(waferSelect);

  function rebuildBody() {
    body.innerHTML = '';
    if (activeTest === null) {
      const empty = document.createElement('div');
      empty.textContent = 'No parametric test data available for a histogram.';
      empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
      body.appendChild(empty);
      return;
    }

    const buckets = getData(activeTest, activeWafer);
    const { unit, limitLow, limitHigh } = getTestMeta(activeTest);

    if (buckets.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No parametric test data available for a histogram.';
      empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
      body.appendChild(empty);
      return;
    }

    const maxCount = Math.max(...buckets.map(b => b.count), 1);

    const statsLabel = document.createElement('div');
    statsLabel.style.cssText = `font-size:10px;color:${cssVar('--text-muted') || '#888'};margin-bottom:2px;`;
    // Updated when unit is known after getTestMeta call above
    statsLabel.textContent = `max ${maxCount} dies/bucket`;
    body.appendChild(statsLabel);

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;cursor:default;';
    body.appendChild(canvas);

    let hovered = -1;
    const dpr = window.devicePixelRatio || 1;

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

      // Spec limit lines
      const xForVal = (v: number) => plotX + ((v - bucketMin) / bucketSpan) * plotMaxWidth;
      ctx.font = '10px system-ui, sans-serif';
      for (const [limit, label] of [[limitLow, 'LSL'], [limitHigh, 'USL']] as const) {
        if (limit === undefined || limit < bucketMin || limit > bucketMin + bucketSpan) continue;
        const x = xForVal(limit);
        ctx.strokeStyle = textColor;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, plotTop); ctx.lineTo(x, plotBottom);
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
      ctx.moveTo(plotX, plotBottom); ctx.lineTo(plotX + plotMaxWidth, plotBottom);
      ctx.stroke();

      // X-axis labels — skip ticks that would overlap
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const minLabelPx = 44;
      const maxLabels = Math.max(2, Math.floor(plotMaxWidth / minLabelPx));
      const rawStep = Math.ceil(buckets.length / maxLabels);
      const labelStep = Math.max(1, rawStep);
      for (let i = 0; i <= buckets.length; i += labelStep) {
        const value = i < buckets.length ? buckets[i].rangeLow : buckets[buckets.length - 1].rangeHigh;
        const x = plotX + i * barWidth;
        ctx.beginPath();
        ctx.moveTo(x, plotBottom); ctx.lineTo(x, plotBottom + 4);
        ctx.stroke();
        ctx.fillText(formatValue(value), x, plotBottom + 6);
      }
      // Unit label once, right-aligned at the axis end
      if (unit) {
        ctx.save();
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillStyle = textColor;
        ctx.globalAlpha = 0.55;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(`(${unit})`, plotX + plotMaxWidth, plotBottom + 20);
        ctx.restore();
      }
    }

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const bar = barAt(e.clientX - rect.left);
      if (bar !== hovered) { hovered = bar; draw(); }
    });
    canvas.addEventListener('mouseleave', () => { if (hovered !== -1) { hovered = -1; draw(); } });

    trackObserver(new ResizeObserver(() => draw())).observe(card);
    draw();
  }

  rebuildBody();
  return card;
}

// ── Correlation matrix panel ──────────────────────────────────────────────────

export interface CorrelationPanelOptions {
  title: string;
  matrix: CorrelationMatrix;
  colorScheme: string;
  /** Called when user clicks a non-diagonal cell — use to link scatter X/Y selectors. */
  onSelectPair?: (xTestNumber: number, yTestNumber: number) => void;
}

export function renderCorrelationPanel(options: CorrelationPanelOptions): HTMLElement {
  const { title, matrix, colorScheme, onSelectPair } = options;
  const { card, body } = cardShell(title);

  // Enable horizontal scroll so matrix never clips
  body.style.overflowX = 'auto';

  const hint = document.createElement('div');
  hint.textContent = 'Pearson r · –1 = anti-correlated, +1 = correlated · click cell to view that pair in scatter';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:6px;`;
  card.insertBefore(hint, body);

  if (matrix.tests.length < 2) {
    const empty = document.createElement('div');
    empty.textContent = 'Need at least two parametric tests for a correlation matrix.';
    empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
    body.appendChild(empty);
    return card;
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;cursor:default;';
  body.appendChild(canvas);

  const n = matrix.tests.length;
  const dpr = window.devicePixelRatio || 1;
  const { forValue } = getColorScheme(colorScheme);
  const textColor = cssVar('--text-secondary') || '#ccc';
  const bgColor = cssVar('--bg-overlay') || '#1a1a1a';
  const borderColor = cssVar('--border-mid') || '#444';
  const accentColor = cssVar('--text-primary') || '#fff';

  // Row label width — fit longest short label
  const shortLabel = (t: TestOption) => t.label.split(' (#')[0];
  const maxLabelChars = Math.min(14, Math.max(...matrix.tests.map(t => shortLabel(t).length)));
  const LABEL_W = maxLabelChars * 6.5 + 8;

  // Column header height — angled labels need room; compute once
  const MAX_HEADER_LBL = 10;
  const LABEL_H = Math.round(MAX_HEADER_LBL * 6.5 * Math.sin(Math.PI / 4)) + 14;

  const MIN_CELL = 14;
  const PREF_CELL = 26;

  let selectedXi = -1;
  let selectedYi = -1;

  function cellSize(availW: number): number {
    const plotW = Math.max(0, availW - LABEL_W);
    return Math.max(MIN_CELL, Math.min(PREF_CELL, Math.floor(plotW / n)));
  }

  function draw() {
    const availW = card.clientWidth - 24;
    const cs = cellSize(availW);
    const plotW = cs * n;
    const totalH = LABEL_H + cs * n + 4;
    const totalW = LABEL_W + plotW;

    canvas.width = Math.max(1, Math.floor(totalW * dpr));
    canvas.height = Math.max(1, Math.floor(totalH * dpr));
    canvas.style.width = `${totalW}px`;
    canvas.style.height = `${totalH}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, totalW, totalH);

    // Column header labels (angled 45°)
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = textColor;
    matrix.tests.forEach((t, xi) => {
      const lbl = shortLabel(t);
      const truncated = lbl.length > MAX_HEADER_LBL ? `${lbl.slice(0, MAX_HEADER_LBL - 1)}…` : lbl;
      const cx = LABEL_W + xi * cs + cs / 2;
      ctx.save();
      ctx.translate(cx, LABEL_H - 4);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = xi === selectedXi ? accentColor : textColor;
      ctx.fillText(truncated, 0, 0);
      ctx.restore();
    });

    // Row labels + cells
    matrix.tests.forEach((t, yi) => {
      const lbl = shortLabel(t);
      const cy = LABEL_H + yi * cs;
      const midY = cy + cs / 2;

      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = yi === selectedYi ? accentColor : textColor;
      ctx.fillText(lbl.length > maxLabelChars ? `${lbl.slice(0, maxLabelChars - 1)}…` : lbl, LABEL_W - 4, midY);

      matrix.cells.filter(c => c.yIndex === yi).forEach(cell => {
        const xi = cell.xIndex;
        const cx = LABEL_W + xi * cs;
        const isSelected = xi === selectedXi && yi === selectedYi;
        const isDiag = xi === yi;
        const r = cell.r;

        if (r === null) {
          ctx.fillStyle = borderColor;
          ctx.globalAlpha = 0.4;
          ctx.fillRect(cx + 1, cy + 1, cs - 2, cs - 2);
          ctx.globalAlpha = 1;
          return;
        }

        const norm = (r + 1) / 2;
        if (isDiag) {
          ctx.fillStyle = cssVar('--bg-hover-row') || '#222';
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = forValue(norm);
          ctx.globalAlpha = Math.abs(r) * 0.8 + 0.2;
        }
        ctx.fillRect(cx + 1, cy + 1, cs - 2, cs - 2);
        ctx.globalAlpha = 1;

        // r value text when cells wide enough
        if (cs >= 28 && !isDiag) {
          ctx.font = `${Math.min(10, cs * 0.35)}px system-ui, sans-serif`;
          ctx.fillStyle = Math.abs(r) > 0.55 ? bgColor : textColor;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(r.toFixed(2), cx + cs / 2, cy + cs / 2);
        }

        // Selection highlight
        if (isSelected) {
          ctx.strokeStyle = accentColor;
          ctx.lineWidth = 2;
          ctx.strokeRect(cx + 1, cy + 1, cs - 2, cs - 2);
          ctx.lineWidth = 1;
        }
      });
    });

    // Grid lines
    ctx.strokeStyle = bgColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= n; i++) {
      const x = LABEL_W + i * cs;
      ctx.beginPath(); ctx.moveTo(x, LABEL_H); ctx.lineTo(x, LABEL_H + n * cs); ctx.stroke();
      const y = LABEL_H + i * cs;
      ctx.beginPath(); ctx.moveTo(LABEL_W, y); ctx.lineTo(LABEL_W + n * cs, y); ctx.stroke();
    }
  }

  card.style.position = 'relative';
  const tooltip = document.createElement('div');
  tooltip.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:50;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:4px;padding:4px 8px;font-size:11px;font-family:system-ui,sans-serif;color:${textColor};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
  card.appendChild(tooltip);

  function cellAt(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const availW = card.clientWidth - 24;
    const cs = cellSize(availW);
    const ox = (e.clientX - rect.left) * (canvas.width / dpr / rect.width);
    const oy = (e.clientY - rect.top) * (canvas.height / dpr / rect.height);
    const xi = Math.floor((ox - LABEL_W) / cs);
    const yi = Math.floor((oy - LABEL_H) / cs);
    return (xi >= 0 && xi < n && yi >= 0 && yi < n) ? { xi, yi } : null;
  }

  canvas.addEventListener('mousemove', e => {
    const hit = cellAt(e);
    if (!hit) { tooltip.style.display = 'none'; canvas.style.cursor = 'default'; return; }
    const { xi, yi } = hit;
    const isDiag = xi === yi;
    canvas.style.cursor = isDiag || !onSelectPair ? 'default' : 'pointer';
    const cell = matrix.cells.find(c => c.xIndex === xi && c.yIndex === yi);
    const xLabel = matrix.tests[xi].label;
    const yLabel = matrix.tests[yi].label;
    const cardRect = card.getBoundingClientRect();
    if (isDiag) {
      tooltip.innerHTML = `<strong>${xLabel}</strong>`;
    } else if (cell?.r !== null && cell?.r !== undefined) {
      tooltip.innerHTML = `<strong>${shortLabel(matrix.tests[yi])}</strong> vs <strong>${shortLabel(matrix.tests[xi])}</strong><br>r = ${cell.r.toFixed(4)}${onSelectPair ? '<br><em>click to view in scatter</em>' : ''}`;
    } else {
      tooltip.innerHTML = `${yLabel} vs ${xLabel}<br><em>insufficient data</em>`;
    }
    tooltip.style.display = 'block';
    tooltip.style.left = `${e.clientX - cardRect.left + 14}px`;
    tooltip.style.top = `${e.clientY - cardRect.top + 14}px`;
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

  canvas.addEventListener('click', e => {
    const hit = cellAt(e);
    if (!hit || !onSelectPair) return;
    const { xi, yi } = hit;
    if (xi === yi) return;
    selectedXi = xi;
    selectedYi = yi;
    draw();
    onSelectPair(matrix.tests[xi].testNumber, matrix.tests[yi].testNumber);
  });

  trackObserver(new ResizeObserver(() => draw())).observe(card);
  draw();
  return card;
}

// ── Trend panel (kept for reference, replaced by correlation matrix) ──────────

export interface TrendPanelOptions {
  title: string;
  testOptions: TestOption[];
  selectedTestNumber: number | null;
  getData: (testNumber: number) => TrendDatum[];
  getTestMeta: (testNumber: number) => { unit?: string; limitLow?: number; limitHigh?: number };
  colorScheme: string;
  onStateChange: (testNumber: number) => void;
  onOpen: (waferIndex: number) => void;
}

const TREND_LEFT = 120;
const TREND_RIGHT = 20;
const TREND_TOP = 24;
const TREND_BOTTOM = 36;

export function renderTrendPanel(options: TrendPanelOptions): HTMLElement {
  const { title, testOptions, colorScheme, getData, getTestMeta, onStateChange, onOpen } = options;
  const { card, controlsRow, body } = cardShell(title);

  let activeTest = options.selectedTestNumber ?? testOptions[0]?.testNumber ?? null;

  const select = document.createElement('select');
  select.style.cssText = 'font-size:12px;padding:2px 6px;background:var(--bg-input);color:var(--text-secondary);border:1px solid var(--border-mid);border-radius:4px;color-scheme:light dark;max-width:240px;';
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
      if (t.testNumber === activeTest) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      activeTest = Number(select.value);
      onStateChange(activeTest);
      rebuildBody();
    });
  }
  controlsRow.appendChild(select);

  const hint = document.createElement('div');
  hint.textContent = 'Median per wafer in lot order · band = Q1–Q3 · click to open wafer';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px;`;
  card.insertBefore(hint, body);

  function rebuildBody() {
    body.innerHTML = '';
    if (testOptions.length === 0 || activeTest === null) {
      const empty = document.createElement('div');
      empty.textContent = 'No parametric test data available for trend.';
      empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
      body.appendChild(empty);
      return;
    }

    const data = getData(activeTest);
    const { unit, limitLow, limitHigh } = getTestMeta(activeTest);
    const finite = data.filter(d => d.count > 0);

    if (finite.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No parametric test data available for trend.';
      empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
      body.appendChild(empty);
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;cursor:default;';
    body.appendChild(canvas);
    body.style.minHeight = '160px';

    const dpr = window.devicePixelRatio || 1;
    let hovered = -1;

    const allMin = Math.min(...finite.map(d => d.q1));
    const allMax = Math.max(...finite.map(d => d.q3));
    const yPad = (allMax - allMin) * 0.1 || 1;
    const yMin = allMin - yPad;
    const yMax = allMax + yPad;
    const ySpan = yMax - yMin || 1;

    const forValue = getColorScheme(colorScheme).forValue;
    const textColor = cssVar('--text-secondary') || '#ccc';
    const axisColor = cssVar('--border-mid') || '#444';
    const hoverBg = cssVar('--bg-hover-row') || '#1d1d1d';
    const medianColor = cssVar('--accent') || '#6af';

    function dims() {
      const w = card.clientWidth - 24;
      const h = Math.max(160, Math.min(300, w * 0.4));
      const plotW = w - TREND_LEFT - TREND_RIGHT;
      const plotH = h - TREND_TOP - TREND_BOTTOM;
      return { w, h, plotW: Math.max(10, plotW), plotH: Math.max(10, plotH) };
    }

    function xFor(i: number, plotW: number): number {
      if (data.length <= 1) return TREND_LEFT + plotW / 2;
      return TREND_LEFT + (i / (data.length - 1)) * plotW;
    }

    function yFor(v: number, plotH: number): number {
      return TREND_TOP + (1 - (v - yMin) / ySpan) * plotH;
    }

    function colAt(offsetX: number, plotW: number): number {
      if (data.length === 0) return -1;
      if (data.length === 1) return Math.abs(offsetX - xFor(0, plotW)) < 20 ? 0 : -1;
      const step = plotW / (data.length - 1);
      const i = Math.round((offsetX - TREND_LEFT) / step);
      return i >= 0 && i < data.length ? i : -1;
    }

    function draw() {
      const { w, h, plotW, plotH } = dims();
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Y-axis gridlines + labels
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      const yTicks = 4;
      for (let i = 0; i <= yTicks; i++) {
        const v = yMin + (ySpan * i) / yTicks;
        const y = yFor(v, plotH);
        ctx.strokeStyle = axisColor;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(TREND_LEFT, y); ctx.lineTo(TREND_LEFT + plotW, y);
        ctx.stroke();
        ctx.fillStyle = textColor;
        ctx.fillText(formatValue(v), TREND_LEFT - 6, y);
      }
      // Unit label once at top of Y axis
      if (unit) drawAxisUnit(ctx, unit, TREND_LEFT - 6, TREND_TOP - 10);

      // Spec limit lines
      for (const [limit, label] of [[limitLow, 'LSL'], [limitHigh, 'USL']] as const) {
        if (limit === undefined || limit < yMin || limit > yMax) continue;
        const y = yFor(limit, plotH);
        ctx.strokeStyle = textColor;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(TREND_LEFT, y); ctx.lineTo(TREND_LEFT + plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = textColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, TREND_LEFT + plotW + 3, y);
      }

      // IQR band
      ctx.beginPath();
      data.forEach((d, i) => {
        if (d.count === 0) return;
        const x = xFor(i, plotW);
        const y = yFor(d.q3, plotH);
        if (i === 0 || data.slice(0, i).every(p => p.count === 0)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      const reversedFinite = [...data].reverse();
      reversedFinite.forEach(d => {
        if (d.count === 0) return;
        const i = data.indexOf(d);
        ctx.lineTo(xFor(i, plotW), yFor(d.q1, plotH));
      });
      ctx.closePath();
      ctx.fillStyle = medianColor;
      ctx.globalAlpha = 0.12;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Median line
      ctx.beginPath();
      let started = false;
      data.forEach((d, i) => {
        if (d.count === 0) { started = false; return; }
        const x = xFor(i, plotW);
        const y = yFor(d.median, plotH);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      });
      ctx.strokeStyle = medianColor;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;

      // Data points + hover highlight
      data.forEach((d, i) => {
        if (d.count === 0) return;
        const x = xFor(i, plotW);
        const y = yFor(d.median, plotH);
        const norm = (d.median - yMin) / ySpan;
        const ptColor = forValue(Math.max(0, Math.min(1, norm)));

        if (i === hovered) {
          ctx.fillStyle = hoverBg;
          ctx.fillRect(x - 20, TREND_TOP, 40, plotH);
        }

        ctx.beginPath();
        ctx.arc(x, y, i === hovered ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = ptColor;
        ctx.fill();
        ctx.strokeStyle = i === hovered ? cssVar('--text-primary') : axisColor;
        ctx.lineWidth = i === hovered ? 1.5 : 0.5;
        ctx.stroke();
        ctx.lineWidth = 1;
      });

      // X-axis labels — skip to avoid overlap
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = textColor;
      const minLabelPx = 40;
      const labelStep = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / minLabelPx))));
      data.forEach((d, i) => {
        if (i % labelStep !== 0 && i !== data.length - 1) return;
        const x = xFor(i, plotW);
        const lbl = d.label.length > 10 ? `${d.label.slice(0, 9)}…` : d.label;
        ctx.fillText(lbl, x, TREND_TOP + plotH + 4);
      });

      // Axis line
      ctx.strokeStyle = axisColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(TREND_LEFT, TREND_TOP + plotH); ctx.lineTo(TREND_LEFT + plotW, TREND_TOP + plotH);
      ctx.stroke();
    }

    card.style.position = 'relative';
    let tooltip = card.querySelector<HTMLElement>('.trend-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'trend-tooltip';
      tooltip.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:50;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:4px;padding:4px 8px;font-size:11px;font-family:system-ui,sans-serif;color:${textColor};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
      card.appendChild(tooltip);
    }
    const tt = tooltip;

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const { plotW } = dims();
      const i = colAt(e.clientX - rect.left, plotW);
      if (i !== hovered) { hovered = i; canvas.style.cursor = i >= 0 && data[i].count > 0 ? 'pointer' : 'default'; draw(); }
      if (i >= 0 && data[i].count > 0) {
        const d = data[i];
        const cardRect = card.getBoundingClientRect();
        const u = unit ? ` ${unit}` : '';
        tt.innerHTML = `<strong>${d.label}</strong><br>median ${formatValue(d.median)}${u}<br>Q1 ${formatValue(d.q1)}${u} · Q3 ${formatValue(d.q3)}${u}`;
        tt.style.display = 'block';
        tt.style.left = `${e.clientX - cardRect.left + 14}px`;
        tt.style.top = `${e.clientY - cardRect.top + 14}px`;
      } else { tt.style.display = 'none'; }
    });
    canvas.addEventListener('mouseleave', () => { if (hovered !== -1) { hovered = -1; draw(); } tt.style.display = 'none'; });
    canvas.addEventListener('click', e => {
      const rect = canvas.getBoundingClientRect();
      const { plotW } = dims();
      const i = colAt(e.clientX - rect.left, plotW);
      if (i >= 0 && data[i].count > 0) onOpen(data[i].waferIndex);
    });

    trackObserver(new ResizeObserver(() => draw())).observe(card);
    draw();
  }

  rebuildBody();
  return card;
}

// ── Scatter panel ─────────────────────────────────────────────────────────────

export interface ScatterPanelOptions {
  title: string;
  testOptions: TestOption[];
  xTestNumber: number | null;
  yTestNumber: number | null;
  getPoints: (xTest: number, yTest: number) => ScatterPoint[];
  colorScheme: string;
  onStateChange: (xTest: number, yTest: number) => void;
}

const SCATTER_LEFT = 52;
const SCATTER_RIGHT = 16;
const SCATTER_TOP = 16;
const SCATTER_BOTTOM = 36;

export function renderScatterPanel(options: ScatterPanelOptions): { card: HTMLElement; setXY: (x: number, y: number) => void } {
  const { title, testOptions, colorScheme, getPoints, onStateChange } = options;
  const { card, controlsRow, body } = cardShell(title);

  let activeX = options.xTestNumber ?? testOptions[0]?.testNumber ?? null;
  let activeY = options.yTestNumber ?? testOptions[1]?.testNumber ?? activeX;

  function makeTestSelect(label: string, selected: number | null, onChange: (n: number) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.style.cssText = `display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${cssVar('--text-muted')};`;
    const lbl = document.createElement('span');
    lbl.textContent = label;
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:12px;padding:2px 6px;background:var(--bg-input);color:var(--text-secondary);border:1px solid var(--border-mid);border-radius:4px;color-scheme:light dark;max-width:180px;';
    if (testOptions.length === 0) {
      sel.disabled = true;
      const opt = document.createElement('option');
      opt.textContent = 'No tests';
      sel.appendChild(opt);
    } else {
      for (const t of testOptions) {
        const opt = document.createElement('option');
        opt.value = String(t.testNumber);
        opt.textContent = t.label;
        if (t.testNumber === selected) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => onChange(Number(sel.value)));
    }
    wrap.append(lbl, sel);
    return wrap;
  }

  const xSelectWrap = makeTestSelect('X:', activeX, n => { activeX = n; if (activeX !== null && activeY !== null) onStateChange(activeX, activeY); rebuildBody(); });
  const ySelectWrap = makeTestSelect('Y:', activeY, n => { activeY = n; if (activeX !== null && activeY !== null) onStateChange(activeX, activeY); rebuildBody(); });
  const xSel = xSelectWrap.querySelector('select') as HTMLSelectElement;
  const ySel = ySelectWrap.querySelector('select') as HTMLSelectElement;
  controlsRow.appendChild(xSelectWrap);
  controlsRow.appendChild(ySelectWrap);

  const hint = document.createElement('div');
  hint.textContent = 'One point per die across all wafers · coloured by hard bin · click legend to filter';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px;`;
  card.insertBefore(hint, body);

  // ── Persistent body — built once, redrawn on setXY ──────────────────────────

  const { forBin } = getColorScheme(colorScheme);
  const activeBins = new Set<number>();

  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;';
  body.appendChild(legend);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;cursor:crosshair;';
  body.appendChild(canvas);
  body.style.minHeight = '200px';

  const dpr = window.devicePixelRatio || 1;
  const textColor = cssVar('--text-secondary') || '#ccc';
  const axisColor = cssVar('--border-mid') || '#444';

  // Current data — refreshed by rebuildBody
  let points: ScatterPoint[] = [];
  let xLo = 0, xHi = 1, yLo = 0, yHi = 1;

  function dims() {
    const w = card.clientWidth - 24;
    const h = Math.max(200, Math.min(400, w * 0.65));
    return { w, h, plotW: Math.max(10, w - SCATTER_LEFT - SCATTER_RIGHT), plotH: Math.max(10, h - SCATTER_TOP - SCATTER_BOTTOM) };
  }

  function updateLegend() {
    for (const btn of legend.querySelectorAll<HTMLElement>('[data-bin]')) {
      const bin = Number(btn.dataset.bin);
      const active = activeBins.size === 0 || activeBins.has(bin);
      btn.style.opacity = active ? '1' : '0.35';
      btn.style.outline = activeBins.has(bin) ? `2px solid ${cssVar('--text-primary')}` : 'none';
    }
  }

  function rebuildLegend(allBins: number[]) {
    legend.innerHTML = '';
    activeBins.clear();
    for (const bin of allBins) {
      const swatch = document.createElement('button');
      swatch.dataset.bin = String(bin);
      swatch.title = `HBin ${bin} — click to filter`;
      const color = forBin(bin);
      swatch.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:10px;border:1px solid ${cssVar('--border-mid')};background:none;cursor:pointer;font-size:11px;color:${cssVar('--text-secondary')};white-space:nowrap;`;
      const dot = document.createElement('span');
      dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};flex-shrink:0;`;
      swatch.append(dot, document.createTextNode(`HBin ${bin}`));
      swatch.addEventListener('click', () => {
        if (activeBins.has(bin)) activeBins.delete(bin); else activeBins.add(bin);
        updateLegend();
        draw();
      });
      legend.appendChild(swatch);
    }
    updateLegend();
  }

  function draw() {
    const xSpan = xHi - xLo, ySpan = yHi - yLo;
    const { w, h, plotW, plotH } = dims();
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (points.length === 0) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data — select two parametric tests with values.', w / 2, h / 2);
      return;
    }

    const ticks = 4;
    ctx.font = '10px system-ui, sans-serif';
    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 0.5;
    ctx.fillStyle = textColor;

    for (let i = 0; i <= ticks; i++) {
      const xv = xLo + (xSpan * i) / ticks;
      const cx = SCATTER_LEFT + (i / ticks) * plotW;
      ctx.beginPath(); ctx.moveTo(cx, SCATTER_TOP); ctx.lineTo(cx, SCATTER_TOP + plotH); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(formatValue(xv), cx, SCATTER_TOP + plotH + 4);

      const yv = yLo + (ySpan * i) / ticks;
      const cy = SCATTER_TOP + (1 - i / ticks) * plotH;
      ctx.beginPath(); ctx.moveTo(SCATTER_LEFT, cy); ctx.lineTo(SCATTER_LEFT + plotW, cy); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(formatValue(yv), SCATTER_LEFT - 4, cy);
    }

    const xUnit = testOptions.find(t => t.testNumber === activeX)?.unit;
    const yUnit = testOptions.find(t => t.testNumber === activeY)?.unit;
    if (xUnit) drawAxisUnit(ctx, xUnit, SCATTER_LEFT + plotW + 4, SCATTER_TOP + plotH + 10);
    if (yUnit) {
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = cssVar('--text-muted') || '#888';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(10, SCATTER_TOP + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`(${yUnit})`, 0, 0);
      ctx.restore();
    }

    const visible = activeBins.size === 0 ? points : points.filter(p => activeBins.has(p.hbin ?? 1));
    const step = visible.length > 5000 ? Math.ceil(visible.length / 5000) : 1;
    ctx.globalAlpha = Math.max(0.15, Math.min(0.7, 200 / (visible.length / step)));
    for (let i = 0; i < visible.length; i += step) {
      const p = visible[i];
      const cx = SCATTER_LEFT + ((p.x - xLo) / xSpan) * plotW;
      const cy = SCATTER_TOP + (1 - (p.y - yLo) / ySpan) * plotH;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = forBin(p.hbin ?? 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SCATTER_LEFT, SCATTER_TOP); ctx.lineTo(SCATTER_LEFT, SCATTER_TOP + plotH);
    ctx.moveTo(SCATTER_LEFT, SCATTER_TOP + plotH); ctx.lineTo(SCATTER_LEFT + plotW, SCATTER_TOP + plotH);
    ctx.stroke();
  }

  function rebuildBody() {
    if (testOptions.length < 2 || activeX === null || activeY === null) {
      points = [];
      rebuildLegend([]);
      draw();
      return;
    }
    points = getPoints(activeX, activeY);
    const allBins = Array.from(new Set(points.map(p => p.hbin ?? 1))).sort((a, b) => a - b);
    rebuildLegend(allBins);

    if (points.length > 0) {
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const yMin = Math.min(...ys), yMax = Math.max(...ys);
      const xPad = (xMax - xMin) * 0.05 || 1, yPad = (yMax - yMin) * 0.05 || 1;
      xLo = xMin - xPad; xHi = xMax + xPad;
      yLo = yMin - yPad; yHi = yMax + yPad;
    }
    draw();
  }

  trackObserver(new ResizeObserver(() => draw())).observe(card);

  rebuildBody();

  function setXY(x: number, y: number) {
    activeX = x;
    activeY = y;
    if (xSel) xSel.value = String(x);
    if (ySel) ySel.value = String(y);
    rebuildBody();
  }

  return { card, setXY };
}

// ── Chart grid ────────────────────────────────────────────────────────────────

export function renderChartGrid(container: HTMLElement, cards: Array<ChartPanel | HTMLElement>, options: RenderChartsOptions, pageControls?: HTMLElement[]): void {
  container.innerHTML = '';

  if (pageControls?.length) {
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:12px 16px 0;flex-wrap:wrap;';
    for (const control of pageControls) toolbar.appendChild(control);
    container.appendChild(toolbar);
  }

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:16px;padding:16px;box-sizing:border-box;align-content:start;';

  // Drop to 1 column when container is narrow
  const colObserver = new ResizeObserver(entries => {
    const w = entries[0]?.contentRect.width ?? 0;
    grid.style.gridTemplateColumns = w < 680 ? '1fr' : 'repeat(2,1fr)';
  });
  colObserver.observe(container);
  activeObservers.push(colObserver);

  for (const card of cards) {
    grid.appendChild(card instanceof HTMLElement ? card : renderPanel(card, options));
  }

  container.appendChild(grid);
}
