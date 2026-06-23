// Shared chrome and helpers for every chart panel: the card shell, the expand
// modal, PNG save, icon buttons, and small canvas/formatting utilities. Each
// per-chart module (boxplot.ts, histogram.ts, …) imports from here so the panel
// files contain only their own drawing logic.

import type { ChartDatum, ChartKind } from './types';
import { ICONS } from './icons';

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
  /**
   * Optional self-contained segmented control (yield sort, hard/soft bins).
   * When present the panel renders a radio group and, on change, recomputes its
   * own data and redraws in place — never rebuilding the charts grid (which
   * would destroy a card currently reparented into the expand modal). The
   * `current` value is persisted by the caller via `onChange`.
   */
  selfControl?: {
    current: string;
    options: Array<[value: string, label: string]>;
    /** Returns fresh data (and optionally a new title) for the chosen value. */
    onChange: (value: string) => { data: ChartDatum[]; title?: string };
  };
}

export interface RenderChartsOptions {
  onOpen: (waferIndices: number[], datum: ChartDatum) => void;
  onOpenSelection: (waferIndices: number[], data: ChartDatum[]) => void;
  savePng?: (blob: Blob, stem: string) => void;
  getHeaderLines?: (title: string) => { title: string; subtitle: string };
}

// ── Shared layout constants ─────────────────────────────────────────────────────
// Used across multiple panels; each panel also defines its own panel-specific
// row/label sizes (BOX_*, HIST_*, …).

export const PADDING = 12;
export const VALUE_WIDTH = 100;

// ── Fill-height canvas (grid vs modal) ──────────────────────────────────────────
// In the grid the card row is content-sized, so a fill-canvas must use a fixed
// height — anything percentage/flex-based feeds back into the card and grows
// unboundedly. In the expand modal the card has a flex-allocated height (bounded
// by the modal box), so the canvas should fill the space the body gives it.
//
// The trick that makes this stable: while in the modal the canvas is taken out
// of flow (`position:absolute; inset:0`), so its own size can no longer change
// `body.clientHeight`. That breaks the canvas→body→draw growth loop and lets the
// body's flex height be the authoritative source. `chartFillHeight` returns the
// height a fill-canvas should draw at, and `applyCanvasFlow` toggles the
// canvas's positioning to match. Both key off `card.dataset.inModal`, which
// openExpandModal sets/clears.

/** True when the card is currently reparented into the expand modal. */
export function isInModal(card: HTMLElement): boolean {
  return card.dataset.inModal === '1';
}

/**
 * Height (CSS px) a fill-style canvas should use. In the grid this is the fixed
 * `gridHeight`. In the modal it's the body's flex-allocated height (minus any
 * non-canvas siblings such as a legend/stats row), with `gridHeight` as a floor.
 */
export function chartFillHeight(card: HTMLElement, body: HTMLElement, canvas: HTMLCanvasElement, gridHeight: number): number {
  if (!isInModal(card)) return gridHeight;
  // Subtract the height of body siblings that sit above the canvas (legend, stats
  // label, …). With the canvas absolutely positioned it no longer contributes to
  // body's own height, so body.clientHeight is the full available space.
  let siblingHeight = 0;
  for (const child of Array.from(body.children)) {
    if (child !== canvas) siblingHeight += (child as HTMLElement).offsetHeight;
  }
  return Math.max(gridHeight, body.clientHeight - siblingHeight);
}

/**
 * Toggle a fill-canvas between in-flow (grid) and absolutely positioned (modal).
 * Call once per draw, before computing height with `chartFillHeight`. When the
 * canvas has body siblings above it (legend/stats), pass `topOffset` so the
 * absolute canvas starts below them rather than overlapping.
 */
export function applyCanvasFlow(card: HTMLElement, canvas: HTMLCanvasElement, topOffset = 0): void {
  if (isInModal(card)) {
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.right = '0';
    canvas.style.top = `${topOffset}px`;
    canvas.style.bottom = '0';
  } else {
    canvas.style.position = '';
    canvas.style.left = canvas.style.right = canvas.style.top = canvas.style.bottom = '';
  }
}

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

