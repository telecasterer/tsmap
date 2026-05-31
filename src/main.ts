import { buildWaferMap } from '@paulrobins/wafermap';
import { renderWaferMap, renderWaferGallery } from '@paulrobins/wafermap/render';
import { analyzeWaferMap } from '@paulrobins/wafermap/stats';
import type { DieResult } from '@paulrobins/wafermap';
import type { ParsedFile } from './types';
import { invoke } from '@tauri-apps/api/core';
import { loadFile, loadStdfPath, parseText } from './fileLoader';

const container = document.getElementById('map-container')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const openBtn = document.getElementById('open-btn')!;
const fileLabel = document.getElementById('file-label')!;
const dropZone = document.getElementById('drop-zone')!;

const isTauri = '__TAURI_INTERNALS__' in window;

// ── PNG save intercept ────────────────────────────────────────────────────────
// wmap's download button creates an <a download> and calls .click().
// In Tauri the browser download is suppressed, so we intercept it here and
// route through save_file (zenity on Linux, rfd on macOS/Windows).
if (isTauri) {
  document.addEventListener('click', async e => {
    const a = (e.target as HTMLElement).closest('a[download]') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.href;
    if (!href.startsWith('blob:')) return;
    e.preventDefault();

    try {
      const blob = await fetch(href).then(r => r.blob());
      const buf = await blob.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const defaultName = a.download || 'wafermap.png';
      await invoke('save_file', { bytes, defaultName });
    } catch (err) {
      console.error('PNG save failed:', err);
    }
  }, true); // capture phase — runs before wmap revokes the blob URL
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderParsed(parsed: ParsedFile) {
  const { wafers, fileName } = parsed;
  const totalDies = wafers.reduce((n, w) => n + w.results.length, 0);
  fileLabel.textContent = `${fileName} — ${wafers.length} wafer${wafers.length !== 1 ? 's' : ''}, ${totalDies} dies`;

  container.innerHTML = '';

  if (wafers.length === 1) {
    container.classList.add('single');
    const waferMap = buildWaferMap({ results: wafers[0].results });
    const statsSummary = analyzeWaferMap(waferMap);
    renderWaferMap(container, waferMap, {
      statsSummary,
      summaryPanel: { placement: 'right', defaultOpen: true },
    });
  } else {
    container.classList.remove('single');
    renderWaferGallery(container, wafers.map(w => {
      const waferMap = buildWaferMap({ results: w.results });
      const statsSummary = analyzeWaferMap(waferMap);
      return { ...waferMap, label: w.waferId, statsSummary };
    }));
  }
}

function renderDemo() {
  const results: DieResult[] = [];
  for (let y = -8; y <= 8; y++) {
    for (let x = -8; x <= 8; x++) {
      if (x * x + y * y > 70) continue;
      const hbin = Math.random() < 0.85 ? 1 : Math.random() < 0.5 ? 2 : 3;
      results.push({ x, y, hbin, sbin: hbin });
    }
  }
  renderParsed({ fileName: 'Demo data', meta: {}, wafers: [{ waferId: 'W1', results }], testDefs: {} });
}

async function handleFile(file: File) {
  fileLabel.textContent = 'Loading…';
  try {
    renderParsed(await loadFile(file));
  } catch (e) {
    fileLabel.textContent = `Error: ${(e as Error).message}`;
  }
}

async function handleNativeOpen() {
  const path = await invoke<string | null>('pick_file');
  if (!path) return;

  fileLabel.textContent = 'Loading…';
  try {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const fileName = path.split('/').pop() ?? path;
    if (ext === 'stdf' || ext === 'std') {
      renderParsed(await loadStdfPath(path));
    } else {
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const text = await readTextFile(path);
      renderParsed(parseText(text, fileName, ext));
    }
  } catch (e) {
    fileLabel.textContent = `Error: ${(e as Error).message}`;
  }
}

openBtn.addEventListener('click', () => {
  if (isTauri) handleNativeOpen();
  else fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) handleFile(file);
});

renderDemo();

// Test hook — removed in production builds
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__loadText = (text: string, name: string) => {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    renderParsed(parseText(text, name, ext));
  };
}
