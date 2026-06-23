// Chart grid + the generic bar-chart panel (yield, bin pareto). Per-chart
// panels live in their own modules (boxplot.ts, histogram.ts, scatter.ts,
// correlation.ts) and share
// chrome/helpers from chartShell.ts. This file re-exports them so existing
// importers (main.ts) keep a single import site.

import {
  cardShell, cssVar, formatValue, trackObserver, isInModal, makeSegmented,
  PADDING, VALUE_WIDTH,
  type ChartPanel, type RenderChartsOptions,
} from './chartShell';

// Re-exports — keep `./charts/render` as the public entry for the charts view.
export { disconnectAllObservers } from './chartShell';
export type { ChartPanel, RenderChartsOptions } from './chartShell';
export { renderBoxplotPanel, type BoxplotPanelOptions } from './boxplot';
export { renderHistogramPanel, type HistogramPanelOptions } from './histogram';
export { renderCorrelationPanel, type CorrelationPanelOptions } from './correlation';
export { renderScatterPanel, type ScatterPanelOptions } from './scatter';
export { renderBinClusterPanel, type BinClusterPanelOptions } from './binCluster';

// ── Bar chart panel (yield, bin pareto) ─────────────────────────────────────────

const ROW_HEIGHT = 24;
const ROW_GAP = 5;
const LABEL_WIDTH = 110;
const MAX_VISIBLE_ROWS = 12;

function renderPanel(panel: ChartPanel, options: RenderChartsOptions): HTMLElement {
  const { controls, barColor, valueLabel, selfControl } = panel;
  let title = panel.title;
  let data = panel.data;
  // getHeaderLines reads `title` lazily so PNG exports pick up the current value
  // after a self-control change (e.g. Hard→Soft bins).
  const getHeaderLines = options.getHeaderLines ? () => options.getHeaderLines!(title) : undefined;
  const { card, heading, controlsRow, body } = cardShell(title, options.savePng, getHeaderLines);

  if (selfControl) {
    // onSelfControlChange is defined below (after draw/maxValue/selected); the
    // segmented control is appended here so it leads the controls row.
    controlsRow.appendChild(makeSegmented(selfControl.options, selfControl.current, value => onSelfControlChange(value)));
  }

  if (controls?.length) {
    for (const control of controls) controlsRow.appendChild(control);
  }

  const hint = document.createElement('div');
  hint.textContent = 'Click a bar to open it · shift-click to select several';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:6px;`;
  card.insertBefore(hint, body);

  const scrollArea = document.createElement('div');
  const visibleAreaHeight = PADDING * 2 + Math.min(data.length, MAX_VISIBLE_ROWS) * (ROW_HEIGHT + ROW_GAP);
  // flex:1 lets the scroll area fill `body` (which is flex:1 in the card). In the
  // grid the max-height caps it to the visible-rows window; in the modal the cap
  // is lifted (see draw) so it uses the full available height.
  scrollArea.style.cssText = `overflow-y:auto;min-height:0;flex:1;max-height:${visibleAreaHeight}px;`;
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
  let maxValue = Math.max(1, ...data.map(d => d.value));

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
    // In the modal the scroll area fills the available height; in the grid it
    // stays capped to the visible-rows window.
    scrollArea.style.maxHeight = isInModal(card) ? 'none' : `${visibleAreaHeight}px`;
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

  // Self-contained selector handler: recompute data and redraw in place. Never
  // rebuilds the charts grid — that would orphan a card open in the expand modal.
  function onSelfControlChange(value: string) {
    if (!selfControl) return;
    selfControl.current = value;
    const next = selfControl.onChange(value);
    data = next.data;
    maxValue = Math.max(1, ...data.map(d => d.value));
    hovered = -1;
    selected.clear();
    updateSelectionBar();
    if (next.title) { title = next.title; heading.textContent = title; }
    draw();
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
  trackObserver(new ResizeObserver(entries => {
    const w = entries[0]?.contentRect.width ?? 0;
    grid.style.gridTemplateColumns = w < 680 ? '1fr' : 'repeat(2,1fr)';
  })).observe(container);

  for (const card of cards) {
    grid.appendChild(card instanceof HTMLElement ? card : renderPanel(card, options));
  }

  container.appendChild(grid);
}
