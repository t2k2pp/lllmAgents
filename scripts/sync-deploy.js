#!/usr/bin/env node
// src → deploy スナップショット同期スクリプト
// 設計書: docs/workspace-separation.md

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const DEPLOY = join(ROOT, 'deploy');
const META = join(DEPLOY, '.deploy-meta.json');

const argv = new Set(process.argv.slice(2));
const FORCE = argv.has('--force');
const VERBOSE = argv.has('--verbose');
const SKIP_BUILD = argv.has('--skip-build');

const EXCLUDE_FROM_DIST = new Set([
  'localllm.exe',
  'localllm.cjs',
  'sea-config.json',
  'sea-prep.blob',
  'ncc',
]);

function log(msg) {
  if (VERBOSE) console.error(`[sync-deploy] ${msg}`);
}

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readMeta() {
  if (!existsSync(META)) return null;
  try { return JSON.parse(readFileSync(META, 'utf8')); } catch { return null; }
}

function currentHead() {
  try { return sh('git rev-parse HEAD'); } catch { return null; }
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function computeSourceHash() {
  const h = createHash('sha1');
  const files = [];
  if (existsSync(SRC)) files.push(...walk(SRC));
  for (const rel of ['package.json', 'README.md', 'tsconfig.json']) {
    const p = join(ROOT, rel);
    if (existsSync(p)) files.push(p);
  }
  files.sort();
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    h.update(rel).update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

function runTsc() {
  log('running tsc...');
  const r = spawnSync('npx', ['--no-install', 'tsc'], {
    cwd: ROOT,
    stdio: VERBOSE ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  if (r.status !== 0) {
    const err = r.stderr?.toString?.() ?? '';
    throw new Error(`tsc failed (code ${r.status}): ${err.slice(0, 500)}`);
  }
}

function mirrorDist() {
  if (!existsSync(DIST)) throw new Error('dist/ not found — build failed?');
  mkdirSync(DEPLOY, { recursive: true });

  const keepInDeploy = new Set(['.deploy-meta.json', 'package.json', 'README.md', 'skills-assets']);
  for (const entry of readdirSync(DEPLOY)) {
    if (!keepInDeploy.has(entry)) {
      rmSync(join(DEPLOY, entry), { recursive: true, force: true });
    }
  }

  for (const entry of readdirSync(DIST)) {
    if (EXCLUDE_FROM_DIST.has(entry)) continue;
    if (entry.endsWith('.map')) continue;
    cpSync(join(DIST, entry), join(DEPLOY, entry), { recursive: true });
  }
  log('dist → deploy mirrored');
}

function copyBuiltinSkills() {
  const from = join(SRC, 'skills', 'builtin');
  const to = join(DEPLOY, 'skills-assets');
  if (!existsSync(from)) return;
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  log('src/skills/builtin → deploy/skills-assets copied');
}

function writeDeployPackageJson() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  pkg.scripts = { start: 'node index.js' };
  pkg.main = 'index.js';
  pkg.bin = { localllm: 'index.js' };
  writeFileSync(join(DEPLOY, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

function copyReadme() {
  const from = join(ROOT, 'README.md');
  if (existsSync(from)) cpSync(from, join(DEPLOY, 'README.md'));
}

function writeMeta(hash, sourceHash) {
  const meta = {
    syncedAt: new Date().toISOString(),
    commit: hash,
    sourceHash,
    node: process.version,
  };
  writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
}

function main() {
  const start = Date.now();
  const prevMeta = readMeta();
  const head = currentHead();
  const sourceHash = computeSourceHash();

  if (!FORCE && prevMeta && prevMeta.sourceHash === sourceHash) {
    log('up-to-date (source hash match), skipping');
    return { skipped: true };
  }

  if (!SKIP_BUILD) runTsc();
  mirrorDist();
  copyBuiltinSkills();
  writeDeployPackageJson();
  copyReadme();
  writeMeta(head, sourceHash);

  return { skipped: false, ms: Date.now() - start, head };
}

try {
  const r = main();
  if (r.skipped) {
    if (VERBOSE) console.error('[sync-deploy] skipped (no changes)');
    process.exit(0);
  }
  console.error(`[sync-deploy] synced (${r.ms}ms, commit ${r.head?.slice(0, 7) ?? 'unknown'})`);
  process.exit(0);
} catch (e) {
  console.error(`[sync-deploy] error: ${e.message}`);
  process.exit(1);
}
