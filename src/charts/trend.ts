// Trend panel — median per wafer in lot order with a Q1–Q3 band, for one
// parametric test. Self-contained: owns its test selection and calls
// onStateChange to persist.

import { getColorScheme } from '@paulrobins/wafermap/renderer';
import type { TestOption, TrendDatum } from './types';
import { cardShell, cssVar, formatValue, drawAxisUnit, trackObserver } from './chartShell';

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