/** Trigger a PNG save of a canvas element. Routes through savePng when provided (Tauri native dialog); falls back to browser download. */
export function saveCanvasPng(
  canvas: HTMLCanvasElement,
  filename: string,
  savePng?: (blob: Blob, stem: string) => void,
  headerLines?: { title: string; subtitle: string },
) {
  const dpr = window.devicePixelRatio || 1;
  const HEADER_H = headerLines ? 40 : 0;

  // Composite onto a white background so the exported PNG is opaque.
  // If headerLines provided, prepend a header strip above the chart content.
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height + HEADER_H * dpr;
  const ctx = flat.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, flat.width, flat.height);

  if (headerLines) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillStyle = '#222222';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(headerLines.title, 12, 16);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#555555';
    ctx.fillText(headerLines.subtitle, 12, 30);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  ctx.drawImage(canvas, 0, HEADER_H * dpr);
  flat.toBlob(blob => {
    if (!blob) return;
    if (savePng) {
      savePng(blob, filename);
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, 'image/png');
}

/**
 * Segmented radio control — a small inline group of mutually-exclusive options.
 * Use instead of a `<select>` when there are only two or three choices. Each
 * option is a real `<input type="radio">` (one shared `name`) wrapped in a label,
 * so keyboard/SR semantics are correct. `onChange` fires with the chosen value.
 */
export function makeSegmented(
  options: Array<[value: string, label: string]>,
  current: string,
  onChange: (value: string) => void,
): HTMLElement {
  const group = document.createElement('div');
  group.setAttribute('role', 'radiogroup');
  group.style.cssText = `display:inline-flex;border:1px solid ${cssVar('--border-mid')};border-radius:4px;overflow:hidden;`;
  const name = `seg-${Math.random().toString(36).slice(2, 9)}`;
  const paints: Array<() => void> = [];

  options.forEach(([value, text], i) => {
    const label = document.createElement('label');
    label.style.cssText = `display:inline-flex;align-items:center;font-size:12px;padding:3px 10px;cursor:pointer;user-select:none;${i > 0 ? `border-left:1px solid ${cssVar('--border-mid')};` : ''}`;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = value;
    radio.checked = value === current;
    // The radio is visually hidden; the label background communicates selection.
    radio.style.cssText = 'position:absolute;opacity:0;width:0;height:0;';

    const paint = () => {
      label.style.background = radio.checked ? cssVar('--accent') : cssVar('--bg-input');
      label.style.color = radio.checked ? cssVar('--text-white') || '#fff' : cssVar('--text-secondary');
    };
    paints.push(paint);
    paint();

    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      for (const p of paints) p();
      onChange(value);
    });

    label.append(radio, document.createTextNode(text));
    group.appendChild(label);
  });

  return group;
}

export function makeIconBtn(svg: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.title = title;
  btn.setAttribute('aria-label', title); // icon-only button — give SRs a name
  btn.innerHTML = svg; // wmap-aligned Lucide SVG; inherits color via currentColor
  // Bordered box matching wmap's gallery-card buttons (themed via tsmap tokens).
  Object.assign(btn.style, {
    border: `1px solid ${cssVar('--border-mid')}`, borderRadius: '4px',
    background: cssVar('--bg-input'), cursor: 'pointer',
    color: cssVar('--text-muted'), padding: '0', lineHeight: '1',
    flexShrink: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '24px', height: '24px',
  });
  btn.addEventListener('mouseenter', () => {
    btn.style.borderColor = cssVar('--accent');
    btn.style.color = cssVar('--accent');
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.borderColor = cssVar('--border-mid');
    btn.style.color = cssVar('--text-muted');
  });
  return btn;
}

