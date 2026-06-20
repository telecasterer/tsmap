---
hide:
  - navigation
  - toc
---

# tsmap

A desktop and browser application for loading and visualising semiconductor wafer map data.
Open STDF, ATDF, CSV, and JSON lot files and get interactive yield maps, parametric heat
maps, bin pareto charts, per-test boxplots and histograms, and a cross-test correlation
matrix — all without uploading your data anywhere.

## Try it in the browser

**[Open tsmap →](app/index.html)**

No install required. Files are parsed locally in your browser using a WebAssembly build of
the same Rust parser used in the desktop app. Nothing is uploaded.

No wafer files of your own? [Download a sample lot](web.md#try-it-with-sample-data) and open
it straight away.

## Download the desktop app

The desktop version adds native file dialogs, drag-and-drop from the OS, and works offline
without a browser. Builds for Linux, macOS, and Windows are attached to each
[GitHub release](https://github.com/telecasterer/tsmap/releases).

## Supported formats

| Format | Notes |
|--------|-------|
| STDF (`.stdf`, `.std`) | Binary V4 — multi-wafer lots, PTR and FTR tests; test selector always shown |
| ATDF (`.atdf`, `.atd`) | ASCII equivalent of STDF |
| CSV (`.csv`, `.txt`, `.dat`) | Column mapping step; wide and long (pivot) formats |
| JSON (`.json`) | Flat array or nested `[{ wafer, results: [{die}] }]` |
| Gzip (`.gz`) | Transparent decompression — e.g. `lot.stdf.gz` |
| Zip (`.zip`) | All contained files extracted and loaded as a batch |

## Links

- [Web app](app/index.html)
- [User guide](user-guide.md)
- [GitHub](https://github.com/telecasterer/tsmap)
- [Releases](https://github.com/telecasterer/tsmap/releases)
- [wafermap library](https://telecasterer.github.io/wafermap/)
