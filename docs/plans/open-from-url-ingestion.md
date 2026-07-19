# "Open from URL" — REST-pull JSON ingestion for tsmap

**Status: not implemented.** Filed as a reference design for a possible future feature —
demand isn't confirmed yet (see cost/complexity below). Referenced from a short entry in
[IDEAS.md](../../IDEAS.md) so a future session has the full design ready without re-deriving it.

## Estimated cost (for future reference)

~700-900 lines touched across the repo if built in full (~300-400 of that is genuinely new
logic — a Rust fetch command, a new modal, platform wiring — the rest is tests, docs, a
dev-only mock server, and a refactor that mostly *moves* existing `main.ts` code rather than
adding to it). Medium-small by volume, since it reuses the existing JSON parser, mapping
overlay, and modal chrome almost entirely.

Main risk: extracting `finishImport` out of `handleFiles` in `main.ts` touches the shared,
well-tested load path for every existing format (STDF/ATDF/CSV/JSON/zip) — not hard to write,
but needs careful before/after verification so no existing load path regresses.

Real tradeoffs: this would be the app's first network-capable code path (new `reqwest`+`rustls`
dependency, a small but real shift for an app that's been fully offline by design); it's a thin
v1 slice (no OAuth/SSO, no pagination, GET+JSON only) that may need a second phase once there's
an actual target system to build against; and hitting the "testable/demonstrable" bar means
committing to build *and maintain* a mock API server script, not just the feature itself.

Researched, not assumed: there is no publicly documented REST API for KLA Klarity, Synopsys
YieldManager/SiliconDash, or PDF Solutions Exensio — this would be a generic bring-your-own-
JSON-API connector, not a named-vendor integration. `tauri-plugin-http` was evaluated and
rejected in favor of a hand-rolled `reqwest` command: its scope system requires pre-configured
glob patterns and has multiple open upstream issues (tauri-apps/tauri #3507, #11735, #12734;
plugins-workspace #1559) about exactly this feature's scenario — arbitrary user-typed URLs
don't fit a static allow-list scope.

## Context

tsmap currently only ingests local files (STDF/ATDF/CSV/JSON) via `platform.pickFiles()`. In
many companies, engineers can't get a raw file off the tester — test data instead lives behind
a database or an internal data-analysis app, typically reachable as a REST/HTTP endpoint. We
want a first data-ingestion path that doesn't require a local file.

Direction, confirmed with the user:
- **tsmap pulls** ("Open from URL"), not push — the user enters an endpoint (+ optional auth) in
  tsmap; tsmap fetches and reuses the *existing* column-mapping overlay to turn arbitrary JSON
  into a `ParsedFile`, exactly like today's "Open file → JSON" path.
- **Arbitrary JSON shape**, mapped via the existing `mappingUI.ts` overlay — no assumption of a
  fixed tsmap-defined schema, since every company's API differs.
- **Tauri-desktop only.** The HTTP fetch + auth happens in Rust (a new Tauri command), never in
  the webview — avoids CORS entirely and keeps credentials out of browser-visible JS/devtools.
- **Must be testable/demonstrable without any real customer system** — built and proven against
  a local mock HTTP server, not assumed access to a real company API.

This reuses nearly the entire existing JSON pipeline: `parse_json_from_bytes`
(`packages/parsers/src/parse_json.rs:47`) already accepts in-memory bytes + a `CsvMapping` and
is target-agnostic — confirmed unmodified, no parsing logic needs to change. The only genuinely
new code is a fetch layer in front of it.

**Scope reality check (researched, not assumed):** there is no publicly documented REST API for
KLA Klarity, Synopsys YieldManager/SiliconDash, or PDF Solutions Exensio — these are enterprise
platforms with custom, negotiated data-exchange integrations, not a standard contract anyone can
test against without a paid relationship. This feature is therefore a **generic bring-your-own-
JSON-API connector**, not a named-vendor integration — the same posture tsmap already takes
toward CSV/JSON files (arbitrary shape + column mapping, no assumed schema). That fits an
internal company tool/DB-fronting-API better than it fits any one commercial YMS platform. If a
real target turns out to need OAuth2/SSO or only exposes GraphQL, the v1 cut lines (below) will
need revisiting — that can't be resolved without a concrete target system in hand.

**Plugin check (researched, not assumed):** `tauri-plugin-dialog`/`tauri-plugin-opener`/
`tauri-plugin-fs` are already in use for exactly what they're for — nothing there is being
reinvented. `modal.ts`'s custom overlay system is a separate concern (native OS dialogs can't
render the interactive HTML the mapping/test-selector/splits UIs need) and isn't a
wheel-reinvention either. For HTTP specifically, `tauri-plugin-http` was evaluated and rejected
for a documented reason, not just a preference: its scope system requires pre-configured glob
patterns, and there are multiple open Tauri GitHub issues (tauri-apps/tauri #3507, #11735,
#12734; plugins-workspace #1559) about exactly this feature's scenario — arbitrary user-typed
URLs don't fit a static allow-list scope (`"url": "*://*"` reportedly still fails to cover
things like `127.0.0.1:*`). The plugin's core value (scoped permissions) doesn't apply well
when the point of the feature is "any endpoint the user types," which is why a small hand-rolled
`reqwest` command remains the better fit.

