// Shared chrome and helpers for every chart panel: the card shell, the expand
// modal, PNG save, icon buttons, and small canvas/formatting utilities. Each
// per-chart module (boxplot.ts, histogram.ts, …) imports from here so the panel
// files contain only their own drawing logic.

import type { ChartDatum, ChartKind } from './types';

// ── ResizeObserver lifecycle ───────────────────────────────────────────────────

const activeObservers: ResizeObserver[] = [];

export function trackObserver(ro: ResizeObserver): ResizeObserver {
  activeObservers.push(ro);
  return ro;
}

export function disconnectAllObservers() {
  for (const ro of activeObservers) ro.disconnect();
  activeObservers.length = 0;
}

// ── Shared types ────────────────────────────────────────────────────────────────

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

// ── Shared layout constants ─────────────────────────────────────────────────────
// Used across multiple panels; each panel also defines its own panel-specific
// row/label sizes (BOX_*, HIST_*, …).

export const PADDING = 12;
export const VALUE_WIDTH = 100;

// ── Canvas / formatting utilities ───────────────────────────────────────────────

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? `${v}` : v.toFixed(2);
}

/** Draw a unit label once at the far end of an axis. */
export function drawAxisUnit(ctx: CanvasRenderingContext2D, unit: string, x: number, y: number) {
  const prev = { textAlign: ctx.textAlign, textBaseline: ctx.textBaseline, fillStyle: ctx.fillStyle, font: ctx.font };
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = cssVar('--text-muted') || '#888';
  ctx.fillText(`(${unit})`, x, y);
  Object.assign(ctx, prev);
}

/** Trigger a PNG download of a canvas element. Uses a blob: URL so the Tauri download intercept fires. */
export function saveCanvasPng(canvas: HTMLCanvasElement, filename: string) {
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

export function makeIconBtn(icon: string, title: string): HTMLButtonElement {
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

export function makeExpandBtn(card: HTMLElement, title: string): HTMLElement {
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

export function cardShell(title: string): { card: HTMLElement; heading: HTMLElement; controlsRow: HTMLElement; body: HTMLElement; saveCanvas: (filename: string) => void } {
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

// ── Expand modal ──────────────────────────────────────────────────────────────

/**
 * Open a card in a fullscreen resizable modal. The card element is reparented
 * into the modal; closing it returns the card to its original position.
 */
export function openExpandModal(card: HTMLElement, title: string) {
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
