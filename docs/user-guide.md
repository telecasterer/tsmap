---
title: User Guide
---

<!-- RENDERER NOTE: this file is processed by two markdown engines.
     marked (scripts/build-user-guide.mjs) → in-app ? modal
     Python-Markdown/pymdownx (zensical)   → docs site
     Rules to avoid divergence:
     - Use 4-space-indented blocks for plain code examples, NOT fenced blocks.
       Fenced blocks require a language tag on the docs site but not in marked.
     - HTML mockup blocks (<div class="tsmap-mockup">) work in both renderers.
     - Test both after structural changes: npm run build:guide && npm run build:site
-->

# tsmap User Guide

tsmap loads semiconductor wafer map data from STDF, ATDF, CSV, and JSON files and renders
interactive yield maps, parametric heat maps, and statistical charts. It runs as a native
desktop application on Linux, macOS, and Windows, and as a browser app at
[telecasterer.github.io/tsmap/app/](https://telecasterer.github.io/tsmap/app/).

This guide covers the full workflow: opening files, column mapping, test filtering, reading
maps, and using the charts view.

## 1. Supported file formats

| Format | Extensions | Notes |
|--------|-----------|-------|
| STDF v4 | `.stdf`, `.std` | Binary; PTR (parametric) and FTR (functional) records; multi-wafer lots |
| ATDF | `.atdf`, `.atd` | ASCII equivalent of STDF; same data, same features |
| CSV | `.csv`, `.txt`, `.dat` | Tab, semicolon, and comma auto-detected; wide and long (pivot) formats |
| JSON | `.json` | Flat array of die objects or nested `[{ wafer, results: [{die}] }]` |
| Gzip | `.gz` | Transparent decompression — e.g. `lot.stdf.gz` |
| Zip | `.zip` | All contained files extracted and loaded as a batch |

STDF and ATDF are always parsed natively — never attempt to open them in a text editor
or spreadsheet. CSV and JSON require a [column mapping step](#3-column-mapping-csv-and-json)
before the data is parsed.

---

## 2. Opening files

### Installing past security warnings

tsmap's installers are not code-signed, so your operating system may warn that the app is
from an unknown or unidentified developer the first time you run it. This is expected — it
reflects the absence of a paid signing certificate, not a problem with the app. The steps
below let you install anyway. If you would rather not install at all, the
[browser version](https://telecasterer.github.io/tsmap/app/) runs with no download.

**Windows** — SmartScreen shows a blue "Windows protected your PC" dialog when you run
`tsmap-<version>-windows-x64.msi` (or the `-setup.exe` installer). Click **More info**, then
**Run anyway**. The warning fades as more people install the app.

**macOS** — Gatekeeper blocks the app with "tsmap can't be opened because it is from an
unidentified developer." After mounting the `.dmg`
(`tsmap-<version>-macos-apple-silicon.dmg` for M-series Macs, `-macos-intel.dmg` for Intel)
and dragging tsmap to Applications, **right-click** the app in Applications and choose
**Open**, then click **Open** in the dialog. You only need to do this once. If macOS instead
says the app is "damaged and can't be opened" — common on Apple Silicon for downloaded
unsigned apps — clear the quarantine flag in Terminal:

    xattr -dr com.apple.quarantine /Applications/tsmap.app

**Linux** — the `.deb`, `.rpm`, and `.AppImage` builds run normally; any warning is just a
browser download nag. For the AppImage, mark it executable first:

    chmod +x tsmap-*-linux-x86_64.AppImage
    ./tsmap-*-linux-x86_64.AppImage

<div class="tsmap-mockup" style="display:flex;align-items:center;gap:12px;padding:6px 12px;background:var(--bg-toolbar);border:1px solid var(--border-strong);border-radius:5px;font-size:13px;margin:8px 0 12px;">
  <span style="background:none;border:1px solid var(--accent);border-radius:4px;color:var(--accent);font-size:12px;padding:3px 10px;">Open file</span>
  <span style="background:none;border:1px solid var(--border-dim);border-radius:4px;color:var(--text-muted);font-size:12px;padding:3px 10px;opacity:.4;">Add files</span>
  <span style="background:none;border:1px solid var(--border-muted);border-radius:4px;color:var(--text-muted);font-size:12px;padding:3px 10px;opacity:.4;">Clear</span>
  <span style="width:1px;height:16px;background:var(--border-mid);flex-shrink:0;"></span>
  <span style="background:none;border:1px solid var(--border-dim);border-radius:4px;color:var(--text-muted);font-size:12px;padding:3px 10px;opacity:.4;">Charts</span>
  <span style="margin-left:auto;"></span>
  <span style="background:none;color:var(--text-muted);display:flex;align-items:center;justify-content:center;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg></span>
</div>

### Open file

Click **Open file** in the toolbar to open a file picker. You can select one file or
multiple files at once. On the desktop the picker opens a native OS dialog; in the browser
it opens the browser file dialog.

### Drag and drop

Drop one or more files anywhere in the window. This is equivalent to selecting them through
the file picker and is supported on both desktop and browser.

### Adding files to an existing lot

Once a file is loaded, the **Add files** button becomes active. Use it to append additional
wafers to the current gallery. After parsing, you will see a confirmation overlay that
summarises the incoming wafers and warns about structural mismatches (different die count,
different hard bin set, duplicate wafer IDs). Click **Add N wafers** to confirm, or
**Cancel** to keep the current data unchanged.

### Clearing data

Click **Clear** to unload all data and return to the empty state.

### What happens next

After selecting files, what happens depends on the format:

| Format | Next step |
|--------|-----------|
| STDF / ATDF | [Test selector overlay](#4-test-selector-stdf-and-atdf) always appears first |
| CSV / JSON | [Column mapping overlay](#3-column-mapping-csv-and-json) appears first |
| Multiple files | [Wafer rename overlay](#21-wafer-rename-overlay) appears before rendering |

### 2.1 Wafer rename overlay

When loading multiple files (or a zip containing multiple files), tsmap shows a rename
overlay listing each wafer with an editable label. The labels are pre-filled from the
file name or the wafer ID in the data. Edit any label that needs changing, then click
**Continue →**.

---

## 3. Column mapping (CSV and JSON)

<div class="tsmap-mockup" style="border:1px solid var(--border-mid);border-radius:5px;overflow:hidden;margin:8px 0 12px;background:var(--bg-overlay);">
  <div class="mapping-header">
    <div><span class="mapping-title">Map columns</span> <span class="mapping-file-info">— example.csv</span></div>
    <button class="btn-secondary" style="pointer-events:none;">Cancel</button>
  </div>
  <table class="mapping-table" style="margin:0;">
    <thead><tr><th>Column</th><th></th><th>Role</th><th>Test name</th></tr></thead>
    <tbody>
      <tr><td class="col-name">x</td><td class="col-arrow">→</td><td><select class="mapping-table select" style="background:var(--bg-input);border:1px solid var(--border-mid);color:var(--text-secondary);padding:2px 4px;border-radius:3px;font-size:12px;color-scheme:light dark;"><option>X position</option></select></td><td></td></tr>
      <tr><td class="col-name">y</td><td class="col-arrow">→</td><td><select style="background:var(--bg-input);border:1px solid var(--border-mid);color:var(--text-secondary);padding:2px 4px;border-radius:3px;font-size:12px;color-scheme:light dark;"><option>Y position</option></select></td><td></td></tr>
      <tr><td class="col-name">hbin</td><td class="col-arrow">→</td><td><select style="background:var(--bg-input);border:1px solid var(--border-mid);color:var(--text-secondary);padding:2px 4px;border-radius:3px;font-size:12px;color-scheme:light dark;"><option>Hard bin</option></select></td><td></td></tr>
      <tr><td class="col-name">vt_lin</td><td class="col-arrow">→</td><td><select style="background:var(--bg-input);border:1px solid var(--border-mid);color:var(--text-secondary);padding:2px 4px;border-radius:3px;font-size:12px;color-scheme:light dark;"><option>Test value</option></select></td><td><input class="test-name-input" value="Vt_lin" style="pointer-events:none;" readonly></td></tr>
      <tr><td class="col-name">site</td><td class="col-arrow">→</td><td><select style="background:var(--bg-input);border:1px solid var(--border-mid);color:var(--text-secondary);padding:2px 4px;border-radius:3px;font-size:12px;color-scheme:light dark;"><option>Test site</option></select></td><td></td></tr>
    </tbody>
  </table>
  <div class="mapping-footer">
    <div class="pass-bin-group">Pass bin(s): <input value="1" style="pointer-events:none;" readonly></div>
    <button class="btn-primary" style="pointer-events:none;">Continue →</button>
  </div>
</div>

CSV and JSON files don't have a fixed schema, so tsmap shows a column mapping overlay
before parsing. It lists every column in the file with a dropdown to assign its role.
Common column names (`x`, `hbin`, `result`, `lo_limit`, etc.) are detected automatically
and pre-filled.

### Role reference

| Role | What it means |
|------|--------------|
| **X position** | Die column coordinate (prober step, integer). Required. |
| **Y position** | Die row coordinate (prober step, integer). Required. |
| **Hard bin** | Hard bin number per die |
| **Soft bin** | Soft bin number per die |
| **Wafer ID** | Identifies which wafer each row belongs to; splits rows into separate wafer maps |
| **Lot ID** | Lot identifier shown in the summary panel |
| **Test site** | Parallel-test site number for each die (the STDF `site_num` equivalent). Dies from all sites share one wafer map; the site appears in the die hover tooltip and can be used as a chart grouping/colour dimension. Numeric values only. |
| **Test value** | Numeric test result (wide format — one column per test); the **Test name** field to the right sets the display name for that test |
| **Test name (long format)** | Column containing the test name in a long/pivot layout |
| **Test result (long format)** | Column containing the numeric result in a long/pivot layout |
| **Low limit (long format)** | LSL in a long-format file |
| **High limit (long format)** | USL in a long-format file |
| **Units (long format)** | Units string in a long-format file |
| **Display info** | Additional metadata captured for grouping/comparison (and shown in tooltips). The **Subdivide file by this column** checkbox is a structural escape hatch for flat files that pack several wafers into one file with no wafer column — it subdivides the file into one wafer map per distinct value of the column. (Do not use it for parallel-test sites — map those to **Test site** instead.) |
| **— ignore —** | Column is not imported |

### Wide vs long format

**Wide format** has one column per test (the most common layout from prober exports). Assign
each test column the **Test value** role and fill in the test name.

**Long format** has one row per die per test (each row includes a test name column and a
result column). Assign the **Test name (long format)** and **Test result (long format)**
roles; optionally assign the limit and units columns too. tsmap detects likely long-format
files automatically and shows a prompt if multiple rows share the same X/Y coordinates.

Examples:

    Wide format — one column per test:
    x, y, hbin, Vt_lin, Idsat_vg1
    1, 1, 1,    452,    185
    2, 1, 2,    438,    179

    Long format — one row per die per test:
    x, y, hbin, test_name,  result
    1, 1, 1,    Vt_lin,     452
    1, 1, 1,    Idsat_vg1,  185
    2, 1, 2,    Vt_lin,     438
    2, 1, 2,    Idsat_vg1,  179

### Pass bins

The **Pass bin(s)** field at the bottom of the overlay specifies which hard bin values are
treated as pass for yield calculation. Default is `1`. Enter multiple bin numbers separated
by commas (e.g. `1,7`).

### Saved mappings

Once you click **Continue →**, the mapping is saved and automatically restored the next
time you open a file with the same set of column names. If the columns have changed, the
overlay re-appears with fresh auto-detection.

---

## 4. Test selector (STDF and ATDF)

<div class="tsmap-mockup" style="background:var(--bg-modal);border:1px solid var(--border-mid);border-radius:8px;overflow:hidden;margin:8px 0 12px;font-size:14px;color:var(--text-light);">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px 20px 8px;">
    <div style="font-size:16px;font-weight:600;">Select tests to import <span style="font-size:13px;font-weight:400;color:var(--text-dim);">(124 found)</span></div>
    <span style="color:var(--text-dim);padding:2px 6px;display:flex;align-items:center;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></span>
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:0 20px 8px;">
    <span style="flex:1;min-width:160px;padding:5px 8px;border:1px solid var(--border-mid);border-radius:4px;background:var(--bg-input);color:var(--text-muted);font-size:13px;">Search by name or number…</span>
    <div style="display:flex;gap:4px;">
      <span style="padding:4px 10px;border-radius:4px;border:1px solid var(--border-mid);font-size:12px;background:var(--accent);color:#fff;">All</span>
      <span style="padding:4px 10px;border-radius:4px;border:1px solid var(--border-mid);font-size:12px;background:none;color:var(--text-secondary);">Parametric</span>
      <span style="padding:4px 10px;border-radius:4px;border:1px solid var(--border-mid);font-size:12px;background:none;color:var(--text-secondary);">Functional</span>
    </div>
  </div>
  <div style="border-top:1px solid var(--border-subtle);font-size:13px;">
    <div style="display:flex;align-items:center;gap:8px;padding:6px 20px;border-bottom:1px solid var(--bg-row-border);">
      <input type="checkbox" checked style="flex-shrink:0;">
      <span style="color:var(--text-dim);min-width:52px;flex-shrink:0;font-family:ui-monospace,'Cascadia Code',monospace;font-size:12px;">1000</span>
      <span style="flex:1;">Vt_lin</span>
      <span style="color:var(--text-dim);font-size:11px;">mV · 350–650</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:6px 20px;border-bottom:1px solid var(--bg-row-border);">
      <input type="checkbox" checked style="flex-shrink:0;">
      <span style="color:var(--text-dim);min-width:52px;flex-shrink:0;font-family:ui-monospace,'Cascadia Code',monospace;font-size:12px;">1001</span>
      <span style="flex:1;">Idsat_vg1</span>
      <span style="color:var(--text-dim);font-size:11px;">µA</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:6px 20px;border-bottom:1px solid var(--bg-row-border);">
      <input type="checkbox" style="flex-shrink:0;">
      <span style="color:var(--text-dim);min-width:52px;flex-shrink:0;font-family:ui-monospace,'Cascadia Code',monospace;font-size:12px;">1010</span>
      <span style="flex:1;color:var(--text-dim);">Ioff_vg1</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:6px 20px;">
      <input type="checkbox" style="flex-shrink:0;">
      <span style="color:var(--text-dim);min-width:52px;flex-shrink:0;font-family:ui-monospace,'Cascadia Code',monospace;font-size:12px;">1011</span>
      <span style="flex:1;color:var(--text-dim);">Ioff_vg2</span>
    </div>
  </div>
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 20px;border-top:1px solid var(--border-mid);background:var(--bg-toolbar);">
    <span style="font-size:13px;color:var(--text-dim);">2 of 124 selected</span>
    <div style="display:flex;gap:8px;">
      <span style="padding:6px 16px;border-radius:4px;border:1px solid var(--border-mid);background:none;color:var(--text-secondary);font-size:13px;">Save list</span>
      <span style="padding:6px 16px;border-radius:4px;border:1px solid var(--border-mid);background:none;color:var(--text-secondary);font-size:13px;">Load list</span>
      <span style="padding:6px 16px;border-radius:4px;border:1px solid var(--border-mid);background:none;color:var(--text-secondary);font-size:13px;">Cancel</span>
      <button class="btn-primary" style="pointer-events:none;">Import →</button>
    </div>
  </div>
</div>

STDF and ATDF files from production testers often contain hundreds of parametric and
functional tests. tsmap always shows a test selector overlay before the full parse so
you can choose which tests to import. This keeps memory usage and load time proportional
to what you actually need.

tsmap uses a two-pass approach: a fast first pass reads only the test record headers
(PTR/FTR) to enumerate all tests and their numbers, names, units, and spec limits —
without accumulating any die data. The selector is built from this scan. The full parse
then runs only for the tests you selected, skipping accumulation for everything else.
For a 25-wafer lot with 500 tests and 10 000 dies per wafer, selecting 20 tests instead
of all 500 reduces the in-memory dataset by roughly 25×.

### Controls

- **Search** — Filter the list by test name or test number. Results update as you type.
- **Type filter** — Show all tests, only Parametric (PTR), or only Functional (FTR).
  The count per type is shown on each button.
- **Range select** — Type a numeric range (`1000-1099`) or a name-based range
  (`Idsat_vg1-Idsat_vg5`) in the range input and click **Select range**. Matching tests
  are added to the selection.
- **Select all / Select none** — Apply to the currently visible list (respects any active
  search filter).
- **Shift-click** — Click one checkbox, then Shift-click another to select or deselect
  the entire range between them.

Each test row shows the test number (in dim monospace), the test name, and — where defined
in the file — the units and spec limits.

### Test lists (Save / Load)

The **Save list** and **Load list** buttons let you persist a selection and reuse it across
sessions or files from the same product.

**Saving** writes a plain-text `.csv` file containing every selected test number and its
current display name. **Loading** reads that file back, restores the selection, and applies
any name overrides — so renamed tests stay renamed on reload.

The file format is one test per line:

    # tsmap test list
    # Saved: 2026-06-15T10:00:00.000Z
    1000,Idsat_vg1
    1001,Idsat_vg2
    1010,Vt_lin


- Lines starting with `#` are comments and are ignored on load.
- Each data line is `<test number>,<display name>`. The name field is optional — a line
  with just a number selects that test without overriding its name.
- Delimiters can be comma, semicolon, or whitespace — the parser accepts all three.
- Tests in the file that are not present in the current scan are silently skipped
  (the log panel shows a count of skipped tests).

You can hand-edit a list file to rename tests for display (e.g. `1000,Threshold Voltage`)
without changing anything in the original data file. Those names appear in the selector,
on the map tooltip, and in the chart axis labels.

### Memory advisory

The footer shows how many tests are selected and estimates the memory footprint
(selected tests × total die count):

- **Amber** — large selection (roughly 50 million die×test pairs); the import will be
  slow.
- **Red** — very large selection (roughly 200 million die×test pairs); risk of running
  out of memory. You'll be asked to confirm before the import starts.

<div class="tsmap-mockup" style="display:flex;flex-direction:column;gap:4px;margin:8px 0 12px;">
  <div style="color:#fbbf24;">Large selection — may be slow to load</div>
  <div style="color:#f87171;">Very large selection — risk of running out of memory</div>
</div>

If you select no tests, only bin data is imported (bin map is still fully usable).

### After load: re-filtering

After a successful load, the **Filter tests…** button appears in the toolbar. Click it to
re-open the test selector at any time and change which tests are imported. The file is
re-parsed with the new selection — bin and yield data is preserved regardless of which
tests you select.

For multi-file batches, the selector is shown once and the same selection is applied to
all files. By default the test list is scanned from the **largest file only** — a fast,
representative default. If a test appears only in a smaller file (so it's missing from the
list), click **Scan all N files** in the selector to re-scan every file and merge the full
test list; your current selection is preserved. The "Filter tests…" dialog offers the same
toggle if you didn't widen the scan at load time.

---

## 5. The wafer map view

After parsing, tsmap renders the wafer map. A single-wafer file shows one full-screen map
with the summary panel open by default; a multi-wafer lot shows a side-by-side gallery.

The map is delivered by the wmap rendering engine. For a full walkthrough of toolbar
controls, plot modes, overlays, zoom and pan, die hover tooltips, findings panel, summary
panel, and gallery controls, click the **?** help button in the map toolbar.

### Value findings

The wafer map's summary panel has a **Findings** list — statistically significant spatial
patterns: regions of the wafer (edge ring, quadrants, clusters, test sites) with unusually
low yield or distinctive bin patterns. These yield and bin findings are fast to compute and
**always on**.

The **Value findings** toolbar control is a **toggle** (shown with a ☐ / ☑ checkbox) that
adds one more category to that same Findings list: regions that read unusually high or low on
a specific *test value*, or fail spec more often there than elsewhere ("the edge ring reads
8% high on VDD_CORE"). This is the **only** thing it changes. It does **not** affect:

- the panel's per-test Min/Mean/Max statistics (always shown),
- test-value maps or stacked value maps,
- the Charts page (boxplots, histograms, scatter, correlation — all independent).

Because this regional value pass scales with regions × tests × dies, it is **off by default**
to keep loads fast. The toggle appears once a file with test values is loaded; switch it on
and the maps re-render with the extra findings in the panel — the wafer's data is already in
memory, so this recomputes in place with no reload. Switch it off to remove them. It resets to
off each time you load a new file, and is disabled in the Charts view (it only affects the
map's summary panel).

---

## 6. Charts view

Click **Charts** in the toolbar to switch to the charts view. Click **← Back to maps** (or
the maps button) to return. Charts and maps share the same parsed data — switching between
them does not re-parse.

The charts view is a two-column grid of panels. Each panel is independent: changing a
dropdown in one panel does not affect others, except that clicking a cell in the correlation
matrix updates the scatter plot's X and Y test selectors.

Every panel has a **Save PNG** (camera icon) button and an **Expand** (corner-arrows icon)
button in its header — the same icons wmap uses for these actions. The expand modal can be
maximized to fill the window (F key) and closes with Esc.

![Charts overview — all six panels](images/charts-overview.png)

### Grouping charts by lot or metadata

When more than one distinct value is present for a metadata field — for example you have
loaded **several lots**, test programs, temperatures, or dates — a **Group by** dropdown
appears in the charts toolbar (next to the colour-scheme selector). It lists every field
that actually varies across the loaded wafers, with the number of distinct values.

Selecting a field re-expresses every chart **per group** (one series/aggregate per lot,
program, temperature, …). Each chart does what makes sense for its kind:

| Chart | Grouped by a field |
| --- | --- |
| Yield by wafer | One bar per group — the group's pooled (die-weighted) yield |
| Bin pareto | Clustered bars — within each bin, one sub-bar per group, with a legend |
| Boxplot | One box per group, pooling all that group's dies |
| Histogram | Overlaid colour-coded distributions, one per group, with a clickable legend |
| Correlation matrix | A **Group** selector picks one group; the matrix is computed for that group alone |
| Scatter | Points coloured by group (instead of by hard bin), with a click-to-filter legend |

Choose **None** to return to the plain per-wafer/whole-lot view.

Two deliberate choices are worth noting:

- **Correlation is never pooled across groups.** Combining lots into one matrix is
  misleading — between-lot mean shifts can manufacture or hide correlations that do not
  exist within any single lot. So the matrix always shows one group at a time. If a group
  has too little variation to compute meaningful correlations, the matrix still renders but
  its cells are blank and the summary reads "No significant correlations found".
- **Only the largest 12 groups** are shown individually; any beyond that are folded into a
  single "… N more" group, so a load with many lots stays readable.

> Grouping is driven by metadata attached to each wafer at load time. STDF and ATDF
> contribute every field present in their MIR record — lot, sublot, part type, program,
> test temperature, test date, tester, node, operator, and more; CSV and JSON contribute
> the lot column plus any columns you mapped as metadata. Only fields that actually *vary*
> across the loaded wafers appear in the dropdown, so if everything shares one value (a
> single uniform lot) the **Group by** control is hidden.

### 6.1 Yield by wafer

![Yield by wafer](images/chart-yield.png)

Horizontal bar chart showing pass yield per wafer across the lot.

- **Sort** dropdown — Sort bars by yield (descending) or by wafer ID order.
- Click a bar to open that wafer's map in a pop-up modal. Close the modal (Esc, the close
  button, or click outside it) to return to the charts page exactly where you left it.
- **Grouped:** one bar per group showing the group's pooled, die-weighted yield.

### 6.2 Bin pareto

![Bin pareto](images/chart-pareto.png)

Failure count by bin across the entire lot, sorted from most to least frequent.

- **Bins** dropdown — Switch between Hard bins and Soft bins.
- Pass bin appears first and is labelled separately; all other bins are sorted by fail
  count descending.
- Click a bar to open a stacked-bin map — that bin counted across the wafers that contain it
  — in a pop-up modal. Close the modal to return to the charts page.
- **Grouped:** clustered bars — within each bin, one colour-coded sub-bar per group, with a
  legend. Hover a sub-bar for its count and share of the bin; click it to open that group's
  wafers in a modal.

### 6.3 Test value distribution (boxplot)

![Boxplot panel](images/boxplot.png)

Per-wafer five-number summary for one parametric test: minimum, Q1, median, Q3, maximum.

- **Test** dropdown — Select which parametric test to plot.
- **Log scale** checkbox — Switch the value axis to log scale (useful for leakage currents,
  resistance, etc.).
- **Axis includes limits** checkbox — Expand the axis to show the LSL and USL spec limits
  if they are defined in the file.
- **Trend line** checkbox — Connect the per-wafer medians with a line to reveal drift
  across wafers in lot order (breaks across wafers with no data for the test).
- Spec limits appear as dashed vertical lines on the plot.
- Click a wafer's box to open that wafer's test value map in a pop-up modal. Close the modal
  to return to the charts page.
- Hover a row to see the full five-number summary in a tooltip.
- **Grouped:** one box per group, pooling all of that group's dies into a single summary.

### 6.4 Value histogram

![Histogram panel](images/histogram.png)

Distribution of test values bucketed across the measurement range.

- **Test** dropdown — Select which parametric test to show.
- **Wafer** dropdown — Show data from all wafers combined, or pick one wafer by ID.
- **Axis includes limits** checkbox — Expand the axis to include spec limits.
- Spec limits (LSL/USL) appear as dashed vertical lines if defined.
- A count (Y) axis with gridlines shows the per-bucket die count.
- **Grouped:** overlaid colour-coded distributions, one per group, sharing the same buckets
  and a numbered Y axis. A legend lists the groups; click one to bring it to the front and
  dim the others (click again to clear). Hover a bucket to see every group's count there.
  The single-wafer selector is hidden while grouped.

### 6.5 Test correlation matrix

![Correlation matrix](images/correlation.png)

Pearson correlation coefficient (r) for every pair of parametric tests. Cell colour
encodes correlation **strength** (|r|) using the active chart colour scheme — stronger
correlations appear as a more saturated colour regardless of sign. Positive and negative
correlations of equal strength look equally prominent; sign is shown in the tooltip.

A summary line above the matrix counts strong (|r| ≥ 0.7) and moderate (0.4–0.7) pairs
among the displayed tests, and notes any weak pairs that were hidden.

- Tests are ranked by mean |r| across all pairs so the most strongly correlated tests
  cluster toward the top-left of the matrix.
- The matrix shows between 6 and 20 tests — enough significant pairs to fill that range.
- Hover a cell to see the full test names, test numbers, and the r value to four decimal
  places.
- Click any off-diagonal cell to instantly update the scatter plot's X and Y tests.
  The grid does not rebuild — scroll position is preserved.
- **Grouped:** a **Group** dropdown appears in the panel; the matrix is computed for the
  selected group only (never pooled across groups). A group with too little variation shows
  a populated grid with blank cells and "No significant correlations found".

### 6.6 Test correlation scatter

![Scatter plot with bin legend](images/scatter.png)

Die-level scatter plot for two parametric tests.

- **X** and **Y** dropdowns — Select which test to plot on each axis.
- **Bin legend** — Hard bin colour swatches above the plot. Click a swatch to filter:
  only dies with that bin are shown at full opacity; others fade. Click again to restore.
  All bins selected = all dies shown.
- Spec limit lines appear as dashed lines on the corresponding axis.
- The correlation matrix's click-cell shortcut updates this panel without rebuilding
  the rest of the charts grid.
- **Grouped:** points are coloured by group instead of by hard bin, and the legend shows
  the groups; click a group to isolate its dies. This shows whether the groups separate in
  the X/Y plane without pooling them into a single (potentially misleading) statistic.

---

## 7. Exporting charts

Every chart panel has a **camera** button that saves the current view as a PNG at the
displayed resolution. To get a clean full-resolution render, use the expand (corner-arrows)
button first to open the panel in the fullscreen modal, then click the camera button.

Each exported PNG includes a header strip above the chart with the panel title, source
filename, wafer and die counts, the active test name (where applicable), and the time of
export. The live card UI is unchanged — the header appears only in the saved file.

On the desktop, PNG saves open a native save dialog. In the browser, the file goes to your
downloads folder.

For map PNG export, use the **camera** button in the map toolbar — see the wmap help for
details.

---

## 8. The log panel

A collapsible log panel sits at the bottom of the window. It shows timestamped messages
from the parser and renderer: file load events, parse warnings, and any errors.

<div class="tsmap-mockup" style="background:var(--bg-toolbar);border:1px solid var(--border-strong);border-radius:5px;overflow:hidden;margin:8px 0 12px;">
  <div style="width:100%;background:none;border:none;border-bottom:1px solid var(--border-subtle);color:var(--text-dim);font-size:12px;text-align:right;padding:3px 12px;">Log (1 error)</div>
  <div style="padding:4px 12px 6px;">
    <div style="font-family:ui-monospace,'Cascadia Code','Segoe UI Mono',monospace;font-size:12px;line-height:1.6;color:var(--text-muted);">14:32:01 Loaded lot.stdf — 3 wafers, 10 482 dies</div>
    <div style="font-family:ui-monospace,'Cascadia Code','Segoe UI Mono',monospace;font-size:12px;line-height:1.6;color:var(--warn-text);">14:32:01 Soft bin 65535 sentinel — fabricated bin 2 for 14 dies</div>
    <div style="font-family:ui-monospace,'Cascadia Code','Segoe UI Mono',monospace;font-size:12px;line-height:1.6;color:var(--error-text);">14:32:02 Failed to load bad.stdf: unexpected end of record</div>
  </div>
</div>

- Click **Log** to expand or collapse the panel.
- If any errors occurred, the button label changes to **Log (N errors)** and the panel
  expands automatically.
- Parser warnings (e.g. fabricated soft bin numbers from sentinel values, unrecognised
  records) appear here rather than blocking the load.

**Soft bin 65535** is a sentinel value in the STDF spec meaning "no soft bin assigned to
this die". When the parser encounters it, it maps those dies to a fabricated soft bin so
the wafer map can render — the hard bin value is unaffected. The number in the warning
(e.g. "fabricated bin 2 for 14 dies") is the count of dies where this substitution was
applied. If soft bin data is not meaningful for your product, this warning can be ignored.

---

## 9. Desktop vs browser differences

| Feature | Desktop | Browser |
|---------|---------|---------|
| File parsing | Native Rust (fast, off UI thread) | WASM in a Web Worker (same logic) |
| File picker | Native OS dialog | Browser dialog |
| Drag and drop | Yes | Yes |
| PNG save | Native save dialog | Browser download folder |
| Zip extraction | Native Rust | In-browser (fflate) |
| Offline use | Yes | Yes (once page loaded) |

The browser version is functionally identical to the desktop app. Files are parsed entirely
in your browser — nothing is sent to a server.

Browser requirements: Chrome 80+, Firefox 113+, Safari 16.4+, Edge 80+.
