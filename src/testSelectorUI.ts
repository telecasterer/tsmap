import type { TestDef } from './types';

export interface TestSelectorOptions {
  fromLargestFile?: boolean;
  initialSelection?: number[];
  nameOverrides?: Map<number, string>;
  onSave?: (entries: Array<{ num: number; name: string }>) => Promise<void>;
  onLoad?: () => Promise<string | null>;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function parseTestListFile(text: string): Array<{ num: number; name?: string }> {
  const results: Array<{ num: number; name?: string }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/[,;\s]+/).filter(t => t.length > 0);
    if (tokens.length === 0) continue;
    const num = parseInt(tokens[0], 10);
    if (isNaN(num)) continue;
    const name = tokens.length > 1 ? tokens.slice(1).join(' ') : undefined;
    results.push({ num, name });
  }
  return results;
}

export function showTestSelectorOverlay(
  testDefs: Record<string, TestDef>,
  onConfirm: (selected: number[], nameOverrides: Map<number, string>) => void,
  onCancel: () => void,
  options: TestSelectorOptions = {},
): void {
  const entries: Array<{ num: number; def: TestDef }> = Object.entries(testDefs)
    .map(([k, def]) => ({ num: parseInt(k, 10), def }))
    .filter(e => !isNaN(e.num))
    .sort((a, b) => a.num - b.num);

  const allNums = entries.map(e => e.num);

  // Default: nothing selected, or caller-supplied initial selection
  const selected = new Set<number>(options.initialSelection ?? []);

  // Name overrides: loaded from file, shadow the STDF-supplied names for display only
  const nameOverrides = new Map<number, string>(options.nameOverrides ?? []);

  function displayName(num: number, def: TestDef): string {
    return nameOverrides.get(num) ?? def.name;
  }

  // ── Overlay shell ─────────────────────────────────────────────────────────

  const overlay = document.createElement('div');
  overlay.id = 'tsmap-test-selector-overlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:10000',
    'background:rgba(0,0,0,0.5)',
    'display:flex', 'align-items:center', 'justify-content:center',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'background:var(--bg-modal)', 'border:1px solid var(--border-mid)',
    'border-radius:8px', 'padding:20px',
    'width:min(640px,90vw)', 'max-height:80vh',
    'display:flex', 'flex-direction:column', 'gap:12px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif',
    'font-size:14px', 'color:var(--text-light)',
  ].join(';');

  // ── Header ────────────────────────────────────────────────────────────────

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:16px;font-weight:600';
  title.textContent = `Select tests to import (${entries.length} found)`;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = [
    'background:none', 'border:none', 'color:var(--text-dim)',
    'font-size:16px', 'cursor:pointer', 'padding:2px 6px', 'line-height:1',
  ].join(';');
  closeBtn.addEventListener('click', () => { cleanup(); onCancel(); });

  header.append(title, closeBtn);

  // ── Controls row ──────────────────────────────────────────────────────────

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center';

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search by name or number…';
  searchInput.style.cssText = [
    'flex:1;min-width:160px;padding:5px 8px',
    'border:1px solid var(--border-mid);border-radius:4px',
    'background:var(--bg-input);color:var(--text-secondary)',
    'font-size:13px;color-scheme:light dark',
  ].join(';');

  const typeFilter = document.createElement('div');
  typeFilter.style.cssText = 'display:flex;gap:4px';
  let activeType: 'all' | 'P' | 'F' = 'all';
  const typeLabels: Array<['all' | 'P' | 'F', string]> = [['all', 'All'], ['P', 'Parametric'], ['F', 'Functional']];
  const typeBtns: HTMLButtonElement[] = [];
  for (const [val, label] of typeLabels) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.dataset.type = val;
    btn.style.cssText = [
      'padding:4px 10px;border-radius:4px;border:1px solid var(--border-mid)',
      'cursor:pointer;font-size:12px',
      val === 'all' ? 'background:var(--accent,#4a9eff);color:#fff' : 'background:none;color:var(--text-secondary)',
    ].join(';');
    btn.addEventListener('click', () => {
      activeType = val;
      typeBtns.forEach(b => {
        const active = b.dataset.type === val;
        b.style.background = active ? 'var(--accent,#4a9eff)' : 'none';
        b.style.color = active ? '#fff' : 'var(--text-secondary)';
      });
      renderList();
    });
    typeBtns.push(btn);
    typeFilter.appendChild(btn);
  }

  controls.append(searchInput, typeFilter);

  // ── Range row ─────────────────────────────────────────────────────────────

  const rangeRow = document.createElement('div');
  rangeRow.style.cssText = 'display:flex;gap:8px;align-items:center';

  const rangeInput = document.createElement('input');
  rangeInput.type = 'text';
  rangeInput.placeholder = 'e.g. test_005-test_050 or 1000-1099';
  rangeInput.style.cssText = [
    'flex:1;padding:5px 8px',
    'border:1px solid var(--border-mid);border-radius:4px',
    'background:var(--bg-input);color:var(--text-secondary)',
    'font-size:13px;color-scheme:light dark',
  ].join(';');

  const applyRangeBtn = document.createElement('button');
  applyRangeBtn.textContent = 'Select range';
  applyRangeBtn.style.cssText = [
    'padding:5px 12px;border-radius:4px;border:1px solid var(--border-mid)',
    'background:none;color:var(--text-secondary);cursor:pointer;font-size:13px',
  ].join(';');
  applyRangeBtn.addEventListener('click', () => {
    const visible = getVisible();
    const visibleSet = new Set(visible.map(e => e.num));
    const rawInput = rangeInput.value.trim();
    if (!rawInput) return;

    // Split on commas, but only commas not inside a name segment.
    // Each segment is either "X-Y" (range) or "X" (single).
    // X and Y can be numeric (test number) or a name string.
    const segments = rawInput.split(',').map(s => s.trim()).filter(Boolean);

    for (const seg of segments) {
      // Split a "from - to" range. Strategy:
      //   1. Try splitting on " - " (dash with spaces on both sides) — unambiguous.
      //   2. Fall back to last '-' in the segment (handles "test_005-test_050").
      let beforeDash: string | null = null;
      let afterDash: string | null = null;

      const spacedDash = seg.indexOf(' - ');
      if (spacedDash !== -1) {
        beforeDash = seg.slice(0, spacedDash).trim();
        afterDash = seg.slice(spacedDash + 3).trim();
      } else {
        const lastDash = seg.lastIndexOf('-');
        if (lastDash > 0 && lastDash < seg.length - 1) {
          beforeDash = seg.slice(0, lastDash).trim();
          afterDash = seg.slice(lastDash + 1).trim();
        }
      }

      if (beforeDash !== null && afterDash !== null) {

        const loNum = parseInt(beforeDash, 10);
        const hiNum = parseInt(afterDash, 10);

        if (!isNaN(loNum) && !isNaN(hiNum)) {
          // Numeric range: select all entries with num in [loNum, hiNum]
          for (const e of entries) {
            if (e.num >= loNum && e.num <= hiNum && visibleSet.has(e.num)) selected.add(e.num);
          }
        } else {
          // Name-based range: find entries whose name matches (prefix/substring)
          // and select everything between the first and last match by sorted position.
          const loLower = beforeDash.toLowerCase();
          const hiLower = afterDash.toLowerCase();
          const loIdx = entries.findIndex(e => e.def.name.toLowerCase().startsWith(loLower) || e.def.name.toLowerCase() === loLower);
          // Find last entry matching hiLower
          let hiIdx = -1;
          for (let i = entries.length - 1; i >= 0; i--) {
            const n = entries[i].def.name.toLowerCase();
            if (n.startsWith(hiLower) || n === hiLower) { hiIdx = i; break; }
          }
          if (loIdx !== -1 && hiIdx !== -1 && loIdx <= hiIdx) {
            for (let i = loIdx; i <= hiIdx; i++) {
              if (visibleSet.has(entries[i].num)) selected.add(entries[i].num);
            }
          }
        }
      } else {
        // Single value: numeric test number or exact/prefix name match
        const n = parseInt(seg, 10);
        if (!isNaN(n)) {
          if (visibleSet.has(n)) selected.add(n);
        } else {
          const segLower = seg.toLowerCase();
          for (const e of entries) {
            if (visibleSet.has(e.num) && (e.def.name.toLowerCase() === segLower || e.def.name.toLowerCase().startsWith(segLower))) {
              selected.add(e.num);
            }
          }
        }
      }
    }
    renderList();
    updateFooter();
  });

  rangeRow.append(rangeInput, applyRangeBtn);

  // ── Select all / none ─────────────────────────────────────────────────────

  const bulkRow = document.createElement('div');
  bulkRow.style.cssText = 'display:flex;gap:8px;align-items:center';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.textContent = 'Select all';
  selectAllBtn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid var(--border-mid);background:none;color:var(--text-secondary);cursor:pointer;font-size:12px';
  selectAllBtn.addEventListener('click', () => {
    for (const e of getVisible()) selected.add(e.num);
    renderList();
    updateFooter();
  });

  const selectNoneBtn = document.createElement('button');
  selectNoneBtn.textContent = 'Select none';
  selectNoneBtn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid var(--border-mid);background:none;color:var(--text-secondary);cursor:pointer;font-size:12px';
  selectNoneBtn.addEventListener('click', () => {
    for (const e of getVisible()) selected.delete(e.num);
    renderList();
    updateFooter();
  });

  bulkRow.append(selectAllBtn, selectNoneBtn);

  // ── List ──────────────────────────────────────────────────────────────────

  const listContainer = document.createElement('div');
  listContainer.style.cssText = [
    'overflow-y:auto;max-height:40vh',
    'border:1px solid var(--border-mid);border-radius:4px',
    'font-family:ui-monospace,"Cascadia Code","Segoe UI Mono",monospace',
    'font-size:12px',
  ].join(';');

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { renderList(); }, 150);
  });

  function getVisible(): Array<{ num: number; def: TestDef }> {
    const q = searchInput.value.trim().toLowerCase();
    return entries.filter(e => {
      if (activeType !== 'all' && e.def.testType !== activeType) return false;
      if (q) {
        const numMatch = e.num.toString().includes(q);
        const nameMatch = displayName(e.num, e.def).toLowerCase().includes(q);
        if (!numMatch && !nameMatch) return false;
      }
      return true;
    });
  }

  let lastClickedVisibleIndex: number | null = null;

  function renderList(): void {
    listContainer.innerHTML = '';
    const visible = getVisible();
    for (let vi = 0; vi < visible.length; vi++) {
      const e = visible[vi];
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
      cb.checked = selected.has(e.num);
      cb.style.cssText = 'flex-shrink:0;cursor:pointer';
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(e.num); else selected.delete(e.num);
        lastClickedVisibleIndex = vi;
        updateFooter();
      });
      cb.addEventListener('click', (evt) => {
        if (evt.shiftKey && lastClickedVisibleIndex !== null) {
          evt.preventDefault();
          const lo = Math.min(lastClickedVisibleIndex, vi);
          const hi = Math.max(lastClickedVisibleIndex, vi);
          const shouldSelect = selected.has(visible[lastClickedVisibleIndex].num);
          for (let i = lo; i <= hi; i++) {
            if (shouldSelect) selected.add(visible[i].num);
            else selected.delete(visible[i].num);
          }
          renderList();
          updateFooter();
        }
        // non-shift clicks: let the browser toggle cb.checked, change handler syncs selected
      });

      const numSpan = document.createElement('span');
      numSpan.style.cssText = 'color:var(--text-dim);min-width:52px;flex-shrink:0';
      numSpan.textContent = e.num.toString();

      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nameSpan.textContent = displayName(e.num, e.def) || e.num.toString();

      const metaSpan = document.createElement('span');
      metaSpan.style.cssText = 'color:var(--text-dim);font-size:11px;flex-shrink:0';
      const parts: string[] = [];
      if (e.def.loLimit != null) parts.push(`≥${e.def.loLimit}`);
      if (e.def.hiLimit != null) parts.push(`≤${e.def.hiLimit}`);
      if (e.def.units) parts.push(e.def.units);
      metaSpan.textContent = parts.join(' ');

      row.append(cb, numSpan, nameSpan, metaSpan);
      listContainer.appendChild(row);
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  const footerNote = document.createElement('div');
  footerNote.style.cssText = 'font-size:12px;color:var(--text-dim);opacity:0.7';

  function setFooterNotes(loadWarning?: string): void {
    const parts: string[] = [];
    if (options.fromLargestFile) parts.push('Test list from largest file — use Filter after load if tests are missing.');
    if (loadWarning) parts.push(loadWarning);
    footerNote.textContent = parts.join(' ');
    footerNote.style.display = parts.length > 0 ? '' : 'none';
  }
  setFooterNotes();

  const footerRow = document.createElement('div');
  footerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';

  const countLabel = document.createElement('span');
  countLabel.style.cssText = 'font-size:13px;color:var(--text-dim)';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px';

  const secondaryBtnCss = [
    'padding:6px 16px;border-radius:4px;border:1px solid var(--border-mid)',
    'background:none;color:var(--text-secondary);cursor:pointer;font-size:13px',
  ].join(';');

  if (options.onSave) {
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save list';
    saveBtn.style.cssText = secondaryBtnCss;
    saveBtn.addEventListener('click', async () => {
      const saveEntries = Array.from(selected)
        .sort((a, b) => a - b)
        .map(num => {
          const def = entries.find(e => e.num === num)!.def;
          return { num, name: displayName(num, def) || String(num) };
        });
      try {
        await options.onSave!(saveEntries);
        options.onLog?.('info', `Test list saved: ${saveEntries.length} test${saveEntries.length !== 1 ? 's' : ''}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        options.onLog?.('error', `Failed to save test list: ${msg}`);
      }
    });
    btnRow.appendChild(saveBtn);
  }

  if (options.onLoad) {
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load list';
    loadBtn.style.cssText = secondaryBtnCss;
    loadBtn.addEventListener('click', async () => {
      let text: string | null;
      try {
        text = await options.onLoad!();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        options.onLog?.('error', `Failed to load test list: ${msg}`);
        return;
      }
      if (text === null) return;
      const parsed = parseTestListFile(text);
      if (parsed.length === 0) {
        options.onLog?.('warn', 'Test list file contained no valid entries');
        return;
      }
      const allNumsSet = new Set(allNums);
      let unknownCount = 0;
      selected.clear();
      for (const { num, name } of parsed) {
        if (!allNumsSet.has(num)) { unknownCount++; continue; }
        selected.add(num);
        if (name) nameOverrides.set(num, name);
      }
      if (unknownCount > 0) {
        options.onLog?.('warn', `${unknownCount} test${unknownCount !== 1 ? 's' : ''} in file not found in current scan and were ignored`);
      }
      options.onLog?.('info', `Test list loaded: ${selected.size} test${selected.size !== 1 ? 's' : ''} selected`);
      setFooterNotes(unknownCount > 0 ? `${unknownCount} test${unknownCount !== 1 ? 's' : ''} in file not found in current scan and were ignored.` : undefined);
      renderList();
      updateFooter();
    });
    btnRow.appendChild(loadBtn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = secondaryBtnCss;
  cancelBtn.addEventListener('click', () => { cleanup(); onCancel(); });

  const confirmBtn = document.createElement('button');
  confirmBtn.style.cssText = [
    'padding:6px 16px;border-radius:4px;border:none',
    'background:var(--accent,#4a9eff);color:#fff;cursor:pointer;font-size:13px;font-weight:600',
  ].join(';');
  confirmBtn.addEventListener('click', () => {
    const sel = Array.from(selected).sort((a, b) => a - b);
    if (sel.length === 0) {
      if (!confirm('No tests selected — only bin data will be loaded. Continue?')) return;
    }
    cleanup();
    onConfirm(sel, new Map(nameOverrides));
  });

  function updateFooter(): void {
    const n = selected.size;
    countLabel.textContent = `${n} of ${allNums.length} tests selected`;
    confirmBtn.textContent = n === 0 ? 'Import (bin data only) →' : `Import ${n} test${n !== 1 ? 's' : ''} →`;
  }

  btnRow.append(cancelBtn, confirmBtn);
  footerRow.append(countLabel, btnRow);
  footer.append(footerNote, footerRow);

  // ── Backdrop click ────────────────────────────────────────────────────────

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { cleanup(); onCancel(); }
  });

  // ── Assemble ──────────────────────────────────────────────────────────────

  panel.append(header, controls, rangeRow, bulkRow, listContainer, footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  renderList();
  updateFooter();

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function cleanup(): void {
    overlay.remove();
  }
}
