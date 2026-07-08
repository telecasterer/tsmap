import { defineConfig } from "vite";
import { readFileSync, realpathSync, lstatSync } from "fs";
import { fileURLToPath } from "url";
/// <reference types="vitest" />

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM;

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// When @paulrobins/wafermap is npm-linked to a local checkout (`npm run
// wmap:link`), its files live OUTSIDE this project root, so Vite's dev server
// blocks them ("outside of Vite serving allow list") and the linked wmap never
// loads. Detect the symlink and, only then, allow serving its real directory.
// In normal (published-dep) dev the link is absent, so the fs boundary stays
// exactly as tight as before — this opens up precisely when linked, and CI's
// clean install is never linked. See CLAUDE.md "Developing wmap alongside tsmap".
function linkedWmapDir(): string | null {
  try {
    const entry = fileURLToPath(new URL('./node_modules/@paulrobins/wafermap', import.meta.url));
    if (!lstatSync(entry).isSymbolicLink()) return null;
    return realpathSync(entry); // the ../wmap checkout the symlink points to
  } catch {
    return null;
  }
}
const wmapLink = linkedWmapDir();

// https://vite.dev/config/
export default defineConfig(async () => ({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  // Use absolute paths for Tauri (serves from localhost), relative for web deploy
  base: isTauriBuild ? '/' : './',

  // Treat .wasm files as static assets so the web platform can import them
  assetsInclude: ['**/*.wasm'],

  // The parser worker (parserWorker.ts) dynamically imports the WASM module,
  // which forces code-splitting — unsupported by the default iife worker format.
  // ES modules also let `new URL(..., import.meta.url)` resolve the .wasm asset.
  worker: { format: 'es' },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and the Cargo workspace's
      // `target/` build output (large, high-churn, and irrelevant to the
      // frontend — watching it can exhaust the OS inotify watcher limit).
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
    // 4. when wmap is linked, allow the dev server to serve its out-of-root
    //    files (default allow list is the project root only). No-op unlinked.
    ...(wmapLink ? { fs: { allow: ['.', wmapLink] } } : {}),
  },
}));
