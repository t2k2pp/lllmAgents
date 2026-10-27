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
//  4. install スクリプトを流して導入済みの exe を更新するか尋ねる (対話できないときは知らせるだけ)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { getGitBuildId } from "./git-revision.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const DEPLOY = join(ROOT, "deploy");
const SRC_BUILTIN_SKILLS = join(ROOT, "src", "skills", "builtin");
const SRC_BUILTIN_AGENTS = join(ROOT, "src", "agents", "builtin");
const EXE_NAME = process.platform === "win32" ? "localllm.exe" : "localllm";
const EXE_SRC = join(DIST, EXE_NAME);
const EXE_DST = join(DEPLOY, EXE_NAME);
const LEGACY_CJS_DST = join(DEPLOY, "localllm.cjs");
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
  const pids = findRunningExePids();
  if (pids === null || pids.length === 0) return; // 調べられない (警告済み) か、 起動なし — OK

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

/**
 * 起動中の localllm.exe の PID (Windows のみ。 ほかの OS は exe がロックされないので空)。
 * tasklist が失敗したら警告して null (調べられなかった)。
 */
function findRunningExePids() {
  if (process.platform !== "win32") return [];
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq localllm.exe", "/NH"], {
    encoding: "utf8",
    shell: false,
  });
  if (r.status !== 0) {
    log("WARN: tasklist 実行に失敗。プロセスチェックをスキップします");
    return null;
  }
  // tasklist の出力は "name PID Session SessionNo MemUsage" の固定幅っぽい列
  return (r.stdout ?? "")
    .split(/\r?\n/)
    .filter((l) => /localllm\.exe/i.test(l))
    .map((l) => l.trim().split(/\s+/)[1] ?? "?");
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
}

function removeUnsupportedArtifacts() {
  if (existsSync(LEGACY_CJS_DST)) {
    rmSync(LEGACY_CJS_DST, { force: true });
    log("removed unsupported legacy CJS artifact");
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
  const build = getGitBuildId({ cwd: ROOT });
  const meta = {
    schemaVersion: 1,
    name: pkg.name,
    version: pkg.version,
    build,
    displayVersion: `v${pkg.version} (build ${build})`,
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
  removeUnsupportedArtifacts();
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

/** install スクリプトの導入先の exe (install.bat / install.sh の INSTALL_DIR と同じ場所) */
function installedExePath() {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "localllm", EXE_NAME) : null;
  }
  return process.env.HOME ? join(process.env.HOME, ".local", "bin", EXE_NAME) : null;
}

/** 大きさと更新日時が同じなら同じ版とみなす (install.bat の copy も cpSync も更新日時を保つ) */
function sameFile(a, b) {
  const sa = statSync(a);
  const sb = statSync(b);
  return sa.size === sb.size && Math.floor(sa.mtimeMs / 1000) === Math.floor(sb.mtimeMs / 1000);
}

function describeMtime(path) {
  return path !== null && existsSync(path) ? statSync(path).mtime.toLocaleString("ja-JP") : "未導入";
}

/**
 * deploy/ を作っただけでは、 普段起動する導入済みの exe は古いまま (2026-10-27 に古い版で動き続けた実例)。
 * 最後に install スクリプトを流すか尋ねる。 対話できないとき (パイプ・CI) は尋ねずに知らせるだけ。
 * @returns 終了コード (流した install が失敗したら 1)
 */
async function offerInstall() {
  const installed = installedExePath();
  const script = process.platform === "win32" ? join(DEPLOY, "install.bat") : join(DEPLOY, "install.sh");
  log(`導入済みの ${EXE_NAME}: ${installed ?? "(場所が分かりません)"} (${describeMtime(installed)})`);
  log(`今回ビルドした ${EXE_NAME}: ${EXE_DST} (${describeMtime(EXE_DST)})`);
  if (installed !== null && existsSync(installed) && sameFile(installed, EXE_DST)) {
    log("導入済みの exe は今回ビルドしたものと同じです");
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log(`導入済みの exe は更新していません。 反映するには ${script} を実行してください`);
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${script} を実行して、 導入済みの localllm を更新しますか? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    log(`実行しませんでした。 反映するには ${script} を実行してください`);
    return 0;
  }
  const pids = findRunningExePids();
  if (pids !== null && pids.length > 0) {
    log(
      `localllm.exe が起動中のため実行しません (PID: ${pids.join(", ")})。 ` +
        `起動中の exe は上書きできません。 終了してから ${script} を実行してください`,
    );
    return 0;
  }
  const r =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/c", script], { cwd: DEPLOY, stdio: "inherit" })
      : spawnSync("sh", [script], { cwd: DEPLOY, stdio: "inherit" });
  if (r.status !== 0) {
    log(`error: ${script} が失敗しました (code ${r.status ?? r.error?.message})`);
    return 1;
  }
  log(`導入済みの ${EXE_NAME} を更新しました (${describeMtime(installed)})`);
  return 0;
}

try {
  main();
  process.exit(await offerInstall());
} catch (e) {
  console.error(`[build-deploy] error: ${e.message}`);
  process.exit(1);
}
