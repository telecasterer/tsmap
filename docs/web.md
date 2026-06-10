# tsmap in the browser

The browser version of tsmap is available at
**[telecasterer.github.io/tsmap/app/](https://telecasterer.github.io/tsmap/app/)**.

It uses a WebAssembly build of the same Rust parser as the desktop app. Files are parsed
entirely in your browser — nothing is sent to a server. Parsing runs in a background Web
Worker, so the interface stays responsive even while a large file loads.

## Opening files

Click **Open file** to pick one or more files from your device, or drag and drop files
anywhere in the window. Multiple files are loaded as a batch and merged into a single
gallery, with a rename step to label each wafer.

For STDF and ATDF files with more than 200 tests, a test selector overlay appears before
parsing — pick which tests to import, then click **Import**. A **Filter tests…** button in
the toolbar lets you change your selection at any time after load.

## Supported formats

All four formats are supported in the browser:

- **STDF** / **ATDF** — parsed directly from binary/text bytes via WASM
- **CSV** / **JSON** — column mapping overlay appears before rendering; the mapping is
  saved per column layout and restored automatically next time
- **Gzip** (`.gz`) — decompressed in-browser using the native `DecompressionStream` API
- **Zip** (`.zip`) — extracted in-browser using [fflate](https://github.com/101arrowz/fflate)

## Differences from the desktop app

| Feature | Browser | Desktop |
|---------|---------|---------|
| File parsing | WASM in a Web Worker (same logic) | Native Rust (off-thread) |
| File picker | Browser dialog | Native OS dialog |
| Last used directory | — | Remembered between sessions |
| Drag and drop | Yes | Yes |
| PNG export | Browser download | Native save dialog |
| HTML reports | Opens in new tab | Writes to temp file |
| Zip extraction | In-browser (fflate) | Rust (native) |
| Offline use | Yes (once loaded) | Yes |

## Browser requirements

Any modern browser with WebAssembly and `DecompressionStream` support — Chrome 80+,
Firefox 113+, Safari 16.4+, Edge 80+.

## Running locally

```bash
git clone https://github.com/telecasterer/tsmap
cd tsmap
npm install
npm run dev:web   # opens at http://localhost:5301
```

Requires Node 22+ and Rust (for rebuilding the WASM parser — not needed just to run the dev server).
