// Histogram panel — bucket distribution for one parametric test on one wafer
// (or all wafers), with spec-limit lines. Self-contained: owns its test/wafer
// selection and calls onStateChange to persist.

import { getColorScheme } from '@paulrobins/wafermap/renderer';
import type { HistogramBucket, HistogramSeriesData, TestOption } from './types';
import { cardShell, cssVar, formatValue, trackObserver, applyCanvasFlow, chartFillHeight, PADDING } from './chartShell';
import { attachTooltip } from '../tooltip';

const HIST_HEIGHT = 230;
const HIST_AXIS_HEIGHT = 36;
const HIST_TOP_MARGIN = 18;

/**
 * Draw a numbered count axis (Y) at the left of the plot, with ~`targetTicks`
 * "nice" gridlines from 0 to maxCount. Shared by the single and faceted views.
 */
function drawCountAxis(
  ctx: CanvasRenderingContext2D,
  plotX: number, plotTop: number, plotBottom: number, plotMaxWidth: number,
  maxCount: number, colors: { text: string; axis: string; grid: string },
  targetTicks = 4,
) {
  // "Nice" step: 1/2/5 × 10^n just above maxCount/targetTicks.
  const rawStep = Math.max(1, maxCount / targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceStep = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const plotH = plotBottom - plotTop;

  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= maxCount + 1e-9; v += niceStep) {
    const y = plotBottom - (v / (maxCount || 1)) * plotH;
    // faint gridline across the plot
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, y); ctx.lineTo(plotX + plotMaxWidth, y);
    ctx.stroke();
    // tick label
    ctx.fillStyle = colors.text;
    ctx.fillText(String(Math.round(v)), plotX - 4, y);
  }
  // Y axis line
  ctx.strokeStyle = colors.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX, plotTop); ctx.lineTo(plotX, plotBottom);
  ctx.stroke();
  ctx.restore();
}

export interface HistogramPanelOptions {
  title: string;
  testOptions: TestOption[];
  selectedTestNumber: number | null;
  getData: (testNumber: number, waferIndex: number | null, axisIncludesLimits: boolean) => HistogramBucket[];
  getTestMeta: (testNumber: number) => { unit?: string; limitLow?: number; limitHigh?: number };
  /**
   * When grouping is active in combined mode, returns one count-series per group
   * over shared buckets — the panel then draws an overlaid, colour-coded
   * histogram with a legend instead of the single-distribution view. When
   * undefined (no grouping / per-wafer mode) the panel uses `getData`.
   */
  getSeriesData?: (testNumber: number, axisIncludesLimits: boolean) => HistogramSeriesData;
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
  const { title, testOptions, colorScheme, getData, getSeriesData, getTestMeta, waferLabels, onStateChange, onToggleAxisIncludesLimits } = options;
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

  // Z-order / emphasis state for faceted legend (group key clicked → brought to
  // front and fully opaque, others dimmed). Persists across redraws within the
  // panel; reset implicitly when the grid rebuilds.
  let emphasizedGroup: string | null = null;

  function rebuildBody() {
    body.innerHTML = '';
    if (activeTest === null) {
      const empty = document.createElement('div');
      empty.textContent = 'No parametric test data available for a histogram.';
      empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
      body.appendChild(empty);
      return;
    }

    // Faceted (combined-by-group) view: overlaid series + legend. The wafer
    // selector is meaningless here (groups pool all their wafers), so hide it.
    const faceted = getSeriesData ? getSeriesData(activeTest, axisIncludesLimits) : null;
    waferSelect.style.display = faceted ? 'none' : '';
    if (faceted) {
      if (faceted.series.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'No parametric test data available for a histogram.';
        empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
        body.appendChild(empty);
        return;
      }
      renderFacetedSeries(faceted);
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
    statsLabel.style.cssText = `font-size:12px;color:${cssVar('--text-muted') || '#888'};margin-bottom:2px;`;
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

    function plotRect(height: number) {
      const plotX = PADDING + 36;
      const plotMaxWidth = canvas.clientWidth - plotX - PADDING;
      const plotMaxHeight = height - HIST_AXIS_HEIGHT - HIST_TOP_MARGIN;
      return { plotX, plotMaxWidth: Math.max(10, plotMaxWidth), plotMaxHeight, plotTop: HIST_TOP_MARGIN };
    }

    function barAt(offsetX: number): number {
      const { plotX, plotMaxWidth } = plotRect(HIST_HEIGHT);
      if (offsetX < plotX || offsetX > plotX + plotMaxWidth) return -1;
      const index = Math.floor(((offsetX - plotX) / plotMaxWidth) * buckets.length);
      return index >= 0 && index < buckets.length ? index : -1;
    }

    function draw() {
      applyCanvasFlow(card, canvas, statsLabel.offsetHeight);
      const width = card.clientWidth - 24;
      const height = chartFillHeight(card, body, canvas, HIST_HEIGHT);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = '11px system-ui, sans-serif';

      const { plotX, plotMaxWidth, plotMaxHeight, plotTop } = plotRect(height);
      const plotBottom = plotTop + plotMaxHeight;
      const barWidth = plotMaxWidth / buckets.length;

      // Count (Y) axis with gridlines, drawn first so bars sit over it.
      drawCountAxis(ctx, plotX, plotTop, plotBottom, plotMaxWidth, maxCount,
        { text: textColor, axis: axisColor, grid: cssVar('--border-subtle') || '#2a2a2a' });

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

    // Informational tooltip (no click action — single-wafer bars aren't clickable).
    card.style.position = 'relative';
    let tooltip = card.querySelector<HTMLElement>('.hist-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'hist-tooltip';
      tooltip.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:50;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:4px;padding:5px 8px;font-size:11px;font-family:system-ui,sans-serif;color:${textColor};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
      card.appendChild(tooltip);
    }
    const tt = tooltip;

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const bar = barAt(e.clientX - rect.left);
      if (bar !== hovered) { hovered = bar; draw(); }
      if (bar >= 0) {
        const b = buckets[bar];
        const cardRect = card.getBoundingClientRect();
        tt.innerHTML = `<strong>${formatValue(b.rangeLow)} – ${formatValue(b.rangeHigh)}${unit ? ` ${unit}` : ''}</strong><br>${b.count} dies`;
        tt.style.display = 'block';
        tt.style.left = `${e.clientX - cardRect.left + 14}px`;
        tt.style.top = `${e.clientY - cardRect.top + 14}px`;
      } else { tt.style.display = 'none'; }
    });
    canvas.addEventListener('mouseleave', () => { if (hovered !== -1) { hovered = -1; draw(); } tt.style.display = 'none'; });

    trackObserver(new ResizeObserver(() => draw())).observe(card);
    draw();
  }

