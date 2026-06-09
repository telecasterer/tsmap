// UI for multi-file loading: rename step + append confirmation with mismatch warnings.

import type { ParsedFile, WaferData } from './types';

// ── Rename overlay ────────────────────────────────────────────────────────────

export interface FileWaferEntry {
  filePath: string;
  fileName: string;
  parsed: ParsedFile;
}

export interface RenamedWafer {
  waferId: string;
  results: WaferData['results'];
  partCount?: number;
  goodCount?: number;
  failCount?: number;
}

/**
 * Show a rename overlay listing one editable wafer ID row per parsed file.
 * Files that produced multiple wafers show one row per wafer.
 * Returns the flat list of renamed wafers to add to the gallery.
 */
export function showRenameOverlay(
  entries: FileWaferEntry[],
  onConfirm: (wafers: RenamedWafer[]) => void,
  onCancel: () => void,
): void {
  const overlay = document.createElement('div');
  overlay.id = 'tsmap-rename-overlay';

  // Build one row per wafer across all files
  const rows: { defaultId: string; fileLabel: string; wafer: WaferData }[] = [];
  for (const entry of entries) {
    for (const wafer of entry.parsed.wafers) {
      const defaultId = resolveWaferId(wafer.waferId, entry.fileName);
      rows.push({ defaultId, fileLabel: entry.fileName, wafer });
    }
  }

  const tableRows = rows.map((row, i) => `
    <tr>
      <td class="rename-file">${esc(row.fileLabel)}</td>
      <td class="rename-arrow">→</td>
      <td><input type="text" class="rename-input" data-idx="${i}" value="${esc(row.defaultId)}"></td>
      <td class="rename-count">${row.wafer.results.length.toLocaleString()} dies</td>
    </tr>`).join('');

  overlay.innerHTML = `
    <div class="mapping-panel">
      <div class="mapping-header">
        <span class="mapping-title">Wafer labels</span>
        <span class="mapping-file-info">${rows.length} wafer${rows.length !== 1 ? 's' : ''} from ${entries.length} file${entries.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="mapping-scroll">
        <table class="mapping-table">
          <thead><tr><th>Source file</th><th></th><th>Wafer label</th><th>Dies</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div class="mapping-footer">
        <button id="rename-cancel" class="btn-secondary">Cancel</button>
        <button id="rename-confirm" class="btn-primary">Continue →</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  document.body.classList.add('overlay-open');

  const closeOverlay = () => {
    overlay.remove();
    document.body.classList.remove('overlay-open');
  };

  overlay.querySelector('#rename-cancel')!.addEventListener('click', () => {
    closeOverlay();
    onCancel();
  });

  overlay.querySelector('#rename-confirm')!.addEventListener('click', () => {
    const inputs = overlay.querySelectorAll<HTMLInputElement>('.rename-input');
    const renamed: RenamedWafer[] = rows.map((row, i) => ({
      waferId: inputs[i].value.trim() || row.defaultId,
      results: row.wafer.results,
      partCount: row.wafer.partCount,
      goodCount: row.wafer.goodCount,
      failCount: row.wafer.failCount,
    }));
    closeOverlay();
    onConfirm(renamed);
  });
}

/** Resolve a good wafer ID from the content ID and/or filename stem. */
export function resolveWaferId(contentId: string, fileName: string): string {
  const generic = /^W\d+$/.test(contentId); // W1, W01, W12 etc.
  if (!generic) return contentId;
  // Try to extract something meaningful from the filename
  const stem = fileName.replace(/\.[^.]+$/, '');
  return stem || contentId;
}

// ── Append confirmation ───────────────────────────────────────────────────────

export interface AppendWarning {
  level: 'warn' | 'info';
  message: string;
}

export interface AppendConfirmParams {
  incoming: RenamedWafer[];
  existing: WaferData[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function showAppendConfirm({ incoming, existing, onConfirm, onCancel }: AppendConfirmParams): void {
  const warnings = detectMismatches(incoming, existing);

  const modal = document.createElement('div');
  modal.className = 'tsmap-modal-backdrop';

  const warningHtml = warnings.length > 0
    ? `<div class="append-warnings">${warnings.map(w =>
        `<div class="append-warning append-${w.level}">
          <span class="warn-icon">${w.level === 'warn' ? '⚠' : 'ℹ'}</span>
          <span>${esc(w.message)}</span>
        </div>`).join('')}</div>`
    : `<div class="append-ok">No structural mismatches detected.</div>`;

  modal.innerHTML = `
    <div class="tsmap-modal">
      <h3>Add ${incoming.length} wafer${incoming.length !== 1 ? 's' : ''} to gallery</h3>
      <p class="append-summary">
        Current gallery: <strong>${existing.length}</strong> wafer${existing.length !== 1 ? 's' : ''} &nbsp;+&nbsp;
        Adding: <strong>${incoming.length}</strong> wafer${incoming.length !== 1 ? 's' : ''}
        &nbsp;=&nbsp; <strong>${existing.length + incoming.length}</strong> total
      </p>
      ${warningHtml}
      <div class="tsmap-modal-buttons">
        <button id="append-cancel" class="btn-secondary">Cancel</button>
        <button id="append-confirm" class="btn-primary${warnings.some(w => w.level === 'warn') ? ' btn-warn' : ''}">
          ${warnings.some(w => w.level === 'warn') ? 'Add anyway' : 'Add to gallery'}
        </button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#append-cancel')!.addEventListener('click', () => { modal.remove(); onCancel(); });
  modal.querySelector('#append-confirm')!.addEventListener('click', () => { modal.remove(); onConfirm(); });
}

