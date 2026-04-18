#!/usr/bin/env node
// 配布フォルダ (deploy/) を組み立てる
// 設計書: docs/workspace-separation.md
//
// 手順:
//  1. build-exe.js を呼んで dist/localllm.exe を生成
//  2. deploy/ を作成し、以下を配置:
//     - localllm.exe (dist/ からコピー)
//     - skills/ (src/skills/builtin/ からコピー)
//     - install.bat / install.sh
//     - README.md (配布版)
//  3. .deploy-meta.json を書き出し

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = join(ROOT, 'dist');
const DEPLOY = join(ROOT, 'deploy');
const SRC_BUILTIN = join(ROOT, 'src', 'skills', 'builtin');
const EXE_SRC = join(DIST, 'localllm.exe');
const EXE_DST = join(DEPLOY, 'localllm.exe');
const SKILLS_DST = join(DEPLOY, 'skills');
const META = join(DEPLOY, '.deploy-meta.json');

const argv = new Set(process.argv.slice(2));
const SKIP_EXE = argv.has('--skip-exe');
const VERBOSE = argv.has('--verbose');

function log(msg) {
  console.error(`[build-deploy] ${msg}`);
}

function runBuildExe() {
  log('building exe via build-exe.js...');
  const r = spawnSync('node', ['build-exe.js'], {
    cwd: ROOT,
    stdio: VERBOSE ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (r.status !== 0) {
    const err = (r.stderr?.toString?.() ?? '').slice(0, 800);
    throw new Error(`build-exe failed (code ${r.status}): ${err}`);
  }
}

function copyExe() {
  if (!existsSync(EXE_SRC)) throw new Error(`exe not found: ${EXE_SRC}`);
  mkdirSync(DEPLOY, { recursive: true });
  cpSync(EXE_SRC, EXE_DST);
  const sz = statSync(EXE_DST).size;
  log(`exe copied (${Math.round(sz / (1024 * 1024))}MB)`);
}

function copySkills() {
  if (!existsSync(SRC_BUILTIN)) throw new Error(`builtin skills not found: ${SRC_BUILTIN}`);
  if (existsSync(SKILLS_DST)) rmSync(SKILLS_DST, { recursive: true, force: true });
  cpSync(SRC_BUILTIN, SKILLS_DST, { recursive: true });
  const count = readdirSync(SKILLS_DST, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  log(`skills copied (${count} skills)`);
}

function copyAsset(src, dst, label) {
  if (!existsSync(src)) {
    log(`WARN: ${label} not found at ${src}`);
    return;
  }
  cpSync(src, dst);
}

function writeMeta() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const meta = {
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
}

function main() {
  const start = Date.now();

  if (!SKIP_EXE) runBuildExe();

  mkdirSync(DEPLOY, { recursive: true });
  copyExe();
  copySkills();

  // install スクリプトと README は scripts/assets/ に予め配置済みのものをコピー
  const assetsDir = join(__dirname, 'deploy-assets');
  copyAsset(join(assetsDir, 'install.bat'), join(DEPLOY, 'install.bat'), 'install.bat');
  copyAsset(join(assetsDir, 'install.sh'), join(DEPLOY, 'install.sh'), 'install.sh');
  copyAsset(join(assetsDir, 'README.md'), join(DEPLOY, 'README.md'), 'README.md');

  writeMeta();

  log(`done (${Date.now() - start}ms)`);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(`[build-deploy] error: ${e.message}`);
  process.exit(1);
}
