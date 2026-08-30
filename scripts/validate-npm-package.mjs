#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_PACKAGE_FILES = 800;
export const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;

const FORBIDDEN_PATHS = [
  /(^|\/)coverage(\/|$)/,
  /(^|\/)deploy(\/|$)/,
  /(^|\/)sandbox(\/|$)/,
  /(^|\/)tests(\/|$)/,
  /\.(?:blob|exe)$/i,
];

export function validatePackReport(report) {
  if (!report || !Array.isArray(report.files)) {
    return ["npm pack のJSONに files がありません"];
  }

  const errors = [];
  if (report.files.length > MAX_PACKAGE_FILES) {
    errors.push(`ファイル数が上限を超えています: ${report.files.length} > ${MAX_PACKAGE_FILES}`);
  }
  if (!Number.isFinite(report.unpackedSize) || report.unpackedSize > MAX_UNPACKED_BYTES) {
    errors.push(`展開サイズが上限を超えています: ${report.unpackedSize} > ${MAX_UNPACKED_BYTES}`);
  }

  const forbidden = report.files
    .map((file) => file.path)
    .filter((filePath) => FORBIDDEN_PATHS.some((pattern) => pattern.test(filePath)));
  if (forbidden.length > 0) {
    errors.push(`配布禁止ファイルが含まれています: ${forbidden.join(", ")}`);
  }

  return errors;
}

export function selectPackReport(parsed) {
  if (Array.isArray(parsed)) return parsed[0];
  if (parsed && typeof parsed === "object") return Object.values(parsed)[0];
  return undefined;
}

function run() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    console.error(
      "[package] npm_execpath が無いため npm pack を検証できません。npm run validate:package を使用してください。",
    );
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || "npm pack --dry-run に失敗しました");
    process.exit(result.status ?? 1);
  }

  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch {
    console.error(`[package] npm pack のJSONを解析できません: ${result.stdout.slice(0, 500)}`);
    process.exit(1);
  }

  const report = selectPackReport(reports);
  const errors = validatePackReport(report);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[package] ${error}`);
    process.exit(1);
  }

  console.log(
    `[package] validation passed: ${report.files.length} files, ${(report.unpackedSize / 1024 / 1024).toFixed(1)} MiB unpacked`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
