// Shared icon set for tsmap's icon buttons (toolbar, modal chrome, test
// selector), aligned with the wmap library so the two
// UIs (tsmap chrome + embedded wmap wafer maps) read as one. These are Lucide
// SVGs copied verbatim from wmap's generated icon module
// (`../wmap/packages/canvas-adapter/icons.ts`, source SVGs in
// `../wmap/docs/images/icons/`): `download` (camera), `expand` (corner arrows),
// `maximize`/`minimize` (fullscreen enter/exit), `close` (x), `help`.
//
// They are COPIED, not imported: wmap marks its icon module internal and does
// not export it. Keep these in sync with wmap; the proper fix — wmap exporting
// its icon set — is logged in WMAP_ISSUES.md (#16). Stroke-width 1.8 matches the
// wmap source. One icon (`printer`) is tsmap-local and NOT from wmap — see its
// note below.
//
// Semantic distinction (must not collide visually): `expand` opens a card in the
// modal (corner arrows); `maximize`/`minimize` toggle fullscreen INSIDE the modal
// (corner brackets). They are deliberately different shapes.
//
// All use `stroke="currentColor"` / `fill="none"` and carry no hardcoded colour,
// so they inherit the button's CSS `color` (a tsmap `--var`) and follow the
// active theme automatically. Per-icon width/height are tuned so they read as
// equal optical weight in the toolbar.

export const ICONS = {
  // Camera — "save the current view as an image" (wmap `download`).
  download: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/><circle cx="12" cy="13" r="3"/></svg>`,

  // Expand a card into the modal — diagonal arrows to opposite corners (wmap `expand`).
  expand: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>`,

  // Enter fullscreen (in modal) — corner brackets pointing outward (wmap `maximize`).
  maximize: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,

  // Exit fullscreen — corner brackets pointing inward (wmap `minimize`).
  shrink: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>`,

  // Close — Lucide `x` (wmap `close`).
  close: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,

  // Help — circle with a question mark (wmap `help`).
  help: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,

  // Printer — Lucide `printer`. tsmap-LOCAL (not from wmap): the user-guide
  // print/save action has no wmap counterpart, so this icon is not part of the
  // wmap sync set above. Do not expect it in wmap's icon module.
  printer: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg>`,
} as const;
