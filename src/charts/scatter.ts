// Scatter panel — die-level X/Y scatter for two parametric tests, coloured by
// hard bin with a click-to-filter legend. Returns { card, setXY } so the
// correlation matrix can update X/Y in place without rebuilding the grid.

import { getColorScheme } from '@paulrobins/wafermap/renderer';
import type { ScatterPoint, TestOption } from './types';
import { cardShell, cssVar, formatValue, drawAxisUnit, trackObserver, applyCanvasFlow, chartFillHeight } from './chartShell';
import { attachTooltip } from '../tooltip';

export interface ScatterPanelOptions {
  title: string;
  testOptions: TestOption[];
  xTestNumber: number | null;
  yTestNumber: number | null;
  getPoints: (xTest: number, yTest: number) => ScatterPoint[];
  getTestMeta: (testNumber: number) => { unit?: string; limitLow?: number; limitHigh?: number };
  colorScheme: string;
  /**
   * When a facet field is active, the group keys (legend order). Non-empty makes
   * the scatter colour points by group (replacing hard-bin colour) and the
   * legend filter operates on groups. `getPoints` should then return points
   * tagged with `group` (via `buildScatterDataGrouped`).
   */
  groups?: string[];
  onStateChange: (xTest: number, yTest: number) => void;
  savePng?: (blob: Blob, stem: string) => void;
  getHeaderLines?: () => { title: string; subtitle: string };
}

const SCATTER_LEFT = 52;
const SCATTER_RIGHT = 16;
const SCATTER_TOP = 16;
const SCATTER_BOTTOM = 44;

