import type { TestDef, TestOverride } from './types';
import { ICONS } from './icons';
import { attachTooltip } from './tooltip';

export interface CapacityInfo {
  /** Total dies across all files being loaded. */
  dieCount: number;
  /** Total tests found in the scan. */
  totalTests: number;
}

export interface TestSelectorOptions {
  /**
   * Current scan scope for a multi-file binary load: `'largest'` = the test list
   * came from the largest file only (a fast default); `'all'` = every file was
   * scanned and merged. Drives the source caption + the "scan all" toggle.
   * Undefined for single-file or CSV/JSON loads (no scope to widen).
   */
  scanScope?: 'largest' | 'all';
  /** Number of binary files in the load — shown in the "scan all N files" toggle. */
  scanFileCount?: number;
  /**
   * Invoked when the user asks to widen the scan to all files. Receives the
   * in-progress selection + test overrides so the host can re-open the selector
   * with them preserved. Only wired when widening is possible (>1 file, scope
   * still `'largest'`); absent otherwise, which hides the toggle.
   */
  onScanAll?: (selection: number[], testOverrides: Map<number, TestOverride>) => void;
  initialSelection?: number[];
  testOverrides?: Map<number, TestOverride>;
  capacity?: CapacityInfo;
  onSave?: (entries: TestListEntry[]) => Promise<void>;
  onLoad?: () => Promise<string | null>;
  /**
   * Same file format the "Load list" button accepts — applied once, before
   * the overlay's first render, so the selection/renames are already checked
   * when the user sees it (used for a CLI-supplied `--tests` file). The
   * overlay is always still shown; this only pre-fills it, per CLAUDE.md's
   * "test selector is always shown, user must choose explicitly" rule.
   */
  preloadListText?: string;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  onAsk?: (message: string) => Promise<boolean>;
}

/** One row of a parsed test-list/definitions file — `num` plus whatever
 * override fields that row actually specified. */
export type TestListEntry = { num: number } & TestOverride;

type TestListField = 'num' | 'name' | 'loLimit' | 'hiLimit' | 'units' | 'testType';

/** Header cell (normalized: trimmed, lowercased, spaces/dashes/underscores
 * collapsed) -> canonical column. Lets a hand-authored or externally-exported
 * file spell columns as "LSL"/"USL"/"Test Type" etc. */
const HEADER_FIELD_ALIASES: Record<string, TestListField> = {
  num: 'num', number: 'num', testnum: 'num', testnumber: 'num',
  name: 'name', testname: 'name',
  lolimit: 'loLimit', lo: 'loLimit', lsl: 'loLimit', low: 'loLimit', lowlimit: 'loLimit',
  hilimit: 'hiLimit', hi: 'hiLimit', usl: 'hiLimit', high: 'hiLimit', highlimit: 'hiLimit',
  units: 'units', unit: 'units',
  testtype: 'testType', type: 'testType',
};

