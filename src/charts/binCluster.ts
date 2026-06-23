// Clustered bin pareto — one horizontal cluster per bin, with side-by-side
// sub-bars coloured per group (lot/program/…). Used only in combined faceting
// mode; the plain (ungrouped) pareto uses the generic bar panel in render.ts.
// Self-contained: owns the hard/soft bin toggle and redraws in place.

import { getColorScheme } from '@paulrobins/wafermap/renderer';
import type { BinClusterData, BinType } from './types';
import { cardShell, cssVar, trackObserver, isInModal, makeSegmented, PADDING, VALUE_WIDTH } from './chartShell';

const CLUSTER_LABEL_WIDTH = 90;
const CLUSTER_GAP = 8;        // gap between bin clusters
const SUBBAR_GAP = 1;         // gap between a cluster's sub-bars
const SUBBAR_HEIGHT = 14;     // height of one group's sub-bar
const MAX_VISIBLE_BINS = 8;

export interface BinClusterPanelOptions {
  title: string;
  binType: BinType;
  getData: (binType: BinType) => BinClusterData;
  colorScheme: string;
  onToggleBinType: (binType: BinType) => void;
  onOpen: (waferIndices: number[]) => void;
  savePng?: (blob: Blob, stem: string) => void;
  getHeaderLines?: () => { title: string; subtitle: string };
}

