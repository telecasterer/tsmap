#!/usr/bin/env node
// Release guard: refuses to build a shippable tsmap against a wmap that users
// can't get. tsmap is developed against a LOCAL, often-unpublished wmap (see the
// `npm run wmap:link` batch workflow in CLAUDE.md) — that's fine for dev, but a
// release must resolve to a published, version-matched wmap or it'll be a
// "works on my machine" build that npm ci can't reproduce.
//
// Fails (exit 1) if either:
//   1. wmap is currently LINKED (node_modules/@paulrobins/wafermap is a symlink) —
//      the build would embed local, unpublished code; or
//   2. the wmap version range in package.json does not resolve to a version that
//      is actually published on npm.
//
// Runs only from `build`/`release` (NOT predev), so it never blocks the local
// link-and-iterate loop. Network-tolerant: if npm can't be reached it warns and
// passes rather than blocking an offline release build.

import { execSync } from 'child_process';
import { readFileSync, lstatSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@paulrobins/wafermap';

function fail(msg) {
  console.error(`\n  ✗ wmap publish check failed\n\n${msg}\n`);
  process.exit(1);
}

// 1. Reject a linked wmap — a release must not embed local unpublished code.
try {
  if (lstatSync(join(ROOT, 'node_modules', PACKAGE)).isSymbolicLink()) {
    fail(
      `  ${PACKAGE} is LINKED to a local checkout (../wmap).\n\n` +
      `  A release must build against the published package. Run:\n\n` +
      `    npm run wmap:unlink\n\n` +
      `  (publish wmap first if this build needs unreleased changes), then rebuild.`,
    );
  }
} catch {
  // Not installed at all — npm ci will handle it; nothing to guard here.
}

// 2. Reject a package.json range that no published version satisfies.
const range = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  .dependencies?.[PACKAGE];
if (!range) fail(`package.json has no ${PACKAGE} dependency.`);

let resolved;
try {
  // `npm show <pkg>@<range> version` prints every published version the range
  // matches (last line = highest). Empty output = nothing published matches.
  const out = execSync(`npm show "${PACKAGE}@${range}" version`, {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  resolved = out ? out.split('\n').pop().trim().split(/\s+/).pop() : '';
} catch (err) {
  // npm exits non-zero for BOTH "offline" and "404 no version matches the
  // range" — but they must be treated oppositely: 404 means the range is
  // unpublished and the guard MUST fail; a network error means skip (don't
  // block an offline release). Distinguish by the E404 signature in npm's
  // stderr; anything else is treated as a network/tooling problem and passed.
  const stderr = String(err.stderr ?? err.message ?? '');
  if (/E404|404/.test(stderr)) {
    resolved = ''; // fall through to the not-published failure below
  } else {
    console.warn(`  ⚠ wmap publish check: npm unreachable — skipping (offline build).`);
    process.exit(0);
  }
}

if (!resolved) {
  fail(
    `  package.json requires ${PACKAGE}@${range}, but no PUBLISHED version\n` +
    `  on npm satisfies that range.\n\n` +
    `  Publish wmap (bump + npm publish in ../wmap), then set package.json to the\n` +
    `  published version before releasing tsmap.`,
  );
}

// Silent on success — keeps release output clean.
