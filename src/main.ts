import { buildWaferMap } from '@paulrobins/wafermap';
import { renderWaferMap, renderWaferGallery } from '@paulrobins/wafermap/render';
import { analyzeWaferMap, analyzeWaferLot } from '@paulrobins/wafermap/stats';
import { invoke } from '@tauri-apps/api/core';
import { loadStdfPath, setLogFn, parseAtdfText } from './fileLoader';
import { showMappingOverlay } from './mappingUI';
import { showRenameOverlay, showAppendConfirm } from './multiFileUI';
import type { CsvMapping } from './mappingUI';
import type { FileWaferEntry, RenamedWafer } from './multiFileUI';
import type { ParsedFile, WaferData, TestDef, LotMeta } from './types';

// ── Rust command return shape ─────────────────────────────────────────────────

interface RustParsedFile {
  meta: LotMeta;
  wafers: WaferData[];
  testDefs: Record<string, TestDef>;
  sites?: unknown[];
}

function rustToLocal(r: RustParsedFile, fileName: string): ParsedFile {
  return { fileName, meta: r.meta, wafers: r.wafers, testDefs: r.testDefs };
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const container  = document.getElementById('map-container')!;
const openBtn    = document.getElementById('open-btn')!;
const addBtn     = document.getElementById('add-btn') as HTMLButtonElement;
const fileLabel  = document.getElementById('file-label')!;
const logList    = document.getElementById('log-list')!;
const logToggle  = document.getElementById('log-toggle')!;
const logPanel   = document.getElementById('log-panel')!;

const isTauri = '__TAURI_INTERNALS__' in window;

// ── State ─────────────────────────────────────────────────────────────────────

let currentWafers: WaferData[] = [];
let currentFileName = 'wafermap';

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
setLogFn(log);

// ── Tauri intercepts ──────────────────────────────────────────────────────────

if (isTauri) {
  // PNG save — wmap uses a detached <a download> never in the DOM
  const _nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download && this.href.startsWith('blob:')) {
      const href = this.href;
      const stem = currentFileName.replace(/\.[^.]+$/, '');
      fetch(href)
        .then(r => r.arrayBuffer())
        .then(async buf => {
          const bytes = Array.from(new Uint8Array(buf));
          const saved = await invoke<string | null>('save_file', { bytes, defaultName: `${stem}.png` });
          if (saved) log('info', `PNG saved: ${saved}`);
        })
        .catch(err => log('error', `PNG save failed: ${err}`));
      return;
    }
    _nativeClick.call(this);
  };

  // Report buttons — wmap calls openHtmlReport() which checks window.__openHtmlReport first.
  // WebKitGTK intercepts window.open() at the native level so we can't patch that.
  (window as any).__openHtmlReport = (html: string) => {
    invoke('write_temp_html', { html })
      .catch(err => log('error', `Failed to open report: ${err}`));
  };

  // File drop
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen<{ paths: string[] }>('tauri://drag-drop', event => {
      const paths = event.payload.paths ?? [];
      if (paths.length > 0) handlePaths(paths, false);
    }).catch(e => log('warn', `File drop listener failed: ${e}`));
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderWafers(wafers: WaferData[], label: string) {
  currentWafers = wafers;
  currentFileName = label;
  addBtn.disabled = wafers.length === 0;

  const totalDies = wafers.reduce((n, w) => n + w.results.length, 0);
  fileLabel.textContent = `${label} — ${wafers.length} wafer${wafers.length !== 1 ? 's' : ''}, ${totalDies} dies`;

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
    container.classList.add('gallery');
    const items = wafers.map(w => {
      const waferMap = buildWaferMap({ results: w.results });
      const statsSummary = analyzeWaferMap(waferMap);
      return { ...waferMap, label: w.waferId, statsSummary };
    });
    const lotStatsSummary = analyzeWaferLot(items, { perWaferSummaries: items.map(i => i.statsSummary) });
    renderWaferGallery(container, items, {
      lotStatsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
    });
  }
}