export function makeExpandBtn(card: HTMLElement, title: string): HTMLElement {
  const btn = makeIconBtn(ICONS.expand, 'Expand (E)');
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

export function cardShell(title: string, savePng?: (blob: Blob, stem: string) => void, getHeaderLines?: () => { title: string; subtitle: string }): { card: HTMLElement; heading: HTMLElement; controlsRow: HTMLElement; body: HTMLElement; saveCanvas: (filename: string) => void } {
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.style.cssText = `display:flex;flex-direction:column;background:${cssVar('--bg-overlay')};border:1px solid ${cssVar('--border-subtle')};border-radius:6px;padding:12px;min-width:0;`;

  const headingRow = document.createElement('div');
  headingRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;';
  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.cssText = `color:${cssVar('--text-primary')};font-size:13px;font-weight:600;flex:1;`;
  headingRow.appendChild(heading);

  const saveBtn = makeIconBtn(ICONS.download, 'Save as PNG');
  headingRow.appendChild(saveBtn);
  const expandBtn = makeExpandBtn(card, title);
  headingRow.appendChild(expandBtn);
  card.appendChild(headingRow);

  const controlsRow = document.createElement('div');
  controlsRow.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;align-items:center;';
  card.appendChild(controlsRow);

  const body = document.createElement('div');
  // position:relative anchors a fill-canvas's `inset` when it goes absolute in the modal.
  body.style.cssText = 'overflow-y:auto;min-height:0;flex:1;position:relative;';
  card.appendChild(body);

  function saveCanvas(filename: string) {
    const canvas = card.querySelector<HTMLCanvasElement>('canvas');
    if (canvas) saveCanvasPng(canvas, filename, savePng, getHeaderLines?.());
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

  const titleId = `chart-modal-title-${Math.random().toString(36).slice(2, 9)}`;

  const box = document.createElement('div');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', titleId);
  box.tabIndex = -1; // focus target on open
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
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '10px 14px', flexShrink: '0',
    borderBottom: `1px solid ${cssVar('--border-subtle')}`,
  });
  const titleEl = document.createElement('span');
  titleEl.id = titleId;
  titleEl.textContent = title;
  Object.assign(titleEl.style, { flex: '1', fontWeight: '600', fontSize: '13px', color: cssVar('--text-primary') });

  const modalBtnStyle: Partial<CSSStyleDeclaration> = {
    border: `1px solid ${cssVar('--border-mid')}`, borderRadius: '4px',
    background: cssVar('--bg-input'), cursor: 'pointer',
    color: cssVar('--text-muted'), padding: '0', lineHeight: '1',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '24px', height: '24px', // match the card buttons (makeIconBtn) for one consistent size
  };
  const hoverIn = (b: HTMLElement) => { b.style.borderColor = cssVar('--accent'); b.style.color = cssVar('--accent'); };
  const hoverOut = (b: HTMLElement) => { b.style.borderColor = cssVar('--border-mid'); b.style.color = cssVar('--text-muted'); };

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.innerHTML = ICONS.maximize;
  fullscreenBtn.title = 'Fullscreen (F)';
  fullscreenBtn.setAttribute('aria-label', 'Fullscreen');
  Object.assign(fullscreenBtn.style, modalBtnStyle);
  fullscreenBtn.addEventListener('mouseenter', () => hoverIn(fullscreenBtn));
  fullscreenBtn.addEventListener('mouseleave', () => hoverOut(fullscreenBtn));

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = ICONS.close;
  closeBtn.title = 'Close (Esc)';
  closeBtn.setAttribute('aria-label', 'Close');
  Object.assign(closeBtn.style, modalBtnStyle);
  closeBtn.addEventListener('mouseenter', () => hoverIn(closeBtn));
  closeBtn.addEventListener('mouseleave', () => hoverOut(closeBtn));
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
  box.focus(); // move focus into the dialog so Esc/F and SR navigation work

  function close() {
    document.removeEventListener('keydown', onKeyDown);
    delete card.dataset.inModal;
    document.body.style.overflow = savedOverflow;
    card.setAttribute('style', savedCardStyle);
    if (originalParent) {
      originalParent.insertBefore(card, originalNext);
    }
    backdrop.remove();
  }

  // "Fullscreen" here is a CSS maximize — the box grows to fill the viewport.
  // We deliberately avoid the real Fullscreen API: WKWebView (macOS Tauri) has
  // element fullscreen disabled unless `macOSPrivateApi` is enabled, and that
  // uses Apple private API. CSS maximize behaves identically on every target.
  let maximized = false;
  const applyMaximize = () => {
    fullscreenBtn.innerHTML = maximized ? ICONS.shrink : ICONS.maximize;
    fullscreenBtn.title = maximized ? 'Restore (F)' : 'Maximize (F)';
    if (maximized) {
      box.style.borderRadius = '0'; box.style.resize = 'none';
      box.style.width = '100vw'; box.style.height = '100vh';
    } else {
      box.style.borderRadius = '10px'; box.style.resize = 'both';
      box.style.width = 'min(92vw, 1100px)'; box.style.height = 'min(88vh, 800px)';
    }
  };
  const toggleFullscreen = () => { maximized = !maximized; applyMaximize(); };
  fullscreenBtn.addEventListener('click', toggleFullscreen);

  function onKeyDown(e: KeyboardEvent) {
    const active = document.activeElement;
    const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA');
    if (e.key === 'Escape') { close(); return; }
    if ((e.key === 'f' || e.key === 'F') && !inInput) toggleFullscreen();
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKeyDown);
}
