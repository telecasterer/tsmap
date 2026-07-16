// Modal UI for assigning wafers to user-defined splits (process corners like
// TT/FF/FS, or any ad-hoc experiment group). Bulk-select rows (checkbox +
// shift-click, mirroring the test selector's UX) then assign/clear a split
// name; save/load round-trips the assignment as CSV via the platform adapter.
// Splits themselves are just a per-wafer metadata field (see splits.ts) — this
// module only owns the assignment UI.

import type { WaferData } from './types';
import { openModal } from './modal';
import { getSplitLabel, setSplitLabel, clearAllSplits, listSplitValues, parseSplitsCsv, formatSplitsCsv } from './splits';

export interface SplitsUIOptions {
  onSave: (csv: string) => Promise<void>;
  onLoad: () => Promise<string | null>;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Called after every assignment change (assign, clear, or CSV load), so the
   * caller can re-render the Group-by-driven charts and persist to localStorage. */
  onChange: () => void;
  /** Whether wafer map/gallery labels currently show the " · <split>" suffix. */
  showSplitSuffix: boolean;
  /** Called when the "Show split in wafer map labels" checkbox is toggled. */
  onToggleSuffix: (show: boolean) => void;
  /** Confirmation prompt for the destructive "Clear all" action. Defaults to
   * `window.confirm`, matching the test selector's `onAsk` fallback. */
  onAsk?: (message: string) => Promise<boolean>;
}