export function renderBinClusterPanel(options: BinClusterPanelOptions): HTMLElement {
  const { title, colorScheme, getData, onToggleBinType, onOpen } = options;
  let binType = options.binType;
  let titleText = title;
  const { card, heading, controlsRow, body } = cardShell(titleText, options.savePng, options.getHeaderLines);

  controlsRow.appendChild(makeSegmented(
    [['hbin', 'Hard bins'], ['sbin', 'Soft bins']],
    binType,
    v => { binType = v as BinType; onToggleBinType(binType); titleText = `${binType === 'hbin' ? 'Hard' : 'Soft'} bin pareto`; heading.textContent = titleText; rebuildBody(); },
  ));

  const hint = document.createElement('div');
  hint.textContent = 'One cluster per bin · a sub-bar per group · click a sub-bar to open its wafers';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;margin-bottom:6px;`;
  card.insertBefore(hint, body);

  function rebuildBody() {
    body.innerHTML = '';
    const data = getData(binType);

    if (data.bins.length === 0 || data.groups.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No bin data available for the current grouping.';
      empty.style.cssText = `color:${cssVar('--text-muted')};font-size:12px;padding:8px 0;`;
      body.appendChild(empty);
      return;
    }

    const groups = data.groups;
    const bins = data.bins;
    const forValue = getColorScheme(colorScheme).forValue;
    const colorOf = (i: number) => forValue(groups.length <= 1 ? 0.5 : i / (groups.length - 1));
    const maxCount = Math.max(1, ...bins.flatMap(b => b.counts));
    const clusterHeight = groups.length * SUBBAR_HEIGHT + (groups.length - 1) * SUBBAR_GAP;
    const rowPitch = clusterHeight + CLUSTER_GAP;

    // Legend.
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:4px;';
    groups.forEach((g, i) => {
      const item = document.createElement('span');
      item.style.cssText = `display:inline-flex;align-items:center;gap:5px;font-size:11px;color:${cssVar('--text-secondary')};`;
      const sw = document.createElement('span');
      sw.style.cssText = `width:10px;height:10px;border-radius:2px;background:${colorOf(i)};`;
      const txt = document.createElement('span');
      txt.textContent = g;
      item.append(sw, txt);
      legend.appendChild(item);
    });
    body.appendChild(legend);

    const scrollArea = document.createElement('div');
    const visibleHeight = PADDING * 2 + Math.min(bins.length, MAX_VISIBLE_BINS) * rowPitch;
    scrollArea.style.cssText = `overflow-y:auto;min-height:0;flex:1;max-height:${visibleHeight}px;`;
    body.appendChild(scrollArea);

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;cursor:default;';
    scrollArea.appendChild(canvas);

    const dpr = window.devicePixelRatio || 1;
    const textColor = cssVar('--text-secondary') || '#ccc';
    const hoverBg = cssVar('--bg-hover-row') || '#1d1d1d';
    let hovered: { bin: number; group: number } | null = null;

    // Tooltip.
    card.style.position = 'relative';
    let tooltip = card.querySelector<HTMLElement>('.bc-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'bc-tooltip';
      tooltip.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:50;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:4px;padding:4px 8px;font-size:11px;font-family:system-ui,sans-serif;color:${textColor};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
      card.appendChild(tooltip);
    }
    const tt = tooltip;

    function plotMetrics() {
      const barX = PADDING + CLUSTER_LABEL_WIDTH;
      const barMaxWidth = Math.max(10, canvas.clientWidth - barX - VALUE_WIDTH - PADDING);
      return { barX, barMaxWidth };
    }

    // Returns the (bin, group) sub-bar at a canvas point, or null.
    function subBarAt(offsetX: number, offsetY: number): { bin: number; group: number } | null {
      const bin = Math.floor((offsetY - PADDING) / rowPitch);
      if (bin < 0 || bin >= bins.length) return null;
      const withinCluster = (offsetY - PADDING) - bin * rowPitch;
      const group = Math.floor(withinCluster / (SUBBAR_HEIGHT + SUBBAR_GAP));
      if (group < 0 || group >= groups.length) return null;
      const { barX, barMaxWidth } = plotMetrics();
      if (offsetX < barX || offsetX > barX + barMaxWidth) return null;
      return { bin, group };
    }

    function draw() {
      scrollArea.style.maxHeight = isInModal(card) ? 'none' : `${visibleHeight}px`;
      const width = card.clientWidth - 24;
      const height = PADDING * 2 + bins.length * rowPitch;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';

      const { barX, barMaxWidth } = plotMetrics();

      bins.forEach((bin, bi) => {
        const clusterTop = PADDING + bi * rowPitch;

        // Bin label, vertically centred on the cluster.
        ctx.fillStyle = textColor;
        ctx.textAlign = 'right';
        ctx.fillText(bin.label, PADDING + CLUSTER_LABEL_WIDTH - 8, clusterTop + clusterHeight / 2);

        groups.forEach((_g, gi) => {
          const y = clusterTop + gi * (SUBBAR_HEIGHT + SUBBAR_GAP);
          const count = bin.counts[gi];
          const isHover = hovered && hovered.bin === bi && hovered.group === gi;

          if (isHover) {
            ctx.fillStyle = hoverBg;
            ctx.fillRect(0, y - 1, width, SUBBAR_HEIGHT + 2);
          }
          // track
          ctx.fillStyle = cssVar('--bg-input') || '#222';
          ctx.fillRect(barX, y, barMaxWidth, SUBBAR_HEIGHT);
          // bar
          const w = Math.max(count > 0 ? 1 : 0, (count / maxCount) * barMaxWidth);
          ctx.fillStyle = colorOf(gi);
          ctx.fillRect(barX, y, w, SUBBAR_HEIGHT);
        });

        // Bin total at the right.
        ctx.fillStyle = textColor;
        ctx.textAlign = 'right';
        ctx.fillText(`${bin.total}`, barX + barMaxWidth + VALUE_WIDTH, clusterTop + clusterHeight / 2);
      });
    }

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const hit = subBarAt(e.clientX - rect.left, e.clientY - rect.top);
      const changed = (hit?.bin !== hovered?.bin) || (hit?.group !== hovered?.group);
      hovered = hit;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      if (changed) draw();
      if (hit) {
        const bin = bins[hit.bin];
        const count = bin.counts[hit.group];
        const pct = bin.total > 0 ? (count / bin.total) * 100 : 0;
        const cardRect = card.getBoundingClientRect();
        tt.innerHTML = `<strong>${bin.label}</strong> · ${groups[hit.group]}<br>${count} dies (${pct.toFixed(1)}% of bin)`;
        tt.style.display = 'block';
        tt.style.left = `${e.clientX - cardRect.left + 14}px`;
        tt.style.top = `${e.clientY - cardRect.top + 14}px`;
      } else {
        tt.style.display = 'none';
      }
    });
    canvas.addEventListener('mouseleave', () => { if (hovered) { hovered = null; draw(); } tt.style.display = 'none'; });
    canvas.addEventListener('click', e => {
      const rect = canvas.getBoundingClientRect();
      const hit = subBarAt(e.clientX - rect.left, e.clientY - rect.top);
      if (!hit) return;
      const wfrs = bins[hit.bin].waferIndices[hit.group];
      if (wfrs.length > 0) onOpen(wfrs);
    });

    trackObserver(new ResizeObserver(() => draw())).observe(card);
    draw();
  }

  rebuildBody();
  return card;
}
