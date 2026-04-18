#!/usr/bin/env node
// ビルトインスキル同期スクリプト
// src/skills/builtin/ → ~/.localllm/skills/ へ差分同期
// 設計書: docs/workspace-separation.md
//
// ルール:
//  - ビルトイン名 = src/skills/builtin/ 直下のディレクトリ名
//  - ユーザー編集検出: 前回同期時のハッシュと現物のハッシュを比較
//    不一致 = ユーザーが手を入れた → .user.bak に退避してから上書き
//  - 削除されたビルトイン = ~/.localllm/skills/<name>.removed/ へリネーム
//  - ユーザー独自スキル = 完全に無視
//  - メタ: ~/.localllm/.skills-sync-meta.json

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_BUILTIN = join(ROOT, 'src', 'skills', 'builtin');
const USER_SKILLS = join(homedir(), '.localllm', 'skills');
const META_PATH = join(homedir(), '.localllm', '.skills-sync-meta.json');

const argv = new Set(process.argv.slice(2));
const VERBOSE = argv.has('--verbose');
const FORCE = argv.has('--force');

function log(msg) {
  if (VERBOSE) console.error(`[sync-skills] ${msg}`);
}

function walkFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else if (e.isFile()) out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function hashDir(dir) {
  if (!existsSync(dir)) return null;
  const files = walkFiles(dir).sort();
  const h = createHash('sha1');
  for (const rel of files) {
    h.update(rel).update('\0');
    h.update(readFileSync(join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

function readMeta() {
  if (!existsSync(META_PATH)) return { skills: {} };
  try { return JSON.parse(readFileSync(META_PATH, 'utf8')); }
  catch { return { skills: {} }; }
}

function writeMeta(meta) {
  mkdirSync(dirname(META_PATH), { recursive: true });
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');
}

function copyDir(from, to) {
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

function backupAsUserBak(dir) {
  const bak = `${dir}.user.bak`;
  if (existsSync(bak)) rmSync(bak, { recursive: true, force: true });
  renameSync(dir, bak);
  return bak;
}

function markAsRemoved(dir) {
  const removed = `${dir}.removed`;
  if (existsSync(removed)) rmSync(removed, { recursive: true, force: true });
  renameSync(dir, removed);
  return removed;
}

function main() {
  if (!existsSync(SRC_BUILTIN)) {
    console.error(`[sync-skills] source not found: ${SRC_BUILTIN}`);
    process.exit(1);
  }

  mkdirSync(USER_SKILLS, { recursive: true });

  const meta = readMeta();
  const prevSkills = meta.skills || {};
  const newSkills = {};

  const builtinNames = readdirSync(SRC_BUILTIN, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  let added = 0, updated = 0, skipped = 0, preserved = 0, removed = 0;

  for (const name of builtinNames) {
    const srcDir = join(SRC_BUILTIN, name);
    const dstDir = join(USER_SKILLS, name);
    const srcHash = hashDir(srcDir);
    const prev = prevSkills[name];

    if (!existsSync(dstDir)) {
      copyDir(srcDir, dstDir);
      newSkills[name] = { hash: srcHash };
      added++;
      log(`added: ${name}`);
      continue;
    }

    const currentHash = hashDir(dstDir);

    if (!FORCE && currentHash === srcHash) {
      newSkills[name] = { hash: srcHash };
      skipped++;
      continue;
    }

    const userEdited = prev && prev.hash && currentHash !== prev.hash;
    if (userEdited && !FORCE) {
      const bak = backupAsUserBak(dstDir);
      copyDir(srcDir, dstDir);
      newSkills[name] = { hash: srcHash };
      preserved++;
      console.error(`[sync-skills] user edits preserved: ${relative(homedir(), bak)}`);
      continue;
    }

    copyDir(srcDir, dstDir);
    newSkills[name] = { hash: srcHash };
    updated++;
    log(`updated: ${name}`);
  }

  // 削除検出: 前回同期時にあったが今回 src に無い
  for (const name of Object.keys(prevSkills)) {
    if (builtinNames.includes(name)) continue;
    const dstDir = join(USER_SKILLS, name);
    if (!existsSync(dstDir)) continue;
    const marked = markAsRemoved(dstDir);
    removed++;
    console.error(`[sync-skills] builtin removed: ${relative(homedir(), marked)}`);
  }

  meta.skills = newSkills;
  meta.syncedAt = new Date().toISOString();
  writeMeta(meta);

  const summary = [
    added && `+${added}`,
    updated && `~${updated}`,
    preserved && `preserved:${preserved}`,
    removed && `removed:${removed}`,
    skipped && `=${skipped}`,
  ].filter(Boolean).join(' ');

  if (summary) console.error(`[sync-skills] ${summary}`);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(`[sync-skills] error: ${e.message}`);
  process.exit(1);
}
