---
hide:
  - navigation
  - toc
---

# tsmap

A desktop and browser application for loading and visualising semiconductor wafer map data.
Open STDF, ATDF, CSV, and JSON files — multi-wafer lots, parametric tests, yield analysis,
and charts are all supported out of the box.

## Try it in the browser

**[Open tsmap →](app/index.html)**

No install required. Files are parsed locally in your browser using a WebAssembly build of
the same Rust parser used in the desktop app. Nothing is uploaded.

## Download the desktop app

The desktop version adds native file dialogs, drag-and-drop from the OS, and works offline
without a browser. Builds for Linux, macOS, and Windows are attached to each
[GitHub release](https://github.com/telecasterer/tsmap/releases).

## Supported formats

| Format | Notes |
|--------|-------|
| STDF (`.stdf`, `.std`) | Binary V4 — multi-wafer lots, PTR and FTR tests |
| ATDF (`.atdf`, `.atd`) | ASCII equivalent of STDF |
| CSV (`.csv`, `.txt`, `.dat`) | Column mapping step; wide and long (pivot) formats |
| JSON (`.json`) | Flat array or nested `[{ wafer, results: [{die}] }]` |
| Gzip (`.gz`) | Transparent decompression — e.g. `lot.stdf.gz` |
| Zip (`.zip`) | All contained files extracted and loaded as a batch |

## Links

- [Web app](app/index.html)
- [GitHub](https://github.com/telecasterer/tsmap)
- [Releases](https://github.com/telecasterer/tsmap/releases)
- [wafermap library](https://telecasterer.github.io/wafermap/)
