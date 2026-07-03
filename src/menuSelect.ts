// A themed, drop-in replacement for a grouped native <select>. tsmap uses this
// where a native select misbehaves in the Linux WebView (WebKitGTK): the open
// popup ignores CSS `color-scheme` (renders in the desktop GTK theme) and, near
// a viewport edge with many items, clips off-screen instead of scrolling/flipping.
// A DOM-based menu is fully themeable and identical on every target (Tauri
// Linux/Windows/macOS + web), because there's no native popup chrome involved.
//
// Same call shape as `makeSelect` but grouped: `makeMenuSelect(groups, current,
// onChange)` returns a trigger button. Migrate other selects to it opportunistically.
//
// Accessibility: the trigger is a `combobox`/`listbox` opener; the popup is a
// `listbox` with `option` rows. Full keyboard support — ArrowUp/Down move the
// active option, Home/End jump, Enter/Space select, Esc closes, printable keys
// type-ahead. Focus returns to the trigger on close. Matches what the native
// <select> provided.

import { cssVar } from './charts/chartShell';

export interface MenuOption { value: string; label: string }
export interface MenuGroup { group: string; options: ReadonlyArray<MenuOption> }

const OPEN_MENUS = new Set<() => void>(); // close-fns of currently open menus (only ever 0 or 1)

/**
 * Build a grouped dropdown as a trigger button + on-demand popup listbox.
 * @param groups   option groups, in display order
 * @param current  initially-selected value
 * @param onChange called with the chosen value on selection
 * @param opts.ariaLabel accessible name for the control (e.g. "Colour theme")
 */
