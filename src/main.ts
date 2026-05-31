import { buildWaferMap } from '@paulrobins/wafermap';
import { renderWaferMap, renderWaferGallery } from '@paulrobins/wafermap/render';
import { analyzeWaferMap, analyzeWaferLot } from '@paulrobins/wafermap/stats';
import { invoke } from '@tauri-apps/api/core';
import { loadStdfPath, setLogFn } from './fileLoader';
import { showMappingOverlay } from './mappingUI';
import type { CsvMapping } from './mappingUI';
import type { ParsedFile, WaferData, TestDef, LotMeta } from './types';

// Shape returned by both parse_stdf and parse_csv Rust commands
interface RustParsedFile {
  meta: LotMeta;
  wafers: WaferData[];
  testDefs: Record<string, TestDef>;
  sites?: unknown[];
}

function rustToLocal(r: RustParsedFile, fileName: string): ParsedFile {
  return { fileName, meta: r.meta, wafers: r.wafers, testDefs: r.testDefs };
}

const container = document.getElementById('map-container')!;
const openBtn = document.getElementById('open-btn')!;
const fileLabel = document.getElementById('file-label')!;
const logList = document.getElementById('log-list')!;
const logToggle = document.getElementById('log-toggle')!;
const logPanel = document.getElementById('log-panel')!;

const isTauri = '__TAURI_INTERNALS__' in window;

// ── Log panel ─────────────────────────────────────────────────────────────────

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, msg: string) {
  const time = new Date().toLocaleTimeString();
  const el = document.createElement('div');
  el.className = `log-entry log-${level}`;
  el.textContent = `${time}  ${msg}`;
  logList.appendChild(el);
  logList.scrollTop = logList.scrollHeight;
  if (level === 'error') logPanel.classList.add('open');
  const errors = logList.querySelectorAll('.log-error').length;
  logToggle.textContent = errors > 0 ? `Log (${errors} error${errors > 1 ? 's' : ''})` : 'Log';
}

logToggle.addEventListener('click', () => logPanel.classList.toggle('open'));

// Wire log into the file loader so parsers can surface diagnostics
setLogFn(log);

// ── PNG save intercept ────────────────────────────────────────────────────────
// wmap's download button creates a blob URL on a detached <a download> element
// and calls a.click() — the element is never in the DOM so document capture
// listeners never see it. We patch HTMLAnchorElement.prototype.click to intercept.
if (isTauri) {
  const _nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download && this.href.startsWith('blob:')) {
      const href = this.href;
      const defaultName = this.download || 'wafermap.png';
      // fetch before the caller revokes the URL (happens synchronously after this returns)
      fetch(href)
        .then(r => r.arrayBuffer())
        .then(async buf => {
          const bytes = Array.from(new Uint8Array(buf));
          const saved = await invoke<string | null>('save_file', { bytes, defaultName });
          if (saved) log('info', `PNG saved: ${saved}`);
        })
        .catch(err => log('error', `PNG save failed: ${err}`));
      return; // skip browser download
    }
    _nativeClick.call(this);
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderParsed(parsed: ParsedFile) {
  const { wafers, fileName } = parsed;
  const totalDies = wafers.reduce((n, w) => n + w.results.length, 0);
  fileLabel.textContent = `${fileName} — ${wafers.length} wafer${wafers.length !== 1 ? 's' : ''}, ${totalDies} dies`;
  log('info', `Loaded ${fileName}: ${wafers.length} wafer${wafers.length !== 1 ? 's' : ''}, ${totalDies} dies`);

  container.innerHTML = '';

  if (wafers.length === 1) {
    container.classList.remove('gallery');
    const waferMap = buildWaferMap({ results: wafers[0].results });
    const statsSummary = analyzeWaferMap(waferMap);
    renderWaferMap(container, waferMap, {
      statsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
    });
  } else {
    container.classList.remove('single');
    container.classList.add('gallery');
    const items = wafers.map(w => {
      const waferMap = buildWaferMap({ results: w.results });
      const statsSummary = analyzeWaferMap(waferMap);
      return { ...waferMap, label: w.waferId, statsSummary };
    });
    const perWaferSummaries = items.map(i => i.statsSummary);
    const lotStatsSummary = analyzeWaferLot(items, { perWaferSummaries });
    renderWaferGallery(container, items, {
      lotStatsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
    });
  }
}