## Approach

### 1. Rust: new command + small refactor

**Refactor `packages/parsers/src/parse_json.rs`:** `json_headers_sync` (line 16) is
file-path-only today; there's no bytes-based equivalent (unlike `parse_json_from_bytes`, which
already exists). Extract the shared body into
`json_headers_from_value(&Value) -> Result<JsonHeadersResult, String>`, then add:
```rust
pub fn json_headers_from_bytes(bytes: &[u8]) -> Result<JsonHeadersResult, String> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let raw: Value = serde_json::from_slice(bytes).map_err(|e| format!("Invalid JSON: {}", e))?;
    json_headers_from_value(&raw)
}
```
Small, behavior-preserving — `json_headers_sync`'s existing tests (lines 443-478) keep passing
unchanged.

**New file `src-tauri/src/commands/fetch_json_url.rs`** — two commands, mirroring
`parse_json.rs`'s existing thin-wrapper pattern:
- `json_headers_from_url(url: String, headers: HashMap<String,String>) -> Result<JsonHeadersResult, String>`
- `parse_json_from_url(url: String, headers: HashMap<String,String>, mapping: CsvMapping) -> Result<ParsedStdf, String>`

Both call a shared private `fetch_bytes_capped(url, headers, max_bytes)` (plain async fn, not a
`#[tauri::command]` — independently unit-testable) that builds a `reqwest::Client`, attaches
each header, does a GET, checks status, caps response size (50 MB), and returns `Vec<u8>`. The
bytes then flow straight into `json_headers_from_bytes` / `parse_json_from_bytes` — zero
duplicated parse logic.

