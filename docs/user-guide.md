---
title: User Guide
---

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

<div style="display:flex;align-items:center;gap:12px;padding:6px 12px;background:var(--bg-toolbar);border:1px solid var(--border-strong);border-radius:5px;font-size:13px;margin:8px 0 12px;">
  <span style="background:none;border:1px solid var(--accent);border-radius:4px;color:var(--accent);font-size:12px;padding:3px 10px;">Open file</span>
  <span style="background:none;border:1px solid var(--border-dim);border-radius:4px;color:var(--text-muted);font-size:12px;padding:3px 10px;opacity:.4;">Add files</span>
  <span style="background:none;border:1px solid var(--border-muted);border-radius:4px;color:var(--text-muted);font-size:12px;padding:3px 10px;opacity:.4;">Clear</span>
  <span style="width:1px;height:16px;background:var(--border-mid);flex-shrink:0;"></span>
  <span style="background:none;border:1px solid var(--border-dim);border-radius:4px;color:var(--text-muted);font-size:12px;padding:3px 10px;opacity:.4;">Charts</span>
  <span style="margin-left:auto;"></span>
  <span style="background:none;border:1px solid var(--border-muted);border-radius:50%;color:var(--text-muted);font-size:12px;font-weight:600;width:20px;height:20px;display:flex;align-items:center;justify-content:center;">?</span>
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

<div style="border:1px solid var(--border-mid);border-radius:5px;overflow:hidden;margin:8px 0 12px;background:var(--bg-overlay);">
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
      <tr><td class="col-name">site</td><td class="col-arrow">→</td><td><select style="background:var(--bg-input);border:1px solid var(--border-mid);color:var(--text-secondary);padding:2px 4px;border-radius:3px;font-size:12px;color-scheme:light dark;"><option>— ignore —</option></select></td><td></td></tr>
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
| **Test value** | Numeric test result (wide format — one column per test); the **Test name** field to the right sets the display name for that test |
| **Test name (long format)** | Column containing the test name in a long/pivot layout |
| **Test result (long format)** | Column containing the numeric result in a long/pivot layout |
| **Low limit (long format)** | LSL in a long-format file |
| **High limit (long format)** | USL in a long-format file |
| **Units (long format)** | Units string in a long-format file |
| **Display info** | Additional per-wafer metadata shown in the gallery label; the **Gallery split** checkbox splits the data into separate wafer maps based on unique values in this column |
| **— ignore —** | Column is not imported |

### Wide vs long format

**Wide format** has one column per test (the most common layout from prober exports). Assign
each test column the **Test value** role and fill in the test name.

**Long format** has one row per die per test (each row includes a test name column and a
result column). Assign the **Test name (long format)** and **Test result (long format)**
roles; optionally assign the limit and units columns too. tsmap detects likely long-format
files automatically and shows a prompt if multiple rows share the same X/Y coordinates.

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

<div style="background:var(--bg-modal);border:1px solid var(--border-mid);border-radius:8px;overflow:hidden;margin:8px 0 12px;font-size:14px;color:var(--text-light);">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px 20px 8px;">
    <div style="font-size:16px;font-weight:600;">Select tests to import <span style="font-size:13px;font-weight:400;color:var(--text-dim);">(124 found)</span></div>
    <span style="color:var(--text-dim);font-size:16px;padding:2px 6px;">✕</span>
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

```
# tsmap test list
# Saved: 2026-06-15T10:00:00.000Z
1000,Idsat_vg1
1001,Idsat_vg2
1010,Vt_lin
```

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

- **Amber** — large selection; the import will be slow.
- **Red** — very large selection; risk of running out of memory. You'll be asked to
  confirm before the import starts.

<div style="display:flex;flex-direction:column;gap:4px;margin:8px 0 12px;">
  <div style="font-size:12px;color:#fbbf24;">Large selection — may be slow to load</div>
  <div style="font-size:12px;color:#f87171;">Very large selection — risk of running out of memory</div>
</div>

If you select no tests, only bin data is imported (bin map is still fully usable).

### After load: re-filtering

After a successful load, the **Filter tests…** button appears in the toolbar. Click it to
re-open the test selector at any time and change which tests are imported. The file is
re-parsed with the new selection — bin and yield data is preserved regardless of which
tests you select.

