// App theme selection. tsmap's colours are driven by a `data-theme` attribute
// on <html> (see the token blocks in index.html). This module owns applying
// that attribute, persisting the choice to localStorage, and notifying the app
// when the theme changes so it can re-render the wmap canvas (whose colours are
// resolved from CSS at draw time, not live-bound).
//
// Modes:
//   'auto'        — no attribute; dark by default, light via the OS media query
//   'dark'        — force dark
//   'light'       — force light
//   'light-green' — light with a green (#8DC63F-derived) accent

export type Theme =
  | 'auto'
  | 'light' | 'light-green' | 'solarized-light' | 'high-contrast'
  | 'dark' | 'nord' | 'solarized-dark';

/** Themes grouped for the picker's <optgroup>s, in display order. */
export const THEME_GROUPS: ReadonlyArray<{
  group: string;
  themes: ReadonlyArray<{ value: Theme; label: string }>;
}> = [
  { group: 'System', themes: [
    { value: 'auto', label: 'Auto (system)' },
  ] },
  { group: 'Light', themes: [
    { value: 'light',           label: 'Light' },
    { value: 'light-green',     label: 'Light green' },
    { value: 'solarized-light', label: 'Solarized Light' },
    { value: 'high-contrast',   label: 'High contrast' },
  ] },
  { group: 'Dark', themes: [
    { value: 'dark',           label: 'Dark' },
    { value: 'nord',           label: 'Nord' },
    { value: 'solarized-dark', label: 'Solarized Dark' },
  ] },
];

/** Flat list of every theme value, for validation. */
const ALL_THEME_VALUES: ReadonlySet<string> =
  new Set(THEME_GROUPS.flatMap(g => g.themes.map(t => t.value)));

const STORAGE_KEY = 'tsmap-theme';
const listeners = new Set<() => void>();

function isTheme(v: string | null): v is Theme {
  return v !== null && ALL_THEME_VALUES.has(v);
}

/** The persisted theme, or 'auto' when unset/invalid. */
export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Apply `theme` to <html> (auto = remove the attribute) and persist it. */
export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
  for (const fn of listeners) fn();
}

/**
 * Subscribe to theme changes — fired on an explicit setTheme AND on an OS
 * light/dark flip while in 'auto' (since that changes resolved colours without
 * touching the attribute). Returns an unsubscribe function. Used by main.ts to
 * re-render the wmap view so its canvas re-resolves the palette.
 */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Apply the persisted theme at startup and wire the OS-scheme listener. Call once. */
export function initTheme(): void {
  setTheme(getTheme());
  // In 'auto', an OS light/dark flip changes colours with no attribute change —
  // notify listeners so the canvas re-resolves. (wmap also listens internally,
  // but tsmap's own modal/menuSelect chrome reads cssVar at build time and need the nudge.)
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getTheme() === 'auto') for (const fn of listeners) fn();
    });
  }
}

/** Read a CSS custom property's current resolved value (e.g. `cssVar('--accent')`). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
