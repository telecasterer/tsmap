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

// ── Slugify heading text to stable anchor IDs (same algorithm as wmap) ────────
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Custom renderer: heading IDs, strip images ────────────────────────────────
const renderer = new Renderer();

renderer.heading = ({ text, depth }) => {
  const id = slugify(text.replace(/<[^>]+>/g, ''));
  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};

// Screenshots are not inlined — they are too large and don't render well inside
// the constrained modal. The guide uses HTML mockups instead for UI elements
// (see §2, §3, §4 in user-guide.md); chart sections have no visual replacements.
renderer.image = () => '';

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
const css = `
.tsmap-guide { font-size: 13px; color: var(--text-light); line-height: 1.6; }
.tsmap-guide h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; color: var(--text-primary); }
.tsmap-guide h2 { font-size: 14px; font-weight: 600; color: var(--text-secondary); margin: 20px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border-subtle); }
.tsmap-guide h3 { font-size: 13px; font-weight: 600; color: var(--text-tertiary); margin: 14px 0 5px; }
.tsmap-guide h4 { font-size: 12px; font-weight: 600; color: var(--text-muted); margin: 10px 0 4px; }
.tsmap-guide p  { margin: 0 0 8px; color: var(--text-subdued); }
.tsmap-guide ul, .tsmap-guide ol { padding-left: 18px; margin: 0 0 8px; color: var(--text-subdued); }
.tsmap-guide li { margin-bottom: 3px; }
.tsmap-guide a  { color: var(--accent); text-decoration: none; }
.tsmap-guide a:hover { text-decoration: underline; }
.tsmap-guide code {
  font-family: ui-monospace, 'Cascadia Code', 'Segoe UI Mono', monospace;
  font-size: 11px; background: var(--bg-input); border: 1px solid var(--border-subtle);
  border-radius: 3px; padding: 1px 5px; color: var(--text-tertiary);
}
.tsmap-guide pre {
  background: var(--bg-input); border: 1px solid var(--border-subtle);
  border-radius: 4px; padding: 10px 12px; overflow-x: auto; margin: 0 0 10px;
}
.tsmap-guide pre code { background: none; border: none; padding: 0; font-size: 11px; }
.tsmap-guide table { border-collapse: collapse; width: 100%; margin: 0 0 10px; font-size: 12px; }
.tsmap-guide th { text-align: left; padding: 5px 8px; color: var(--text-tertiary); font-weight: 600; border-bottom: 1px solid var(--border-mid); }
.tsmap-guide td { padding: 4px 8px; color: var(--text-subdued); border-bottom: 1px solid var(--border-subtle); vertical-align: top; }
.tsmap-guide tr:last-child td { border-bottom: none; }
.tsmap-guide hr { border: none; border-top: 1px solid var(--border-subtle); margin: 16px 0; }
.tsmap-guide blockquote { border-left: 3px solid var(--border-mid); margin: 0 0 8px; padding: 4px 12px; color: var(--text-muted); }
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
