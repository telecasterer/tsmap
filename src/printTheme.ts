// Shared light-theme CSS-var block for standalone print/PDF pages opened via
// platform.openReport (the user guide's print button, the lot report). These
// pages are deliberately LIGHT-THEMED regardless of the app's current theme:
// they're for paper and PDF, where a dark background wastes ink and reads
// poorly. Values sourced from index.html's light-theme block — keep in sync
// if a page starts using a new --var token (any missing token renders as its
// CSS default, usually harmless, but text/border tokens would look wrong).
export const LIGHT_TOKENS = `
  --accent: #1a6bbf;
  --bg-input: #fff;
  --bg-modal: #fff;
  --bg-overlay: #fff;
  --bg-toolbar: #f0f0f0;
  --bg-row-border: #e8e8e8;
  --border-strong: #ccc;
  --border-mid: #bbb;
  --border-muted: #bbb;
  --border-dim: #aaa;
  --border-subtle: #d8d8d8;
  --text-primary: #111;
  --text-secondary: #222;
  --text-tertiary: #333;
  --text-muted: #555;
  --text-dim: #666;
  --text-light: #1a1a1a;
  --text-subdued: #444;
  --error-text: #b91c1c;
  --warn-text: #92400e;
`;