function normalizeHeaderKey(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Column order assumed for a comma-delimited file with no header row —
 * matches the file this app has always written (num,name), extended with
 * the new optional columns. */
const DEFAULT_COLUMNS: TestListField[] = ['num', 'name', 'loLimit', 'hiLimit', 'units', 'testType'];

/**
 * Parses a "test list" / test-definitions file: one test per line, either
 * `<num> <name>` (legacy, whitespace/semicolon-separated, no limit/type
 * columns — untouched for backward compatibility) or comma-delimited with an
 * optional self-describing header (`num,name,loLimit,hiLimit,units,testType`,
 * any subset/order, column names matched case-insensitively with synonyms
 * like `lsl`/`usl`/`type` — see `HEADER_FIELD_ALIASES`). Without a header,
 * comma-delimited rows use the default column order above, so old
 * header-less `num,name` saves keep parsing exactly as before.
 *
 * Never throws: a malformed individual field is dropped (with `onWarn`, if
 * given) but leaves the rest of the row intact; only a row whose test number
 * can't be identified at all is skipped entirely.
 */
export function parseTestListFile(
  text: string,
  onWarn?: (lineNo: number, message: string) => void,
): TestListEntry[] {
  const results: TestListEntry[] = [];
  let columns: Array<TestListField | undefined> = DEFAULT_COLUMNS;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    if (!line.includes(',')) {
      // Legacy shorthand: whitespace/semicolon-separated, num + optional
      // name only — no limit/type columns are reachable via this form.
      const tokens = line.split(/[;\s]+/).filter(t => t.length > 0);
      if (tokens.length === 0) continue;
      const num = parseInt(tokens[0], 10);
      if (isNaN(num)) continue;
      const name = tokens.length > 1 ? tokens.slice(1).join(' ') : undefined;
      results.push({ num, name });
      continue;
    }

    const fields = line.split(',').map(f => f.trim());
    const numIdx = columns.indexOf('num');
    const numRaw = numIdx >= 0 && numIdx < fields.length ? fields[numIdx] : fields[0];
    const num = parseInt(numRaw, 10);

    if (isNaN(num)) {
      // Not a data row: either a header line (redefines `columns` for
      // subsequent rows) or unrecognized text — either way, not data. Only
      // warn about unmatched cells once we know this line IS a header (i.e.
      // at least one cell matched) — a genuinely unrecognized/garbage line
      // (no matches at all) is silently skipped, same as always.
      const mapping: Array<TestListField | undefined> = [];
      const unmatchedRaw: string[] = [];
      let matchedAny = false;
      for (const raw of fields) {
        const field = HEADER_FIELD_ALIASES[normalizeHeaderKey(raw)];
        mapping.push(field);
        if (field) matchedAny = true;
        else if (raw) unmatchedRaw.push(raw);
      }
      if (matchedAny) {
        columns = mapping;
        for (const raw of unmatchedRaw) onWarn?.(lineNo, `Unrecognized column "${raw}" ignored`);
      }
      continue;
    }

    const row: TestListEntry = { num };
    for (let c = 0; c < fields.length; c++) {
      const field = columns[c];
      const raw = fields[c];
      if (!field || field === 'num') {
        if (field !== 'num' && raw) onWarn?.(lineNo, `Unrecognized extra column ${c + 1} ("${raw}") ignored`);
        continue;
      }
      if (!raw) continue; // blank field => no override for this field
      switch (field) {
        case 'name':
          row.name = raw;
          break;
        case 'loLimit':
        case 'hiLimit': {
          const n = Number(raw);
          if (Number.isFinite(n)) row[field] = n;
          else onWarn?.(lineNo, `Invalid ${field === 'loLimit' ? 'loLimit' : 'hiLimit'} value "${raw}" ignored`);
          break;
        }
        case 'units':
          row.units = raw;
          break;
        case 'testType': {
          const t = raw.toUpperCase();
          if (t === 'P' || t === 'F') row.testType = t;
          else onWarn?.(lineNo, `Invalid test type "${raw}" ignored (expected P or F)`);
          break;
        }
      }
    }
    results.push(row);
  }

  return results;
}

/** Serializes test-list entries back to the file `parseTestListFile` reads —
 * canonical header, one row per entry, all 6 columns always present (blank
 * for unset fields). Commas inside `name`/`units` are replaced with a space
 * (no CSV quoting support) — a pre-existing lossy edge case, not new here. */
export function formatTestListCsv(entries: TestListEntry[]): string {
  const clean = (s: string) => s.replace(/,/g, ' ');
  const lines = [
    '# tsmap test list',
    `# Saved: ${new Date().toISOString()}`,
    'num,name,loLimit,hiLimit,units,testType',
    ...entries.map(e => [
      e.num,
      e.name !== undefined ? clean(e.name) : '',
      e.loLimit !== undefined ? e.loLimit : '',
      e.hiLimit !== undefined ? e.hiLimit : '',
      e.units !== undefined ? clean(e.units) : '',
      e.testType ?? '',
    ].join(',')),
  ];
  return lines.join('\n');
}