  // ── Faceted overlay: one coloured series per group + clickable legend ─────────
  function renderFacetedSeries(facet: HistogramSeriesData) {
    const { unit, limitLow, limitHigh } = getTestMeta(activeTest!);
    const ranges = facet.ranges;
    const series = facet.series;

    // Per-group colour: evenly spaced across the active colour scheme.
    const forValue = getColorScheme(colorScheme).forValue;
    const colorOf = (i: number) => forValue(series.length <= 1 ? 0.5 : i / (series.length - 1));

    // If a clicked group is no longer present (test changed), clear emphasis.
    if (emphasizedGroup && !series.some(s => s.groupKey === emphasizedGroup)) emphasizedGroup = null;

    const maxCount = Math.max(1, ...series.flatMap(s => s.counts));

    const statsLabel = document.createElement('div');
    statsLabel.style.cssText = `font-size:12px;color:${cssVar('--text-muted') || '#888'};margin-bottom:2px;`;
    statsLabel.textContent = `${series.length} groups · max ${maxCount} dies/bucket`;
    body.appendChild(statsLabel);

    // Legend — swatch + group name; click to emphasise (bring to front, dim rest);
    // click the emphasised one again to clear.
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:4px;';
    series.forEach((s, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      attachTooltip(item, `${s.groupKey} — click to emphasise (dim the rest)`);
      item.style.cssText = `display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:1px 4px;border:none;background:none;cursor:pointer;color:${cssVar('--text-secondary')};border-radius:3px;`;
      const sw = document.createElement('span');
      sw.style.cssText = `width:10px;height:10px;border-radius:2px;background:${colorOf(i)};flex:0 0 auto;`;
      const txt = document.createElement('span');
      txt.textContent = s.groupKey;
      item.append(sw, txt);
      const dim = emphasizedGroup !== null && emphasizedGroup !== s.groupKey;
      item.style.opacity = dim ? '0.45' : '1';
      if (emphasizedGroup === s.groupKey) item.style.background = cssVar('--bg-hover-row') || '#1d1d1d';
      item.addEventListener('click', () => {
        emphasizedGroup = emphasizedGroup === s.groupKey ? null : s.groupKey;
        rebuildBody();
      });
      legend.appendChild(item);
    });
    body.appendChild(legend);

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;cursor:default;';
    body.appendChild(canvas);

    const dpr = window.devicePixelRatio || 1;
    const bucketMin = ranges[0].rangeLow;
    const bucketSpan = ranges[ranges.length - 1].rangeHigh - bucketMin || 1;
    const textColor = cssVar('--text-secondary') || '#ccc';
    const axisColor = cssVar('--border-mid') || '#444';
    const siblingH = () => statsLabel.offsetHeight + legend.offsetHeight;

    let hoveredBucket = -1;
    let facetGeom = { plotX: PADDING + 36, plotMaxWidth: 10, barWidth: 10 };

    function draw() {
      applyCanvasFlow(card, canvas, siblingH());
      const width = card.clientWidth - 24;
      const height = chartFillHeight(card, body, canvas, HIST_HEIGHT);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = '11px system-ui, sans-serif';

      const plotX = PADDING + 36;
      const plotMaxWidth = Math.max(10, width - plotX - PADDING);
      const plotTop = HIST_TOP_MARGIN;
      const plotMaxHeight = height - HIST_AXIS_HEIGHT - HIST_TOP_MARGIN;
      const plotBottom = plotTop + plotMaxHeight;
      const barWidth = plotMaxWidth / ranges.length;
      facetGeom = { plotX, plotMaxWidth, barWidth };

      // Count (Y) axis with gridlines, behind the series.
      drawCountAxis(ctx, plotX, plotTop, plotBottom, plotMaxWidth, maxCount,
        { text: textColor, axis: axisColor, grid: cssVar('--border-subtle') || '#2a2a2a' });

      // Faint highlight band on the hovered bucket.
      if (hoveredBucket >= 0) {
        ctx.fillStyle = cssVar('--bg-hover-row') || '#1d1d1d';
        ctx.globalAlpha = 0.5;
        ctx.fillRect(plotX + hoveredBucket * barWidth, plotTop, barWidth, plotMaxHeight);
        ctx.globalAlpha = 1;
      }

      // Draw each series as a stepped outline with translucent fill. Emphasised
      // group (if any) drawn last so it sits on top.
      const drawOrder = series
        .map((s, i) => ({ s, i }))
        .sort((a, b) => (a.s.groupKey === emphasizedGroup ? 1 : 0) - (b.s.groupKey === emphasizedGroup ? 1 : 0));

      for (const { s, i } of drawOrder) {
        const emphasised = emphasizedGroup === s.groupKey;
        const dim = emphasizedGroup !== null && !emphasised;
        const color = colorOf(i);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = emphasised ? 2 : 1;
        ctx.globalAlpha = dim ? 0.12 : (emphasizedGroup ? 0.32 : 0.22);
        // filled stepped area
        ctx.beginPath();
        ctx.moveTo(plotX, plotBottom);
        s.counts.forEach((c, b) => {
          const x = plotX + b * barWidth;
          const y = plotBottom - (c / maxCount) * plotMaxHeight;
          ctx.lineTo(x, y);
          ctx.lineTo(x + barWidth, y);
        });
        ctx.lineTo(plotX + plotMaxWidth, plotBottom);
        ctx.closePath();
        ctx.fill();
        // outline
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.beginPath();
        s.counts.forEach((c, b) => {
          const x = plotX + b * barWidth;
          const y = plotBottom - (c / maxCount) * plotMaxHeight;
          if (b === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          ctx.lineTo(x + barWidth, y);
        });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

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

      // X axis
      ctx.strokeStyle = axisColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotX, plotBottom); ctx.lineTo(plotX + plotMaxWidth, plotBottom);
      ctx.stroke();

      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const minLabelPx = 44;
      const maxLabels = Math.max(2, Math.floor(plotMaxWidth / minLabelPx));
      const labelStep = Math.max(1, Math.ceil(ranges.length / maxLabels));
      for (let b = 0; b <= ranges.length; b += labelStep) {
        const value = b < ranges.length ? ranges[b].rangeLow : ranges[ranges.length - 1].rangeHigh;
        const x = plotX + b * barWidth;
        ctx.beginPath();
        ctx.moveTo(x, plotBottom); ctx.lineTo(x, plotBottom + 4);
        ctx.stroke();
        ctx.fillText(formatValue(value), x, plotBottom + 6);
      }
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

    // Hover tooltip listing every group's count in the hovered bucket.
    card.style.position = 'relative';
    let tooltip = card.querySelector<HTMLElement>('.hist-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'hist-tooltip';
      tooltip.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:50;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:4px;padding:5px 8px;font-size:11px;font-family:system-ui,sans-serif;color:${textColor};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
      card.appendChild(tooltip);
    }
    const tt = tooltip;

    function bucketAt(offsetX: number): number {
      const { plotX, plotMaxWidth, barWidth } = facetGeom;
      if (offsetX < plotX || offsetX > plotX + plotMaxWidth) return -1;
      const b = Math.floor((offsetX - plotX) / barWidth);
      return b >= 0 && b < ranges.length ? b : -1;
    }

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const b = bucketAt(e.clientX - rect.left);
      if (b !== hoveredBucket) { hoveredBucket = b; draw(); }
      if (b >= 0) {
        const r = ranges[b];
        const rows = series.map((s, i) =>
          `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${colorOf(i)};margin-right:5px;"></span>${s.groupKey}: ${s.counts[b]}`
        ).join('<br>');
        const cardRect = card.getBoundingClientRect();
        tt.innerHTML = `<strong>${formatValue(r.rangeLow)} – ${formatValue(r.rangeHigh)}${unit ? ` ${unit}` : ''}</strong><br>${rows}`;
        tt.style.display = 'block';
        tt.style.left = `${e.clientX - cardRect.left + 14}px`;
        tt.style.top = `${e.clientY - cardRect.top + 14}px`;
      } else {
        tt.style.display = 'none';
      }
    });
    canvas.addEventListener('mouseleave', () => {
      if (hoveredBucket !== -1) { hoveredBucket = -1; draw(); }
      tt.style.display = 'none';
    });

    trackObserver(new ResizeObserver(() => draw())).observe(card);
    draw();
  }

  rebuildBody();
  return card;
}
