// Wraps the in-app user-guide fragment (USER_GUIDE_HTML — a <style> block plus
// `.tsmap-guide` content that references tsmap's --var theme tokens) into a
// standalone, self-contained HTML document for opening in an external browser
// (via platform.openReport → browser Print / Save-as-PDF).
//
// The page is deliberately LIGHT-THEMED regardless of the app's current theme:
// it's for paper and PDF, where a dark background wastes ink and reads poorly.
// We define light values for exactly the --var tokens the guide's own styles
// use, so the fragment resolves against them unchanged — no need to rewrite the
// generated guide CSS.

import { USER_GUIDE_HTML } from './userGuideHtml';

// Light, print-friendly values for the theme tokens the guide fragment
// references. Sourced from index.html's light-theme block. Keep in sync if the
// guide starts using a new --var token (any missing token renders as its CSS
// default — usually harmless, but text/border tokens would look wrong).
const LIGHT_TOKENS = `
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

/** A complete, standalone light-themed HTML document of the user guide. */
export function userGuidePrintHtml(appVersion: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tsmap user guide</title>
<style>
  :root {${LIGHT_TOKENS}}
  html { background: #fff; }
  body {
    margin: 0; background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    color: #111;
  }
  /* Centred reading column with page margins — matches the in-app cap. */
  .guide-page { max-width: 780px; margin: 0 auto; padding: 32px 28px 64px; }
  .guide-print-header {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; margin-bottom: 20px; padding-bottom: 10px;
    border-bottom: 1px solid #ddd;
  }
  .guide-print-header h1 { margin: 0; font-size: 20px; color: #111; }
  .guide-print-header .ver { font-size: 12px; color: #666; }
  /* Images/mockups shouldn't overflow the print column. */
  .tsmap-guide img, .tsmap-guide table { max-width: 100%; }
  @media print {
    /* Let the browser use its own page margins; avoid a huge blank top margin. */
    .guide-page { padding: 0; max-width: none; }
    /* Don't split headings/mockups across a page break where avoidable. */
    .tsmap-guide h1, .tsmap-guide h2, .tsmap-guide h3, .tsmap-guide h4 { break-after: avoid; }
    .tsmap-guide pre, .tsmap-guide table { break-inside: avoid; }
    a { color: #000; text-decoration: underline; }
  }
</style>
</head>
<body>
  <div class="guide-page">
    <div class="guide-print-header">
      <h1>tsmap user guide</h1>
      <span class="ver">v${escapeHtml(appVersion)}</span>
    </div>
    ${USER_GUIDE_HTML}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