function showEmptyState() {
  currentWafers = [];
  addBtn.disabled = true;
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

// ── Multi-file load flow ──────────────────────────────────────────────────────

async function handlePaths(paths: string[], isAppend: boolean) {
  if (paths.length === 0) return;

  fileLabel.textContent = `Loading ${paths.length} file${paths.length > 1 ? 's' : ''}…`;

  // Validate all files have the same extension
  const exts = [...new Set(paths.map(p => p.split('.').pop()?.toLowerCase() ?? ''))];
  if (exts.length > 1) {
    log('error', `Mixed formats not supported: ${exts.join(', ')} — please select files of the same type`);
    fileLabel.textContent = 'Error: mixed formats';
    return;
  }

  // For CSV/JSON: show mapping overlay once for the first file, apply to all
  // For STDF/ATDF: parse directly (no mapping needed)
  const ext = exts[0];
  let mappingPromise: Promise<CsvMapping | null> = Promise.resolve(null);

  if (ext === 'csv' || ext === 'txt' || ext === 'dat' || ext === 'json') {
    const command = (ext === 'json') ? 'json_headers' : 'csv_headers';
    const headersResult = await invoke<{ headers: string[]; sample: Record<string, string>[]; rowCount: number }>(
      command, { path: paths[0] }
    ).catch(e => { log('error', `Failed to read headers: ${e}`); return null; });

    if (!headersResult) { fileLabel.textContent = ''; return; }

    const note = paths.length > 1
      ? ` — mapping will be applied to all ${paths.length} files`
      : '';
    log('info', `${paths[0].split('/').pop()}: ${headersResult.rowCount} rows, ${headersResult.headers.length} columns${note}`);

    mappingPromise = new Promise(resolve => {
      showMappingOverlay(headersResult,
        (mapping) => resolve(mapping),
        () => { fileLabel.textContent = ''; resolve(null); }
      );
    });
  }

  const mapping = await mappingPromise;
  if (mapping === null && (ext === 'csv' || ext === 'txt' || ext === 'dat' || ext === 'json')) {
    return; // cancelled
  }

  // Parse all files
  const entries: FileWaferEntry[] = [];
  for (const path of paths) {
    const fileName = path.split('/').pop() ?? path;
    fileLabel.textContent = `Parsing ${fileName}…`;
    try {
      let parsed: ParsedFile;
      if (ext === 'stdf' || ext === 'std') {
        parsed = await loadStdfPath(path);
      } else if (ext === 'atdf' || ext === 'atd') {
        const text = await invoke<string>('read_text_file', { path });
        parsed = parseAtdfText(text, fileName);
      } else if (ext === 'json') {
        parsed = rustToLocal(await invoke<RustParsedFile>('parse_json', { path, mapping }), fileName);
      } else {
        parsed = rustToLocal(await invoke<RustParsedFile>('parse_csv', { path, mapping }), fileName);
      }
      entries.push({ filePath: path, fileName, parsed });
      log('info', `Parsed ${fileName}: ${parsed.wafers.length} wafer${parsed.wafers.length !== 1 ? 's' : ''}`);
    } catch (e) {
      log('error', `Failed to parse ${fileName}: ${(e as Error).message}`);
    }
  }

  if (entries.length === 0) {
    fileLabel.textContent = 'Error: no files parsed successfully';
    return;
  }

  // Rename step — always shown for multi-file, or single file with generic wafer ID
  const allWafers = entries.flatMap(e => e.parsed.wafers);
  const needsRename = entries.length > 1 || (allWafers.length === 1 && /^W\d+$/.test(allWafers[0].waferId));

  const getRenamed = (): Promise<RenamedWafer[] | null> => {
    if (!needsRename) {
      return Promise.resolve(allWafers.map(w => ({
        waferId: w.waferId,
        results: w.results,
        partCount: w.partCount,
        goodCount: w.goodCount,
        failCount: w.failCount,
      })));
    }
    return new Promise(resolve => {
      showRenameOverlay(entries,
        (renamed) => resolve(renamed),
        () => { fileLabel.textContent = ''; resolve(null); }
      );
    });
  };

  const renamed = await getRenamed();
  if (!renamed) return;

  if (isAppend && currentWafers.length > 0) {
    // Show append confirmation with mismatch warnings
    await new Promise<void>(resolve => {
      showAppendConfirm({
        incoming: renamed,
        existing: currentWafers,
        onConfirm: () => {
          const merged = [
            ...currentWafers,
            ...renamed.map(r => ({ waferId: r.waferId, results: r.results, partCount: r.partCount, goodCount: r.goodCount, failCount: r.failCount })),
          ];
          renderWafers(merged, currentFileName);
          log('info', `Added ${renamed.length} wafer${renamed.length !== 1 ? 's' : ''} — gallery now has ${merged.length}`);
          resolve();
        },
        onCancel: () => { fileLabel.textContent = `${currentWafers.length} wafers loaded`; resolve(); },
      });
    });
  } else {
    renderWafers(
      renamed.map(r => ({ waferId: r.waferId, results: r.results, partCount: r.partCount, goodCount: r.goodCount, failCount: r.failCount })),
      entries.length === 1 ? entries[0].fileName : `${entries.length} files`
    );
  }
}

// ── Open / Add buttons ────────────────────────────────────────────────────────

async function pickAndHandle(isAppend: boolean) {
  let paths: string[];
  try {
    paths = await invoke<string[]>('pick_files');
  } catch (e) {
    log('error', `File picker failed: ${(e as Error).message}`);
    return;
  }
  if (!paths || paths.length === 0) return;
  handlePaths(paths, isAppend);
}

openBtn.addEventListener('click', e => {
  if (isTauri) { e.preventDefault(); pickAndHandle(false); }
});

addBtn.addEventListener('click', () => { if (isTauri) pickAndHandle(true); });

showEmptyState();