**Dependency:** `reqwest = { version = "0.12", default-features = false, features =
["rustls-tls"] }` in `src-tauri/Cargo.toml` — `rustls-tls` avoids an OpenSSL system dependency;
async, fits the existing `tokio` runtime and `#[tauri::command] pub async fn` convention already
used throughout `src-tauri/src/commands/`. `tauri-plugin-http` was considered and rejected: a
hand-rolled command is a smaller diff, keeps the fetch fully opaque to the webview, and —
critically — **needs no `capabilities/default.json` entry at all** (confirmed by reading that
file: it only lists plugin-scoped permissions; custom commands registered via
`generate_handler!` aren't gated by the capability system).

**Registration:** `src-tauri/src/commands/mod.rs` (`pub mod fetch_json_url;` + re-export),
`src-tauri/src/lib.rs` (add both names to the `use commands::{...}` import and the
`generate_handler![...]` list, ~line 90).

### 2. Auth handling

Keep Rust generic: both commands take a plain `headers: HashMap<String,String>` — no
`bearer`/`apiKey` concept in Rust at all. The frontend builds the header map:
```ts
// src/openUrlUI.ts
export type AuthType = 'none' | 'bearer' | 'apiKey';
export function buildAuthHeaders(authType, token, apiKeyHeaderName, apiKeyValue): Record<string,string> { ... }
```
- Tauri's `invoke()` IPC never touches the webview's own network stack — the actual GET happens
  inside the Rust process via `reqwest`, so no CORS and no credential ever appears in the
  webview's Network devtools panel or a `window.fetch` call.
- **No secret persistence.** Don't reuse `mappingUI.ts`'s existing `localStorage` mapping-cache
  key for this (it holds only column-role mappings, no changes needed there). Token/API-key
  value lives only in the modal's in-memory form state, dropped on close. Only the non-secret
  URL (and API-key header *name*, never its value) may optionally be remembered in a new small
  `localStorage` key for convenience — document this plainly in the guide. Rust error messages
  include the URL and HTTP status only, never header contents.

### 3. Frontend: new entry point, zero changes to `mappingUI.ts`

- New toolbar button `#open-url-btn` in `index.html`, always visible on both platforms (not
  hidden on web — see below).
- New module `src/openUrlUI.ts`: a small modal via the existing `openModal()` helper
  (`src/modal.ts`, `sizing: 'content'` — same pattern as `splitsUI.ts`, no new modal plumbing).
  Fields: URL, auth-type select, conditional token/header inputs, inline error banner.
- `showMappingOverlay(headersResult, onConfirm, onCancel)` (`src/mappingUI.ts:236`) is already
  fully decoupled from how the `HeadersResult` was obtained — confirmed today it's called
  identically for CSV and JSON file picks (`main.ts:711`). The URL flow's fetch returns the same
  `HeadersResult` shape, so it calls `showMappingOverlay` unmodified — a new caller only, no
  edits to `mappingUI.ts`.
- **Downstream pipeline reuse (test selector, rename, append) — confirmed extraction point:**
  verified in `main.ts:641-984` (`handleFiles`). Extract everything from the "Test selector"
  section (line 780) through the final render/append dispatch (line 984) into a standalone
  `finishImport(files, preParsed, firstPassTestDefs, binaryFiles, binaryScanDieCount, isAppend)`.
  `handleFiles` becomes: existing extension-detection/mapping/parse work, then call
  `finishImport(...)`. A new `handleUrlImport(url, headers, mapping)` fetches via
  `platform.parseJsonFromUrl`, wraps the result in a synthetic single-entry `preParsed` map, and
  calls the same `finishImport` — giving full parity (test selector always shown when `testDefs`
  non-empty, rename overlay, append-confirm) for zero logic duplication. This is real surgery on
  well-tested core logic — treat as its own isolated step, verified by re-running `npm test` and
  re-checking a few existing load paths (STDF, CSV, JSON, zip) still behave identically before
  adding anything on top.
- `deriveFileName(url)` — small pure helper (last path segment, or hostname fallback) so the
  synthetic entry has a sensible display name.

### 4. `platform.ts` changes

Two new **required** `Platform` interface methods (confirmed: every existing method —
`pickFiles`, `openGuide`, etc. — is implemented by both adapters with no optional members
anywhere; follow that convention rather than introducing the codebase's first optional method):
```ts
jsonHeadersFromUrl(url: string, headers: Record<string,string>): Promise<HeadersResult>;
parseJsonFromUrl(url: string, headers: Record<string,string>, mapping: CsvMapping): Promise<RustParsedFile>;
```
- Tauri adapter: thin `invoke('json_headers_from_url', {...})` / `invoke('parse_json_from_url',
  {...})`, matching every other method's existing pattern.
- Web adapter: throws `'Open from URL requires the desktop app — this feature isn't available in
  the browser build.'` — a clear stub, not a silent no-op.
- Button stays visible (not `isTauri`-gated) so the same declarative screenshot-capture step
  (`scripts/capture-screenshots.mjs`, headless Chromium, `isTauri` always false there) can
  capture the dialog for the user guide, per CLAUDE.md's "every full-screen overlay gets a real
  captured screenshot" rule — a hidden-on-web button could never be captured.

### 5. Testing / demo plan — the "no real customer system" requirement

- **New `scripts/mock-json-api-server.mjs`**: a small Node `http.createServer` (modeled on the
  static server already in `scripts/capture-screenshots.mjs`), serving a synthetic multi-wafer
  JSON payload at e.g. `GET /wafer-lot`, with selectable auth enforcement (`--auth
  none|bearer|apikey`, returns 401 on missing/wrong credentials) so the demo exercises the auth
  path, not just happy-path. `npm run mock:api` script. This is the artifact that makes the
  feature demonstrable end-to-end and doubles as the manual smoke-test fixture.
- **Rust unit tests** in `fetch_json_url.rs`, using a hand-rolled `std::net::TcpListener` mock
  (no new dep) mirroring the existing in-memory-bytes test style in `parse_json.rs`:
  headers/parse round-trip, auth-header propagation assertion, non-2xx → clean `Err`, size-cap
  trip.
- **Vitest** `src/openUrlUI.test.ts` for the pure `buildAuthHeaders`/`deriveFileName` helpers,
  following the existing convention of testing extracted pure logic rather than full DOM
  (`mappingUI.test.ts`, `testSelectorUI.test.ts`).
- **Screenshot capture**: new `openUrlDialog` setup step in `capture-screenshots.mjs` (mirrors
  the existing `openSplitsDialog` case) + a `capture-definitions.mjs` entry, run via `node
  scripts/capture-screenshots.mjs --only open-from-url`. Add the image + a new user-guide
  section documenting the mock-server walkthrough, then `npm run build:guide`. Add a row to
  CLAUDE.md's screenshot-recapture table.

### 6. Explicit v1 cut lines (don't build)

GET only (no POST/body/other methods); no pagination/streaming (single response, capped at
50MB); no OAuth/token-refresh (static pasted token only); no polling/auto-refresh (one fetch =
one import, like opening a file); no custom TLS trust config; no batch/multi-URL import (one
endpoint per invocation); no non-JSON response formats (CSV/XML/NDJSON-over-HTTP); no OS
keychain/credential vault; no proxy configuration UI.

### 7. Versioning

Bump `package.json` + `src-tauri/Cargo.toml` together, `cargo check` to refresh `Cargo.lock`,
add a `CHANGELOG.md` `### Added` entry describing the feature, the `reqwest` dependency, and the
mock-server demo fixture (per CLAUDE.md's versioning rules).

## Critical files

- `packages/parsers/src/parse_json.rs` — refactor for `json_headers_from_bytes`;
  `parse_json_from_bytes` (line 47) reused unmodified
- `src-tauri/src/commands/fetch_json_url.rs` — new, template is
  `src-tauri/src/commands/parse_json.rs`
- `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` — command registration
- `src-tauri/Cargo.toml` — add `reqwest`
- `src/platform.ts` — new `Platform` methods + both adapter impls
- `src/openUrlUI.ts` — new modal, built on `src/modal.ts`'s `openModal()`
- `src/main.ts` — extract `finishImport` from `handleFiles` (lines 641-984), add
  `handleUrlImport`
- `src/mappingUI.ts` — unchanged; integration contract only (`showMappingOverlay`, line 236)
- `scripts/mock-json-api-server.mjs` — new demo/test fixture server
- `scripts/capture-screenshots.mjs`, `scripts/capture-definitions.mjs` — new capture target
- `docs/user-guide.md`, `CLAUDE.md` (screenshot table) — docs

## Verification

1. `cargo test --manifest-path packages/parsers/Cargo.toml` — confirm the
   `json_headers_from_bytes` refactor doesn't regress existing `json_headers_sync` tests.
2. `cargo test` (src-tauri) — new mock-TCP-listener tests pass (headers, parse, auth
   propagation, non-2xx, size cap).
3. `npm test` — new `openUrlUI.test.ts` passes; existing `lib.test.ts`/`wmap-integration.test.ts`
   still pass after the `main.ts` extraction.
4. `npm run mock:api` in one terminal, `npm run tauri dev` in another — manually: click "Open
   from URL…", enter `http://127.0.0.1:8787/wafer-lot` with the demo Bearer token, confirm the
   mapping overlay appears identically to a JSON-file open, confirm mapping, confirm the test
   selector appears, confirm a wafer map renders. Repeat with a wrong/missing token to confirm
   the 401 surfaces as a clean error, not a crash.
5. `node scripts/capture-screenshots.mjs --only open-from-url` — confirm the new dialog is
   captured; `npm run build:guide` — confirm it appears in the built guide.
6. `npx tsc --noEmit` and `npm run check:rust` clean.