export function renderScatterPanel(options: ScatterPanelOptions): { card: HTMLElement; setXY: (x: number, y: number) => void } {
  const { title, testOptions, colorScheme, getPoints, getTestMeta, onStateChange, groups } = options;
  const { card, controlsRow, body } = cardShell(title, options.savePng, options.getHeaderLines);

  // When a facet is active, colour + legend + filter key on group rather than bin.
  const byGroup = !!(groups && groups.length > 0);
  const groupColorIndex = new Map<string, number>((groups ?? []).map((g, i) => [g, i]));

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
  hint.textContent = byGroup
    ? 'One point per die · coloured by group · click legend to filter'
    : 'One point per die across all wafers · coloured by hard bin · click legend to filter';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px;`;
  card.insertBefore(hint, body);

  // ── Persistent body — built once, redrawn on setXY ──────────────────────────

  const scheme = getColorScheme(colorScheme);
  const { forBin } = scheme;
  // Category = the colour/filter key: group name (byGroup) or hard-bin number.
  const categoryOf = (p: ScatterPoint): string => byGroup ? (p.group ?? '—') : String(p.hbin ?? 1);
  const colorOfCategory = (cat: string): string => {
    if (byGroup) {
      const n = groups!.length;
      return scheme.forValue(n <= 1 ? 0.5 : (groupColorIndex.get(cat) ?? 0) / (n - 1));
    }
    return forBin(Number(cat));
  };
  const labelOfCategory = (cat: string): string => byGroup ? cat : `HBin ${cat}`;
  // Active filter set (empty = show all). Keyed by category string.
  const activeCats = new Set<string>();

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
    const gridH = Math.max(200, Math.min(400, w * 0.65));
    const h = chartFillHeight(card, body, canvas, gridH);
    return { w, h, plotW: Math.max(10, w - SCATTER_LEFT - SCATTER_RIGHT), plotH: Math.max(10, h - SCATTER_TOP - SCATTER_BOTTOM) };
  }

  function updateLegend() {
    for (const btn of legend.querySelectorAll<HTMLElement>('[data-cat]')) {
      const cat = btn.dataset.cat!;
      const active = activeCats.size === 0 || activeCats.has(cat);
      btn.style.opacity = active ? '1' : '0.35';
      btn.style.outline = activeCats.has(cat) ? `2px solid ${cssVar('--text-primary')}` : 'none';
    }
  }

  function rebuildLegend(cats: string[]) {
    legend.innerHTML = '';
    activeCats.clear();
    for (const cat of cats) {
      const swatch = document.createElement('button');
      swatch.dataset.cat = cat;
      attachTooltip(swatch, `${labelOfCategory(cat)} — click to filter`);
      const color = colorOfCategory(cat);
      swatch.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:10px;border:1px solid ${cssVar('--border-mid')};background:none;cursor:pointer;font-size:11px;color:${cssVar('--text-secondary')};white-space:nowrap;`;
      const dot = document.createElement('span');
      dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};flex-shrink:0;`;
      swatch.append(dot, document.createTextNode(labelOfCategory(cat)));
      swatch.addEventListener('click', () => {
        if (activeCats.has(cat)) activeCats.delete(cat); else activeCats.add(cat);
        updateLegend();
        draw();
      });
      legend.appendChild(swatch);
    }
    updateLegend();
  }

  function draw() {
    applyCanvasFlow(card, canvas, legend.offsetHeight);
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
    if (xUnit) drawAxisUnit(ctx, xUnit, SCATTER_LEFT + plotW / 2, SCATTER_TOP + plotH + 24);
    if (yUnit) {
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = cssVar('--text-muted') || '#888';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(6, SCATTER_TOP + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`(${yUnit})`, 0, 0);
      ctx.restore();
    }

    const visible = activeCats.size === 0 ? points : points.filter(p => activeCats.has(categoryOf(p)));
    const step = visible.length > 5000 ? Math.ceil(visible.length / 5000) : 1;
    ctx.globalAlpha = Math.max(0.15, Math.min(0.7, 200 / (visible.length / step)));
    for (let i = 0; i < visible.length; i += step) {
      const p = visible[i];
      const cx = SCATTER_LEFT + ((p.x - xLo) / xSpan) * plotW;
      const cy = SCATTER_TOP + (1 - (p.y - yLo) / ySpan) * plotH;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = colorOfCategory(categoryOf(p));
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Spec limit lines — vertical for X test, horizontal for Y test
    if (activeX !== null && activeY !== null) {
      const xMeta = getTestMeta(activeX);
      const yMeta = getTestMeta(activeY);
      const limitColor = cssVar('--text-muted') || '#888';
      ctx.strokeStyle = limitColor;
      ctx.fillStyle = limitColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.font = '9px system-ui, sans-serif';
      ctx.textBaseline = 'top';

      // X limits → vertical lines
      for (const [lim, label] of [[xMeta.limitLow, 'LSL'], [xMeta.limitHigh, 'USL']] as const) {
        if (lim === undefined || lim < xLo || lim > xHi) continue;
        const cx = SCATTER_LEFT + ((lim - xLo) / xSpan) * plotW;
        ctx.beginPath();
        ctx.moveTo(cx, SCATTER_TOP);
        ctx.lineTo(cx, SCATTER_TOP + plotH);
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillText(label, cx + 2, SCATTER_TOP + 2);
      }

      // Y limits → horizontal lines
      for (const [lim, label] of [[yMeta.limitLow, 'LSL'], [yMeta.limitHigh, 'USL']] as const) {
        if (lim === undefined || lim < yLo || lim > yHi) continue;
        const cy = SCATTER_TOP + (1 - (lim - yLo) / ySpan) * plotH;
        ctx.beginPath();
        ctx.moveTo(SCATTER_LEFT, cy);
        ctx.lineTo(SCATTER_LEFT + plotW, cy);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillText(label, SCATTER_LEFT + plotW - 2, cy + 2);
      }

      ctx.setLineDash([]);
    }

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
    let cats: string[];
    if (byGroup) {
      // Preserve the supplied group order; only show groups actually present.
      const present = new Set(points.map(categoryOf));
      cats = groups!.filter(g => present.has(g));
    } else {
      cats = Array.from(new Set(points.map(p => p.hbin ?? 1))).sort((a, b) => a - b).map(String);
    }
    rebuildLegend(cats);

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