export function makeMenuSelect(
  groups: ReadonlyArray<MenuGroup>,
  current: string,
  onChange: (value: string) => void,
  opts: { ariaLabel?: string } = {},
): HTMLButtonElement {
  const flat: MenuOption[] = groups.flatMap(g => g.options);
  let selected = current;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (opts.ariaLabel) trigger.setAttribute('aria-label', opts.ariaLabel);
  trigger.style.cssText = [
    'display:inline-flex', 'align-items:center', 'gap:6px',
    'font-size:12px', 'padding:2px 8px', 'height:24px',
    'background:var(--bg-input)', 'color:var(--text-secondary)',
    'border:1px solid var(--border-mid)', 'border-radius:4px',
    'cursor:pointer', 'white-space:nowrap',
  ].join(';');

  const labelSpan = document.createElement('span');
  const caret = document.createElement('span');
  caret.textContent = '▾';
  caret.style.cssText = 'font-size:10px;color:var(--text-muted);flex-shrink:0;';
  trigger.append(labelSpan, caret);

  const syncLabel = () => {
    labelSpan.textContent = flat.find(o => o.value === selected)?.label ?? selected;
  };
  syncLabel();

  // ── Popup (built lazily on open, torn down on close) ─────────────────────
  let popup: HTMLElement | null = null;
  let activeIdx = -1;               // index into `flat` of the keyboard-active option
  let rowEls: HTMLElement[] = [];   // parallel to `flat`
  let typeahead = '';
  let typeaheadTimer: number | undefined;

  function isOpen(): boolean { return popup !== null; }

  function setActive(idx: number): void {
    if (idx < 0 || idx >= rowEls.length) return;
    if (activeIdx >= 0) rowEls[activeIdx].style.background = '';
    activeIdx = idx;
    const el = rowEls[idx];
    el.style.background = cssVar('--bg-hover-row');
    el.scrollIntoView({ block: 'nearest' });
    popup?.setAttribute('aria-activedescendant', el.id);
  }

  function choose(value: string): void {
    if (value !== selected) { selected = value; syncLabel(); onChange(value); }
    close();
  }

  function open(): void {
    if (isOpen()) return;
    // Only one menu open at a time.
    for (const c of OPEN_MENUS) c();

    popup = document.createElement('div');
    popup.setAttribute('role', 'listbox');
    if (opts.ariaLabel) popup.setAttribute('aria-label', opts.ariaLabel);
    popup.style.cssText = [
      'position:fixed', 'z-index:var(--z-tooltip)',
      'background:var(--bg-overlay)', 'color:var(--text-secondary)',
      'border:1px solid var(--border-mid)', 'border-radius:6px',
      'box-shadow:0 6px 20px rgba(0,0,0,0.35)',
      'padding:4px', 'overflow-y:auto', 'min-width:160px',
      'font-size:12px', 'font-family:system-ui,sans-serif',
    ].join(';');

    rowEls = [];
    let flatIdx = 0;
    const uid = Math.random().toString(36).slice(2, 8);
    for (const g of groups) {
      const header = document.createElement('div');
      header.setAttribute('role', 'presentation');
      header.textContent = g.group;
      header.style.cssText = `padding:4px 8px 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:${cssVar('--text-muted')};`;
      popup.appendChild(header);

      for (const o of g.options) {
        const idx = flatIdx++;
        const row = document.createElement('div');
        row.id = `menuopt-${uid}-${idx}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(o.value === selected));
        row.textContent = o.label;
        row.style.cssText = 'padding:5px 10px;border-radius:4px;cursor:pointer;white-space:nowrap;';
        if (o.value === selected) row.style.color = cssVar('--accent');
        row.addEventListener('mouseenter', () => setActive(idx));
        row.addEventListener('click', () => choose(o.value));
        popup.appendChild(row);
        rowEls.push(row);
      }
    }

    document.body.appendChild(popup);
    positionPopup();
    trigger.setAttribute('aria-expanded', 'true');
    OPEN_MENUS.add(close);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onOutsidePointer, true);
    window.addEventListener('blur', close); // alt-tab in a WebView won't fire outside-pointer
    window.addEventListener('resize', close);

    // Activate the selected option (or first) for keyboard start point.
    const sel = flat.findIndex(o => o.value === selected);
    setActive(sel >= 0 ? sel : 0);
  }

  function positionPopup(): void {
    if (!popup) return;
    const r = trigger.getBoundingClientRect();
    const margin = 8;
    // Cap height to whichever side has more room, so it scrolls instead of clipping.
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    const openUp = below < 200 && above > below;
    popup.style.maxHeight = `${Math.max(120, (openUp ? above : below))}px`;

    // Measure after max-height is set.
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    let left = r.left;
    if (left + pw + margin > window.innerWidth) left = window.innerWidth - pw - margin;
    if (left < margin) left = margin;
    popup.style.left = `${left}px`;
    if (openUp) popup.style.top = `${Math.max(margin, r.top - ph - 4)}px`;
    else        popup.style.top = `${r.bottom + 4}px`;
  }

  function close(): void {
    if (!popup) return;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    OPEN_MENUS.delete(close);
    popup.remove();
    popup = null;
    activeIdx = -1;
    rowEls = [];
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    trigger.focus();
  }

  function onOutsidePointer(e: PointerEvent): void {
    const t = e.target as Node;
    if (popup && !popup.contains(t) && !trigger.contains(t)) close();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!isOpen()) return;
    switch (e.key) {
      case 'Escape':    e.preventDefault(); close(); break;
      case 'ArrowDown': e.preventDefault(); setActive(Math.min(activeIdx + 1, rowEls.length - 1)); break;
      case 'ArrowUp':   e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); break;
      case 'Home':      e.preventDefault(); setActive(0); break;
      case 'End':       e.preventDefault(); setActive(rowEls.length - 1); break;
      case 'Enter':
      case ' ':         e.preventDefault(); if (activeIdx >= 0) choose(flat[activeIdx].value); break;
      case 'Tab':       close(); break; // let focus move naturally after closing
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          typeahead += e.key.toLowerCase();
          window.clearTimeout(typeaheadTimer);
          typeaheadTimer = window.setTimeout(() => { typeahead = ''; }, 600);
          const hit = flat.findIndex(o => o.label.toLowerCase().startsWith(typeahead));
          if (hit >= 0) setActive(hit);
        }
    }
  }

  trigger.addEventListener('click', () => { if (isOpen()) close(); else open(); });
  trigger.addEventListener('keydown', e => {
    if (!isOpen() && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      open();
    }
  });

  return trigger;
}