export function detectMismatches(incoming: RenamedWafer[], existing: WaferData[]): AppendWarning[] {
  const warnings: AppendWarning[] = [];
  if (existing.length === 0) return warnings;

  const existingCounts = existing.map(w => w.results.length);
  const incomingCounts = incoming.map(w => w.results.length);
  const existingMean = mean(existingCounts);
  const incomingMean = mean(incomingCounts);

  // Die count mismatch — flag if means differ by more than 5%
  if (Math.abs(existingMean - incomingMean) / Math.max(existingMean, incomingMean) > 0.05) {
    warnings.push({
      level: 'warn',
      message: `Die count differs — existing wafers average ${Math.round(existingMean)} dies, incoming average ${Math.round(incomingMean)} dies`,
    });
  }

  // Coordinate range mismatch — proxy for different die size / wafer geometry
  const existingRange = coordRange(existing.flatMap(w => w.results));
  const incomingRange = coordRange(incoming.flatMap(w => w.results));
  if (existingRange && incomingRange) {
    const xSpanExist = existingRange.maxX - existingRange.minX;
    const xSpanNew   = incomingRange.maxX - incomingRange.minX;
    if (Math.abs(xSpanExist - xSpanNew) > 4) { // more than 4 die-steps difference
      warnings.push({
        level: 'warn',
        message: `Wafer grid size differs — existing span ${xSpanExist} columns, incoming ${xSpanNew} columns`,
      });
    }
  }

  // Hard bin set mismatch
  const existingBins = new Set(existing.flatMap(w => w.results.map(d => d.hbin)));
  const incomingBins = new Set(incoming.flatMap(w => w.results.map(d => d.hbin)));
  const onlyInExisting = [...existingBins].filter(b => !incomingBins.has(b));
  const onlyInIncoming = [...incomingBins].filter(b => !existingBins.has(b));
  if (onlyInExisting.length > 0 || onlyInIncoming.length > 0) {
    warnings.push({
      level: 'warn',
      message: `Hard bin sets differ — bins only in existing: [${onlyInExisting.join(', ') || 'none'}], only in new: [${onlyInIncoming.join(', ') || 'none'}]`,
    });
  }

  // Duplicate wafer IDs
  const existingIds = new Set(existing.map(w => w.waferId));
  const dupes = incoming.map(w => w.waferId).filter(id => existingIds.has(id));
  if (dupes.length > 0) {
    warnings.push({
      level: 'warn',
      message: `Duplicate wafer ID${dupes.length > 1 ? 's' : ''}: ${dupes.join(', ')} — already in gallery`,
    });
  }

  return warnings;
}

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function coordRange(results: { x: number; y: number }[]) {
  if (!results.length) return null;
  let minX = Infinity, maxX = -Infinity;
  for (const { x } of results) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  return { minX, maxX };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