export function showSplitsModal(wafers: WaferData[], options: SplitsUIOptions): void {
  const selected = new Set<number>(); // indices into `wafers`
  let lastClickedVisibleIndex: number | null = null;
  let searchQuery = '';

  const secondaryBtnCss = [
    'padding:6px 14px;border-radius:4px;border:1px solid var(--border-mid)',
    'background:none;color:var(--text-secondary);cursor:pointer;font-size:13px',
  ].join(';');

  const modalHandle = openModal({
    title: `Wafer splits (${wafers.length} wafer${wafers.length !== 1 ? 's' : ''})`,
    sizing: 'content',
    bodyOverflow: 'hidden',
    mount(body) {
      body.style.cssText += 'padding:16px;gap:10px;font-size:13px;color:var(--text-light)';

      // Status banner. Empty state (no wafer has a split yet): guidance + a
      // Load shortcut — the moment a first-time user (fresh off the test
      // selector's "select all to proceed" flow) is most likely to assume they
      // must select everything. Assigned state: a summary ("2 splits assigned
      // to 6 of 13 wafers"), so e.g. the auto-restored sample-data splits read
      // as "already done" rather than a task waiting to be repeated.
      const statusBanner = document.createElement('div');
      statusBanner.style.cssText = [
        'display:flex;align-items:center;gap:10px;flex-wrap:wrap',
        'border:1px solid var(--border-mid);border-radius:4px;padding:8px 10px',
        'font-size:12px;color:var(--text-secondary)',
      ].join(';');
      const statusBannerText = document.createElement('span');
      statusBannerText.style.cssText = 'flex:1;min-width:200px';
      const statusBannerLoadBtn = document.createElement('button');
      statusBannerLoadBtn.textContent = 'Load splits…';
      statusBannerLoadBtn.style.cssText = [
        'padding:3px 10px;border-radius:4px;border:1px solid var(--border-mid)',
        'background:none;color:var(--accent,#4a9eff);cursor:pointer;font-size:12px;flex-shrink:0',
      ].join(';');
      statusBannerLoadBtn.addEventListener('click', () => { void loadSplits(); });
      statusBanner.append(statusBannerText, statusBannerLoadBtn);

      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.placeholder = 'Filter by wafer ID or source file…';
      searchInput.style.cssText = [
        'padding:5px 8px;border:1px solid var(--border-mid);border-radius:4px',
        'background:var(--bg-input);color:var(--text-secondary);font-size:13px',
      ].join(';');
      searchInput.addEventListener('input', () => { searchQuery = searchInput.value.trim().toLowerCase(); renderList(); });

      const suffixLabel = document.createElement('label');
      suffixLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text-secondary)';
      const suffixCb = document.createElement('input');
      suffixCb.type = 'checkbox';
      suffixCb.checked = options.showSplitSuffix;
      suffixCb.style.cssText = 'cursor:pointer';
      suffixCb.addEventListener('change', () => {
        options.onToggleSuffix(suffixCb.checked);
        options.onChange();
      });
      suffixLabel.append(suffixCb, document.createTextNode('Show split in wafer map labels'));

      const bulkRow = document.createElement('div');
      bulkRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
      const selectAllBtn = document.createElement('button');
      selectAllBtn.textContent = 'Select all';
      selectAllBtn.style.cssText = secondaryBtnCss;
      selectAllBtn.addEventListener('click', () => { for (const [i] of getVisible()) selected.add(i); renderList(); });
      const selectNoneBtn = document.createElement('button');
      selectNoneBtn.textContent = 'Select none';
      selectNoneBtn.style.cssText = secondaryBtnCss;
      selectNoneBtn.addEventListener('click', () => { for (const [i] of getVisible()) selected.delete(i); renderList(); });
      bulkRow.append(selectAllBtn, selectNoneBtn);

      const listContainer = document.createElement('div');
      listContainer.style.cssText = [
        'overflow-y:auto;flex:1;min-height:0',
        'border:1px solid var(--border-mid);border-radius:4px',
        'font-family:ui-monospace,"Cascadia Code","Segoe UI Mono",monospace;font-size:12px',
      ].join(';');

      function getVisible(): Array<[number, WaferData]> {
        return wafers
          .map((w, i): [number, WaferData] => [i, w])
          .filter(([, w]) => {
            if (!searchQuery) return true;
            const hay = `${w.waferId} ${w.source?.sourceFile ?? ''} ${getSplitLabel(w) ?? ''}`.toLowerCase();
            return hay.includes(searchQuery);
          });
      }

      function renderList(): void {
        listContainer.innerHTML = '';
        const visible = getVisible();
        for (let vi = 0; vi < visible.length; vi++) {
          const [i, w] = visible[vi];
          const row = document.createElement('label');
          row.style.cssText = [
            'display:flex;align-items:center;gap:8px',
            'padding:4px 8px;cursor:pointer',
            'border-bottom:1px solid var(--border-mid)',
          ].join(';');
          row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover-row)'; });
          row.addEventListener('mouseleave', () => { row.style.background = ''; });

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selected.has(i);
          cb.style.cssText = 'flex-shrink:0;cursor:pointer';
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(i); else selected.delete(i);
            lastClickedVisibleIndex = vi;
            updateUi();
          });
          cb.addEventListener('click', (evt) => {
            if (evt.shiftKey && lastClickedVisibleIndex !== null) {
              evt.preventDefault();
              const lo = Math.min(lastClickedVisibleIndex, vi);
              const hi = Math.max(lastClickedVisibleIndex, vi);
              const shouldSelect = selected.has(visible[lastClickedVisibleIndex][0]);
              for (let k = lo; k <= hi; k++) {
                if (shouldSelect) selected.add(visible[k][0]); else selected.delete(visible[k][0]);
              }
              renderList();
            }
          });

          const idSpan = document.createElement('span');
          idSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          idSpan.textContent = w.waferId;

          const srcSpan = document.createElement('span');
          srcSpan.style.cssText = 'color:var(--text-dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          srcSpan.textContent = w.source?.sourceFile ?? '';

          const splitSpan = document.createElement('span');
          splitSpan.style.cssText = 'min-width:80px;flex-shrink:0;text-align:right;color:var(--accent)';
          splitSpan.textContent = getSplitLabel(w) ?? '—';

          row.append(cb, idSpan, srcSpan, splitSpan);
          listContainer.appendChild(row);
        }
        updateUi();
      }

      // ── Assign row ────────────────────────────────────────────────────────
      const assignRow = document.createElement('div');
      assignRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';

      const splitInput = document.createElement('input');
      splitInput.type = 'text';
      splitInput.placeholder = 'Split name (e.g. TT, FF, FS)…';
      splitInput.style.cssText = [
        'flex:1;min-width:140px;padding:5px 8px',
        'border:1px solid var(--border-mid);border-radius:4px',
        'background:var(--bg-input);color:var(--text-secondary);font-size:13px',
      ].join(';');

      const existingRow = document.createElement('div');
      existingRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap';
      for (const v of listSplitValues(wafers)) {
        const chip = document.createElement('button');
        chip.textContent = v;
        chip.style.cssText = [
          'padding:2px 8px;border-radius:10px;border:1px solid var(--border-mid)',
          'background:none;color:var(--text-secondary);cursor:pointer;font-size:11px',
        ].join(';');
        chip.addEventListener('click', () => { splitInput.value = v; });
        existingRow.appendChild(chip);
      }

      // Both action buttons are disabled while nothing is selected (see
      // updateUi) — selection here is transient scope for the next action,
      // unlike the test selector where checked = imported. A disabled button
      // plus the hint line below makes that legible instead of a silent no-op.
      const assignBtn = document.createElement('button');
      assignBtn.textContent = 'Assign to selected';
      assignBtn.style.cssText = secondaryBtnCss;
      assignBtn.addEventListener('click', () => {
        const label = splitInput.value.trim();
        if (!label || selected.size === 0) return;
        for (const i of selected) setSplitLabel(wafers[i], label);
        options.onLog('info', `Assigned ${selected.size} wafer${selected.size !== 1 ? 's' : ''} to split "${label}"`);
        selected.clear();
        renderList();
        rebuildChips();
        options.onChange();
      });

      const clearBtn = document.createElement('button');
      clearBtn.textContent = 'Clear split';
      clearBtn.style.cssText = secondaryBtnCss;
      clearBtn.addEventListener('click', () => {
        if (selected.size === 0) return;
        for (const i of selected) setSplitLabel(wafers[i], undefined);
        selected.clear();
        renderList();
        rebuildChips();
        options.onChange();
      });

      // Distinct from "Clear split" (selected rows only) — this wipes every
      // wafer's assignment regardless of the current filter/selection, so it
      // gets its own confirm step and a "danger" hover treatment (matches the
      // main toolbar's Clear/reset button) rather than living in the bulk row.
      const clearAllBtn = document.createElement('button');
      clearAllBtn.textContent = 'Clear all';
      clearAllBtn.style.cssText = secondaryBtnCss;
      clearAllBtn.addEventListener('mouseenter', () => { clearAllBtn.style.borderColor = 'var(--error-text)'; clearAllBtn.style.color = 'var(--error-text)'; });
      clearAllBtn.addEventListener('mouseleave', () => { clearAllBtn.style.borderColor = 'var(--border-mid)'; clearAllBtn.style.color = 'var(--text-secondary)'; });
      clearAllBtn.addEventListener('click', async () => {
        const assignedCount = wafers.filter(w => getSplitLabel(w) !== undefined).length;
        if (assignedCount === 0) return;
        const ask = options.onAsk ?? ((msg) => Promise.resolve(window.confirm(msg)));
        const ok = await ask(`Clear the split assignment from all ${assignedCount} assigned wafer${assignedCount !== 1 ? 's' : ''}?`);
        if (!ok) return;
        clearAllSplits(wafers);
        selected.clear();
        renderList();
        rebuildChips();
        options.onLog('info', `Cleared split assignment from ${assignedCount} wafer${assignedCount !== 1 ? 's' : ''}`);
        options.onChange();
      });

      function rebuildChips() {
        existingRow.innerHTML = '';
        for (const v of listSplitValues(wafers)) {
          const chip = document.createElement('button');
          chip.textContent = v;
          chip.style.cssText = [
            'padding:2px 8px;border-radius:10px;border:1px solid var(--border-mid)',
            'background:none;color:var(--text-secondary);cursor:pointer;font-size:11px',
          ].join(';');
          chip.addEventListener('click', () => { splitInput.value = v; });
          existingRow.appendChild(chip);
        }
      }

      assignRow.append(splitInput, assignBtn, clearBtn, clearAllBtn);

      const selectionHint = document.createElement('div');
      selectionHint.style.cssText = 'font-size:12px;color:var(--text-dim);opacity:0.8';
      selectionHint.textContent = 'Tick wafers above to enable Assign / Clear split.';

      function updateUi(): void {
        const n = selected.size;
        assignBtn.textContent = n > 0 ? `Assign to ${n} selected` : 'Assign to selected';
        for (const btn of [assignBtn, clearBtn]) {
          btn.disabled = n === 0;
          btn.style.opacity = n === 0 ? '0.5' : '';
          btn.style.cursor = n === 0 ? 'default' : 'pointer';
        }
        selectionHint.style.display = n === 0 ? '' : 'none';
        const assignedCount = wafers.filter(w => getSplitLabel(w) !== undefined).length;
        if (assignedCount === 0) {
          statusBannerText.textContent = 'No splits assigned yet — tick wafers and assign a split name below, or load a saved assignment from CSV.';
          statusBannerLoadBtn.style.display = '';
        } else {
          const splitCount = listSplitValues(wafers).length;
          statusBannerText.textContent = `${splitCount} split${splitCount !== 1 ? 's' : ''} assigned to ${assignedCount} of ${wafers.length} wafers.`;
          statusBannerLoadBtn.style.display = 'none';
        }
      }

      // ── Save / load ───────────────────────────────────────────────────────
      const ioRow = document.createElement('div');
      ioRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save splits…';
      saveBtn.style.cssText = secondaryBtnCss;
      saveBtn.addEventListener('click', async () => {
        try {
          await options.onSave(formatSplitsCsv(wafers));
          options.onLog('info', 'Splits saved');
        } catch (e) {
          options.onLog('error', `Failed to save splits: ${e instanceof Error ? e.message : String(e)}`);
        }
      });

      // Shared by the footer "Load splits…" button and the empty-state banner's.
      async function loadSplits(): Promise<void> {
        let text: string | null;
        try {
          text = await options.onLoad();
        } catch (e) {
          options.onLog('error', `Failed to load splits: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        if (text === null) return;
        const parsedRows = parseSplitsCsv(text);
        if (parsedRows.size === 0) { options.onLog('warn', 'Splits file contained no valid rows'); return; }
        let matched = 0;
        for (const w of wafers) {
          const split = parsedRows.get(w.waferId);
          if (split === undefined) continue;
          matched++;
          setSplitLabel(w, split || undefined);
        }
        const unmatched = parsedRows.size - matched;
        options.onLog('info', `Splits loaded: ${matched} wafer${matched !== 1 ? 's' : ''} matched${unmatched > 0 ? `, ${unmatched} row${unmatched !== 1 ? 's' : ''} unmatched` : ''}`);
        renderList();
        rebuildChips();
        options.onChange();
      }

      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load splits…';
      loadBtn.style.cssText = secondaryBtnCss;
      loadBtn.addEventListener('click', () => { void loadSplits(); });

      ioRow.append(saveBtn, loadBtn);

      // Footer: assignments/clears/CSV-loads above all apply immediately (no
      // separate "save" step) — Done just closes the window. Say so explicitly
      // and put a clear primary action there instead of relying on the header
      // close (X), which reads as "cancel" rather than "I'm finished".
      const footerRow = document.createElement('div');
      footerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';

      const footerNote = document.createElement('span');
      footerNote.textContent = 'Changes apply immediately.';
      footerNote.style.cssText = 'font-size:12px;color:var(--text-dim);opacity:0.8';

      const doneBtn = document.createElement('button');
      doneBtn.textContent = 'Done';
      doneBtn.style.cssText = [
        'padding:6px 16px;border-radius:4px;border:none',
        'background:var(--accent,#4a9eff);color:#fff;cursor:pointer;font-size:13px;font-weight:600',
      ].join(';');
      doneBtn.addEventListener('click', () => modalHandle.close());

      footerRow.append(footerNote, doneBtn);

      body.append(statusBanner, searchInput, suffixLabel, bulkRow, listContainer, assignRow, selectionHint, existingRow, ioRow, footerRow);
      renderList();
    },
  });
}
