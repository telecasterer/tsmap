// Compiles docs/user-guide.md → guide-dist/index.html + guide-dist/images/*
// — a single, self-contained, offline-capable HTML page. This is now the ONLY
// rendering of the guide: it's opened directly (via platform.openGuide(), see
// src/platform.ts) whether the app is running offline in Tauri (bundled as a
// resource, see tauri.conf.json) or online in the browser (served from the
// web build's own origin). There is no separate in-app-modal renderer and no
// separate print-page renderer any more — a real HTML page opened in a real
// browser gets native Ctrl+P / Save-as-PDF for free.
//
// Run manually with: npm run build:guide
// Runs automatically via predev / prebuild hooks.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'fs';
import { marked, Renderer } from 'marked';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// Written into public/ (Vite's static-asset passthrough) so the same build
// output serves both consumers with zero extra copy step: `vite dev`/`vite
// build` expose it at the relative URL /guide/ for the web build, and
// tauri.conf.json's bundle.resources points at this same directory for the
// desktop build (offline-capable — see src/platform.ts's openGuide()).
const OUT_DIR = join(ROOT, 'public/guide');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// ── Slugify heading text to stable anchor IDs (same algorithm as wmap) ────────
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── PNG intrinsic size (just enough of the format to read IHDR) ───────────────
// scripts/capture-screenshots.mjs always captures at deviceScaleFactor: 2 (for
// crisp text in the doc images), so every PNG's pixel dimensions are 2x its
// true captured CSS size. Without an explicit width/height, a browser renders
// an <img> at its raw pixel size — i.e. every screenshot in the guide would
// display at literally double its real size. Most obvious on small dialogs
// (e.g. the append-confirm modal), since large full-viewport captures already
// get clamped down by .tsmap-guide img's max-width:100% regardless. Reading
// each PNG's real dimensions and halving them for the emitted width/height
// fixes this once, for every image, rather than hand-tuning CSS per image.
function pngDimensions(filePath) {
  const buf = readFileSync(filePath);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ── Custom renderer: heading IDs, local relative images ───────────────────────
const renderer = new Renderer();

renderer.heading = ({ text, depth }) => {
  const id = slugify(text.replace(/<[^>]+>/g, ''));
  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};

// Images are bundled alongside this page (copied from docs/images/ into
// guide-dist/images/ below) and referenced with a plain relative src — no
// reachability probing needed, this is a real file sitting next to a real page.
renderer.image = ({ href, text }) => {
  const rel = /^https?:\/\//.test(href) ? href : `images/${href.replace(/^images\//, '')}`;
  const alt = text ? ` alt="${text}"` : '';
  let sizeAttrs = '';
  if (!/^https?:\/\//.test(href)) {
    const srcPath = join(ROOT, 'docs/images', href.replace(/^images\//, ''));
    try {
      const { width, height } = pngDimensions(srcPath);
      sizeAttrs = ` width="${Math.round(width / 2)}" height="${Math.round(height / 2)}"`;
    } catch { /* non-PNG or unreadable — fall back to natural (2x) size */ }
  }
  return `<img src="${rel}"${sizeAttrs}${alt}>`;
};

marked.setOptions({ renderer });

// ── Read and pre-process markdown ─────────────────────────────────────────────
let md = readFileSync(join(ROOT, 'docs/user-guide.md'), 'utf8');

// Strip YAML frontmatter
md = md.replace(/^---\n[\s\S]*?\n---\n/, '');

// ── Render to HTML ────────────────────────────────────────────────────────────
let html = await marked(md);

// ── Rewrite internal anchor links to scrollIntoView (smooth-scrolls within
// the page rather than a hash-navigation reload) ───────────────────────────────
html = html.replace(
  /href="#([^"]+)"/g,
  (_, id) =>
    `href="#${id}" onclick="(function(e){e.preventDefault();var t=document.querySelector('.tsmap-guide [id=\\'${id}\\']');if(t)t.scrollIntoView({behavior:'smooth'});})(event)"`
);

// ── Light theme tokens ─────────────────────────────────────────────────────────
// This is now a standalone page (no host app :root to inherit from), so it
// carries its own fixed light-theme values — the same ones src/printTheme.ts's
// LIGHT_TOKENS used for the old print-only page. Kept as a plain literal here
// (this script runs under plain Node, not the app's TS build) rather than
// importing printTheme.ts; printTheme.ts itself is still used at runtime for
// the lot summary report, a separate concern.
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
  --guide-content-width: 960px;
`;

// ── Guide typography ───────────────────────────────────────────────────────────
// Aligned with wmap's in-app guide (14px body, roomier zebra-striped tables,
// centered reading column) so the two products' guides read as one family,
// even though they're opened from two separate entry points.
const guideCss = `
.tsmap-guide { font-size: 14px; color: var(--text-light); line-height: 1.65; max-width: var(--guide-content-width, 960px); margin: 0 auto; }
.tsmap-guide h1 { font-size: 1.35em; font-weight: 700; margin: 0 0 18px; padding-bottom: 10px; border-bottom: 2px solid var(--border-mid); color: var(--text-primary); }
.tsmap-guide h2 { font-size: 1.1em; font-weight: 700; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
.tsmap-guide h3 { font-size: 1em; font-weight: 700; margin: 20px 0 6px; color: var(--text-tertiary); }
.tsmap-guide h4 { font-size: 0.9em; font-weight: 600; margin: 14px 0 5px; color: var(--text-muted); }
.tsmap-guide p  { margin: 0 0 12px; color: var(--text-subdued); }
.tsmap-guide ul, .tsmap-guide ol { padding-left: 22px; margin: 0 0 12px; color: var(--text-subdued); }
.tsmap-guide li { margin-bottom: 4px; }
.tsmap-guide a  { color: var(--accent); text-decoration: none; }
.tsmap-guide a:hover { text-decoration: underline; }
.tsmap-guide strong { font-weight: 600; }
.tsmap-guide code {
  font-family: ui-monospace, 'Cascadia Code', 'Segoe UI Mono', monospace;
  font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-subtle);
  border-radius: 3px; padding: 1px 5px; color: var(--text-tertiary);
}
.tsmap-guide pre {
  background: var(--bg-input); border: 1px solid var(--border-subtle);
  border-radius: 4px; padding: 10px 12px; overflow-x: auto; margin: 0 0 12px;
}
.tsmap-guide pre code { background: none; border: none; padding: 0; font-size: 12px; }
.tsmap-guide table { border-collapse: collapse; width: 100%; max-width: 900px; margin: 0 0 16px; font-size: 13px; }
.tsmap-guide th { text-align: left; padding: 7px 10px; color: var(--text-tertiary); font-weight: 600; background: var(--bg-toolbar); border: 1px solid var(--border-mid); }
.tsmap-guide td { padding: 6px 10px; color: var(--text-subdued); border: 1px solid var(--border-subtle); vertical-align: top; }
.tsmap-guide tr:nth-child(even) td { background: var(--bg-row-border); }
.tsmap-guide img { max-width: 100%; height: auto; }
.tsmap-guide .tsmap-mockup { max-width: 760px; }
.tsmap-guide hr { border: none; border-top: 1px solid var(--border-subtle); margin: 24px 0; }
.tsmap-guide blockquote { border-left: 3px solid var(--border-mid); margin: 0 0 12px; padding: 4px 12px; color: var(--text-muted); }
`;

// ── Copy images ─────────────────────────────────────────────────────────────────
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(join(OUT_DIR, 'images'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'docs/images'))) {
  copyFileSync(join(ROOT, 'docs/images', f), join(OUT_DIR, 'images', f));
}

// ── Wrap as a standalone document ─────────────────────────────────────────────
const page = `<!doctype html>
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
  .guide-page { max-width: 1060px; margin: 0 auto; padding: 32px 28px 64px; }
  .guide-header {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; margin-bottom: 20px; padding-bottom: 10px;
    border-bottom: 1px solid #ddd;
  }
  .guide-header h1 { margin: 0; font-size: 20px; color: #111; }
  .guide-header .ver { font-size: 12px; color: #666; }
  ${guideCss}
  @media print {
    .guide-page { padding: 0; max-width: none; }
    .tsmap-guide h1, .tsmap-guide h2, .tsmap-guide h3, .tsmap-guide h4 { break-after: avoid; }
    .tsmap-guide pre, .tsmap-guide table { break-inside: avoid; }
    a { color: #000; text-decoration: underline; }
  }
</style>
</head>
<body>
  <div class="guide-page">
    <div class="guide-header">
      <h1>tsmap user guide</h1>
      <span class="ver">v${pkg.version}</span>
    </div>
    <div class="tsmap-guide">${html}</div>
  </div>
</body>
</html>
`;

writeFileSync(join(OUT_DIR, 'index.html'), page, 'utf8');
console.log(`build:guide — public/guide/index.html written (+ ${readdirSync(join(OUT_DIR, 'images')).length} images)`);
