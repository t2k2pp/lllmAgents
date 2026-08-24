#!/usr/bin/env node
// 配布フォルダ (deploy/) を組み立てる
// 設計書: docs/workspace-separation.md
//
// 手順:
//  1. build-exe.js を呼んで dist/localllm.exe を生成
//  2. deploy/ を作成し、以下を配置:
//     - localllm.exe (dist/ からコピー)
//     - skills/ (src/skills/builtin/ からコピー)
//     - agents/ (src/agents/builtin/ からコピー)
//     - install.bat / install.sh
//     - README.md (配布版)
//  3. .deploy-meta.json を書き出し

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const DEPLOY = join(ROOT, "deploy");
const SRC_BUILTIN_SKILLS = join(ROOT, "src", "skills", "builtin");
const SRC_BUILTIN_AGENTS = join(ROOT, "src", "agents", "builtin");
const EXE_NAME = process.platform === "win32" ? "localllm.exe" : "localllm";
const EXE_SRC = join(DIST, EXE_NAME);
const EXE_DST = join(DEPLOY, EXE_NAME);
const SKILLS_DST = join(DEPLOY, "skills");
const AGENTS_DST = join(DEPLOY, "agents");
const META = join(DEPLOY, ".deploy-meta.json");

const argv = new Set(process.argv.slice(2));
const SKIP_EXE = argv.has("--skip-exe");
const VERBOSE = argv.has("--verbose");
const FORCE = argv.has("--force");

function log(msg) {
  console.error(`[build-deploy] ${msg}`);
}

/**
 * Windows で localllm.exe が起動中だと exe がファイルロックされ、
 * ビルドが「成功っぽく」見えても実体は古いままになる罠を防ぐ。
 * --force で警告のみにできる（ユーザーが意図的に上書きしたい場合）。
 */
function checkExeNotRunning() {
  if (process.platform !== "win32") return;
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq localllm.exe", "/NH"], {
    encoding: "utf8",
    shell: false,
  });
  if (r.status !== 0) {
    log("WARN: tasklist 実行に失敗。プロセスチェックをスキップします");
    return;
  }
  const out = r.stdout ?? "";
  if (!/localllm\.exe/i.test(out)) return; // 起動なし — OK

  // 起動中: PID 抽出 (tasklist の出力は "name PID Session SessionNo MemUsage" の固定幅っぽい列)
  const pids = out
    .split(/\r?\n/)
    .filter((l) => /localllm\.exe/i.test(l))
    .map((l) => l.trim().split(/\s+/)[1] ?? "?");

  const msg =
    `localllm.exe が起動中です (PID: ${pids.join(", ")})。\n` +
    `  Windows では実行中の exe はロックされ、ビルドが上書きできず古いまま残ります。\n` +
    `  対処:\n` +
    `    1. REPL を /quit で終了する  または\n` +
    `    2. taskkill /PID ${pids[0]} /F で強制終了する\n` +
    `  --force でこのチェックを無視できますが、ロック解除前のビルドは無音で失敗します。`;

  if (FORCE) {
    log(`WARN: ${msg}`);
    return;
  }
  throw new Error(msg);
}

function runBuildExe() {
  log("building exe via build-exe.js...");
  const r = spawnSync("node", ["build-exe.js"], {
    cwd: ROOT,
    stdio: VERBOSE ? "inherit" : ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (r.status !== 0) {
    const err = (r.stderr?.toString?.() ?? "").slice(0, 800);
    throw new Error(`build-exe failed (code ${r.status}): ${err}`);
  }
}

function copyExe() {
  if (!existsSync(EXE_SRC)) throw new Error(`exe not found: ${EXE_SRC}`);
  mkdirSync(DEPLOY, { recursive: true });
  cpSync(EXE_SRC, EXE_DST);
  const sz = statSync(EXE_DST).size;
  log(`exe copied (${Math.round(sz / (1024 * 1024))}MB)`);

  // Fallback mode 用に .cjs もコピー (SEAが失敗した時用)
  const cjsSrc = EXE_SRC.replace(EXE_NAME, "localllm.cjs");
  const cjsDst = EXE_DST.replace(EXE_NAME, "localllm.cjs");
  if (existsSync(cjsSrc)) {
    cpSync(cjsSrc, cjsDst);
    log(`cjs bundle copied`);
  }
}

function copySkills() {
  if (!existsSync(SRC_BUILTIN_SKILLS)) throw new Error(`builtin skills not found: ${SRC_BUILTIN_SKILLS}`);
  if (existsSync(SKILLS_DST)) rmSync(SKILLS_DST, { recursive: true, force: true });
  cpSync(SRC_BUILTIN_SKILLS, SKILLS_DST, { recursive: true });
  const count = readdirSync(SKILLS_DST, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  log(`skills copied (${count} skills)`);
}

function copyAgents() {
  if (!existsSync(SRC_BUILTIN_AGENTS)) throw new Error(`builtin agents not found: ${SRC_BUILTIN_AGENTS}`);
  if (existsSync(AGENTS_DST)) rmSync(AGENTS_DST, { recursive: true, force: true });
  cpSync(SRC_BUILTIN_AGENTS, AGENTS_DST, { recursive: true });
  const count = readdirSync(AGENTS_DST, { withFileTypes: true }).filter(
    (e) => e.isFile() && e.name.endsWith(".md"),
  ).length;
  log(`agents copied (${count} agents)`);
}

function copyAsset(src, dst, label) {
  if (!existsSync(src)) {
    log(`WARN: ${label} not found at ${src}`);
    return;
  }
  cpSync(src, dst);
}

function writeMeta() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const meta = {
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`);
}

function main() {
  const start = Date.now();

  checkExeNotRunning();

  if (!SKIP_EXE) runBuildExe();

  mkdirSync(DEPLOY, { recursive: true });
  copyExe();
  copySkills();
  copyAgents();

  // install スクリプトと README は scripts/assets/ に予め配置済みのものをコピー
  const assetsDir = join(__dirname, "deploy-assets");
  copyAsset(join(assetsDir, "install.bat"), join(DEPLOY, "install.bat"), "install.bat");
  copyAsset(join(assetsDir, "install.sh"), join(DEPLOY, "install.sh"), "install.sh");
  copyAsset(join(assetsDir, "README.md"), join(DEPLOY, "README.md"), "README.md");

  writeMeta();

  log(`done. deploy/${EXE_NAME} is up to date.`);
  log(`done (${Date.now() - start}ms)`);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(`[build-deploy] error: ${e.message}`);
  process.exit(1);
}
