// Correlation matrix panel — Pearson r for every parametric test pair, drawn as
// colour-graduated cells. Clicking a non-diagonal cell calls onSelectPair so the
// scatter panel can update its X/Y in place (no grid rebuild).

import { getColorScheme } from '@paulrobins/wafermap/renderer';
import type { CorrelationMatrix, TestOption } from './types';
import { cardShell, cssVar, trackObserver } from './chartShell';

export interface CorrelationPanelOptions {
  title: string;
  matrix: CorrelationMatrix;
  colorScheme: string;
  /** Total tests before capping — when set and > matrix.tests.length, shows a "top N of M" note. */
  totalTests?: number;
  /** Called when user clicks a non-diagonal cell — use to link scatter X/Y selectors. */
  onSelectPair?: (xTestNumber: number, yTestNumber: number) => void;
  savePng?: (blob: Blob, stem: string) => void;
}

export function renderCorrelationPanel(options: CorrelationPanelOptions): HTMLElement {
  const { title, matrix, colorScheme, totalTests, onSelectPair, savePng } = options;
  const { card, body } = cardShell(title, savePng);

  // Enable horizontal scroll so matrix never clips
  body.style.overflowX = 'auto';

  const hintRow = document.createElement('div');
  hintRow.style.cssText = 'display:flex;align-items:baseline;gap:12px;margin-bottom:6px;flex-wrap:wrap;';
  const hint = document.createElement('span');
  hint.textContent = 'Pearson r · –1 = anti-correlated, +1 = correlated · click cell to view that pair in scatter';
  hint.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;`;
  hintRow.appendChild(hint);
  if (totalTests !== undefined && totalTests > matrix.tests.length) {
    const capNote = document.createElement('span');
    capNote.textContent = `Showing top ${matrix.tests.length} of ${totalTests} tests by mean |r|`;
    capNote.style.cssText = `color:${cssVar('--text-muted')};font-size:11px;font-style:italic;`;
    hintRow.appendChild(capNote);
  }
  card.insertBefore(hintRow, body);

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
