// Boxplot panel — per-wafer five-number summary for one parametric test, with a
// log-scale toggle. Self-contained: owns its test selection state and calls
// onStateChange/onToggleLogScale to persist without rebuilding the grid.

import { getColorScheme } from '@paulrobins/wafermap/renderer';
import type { BoxplotDatum, TestOption } from './types';
import { cardShell, cssVar, formatValue, trackObserver, PADDING, VALUE_WIDTH } from './chartShell';

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
  axisIncludesLimits: boolean;
  colorScheme: string;
  onStateChange: (testNumber: number) => void;
  onToggleLogScale: () => void;
  onToggleAxisIncludesLimits: () => void;
  onOpen: (waferIndex: number) => void;
  savePng?: (blob: Blob, stem: string) => void;
}

export function renderBoxplotPanel(options: BoxplotPanelOptions): HTMLElement {
  const { title, testOptions, colorScheme, getData, getTestMeta, onStateChange, onToggleLogScale, onToggleAxisIncludesLimits, onOpen } = options;
  const { card, controlsRow, body } = cardShell(title, options.savePng);

  let activeTest = options.selectedTestNumber ?? testOptions[0]?.testNumber ?? null;
  let logScale = options.logScale;
  let axisIncludesLimits = options.axisIncludesLimits;

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

  const limLabel = document.createElement('label');
  limLabel.style.cssText = `display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${cssVar('--text-muted')};cursor:pointer;user-select:none;`;
  const limCheckbox = document.createElement('input');
  limCheckbox.type = 'checkbox';
  limCheckbox.checked = axisIncludesLimits;
  limCheckbox.style.cssText = 'margin:0;cursor:pointer;';
  limCheckbox.addEventListener('change', () => {
    axisIncludesLimits = limCheckbox.checked;
    onToggleAxisIncludesLimits();
    rebuildBody();
  });
  limLabel.append(limCheckbox, document.createTextNode('Axis includes limits'));
  controlsRow.appendChild(limLabel);

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
    const dataMin = Math.min(...finite.map(d => d.min));
    const dataMax = Math.max(...finite.map(d => d.max));
    const globalMin = axisIncludesLimits && limitLow  !== undefined ? Math.min(dataMin, limitLow)  : dataMin;
    const globalMax = axisIncludesLimits && limitHigh !== undefined ? Math.max(dataMax, limitHigh) : dataMax;
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
        if (limit === undefined) continue;
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
