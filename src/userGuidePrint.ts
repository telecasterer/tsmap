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
import { LIGHT_TOKENS } from './printTheme';

// Wider than the in-app modal's --guide-content-width (index.html) — this
// page is a standalone browser tab/print target, not a fixed-size dialog box,
// so there's no reason to cap it as tightly. The mockup/screenshot images
// (max-width: 100% of this column) are the reason: readable text in
// screenshots needs real pixels, not the modal's narrower reading column.
const GUIDE_TOKENS = `${LIGHT_TOKENS}\n  --guide-content-width: 1400px;\n`;

// The guide fragment ships images as `<img data-src="...">` rather than
// `src` so the in-app modal can gate loading on a reachability probe (see
// guideImages.ts) before fetching from GitHub Pages. This print page opens in
// the system browser instead of the Tauri webview, where fetching a remote
// https image from a file:// document is an ordinary resource load with no
// probe needed — so promote data-src to src directly here. Without this the
// print/PDF page has no script to do the promotion and every image is
// silently missing.
function promoteGuideImages(html: string): string {
  return html.replace(
    /<img data-src="([^"]*)"/g,
    (_, url) => `<img src="${url}" onerror="this.style.display='none'"`
  );
}

/** A complete, standalone light-themed HTML document of the user guide. */
export function userGuidePrintHtml(appVersion: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tsmap user guide</title>
<style>
  :root {${GUIDE_TOKENS}}
  html { background: #fff; }
  body {
    margin: 0; background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    color: #111;
  }
  /* Centred reading column with page margins — matches the in-app cap. */
  .guide-page { max-width: 1460px; margin: 0 auto; padding: 32px 28px 64px; }
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
    ${promoteGuideImages(USER_GUIDE_HTML)}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
