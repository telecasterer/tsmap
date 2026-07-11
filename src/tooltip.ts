// Shared themed hover tooltip for tsmap's own chrome (top toolbar, chart-card
// icon buttons, modal-header buttons). Replaces the native `title` attribute,
// which the OS/WebView renders slowly (≈1s delay) in unthemeable black.
//
// Mirrors wmap's in-canvas toolbar tooltip (createTooltip in canvas-adapter/
// toolbar.js) — same dark box, font, and instant show-on-hover — so the app's
// tooltips match the map toolbar's. One singleton element for the whole page:
// because every consumer points at the same node, showing it anywhere hides it
// everywhere else, so a stuck/duplicated tooltip is structurally impossible.

let sharedTooltip: HTMLElement | null = null;

/** The one shared tooltip element, lazily created and appended to <body>.
 *  Always re-appends, even when already connected: CSS breaks z-index ties by
 *  DOM order, so any overlay appended to <body> *after* this element's first
 *  show (any modal, menu, or popup — all of which share --z-tooltip's tier or
 *  land at --z-modal just below it) would otherwise silently out-rank the
 *  tooltip and render it hidden behind them, despite --z-tooltip being the
 *  documented top tier. Moving to the end on every show keeps it truly last
 *  regardless of what else has been appended since. `appendChild` on a node
 *  that's already body's last child is a cheap no-op relocate. */
function getTooltip(): HTMLElement {
  const el = sharedTooltip ?? document.createElement('div');
  if (!sharedTooltip) {
    Object.assign(el.style, {
      position: 'fixed',
      pointerEvents: 'none',
      background: 'rgba(30, 32, 40, 0.93)',
      color: '#f0f0f2',
      border: '1px solid rgba(255,255,255,0.10)',
      padding: '7px 11px',
      borderRadius: '5px',
      fontSize: '13px',
      lineHeight: '1.55',
      maxWidth: '280px',
      whiteSpace: 'pre-wrap',
      // pre-wrap alone only breaks at existing whitespace/newlines — a long
      // unbroken string (e.g. a filesystem path, which has no spaces) has
      // nowhere to wrap and overflows the fixed maxWidth instead of clipping
      // to it. break-word forces a break within such a run when needed.
      overflowWrap: 'break-word',
      // --z-tooltip is the top tier of the app's stacking scale (see index.html
      // :root): above every tsmap overlay and modal, and above wmap's overlay
      // band, so the hint is never clipped behind the chrome it annotates.
      zIndex: 'var(--z-tooltip)',
      display: 'none',
      fontFamily: 'system-ui, sans-serif',
      boxShadow: '0 3px 10px rgba(0,0,0,0.45)',
    } as Partial<CSSStyleDeclaration>);
    sharedTooltip = el;
  }
  document.body.appendChild(el);
  return el;
}

/** Position the tooltip near the pointer, flipping to stay inside the viewport. */
function positionTooltip(tooltip: HTMLElement, clientX: number, clientY: number) {
  tooltip.style.left = '0';
  tooltip.style.top = '0';
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  const margin = 8;
  let x = clientX + 14;
  let y = clientY - 8;
  if (x + tw + margin > window.innerWidth) x = clientX - tw - 6;
  if (y + th + margin > window.innerHeight) y = window.innerHeight - th - margin;
  if (y < margin) y = margin;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hide() {
  if (sharedTooltip) sharedTooltip.style.display = 'none';
}

/**
 * Attach a themed hover tooltip to `el`, replacing the native `title`. `text`
 * may be a string or a getter — pass a getter for buttons whose hint changes at
 * runtime (e.g. a toggle's "Show"/"Hide"). The text may contain inline HTML
 * (e.g. `<strong>`); newlines are honoured via `white-space: pre-wrap`.
 *
 * The element's accessible name is preserved: the resolved text is mirrored to
 * the `data-tip` attribute and, for elements with no other accessible name
 * (icon-only buttons), to `aria-label`. The native `title` is stripped so the
 * slow black OS tooltip can never double-render.
 */
export function attachTooltip(el: HTMLElement, text: string | (() => string)) {
  const resolve = typeof text === 'function' ? text : () => text;

  const syncName = () => {
    const html = resolve();
    const plain = html.replace(/<[^>]+>/g, '');
    el.setAttribute('data-tip', plain); // accessible-name source + debug hook
    if (!el.textContent?.trim()) el.setAttribute('aria-label', plain);
  };
  // Strip the native title so the slow black OS tooltip can't also appear, but
  // keep its content as the accessible name first.
  if (el.getAttribute('title')) el.removeAttribute('title');
  syncName();

  el.addEventListener('mouseenter', e => {
    const tt = getTooltip();
    tt.innerHTML = resolve();
    syncName(); // keep aria-label in step with a getter-driven hint
    tt.style.display = 'block';
    positionTooltip(tt, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
  });
  el.addEventListener('mousemove', e => {
    if (sharedTooltip?.style.display === 'block') {
      positionTooltip(sharedTooltip, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    }
  });
  el.addEventListener('mouseleave', hide);
  // Hide on click so the hint doesn't linger over a freshly opened menu/modal.
  el.addEventListener('click', hide);
}

/**
 * Convert every element under `root` that carries a `title` attribute into a
 * themed tooltip. Used to upgrade the static top-toolbar markup in index.html
 * without rewiring each button by hand.
 */
export function upgradeTitleTooltips(root: ParentNode = document) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[title]'))) {
    const text = el.getAttribute('title');
    if (text) attachTooltip(el, text);
  }
}
