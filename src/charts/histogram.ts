// Histogram panel — bucket distribution for one parametric test on one wafer
// (or all wafers), with spec-limit lines. Self-contained: owns its test/wafer
// selection and calls onStateChange to persist.

import { getColorScheme } from '@paulrobins/wafermap/renderer';
import type { HistogramBucket, TestOption } from './types';
import { cardShell, cssVar, formatValue, trackObserver, PADDING } from './chartShell';

const HIST_HEIGHT = 230;
const HIST_AXIS_HEIGHT = 36;
const HIST_TOP_MARGIN = 18;

export interface HistogramPanelOptions {
  title: string;
  testOptions: TestOption[];
  selectedTestNumber: number | null;
  getData: (testNumber: number, waferIndex: number | null, axisIncludesLimits: boolean) => HistogramBucket[];
  getTestMeta: (testNumber: number) => { unit?: string; limitLow?: number; limitHigh?: number };
  colorScheme: string;
  waferLabels: string[];
  selectedWafer: number | null;
  axisIncludesLimits: boolean;
  onStateChange: (testNumber: number, waferIndex: number | null) => void;
  onToggleAxisIncludesLimits: () => void;
  savePng?: (blob: Blob, stem: string) => void;
  getHeaderLines?: () => { title: string; subtitle: string };
}

const HISTOGRAM_LOT_VALUE = 'lot';

export function renderHistogramPanel(options: HistogramPanelOptions): HTMLElement {
  const { title, testOptions, colorScheme, getData, getTestMeta, waferLabels, onStateChange, onToggleAxisIncludesLimits } = options;
  const { card, controlsRow, body } = cardShell(title, options.savePng, options.getHeaderLines);

  let activeTest = options.selectedTestNumber ?? testOptions[0]?.testNumber ?? null;
  let activeWafer = options.selectedWafer;
  let axisIncludesLimits = options.axisIncludesLimits;

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

  function rebuildBody() {
    body.innerHTML = '';
    if (activeTest === null) {
      const empty = document.createElement('div');
      empty.textContent = 'No parametric test data available for a histogram.';
      empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
      body.appendChild(empty);
      return;
    }

    const buckets = getData(activeTest, activeWafer, axisIncludesLimits);
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
        if (limit === undefined) continue;
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