export function showTestSelectorOverlay(
  testDefs: Record<string, TestDef>,
  onConfirm: (selected: number[], testOverrides: Map<number, TestOverride>) => void,
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

  // Test overrides: loaded from file (or an inline rename), shadow the
  // parser-supplied name/limits/units/type for display, and are applied on
  // top of the real TestDef after import (see applyTestOverrides in lib.ts).
  const testOverrides = new Map<number, TestOverride>(options.testOverrides ?? []);

  function displayName(num: number, def: TestDef): string {
    return testOverrides.get(num)?.name ?? def.name;
  }

  function effectiveLimits(num: number, def: TestDef): { loLimit?: number; hiLimit?: number; units?: string; testType: 'P' | 'F' } {
    const ov = testOverrides.get(num);
    return {
      loLimit: ov?.loLimit ?? def.loLimit,
      hiLimit: ov?.hiLimit ?? def.hiLimit,
      units: ov?.units ?? def.units,
      testType: ov?.testType ?? def.testType,
    };
  }

  // ── Overlay shell ─────────────────────────────────────────────────────────

  // z-modal: this overlay is shown both pre-render (initial load) and
  // post-render ("Filter tests…" re-invokes it over an already-rendered
  // wafer map/gallery) — it must clear wmap's own toolbar band (--wmap-z,
  // default 6000) in the post-render case, same as any other app modal
  // opened over a rendered map. See the z-index note in CLAUDE.md.
  const overlay = document.createElement('div');
  overlay.id = 'tsmap-test-selector-overlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:var(--z-modal)',
    'background:rgba(0,0,0,0.5)',
    'display:flex', 'align-items:center', 'justify-content:center',
  ].join(';');

  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'tsmap-test-selector-title');
  panel.tabIndex = -1;
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
  title.id = 'tsmap-test-selector-title';
  title.style.cssText = 'font-size:16px;font-weight:600';
  title.textContent = `Select tests to import (${entries.length} found)`;

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = ICONS.close;
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.style.cssText = [
    'background:none', 'border:none', 'color:var(--text-dim)',
    'cursor:pointer', 'padding:2px 6px', 'line-height:1',
    'display:flex', 'align-items:center', 'justify-content:center',
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
    'font-size:13px',
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
    'font-size:13px',
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

      // Renaming for display: looks like plain text until hovered/focused (a
      // border/background only appear then), so the common non-renaming case
      // is visually identical to the old static span. Committing happens on
      // blur/Enter (not per keystroke) — clearing or retyping the original
      // name removes the override so displayName() falls back to e.def.name.
      // Lives in `testOverrides`, the same map Save list / Load list already
      // read and write, so no separate save-path wiring is needed. Merges
      // into any existing entry (rather than replacing it) so renaming a test
      // never discards a limit/type override loaded from a file on the same row.
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.spellcheck = false;
      nameInput.value = displayName(e.num, e.def) || e.num.toString();
      nameInput.setAttribute('aria-label', `Display name for test ${e.num}`);
      nameInput.style.cssText = [
        'flex:1;min-width:0;font:inherit;color:inherit',
        'background:none;border:1px solid transparent;border-radius:3px',
        'padding:1px 4px;margin:-1px -4px',
        'overflow:hidden;text-overflow:ellipsis',
      ].join(';');
      // Click/mousedown on the input must not fall through to the row's own
      // shift-click range-select handling on the checkbox (that listener is
      // on `cb`, not here, but stop it explicitly rather than rely on the
      // browser's label/form-control click semantics being exactly right).
      nameInput.addEventListener('click', evt => evt.stopPropagation());
      nameInput.addEventListener('mouseenter', () => {
        if (document.activeElement !== nameInput) nameInput.style.borderColor = 'var(--border-mid)';
      });
      nameInput.addEventListener('mouseleave', () => {
        if (document.activeElement !== nameInput) nameInput.style.borderColor = 'transparent';
      });
      nameInput.addEventListener('focus', () => {
        nameInput.style.borderColor = 'var(--accent,#4a9eff)';
        nameInput.style.background = 'var(--bg-input)';
      });
      nameInput.addEventListener('blur', () => {
        nameInput.style.borderColor = 'transparent';
        nameInput.style.background = 'none';
        const trimmed = nameInput.value.trim();
        const existing = testOverrides.get(e.num) ?? {};
        if (!trimmed || trimmed === e.def.name) {
          const { name: _name, ...rest } = existing;
          if (Object.keys(rest).length) testOverrides.set(e.num, rest);
          else testOverrides.delete(e.num);
          nameInput.value = e.def.name;
        } else {
          testOverrides.set(e.num, { ...existing, name: trimmed });
          nameInput.value = trimmed;
        }
      });
      nameInput.addEventListener('keydown', evt => {
        if (evt.key === 'Enter') { evt.preventDefault(); nameInput.blur(); }
        else if (evt.key === 'Escape') {
          // Revert the in-progress edit only — stopPropagation so this
          // doesn't also reach the overlay's own document-level Escape
          // listener, which would close the whole dialog.
          evt.preventDefault();
          evt.stopPropagation();
          nameInput.value = displayName(e.num, e.def); // discard in-progress edit
          nameInput.blur();
        }
      });

      // Limits/units and type columns — always shown (not just when overridden),
      // so the dialog doubles as a read-only preview of a test's full definition.
      // Values are *effective* (override-aware, like displayName()) rather than
      // the raw parsed def — the only visible confirmation that a loaded
      // limit/type override actually took effect, since there's no inline
      // editor for these fields (Save/Load list is the whole edit workflow).
      const eff = effectiveLimits(e.num, e.def);

      const limitsSpan = document.createElement('span');
      limitsSpan.style.cssText = 'color:var(--text-dim);font-size:11px;flex-shrink:0;min-width:120px;text-align:right';
      const limitParts: string[] = [];
      if (eff.loLimit != null) limitParts.push(`≥${eff.loLimit}`);
      if (eff.hiLimit != null) limitParts.push(`≤${eff.hiLimit}`);
      if (eff.units) limitParts.push(eff.units);
      limitsSpan.textContent = limitParts.join(' ');

      const typeSpan = document.createElement('span');
      typeSpan.style.cssText = 'color:var(--text-dim);font-size:11px;flex-shrink:0;min-width:14px;text-align:center';
      typeSpan.textContent = eff.testType;

      const ov = testOverrides.get(e.num);
      if (ov && (ov.loLimit !== undefined || ov.hiLimit !== undefined || ov.units !== undefined)) {
        attachTooltip(limitsSpan, 'Loaded from file');
      }
      if (ov?.testType !== undefined) {
        attachTooltip(typeSpan, 'Loaded from file');
      }

      row.append(cb, numSpan, nameInput, limitsSpan, typeSpan);
      listContainer.appendChild(row);
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  // Scan-scope row: a caption describing where the test list came from, and — when
  // only the largest file was scanned — a button to widen the scan to all files.
  const scopeRow = document.createElement('div');
  scopeRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';

  const fileCount = options.scanFileCount ?? 0;
  if (options.scanScope) {
    const scopeNote = document.createElement('span');
    scopeNote.style.cssText = 'font-size:12px;color:var(--text-dim);opacity:0.8';
    scopeNote.textContent = options.scanScope === 'all'
      ? `Test list merged from all ${fileCount} files.`
      : 'Test list from the largest file.';
    scopeRow.appendChild(scopeNote);

    if (options.scanScope === 'largest' && options.onScanAll) {
      const scanAllBtn = document.createElement('button');
      scanAllBtn.textContent = `Scan all ${fileCount} files`;
      scanAllBtn.style.cssText = [
        'padding:3px 10px;border-radius:4px;border:1px solid var(--border-mid)',
        'background:none;color:var(--accent,#4a9eff);cursor:pointer;font-size:12px',
      ].join(';');
      attachTooltip(scanAllBtn, 'Re-scan every file and merge the full test list (use when a test only appears in a smaller file). Your current selection is kept.');
      scanAllBtn.addEventListener('click', () => {
        cleanup();
        options.onScanAll!(Array.from(selected).sort((a, b) => a - b), new Map(testOverrides));
      });
      scopeRow.appendChild(scanAllBtn);
    }
  }

  const footerNote = document.createElement('div');
  footerNote.style.cssText = 'font-size:12px;color:var(--text-dim);opacity:0.7';

  function setFooterNotes(loadWarning?: string): void {
    footerNote.textContent = loadWarning ?? '';
    footerNote.style.display = loadWarning ? '' : 'none';
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
      const saveEntries: TestListEntry[] = Array.from(selected)
        .sort((a, b) => a - b)
        .map(num => {
          const def = entries.find(e => e.num === num)!.def;
          const eff = effectiveLimits(num, def);
          return {
            num,
            name: displayName(num, def) || String(num),
            loLimit: eff.loLimit,
            hiLimit: eff.hiLimit,
            units: eff.units,
            testType: eff.testType,
          };
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

  // Shared by the interactive "Load list" button and a CLI-supplied
  // `preloadListText` (applied once before the overlay's first render) — same
  // parsing, unknown-test validation, and log messages either way.
  function applyLoadedList(text: string): void {
    let malformedCount = 0;
    const parsed = parseTestListFile(text, () => { malformedCount++; });
    if (parsed.length === 0) {
      options.onLog?.('warn', 'Test list file contained no valid entries');
      return;
    }
    const allNumsSet = new Set(allNums);
    let unknownCount = 0;
    let limitOnFunctionalCount = 0;
    selected.clear();
    for (const { num, name, loLimit, hiLimit, units, testType } of parsed) {
      if (!allNumsSet.has(num)) { unknownCount++; continue; }
      selected.add(num);
      const existing = testOverrides.get(num) ?? {};
      const ov: TestOverride = { ...existing };
      if (name !== undefined) ov.name = name;
      // Functional tests have no numeric value to check a spec limit
      // against — a row that specifies limits for one (whether the row's
      // own type column says F, or the test's real parsed type is F and the
      // row doesn't override type) is a likely data-entry mistake, so drop
      // the limits and warn rather than carry dead data (applyTestOverrides
      // in lib.ts enforces the same rule as a final safety net).
      const effectiveType = testType ?? testDefs[String(num)]?.testType;
      if (effectiveType === 'F' && (loLimit !== undefined || hiLimit !== undefined)) {
        limitOnFunctionalCount++;
      } else {
        if (loLimit !== undefined) ov.loLimit = loLimit;
        if (hiLimit !== undefined) ov.hiLimit = hiLimit;
      }
      if (units !== undefined) ov.units = units;
      if (testType !== undefined) ov.testType = testType;
      if (Object.keys(ov).length) testOverrides.set(num, ov);
    }
    const notes: string[] = [];
    if (unknownCount > 0) {
      const msg = `${unknownCount} test${unknownCount !== 1 ? 's' : ''} in file not found in current scan and were ignored`;
      options.onLog?.('warn', msg);
      notes.push(`${msg}.`);
    }
    if (limitOnFunctionalCount > 0) {
      const msg = `${limitOnFunctionalCount} functional test${limitOnFunctionalCount !== 1 ? 's' : ''} had limit values ignored (limits only apply to parametric tests)`;
      options.onLog?.('warn', msg);
      notes.push(`${msg}.`);
    }
    if (malformedCount > 0) {
      const msg = `${malformedCount} field${malformedCount !== 1 ? 's' : ''} in file could not be parsed and were ignored`;
      options.onLog?.('warn', msg);
      notes.push(`${msg}.`);
    }
    options.onLog?.('info', `Test list loaded: ${selected.size} test${selected.size !== 1 ? 's' : ''} selected`);
    setFooterNotes(notes.length ? notes.join(' ') : undefined);
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
      applyLoadedList(text);
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

  // ── Memory advisory ────────────────────────────────────────────────────────
  // Thresholds in die×test pairs. Calibrated against known-good behaviour:
  // ~300k dies × 30 tests = 9M pairs is fine; warn starts above ~50M pairs.
  const WARN_PAIRS   = 50_000_000;   // ~50M die×test pairs — show amber
  const DANGER_PAIRS = 200_000_000;  // ~200M die×test pairs — show red + confirm

  const memAdvisory = document.createElement('div');
  memAdvisory.style.cssText = 'font-size:12px;display:none';

  function dieTestPairs(): number {
    if (!options.capacity || selected.size === 0) return 0;
    return options.capacity.dieCount * selected.size;
  }

  function updateMemAdvisory(): void {
    if (!options.capacity || selected.size === 0) {
      memAdvisory.style.display = 'none';
      return;
    }
    const pairs = dieTestPairs();
    if (pairs < WARN_PAIRS) {
      memAdvisory.style.display = 'none';
      return;
    }
    memAdvisory.style.display = '';
    if (pairs >= DANGER_PAIRS) {
      memAdvisory.style.color = 'var(--error,#f87171)';
      memAdvisory.textContent = 'Very large selection — risk of running out of memory';
    } else {
      memAdvisory.style.color = 'var(--warn,#fbbf24)';
      memAdvisory.textContent = 'Large selection — may be slow to load';
    }
  }

  confirmBtn.addEventListener('click', async () => {
    const sel = Array.from(selected).sort((a, b) => a - b);
    const ask = options.onAsk ?? ((msg) => Promise.resolve(window.confirm(msg)));
    if (sel.length === 0) {
      if (!await ask('No tests selected — only bin data will be loaded. Continue?')) return;
    }
    if (dieTestPairs() >= DANGER_PAIRS) {
      if (!await ask('This is a very large selection and may run out of memory. Consider selecting fewer tests. Continue anyway?')) return;
    }
    cleanup();
    onConfirm(sel, new Map(testOverrides));
  });

  function updateFooter(): void {
    const n = selected.size;
    countLabel.textContent = `${n} of ${allNums.length} tests selected`;
    confirmBtn.textContent = n === 0 ? 'Import (bin data only) →' : `Import ${n} test${n !== 1 ? 's' : ''} →`;
    updateMemAdvisory();
  }

  btnRow.append(cancelBtn, confirmBtn);
  footerRow.append(countLabel, btnRow);
  footer.append(scopeRow, footerNote, memAdvisory, footerRow);

  // ── Backdrop click ────────────────────────────────────────────────────────

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { cleanup(); onCancel(); }
  });

  // ── Escape to cancel ──────────────────────────────────────────────────────
  // Routes through the same cleanup + onCancel path as the backdrop/Cancel
  // button so the load flow is restored consistently. Ignored while a nested
  // native confirm (onAsk) is up — window.confirm is modal and consumes keys —
  // so no extra guard is needed here.

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { cleanup(); onCancel(); }
  }
  document.addEventListener('keydown', onKeyDown);

  // ── Assemble ──────────────────────────────────────────────────────────────

  panel.append(header, controls, rangeRow, bulkRow, listContainer, footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  panel.focus(); // move focus into the dialog so Esc and SR navigation work

  if (options.preloadListText) applyLoadedList(options.preloadListText);

  renderList();
  updateFooter();

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function cleanup(): void {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  }
}