For multi-file batches, the selector is shown once based on the largest file; the same
selection is applied to all files.

---

## 5. The wafer map view

After parsing, tsmap renders the wafer map. A single-wafer file shows one full-screen map
with the summary panel open by default; a multi-wafer lot shows a side-by-side gallery.

The map is delivered by the wmap rendering engine. For a full walkthrough of toolbar
controls, plot modes, overlays, zoom and pan, die hover tooltips, findings panel, summary
panel, and gallery controls, click the **?** help button in the map toolbar.

---

## 6. Charts view

Click **Charts** in the toolbar to switch to the charts view. Click **← Back to maps** (or
the maps button) to return. Charts and maps share the same parsed data — switching between
them does not re-parse.

The charts view is a two-column grid of panels. Each panel is independent: changing a
dropdown in one panel does not affect others, except that clicking a cell in the correlation
matrix updates the scatter plot's X and Y test selectors.

Every panel has a **Download PNG** (⤓) button and an **Expand** (⛶) button in its header.
The expand modal supports fullscreen (F key) and closes with Esc.

![Charts overview — all six panels](images/charts-overview.png)

### 6.1 Yield by wafer

![Yield by wafer](images/chart-yield.png)

Horizontal bar chart showing pass yield per wafer across the lot.

- **Sort** dropdown — Sort bars by yield (descending) or by wafer ID order.
- Click a bar to open that wafer's map.
- Shift-click or Ctrl-click multiple bars to select a group, then click **Open selected**
  to open a filtered view of those wafers.

### 6.2 Bin pareto

![Bin pareto](images/chart-pareto.png)

Failure count by bin across the entire lot, sorted from most to least frequent.

- **Bins** dropdown — Switch between Hard bins and Soft bins.
- Pass bin appears first and is labelled separately; all other bins are sorted by fail
  count descending.
- Click a bar to highlight dies with that bin.

### 6.3 Test value distribution (boxplot)

![Boxplot panel](images/boxplot.png)

Per-wafer five-number summary for one parametric test: minimum, Q1, median, Q3, maximum.

- **Test** dropdown — Select which parametric test to plot.
- **Log scale** checkbox — Switch the value axis to log scale (useful for leakage currents,
  resistance, etc.).
- **Axis includes limits** checkbox — Expand the axis to show the LSL and USL spec limits
  if they are defined in the file.
- Spec limits appear as dashed vertical lines on the plot.
- Click a wafer's box to open that wafer's test value map.
- Hover a row to see the full five-number summary in a tooltip.

### 6.4 Value histogram

![Histogram panel](images/histogram.png)

Distribution of test values bucketed across the measurement range.

- **Test** dropdown — Select which parametric test to show.
- **Wafer** dropdown — Show data from all wafers combined, or pick one wafer by ID.
- **Axis includes limits** checkbox — Expand the axis to include spec limits.
- Spec limits (LSL/USL) appear as dashed vertical lines if defined.

### 6.5 Test correlation matrix

![Correlation matrix](images/correlation.png)

Pearson correlation coefficient (r) for every pair of parametric tests. Cells are
colour-coded: blue for positive correlation, red for negative; opacity scales with |r|.

- The matrix shows the top N tests ranked by mean |r| across all pairs.
- Hover a cell to see the full test names and the r value to four decimal places.
- Click any off-diagonal cell to instantly update the scatter plot's X and Y tests.
  The grid does not rebuild — scroll position is preserved.
- If the full test count exceeds the matrix size, a label shows how many tests are
  displayed vs. total.

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

---

## 7. Exporting charts

Every chart panel has a **⤓** download button that saves the current view as a PNG at the
displayed resolution. To get a clean full-resolution render, use the expand (⛶) button
first to open the panel in the fullscreen modal, then click ⤓.

On the desktop, PNG saves open a native save dialog. In the browser, the file goes to your
downloads folder.

For map PNG export, use the **⤓** button in the map toolbar — see the wmap help (**?**) for
details.

---

## 8. The log panel

A collapsible log panel sits at the bottom of the window. It shows timestamped messages
from the parser and renderer: file load events, parse warnings, and any errors.

<div style="background:var(--bg-toolbar);border:1px solid var(--border-strong);border-radius:5px;overflow:hidden;margin:8px 0 12px;">
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
