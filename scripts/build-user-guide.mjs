// Compiles docs/user-guide.md → src/userGuideHtml.ts
// The generated constant is imported by main.ts to drive the in-app ? modal.
// Run manually with: npm run build:guide
// Runs automatically via predev / prebuild hooks.

import { readFileSync, writeFileSync } from 'fs';
import { marked, Renderer } from 'marked';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Images referenced in the markdown are not bundled with the app — the app has
// no local copy of docs/images/*.png. Instead they're rewritten to absolute
// GitHub Pages URLs and loaded at runtime (see src/guideImages.ts), which
// probes reachability first and falls back to text-only when offline. This
// must match zensical.toml's site_url.
const GH_PAGES_BASE = 'https://telecasterer.github.io/tsmap/';

// ── Slugify heading text to stable anchor IDs (same algorithm as wmap) ────────
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Custom renderer: heading IDs, remote-loaded images ────────────────────────
const renderer = new Renderer();

renderer.heading = ({ text, depth }) => {
  const id = slugify(text.replace(/<[^>]+>/g, ''));
  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};

// Images aren't bundled with the app, so they're pointed at the published
// GitHub Pages copy instead. Emitted as `data-src` (not `src`) so nothing
// fetches until the runtime reachability probe in src/guideImages.ts decides
// to promote it — setting `src` eagerly here would fire the request the
// moment the HTML is inserted into the DOM, before the probe can run.
renderer.image = ({ href, text }) => {
  const url = /^https?:\/\//.test(href) ? href : GH_PAGES_BASE + href;
  const alt = text ? ` alt="${text}"` : '';
  return `<img data-src="${url}"${alt}>`;
};

marked.setOptions({ renderer });

// ── Read and pre-process markdown ─────────────────────────────────────────────
let md = readFileSync(join(ROOT, 'docs/user-guide.md'), 'utf8');

// Strip YAML frontmatter
md = md.replace(/^---\n[\s\S]*?\n---\n/, '');

// ── Render to HTML ────────────────────────────────────────────────────────────
let html = await marked(md);

// ── Rewrite internal anchor links to scrollIntoView (works in Tauri/WebView) ──
html = html.replace(
  /href="#([^"]+)"/g,
  (_, id) =>
    `href="#${id}" onclick="(function(e){e.preventDefault();var t=document.querySelector('.tsmap-guide [id=\\'${id}\\']');if(t)t.scrollIntoView({behavior:'smooth'});})(event)"`
);

// ── Scoped CSS ────────────────────────────────────────────────────────────────
// CSS variables and app classes (.btn-primary etc.) are provided by:
//   - index.html :root block when rendered inside the app
//   - docs/tsmap-theme.css (via zensical extra_css) on the docs site
// Typography aligned with wmap's in-app guide (larger 14px body, 1.65 line
// height, roomier tables with bordered cells + zebra striping, centered reading
// column) so the two products' guides read as one — but kept THEME-AWARE via
// --var tokens (wmap's guide is hardcoded light; tsmap follows the OS theme).
const css = `
.tsmap-guide { font-size: 14px; color: var(--text-light); line-height: 1.65; max-width: 720px; margin: 0 auto; }
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
.tsmap-guide table { border-collapse: collapse; width: 100%; margin: 0 0 16px; font-size: 13px; }
.tsmap-guide th { text-align: left; padding: 7px 10px; color: var(--text-tertiary); font-weight: 600; background: var(--bg-toolbar); border: 1px solid var(--border-mid); }
.tsmap-guide td { padding: 6px 10px; color: var(--text-subdued); border: 1px solid var(--border-subtle); vertical-align: top; }
.tsmap-guide tr:nth-child(even) td { background: var(--bg-row-border); }
.tsmap-guide img, .tsmap-guide table { max-width: 100%; }
.tsmap-guide hr { border: none; border-top: 1px solid var(--border-subtle); margin: 24px 0; }
.tsmap-guide blockquote { border-left: 3px solid var(--border-mid); margin: 0 0 12px; padding: 4px 12px; color: var(--text-muted); }
.tsmap-guide-offline-note {
  margin: 0 0 18px; padding: 8px 12px; font-size: 13px; color: var(--text-muted);
  background: var(--bg-toolbar); border: 1px solid var(--border-subtle); border-radius: 4px;
}
.tsmap-guide-offline-note a { color: var(--accent); cursor: pointer; }
.tsmap-guide-offline-note a:hover { text-decoration: underline; }
`;

// ── Wrap ──────────────────────────────────────────────────────────────────────
const wrapped = `<style>${css}</style><div class="tsmap-guide">${html}</div>`;

// ── Escape for template literal ───────────────────────────────────────────────
const escaped = wrapped
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

// ── Write output ──────────────────────────────────────────────────────────────
const output = `// @generated — do not edit directly; run \`npm run build:guide\` to regenerate
export const USER_GUIDE_HTML = \`${escaped}\`;
`;

writeFileSync(join(ROOT, 'src/userGuideHtml.ts'), output, 'utf8');
console.log('build:guide — src/userGuideHtml.ts written');
