#!/usr/bin/env node
// Release guard: catches the exact failure mode that let `packages/parsers`
// (the shared Rust/WASM parser crate, published as `@paulrobins/testdata-parser`)
// drift silently for a month — real source changes shipped in tsmap v0.1.20 via
// the native build's Cargo path dependency (which always compiles the crate from
// source, regardless of npm state), while the browser/WASM build kept running
// the stale published package, because nothing checked whether the crate's
// *version* actually moved when its *source* did. Unlike wmap, this crate has
// no local-link dev workflow — the native build's source-of-truth being "always
// current" is exactly what let the web build's staleness go unnoticed.
//
// Fails (exit 1) if any of:
//   1. packages/parsers/src (or Cargo.toml) has changed since the version in
//      Cargo.toml was last bumped — the crate's source has drifted ahead of
//      its own version number, so a bump + publish is needed before release.
//   2. packages/parsers/Cargo.toml's version doesn't match the range pinned
//      in package.json's @paulrobins/testdata-parser dependency — the crate
//      was bumped locally but package.json was never updated to point at it.
//   3. package.json's pinned range doesn't resolve to a version actually
//      published on npm — bumped and pinned, but never `npm publish`ed.
//
// Runs only from `build`/`release` (NOT predev), mirroring check-wmap-published.js.
// Tolerant of a shallow git clone (check 1) and of npm being unreachable
// (check 3) — warns and continues rather than blocking a build on something
// it can't actually verify (e.g. CI's default shallow checkout).

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@paulrobins/testdata-parser';
const CRATE_TOML = 'packages/parsers/Cargo.toml';
const CRATE_SRC = 'packages/parsers/src';

function fail(msg) {
  console.error(`\n  ✗ testdata-parser publish check failed\n\n${msg}\n`);
  process.exit(1);
}

function git(args) {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function cargoVersion() {
  const toml = readFileSync(join(ROOT, CRATE_TOML), 'utf8');
  const m = toml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) fail(`Could not find a version in ${CRATE_TOML}.`);
  return m[1];
}

// ── 1. Has the crate's source drifted since its version was last bumped? ────
// Find the most recent commit that changed the `version = "..."` line in
// Cargo.toml, then check whether any LATER commit touched the crate's source.
// Tolerant of shallow clones — if no version-bump commit is found in the
// available history, warn and skip rather than guess.
try {
  const isShallow = git('rev-parse --is-shallow-repository') === 'true';
  const commits = git(`log --format=%H -- ${CRATE_TOML}`).split('\n').filter(Boolean);
  let bumpCommit = null;
  for (const commit of commits) {
    const diff = git(`show ${commit} -- ${CRATE_TOML}`);
    if (/^\+version = "/m.test(diff)) { bumpCommit = commit; break; }
  }
  if (!bumpCommit) {
    const why = isShallow ? 'shallow git history' : `no version-bump commit found for ${CRATE_TOML}`;
    console.warn(`  ⚠ testdata-parser publish check: ${why} — skipping source-drift check.`);
  } else {
    const drift = git(`log --oneline ${bumpCommit}..HEAD -- ${CRATE_SRC} ${CRATE_TOML}`);
    if (drift) {
      fail(
        `  packages/parsers/src (or Cargo.toml) has changed since the crate's\n` +
        `  version was last bumped (${bumpCommit.slice(0, 7)}):\n\n` +
        drift.split('\n').map(l => `    ${l}`).join('\n') + '\n\n' +
        `  Bump the version in ${CRATE_TOML}, then wasm-pack build + npm publish\n` +
        `  (see CLAUDE.md's "Shared parsers crate" section) before releasing.`,
      );
    }
  }
} catch (err) {
  console.warn(`  ⚠ testdata-parser publish check: git history unavailable (${String(err.message).split('\n')[0]}) — skipping source-drift check.`);
}

// ── 2. Does Cargo.toml's version match package.json's pinned range? ─────────
const cargoVer = cargoVersion();
const range = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies?.[PACKAGE];
if (!range) fail(`package.json has no ${PACKAGE} dependency.`);
const pinnedVer = range.replace(/^[\^~]/, '');
if (pinnedVer !== cargoVer) {
  fail(
    `  packages/parsers/Cargo.toml is at ${cargoVer}, but package.json pins\n` +
    `  ${PACKAGE}@${range}.\n\n` +
    `  After publishing, run: npm install ${PACKAGE}@^${cargoVer}`,
  );
}

// ── 3. Does that range actually resolve to a published npm version? ─────────
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
    console.warn(`  ⚠ testdata-parser publish check: npm unreachable — skipping (offline build).`);
    process.exit(0);
  }
}

if (!resolved) {
  fail(
    `  package.json requires ${PACKAGE}@${range}, but no PUBLISHED version\n` +
    `  on npm satisfies that range.\n\n` +
    `  Publish the parser crate (bump packages/parsers/Cargo.toml, wasm-pack\n` +
    `  build, npm publish — see CLAUDE.md's "Shared parsers crate" section),\n` +
    `  then release tsmap.`,
  );
}

// Silent on success — keeps release output clean.
