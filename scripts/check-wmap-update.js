#!/usr/bin/env node
// Checks if a newer @paulrobins/wafermap is on npm and installs it if so.
// Skips the network call if already checked within the last 24 hours.

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAMP_FILE = join(ROOT, 'node_modules/.wmap-update-check');
const PACKAGE = '@paulrobins/wafermap';
const ONE_DAY = 24 * 60 * 60 * 1000;

function installedVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', PACKAGE, 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return null;
  }
}

function latestVersion() {
  const out = execSync(`npm show ${PACKAGE} version`, { encoding: 'utf8', timeout: 10000 });
  return out.trim();
}

function stampAge() {
  if (!existsSync(STAMP_FILE)) return Infinity;
  return Date.now() - Number(readFileSync(STAMP_FILE, 'utf8').trim());
}

const current = installedVersion();

if (stampAge() < ONE_DAY) {
  process.exit(0);
}

let latest;
try {
  latest = latestVersion();
} catch {
  // Network unavailable — don't block the build
  process.exit(0);
}

writeFileSync(STAMP_FILE, String(Date.now()));

if (current === latest) {
  process.exit(0);
}

console.log(`wmap update: ${current ?? 'none'} → ${latest} — installing...`);
execSync(`npm install ${PACKAGE}@${latest}`, { stdio: 'inherit', cwd: ROOT });
