#!/usr/bin/env node
// Stop フックエントリポイント
// - sync-deploy.js を呼ぶ（ハッシュ一致なら即 no-op）
// - 未 push コミットがあれば警告
// 設計書: docs/workspace-separation.md

import { execSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SYNC_SCRIPT = join(__dirname, 'sync-deploy.js');
const TIMEOUT_MS = 60_000;

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function isGitRepo() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runSync() {
  const r = spawnSync('node', [SYNC_SCRIPT], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
  });
  const err = (r.stderr || '').trim();
  if (r.status === 0) {
    if (err) console.error(err);
    return;
  }
  console.error(`[on-stop] sync-deploy failed (code ${r.status})`);
  if (err) console.error(err);
}

function checkUnpushed() {
  const upstream = sh('git rev-parse --abbrev-ref --symbolic-full-name @{u}');
  if (!upstream) return;
  const log = sh('git log @{u}..HEAD --oneline');
  if (!log) return;
  const count = log.split('\n').length;
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  console.error(`[on-stop] WARN: ${count} unpushed commit(s) on ${branch} — run: git push`);
}

function main() {
  if (!isGitRepo()) return;
  runSync();
  checkUnpushed();
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(`[on-stop] error: ${e.message}`);
  process.exit(0);
}