function showEmptyState() {
  container.classList.remove('gallery');
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;gap:16px;color:#555;user-select:none;">
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="28" stroke="#3a3a3a" stroke-width="2"/>
        <circle cx="32" cy="32" r="18" stroke="#3a3a3a" stroke-width="1.5" stroke-dasharray="3 3"/>
        <circle cx="32" cy="32" r="8"  stroke="#3a3a3a" stroke-width="1.5"/>
        <line x1="32" y1="4"  x2="32" y2="10" stroke="#3a3a3a" stroke-width="2" stroke-linecap="round"/>
        <line x1="32" y1="54" x2="32" y2="60" stroke="#3a3a3a" stroke-width="2" stroke-linecap="round"/>
        <line x1="4"  y1="32" x2="10" y2="32" stroke="#3a3a3a" stroke-width="2" stroke-linecap="round"/>
        <line x1="54" y1="32" x2="60" y2="32" stroke="#3a3a3a" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <div style="font-size:15px;color:#666;">Open a file to get started</div>
      <div style="font-size:12px;color:#444;">Supports STDF, ATDF, CSV and JSON</div>
    </div>`;
}


async function handleNativePath(path: string) {
  fileLabel.textContent = 'Loading…';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const fileName = path.split('/').pop() ?? path;
  log('info', `Opening ${fileName} (${ext})`);

  try {
    if (ext === 'stdf' || ext === 'std') {
      renderParsed(await loadStdfPath(path));
      return;
    }

    if (ext === 'csv' || ext === 'txt' || ext === 'dat') {
      // Get headers + sample, show mapping overlay
      const headersResult = await invoke<{ headers: string[]; sample: Record<string, string>[]; rowCount: number }>(
        'csv_headers', { path }
      );
      log('info', `${fileName}: ${headersResult.rowCount} rows, ${headersResult.headers.length} columns`);

      showMappingOverlay(
        headersResult,
        async (mapping: CsvMapping) => {
          fileLabel.textContent = 'Parsing…';
          try {
            const parsed = await invoke<RustParsedFile>('parse_csv', { path, mapping });
            renderParsed(rustToLocal(parsed, fileName));
          } catch (e) {
            fileLabel.textContent = 'Error loading file';
            log('error', `Failed to parse ${fileName}: ${(e as Error).message}`);
          }
        },
        () => { fileLabel.textContent = ''; }
      );
      return;
    }

    // ATDF, JSON — read as text and parse in TypeScript
    const { parseAtdfText, parseJsonText } = await import('./fileLoader');
    const text = await invoke<string>('read_text_file', { path });
    if (ext === 'atdf' || ext === 'atd') {
      renderParsed(parseAtdfText(text, fileName));
    } else if (ext === 'json') {
      renderParsed(parseJsonText(text, fileName));
    } else {
      log('warn', `Unknown extension "${ext}" — attempting CSV mapping`);
      const headersResult = await invoke<{ headers: string[]; sample: Record<string, string>[]; rowCount: number }>(
        'csv_headers', { path }
      );
      showMappingOverlay(headersResult,
        async (mapping: CsvMapping) => {
          const parsed = await invoke<RustParsedFile>('parse_csv', { path, mapping });
          renderParsed(rustToLocal(parsed, fileName));
        },
        () => { fileLabel.textContent = ''; }
      );
    }
  } catch (e) {
    fileLabel.textContent = 'Error loading file';
    log('error', `Failed to load ${fileName}: ${(e as Error).message}`);
  }
}

async function handleNativeOpen() {
  let path: string | null;
  try {
    path = await invoke<string | null>('pick_file');
  } catch (e) {
    log('error', `File picker failed: ${(e as Error).message}`);
    return;
  }
  if (!path) return;
  handleNativePath(path);
}

// ── File drop (Tauri) ─────────────────────────────────────────────────────────
// In Tauri, OS-level file drops are intercepted before the webview sees them.
// We listen to the Tauri drag-drop event instead of browser DragEvent.
if (isTauri) {
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen<{ paths: string[] }>('tauri://drag-drop', event => {
      const path = event.payload.paths?.[0];
      if (path) handleNativePath(path);
    }).catch(e => log('warn', `File drop listener failed: ${e}`));
  });
}

// ── File open wiring ──────────────────────────────────────────────────────────

openBtn.addEventListener('click', e => {
  if (isTauri) {
    e.preventDefault();
    handleNativeOpen();
  }
  // non-Tauri: <label for="file-input"> opens the picker natively
});



showEmptyState();

