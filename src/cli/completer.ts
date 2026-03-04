/**
 * REPL入力のTab補完
 *
 * 1. /コマンド補完: /he → /help, /mo → /model, /model → /model list
 * 2. @ファイルパス補完: @src/cl → @src/cli/, @src/cli/re → @src/cli/repl.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CompleterResult } from "node:readline";

/** 組み込みコマンド一覧 */
const BUILTIN_COMMANDS = [
  "/help",
  "/quit",
  "/exit",
  "/clear",
  "/context",
  "/compact",
  "/model",
  "/model list",
  "/todo",
  "/sessions",
  "/resume",
  "/continue",
  "/memory",
  "/remember",
  "/diff",
  "/plan",
  "/skills",
  "/status",
  "/mode",
];

export interface CompleterOptions {
  /** 登録済みスキルのトリガー一覧 (例: ["/commit", "/tdd"]) */
  skillTriggers?: string[];
  /** 作業ディレクトリ */
  cwd?: string;
}

/**
 * readline completer を生成する。
 * readline.createInterface({ completer }) に渡す。
 */
export function createCompleter(
  options: CompleterOptions = {},
): (line: string) => CompleterResult {
  const { skillTriggers = [], cwd = process.cwd() } = options;
  const allCommands = [...BUILTIN_COMMANDS, ...skillTriggers];

  return (line: string): CompleterResult => {
    // --- /コマンド補完 ---
    if (line.startsWith("/")) {
      const matches = allCommands.filter((cmd) => cmd.startsWith(line));
      return [matches, line];
    }

    // --- @ファイルパス補完 ---
    // 入力中の最後の @path を検出
    const atMatch = line.match(/@([^\s]*)$/);
    if (atMatch) {
      const partial = atMatch[1]; // "@" の後の部分 (例: "src/cl")
      const completions = completeFilePath(partial, cwd);
      // completerの戻り値は [候補配列, マッチ対象文字列]
      // マッチ対象は "@partial" 全体
      const atPrefix = `@${partial}`;
      return [completions.map((c) => `@${c}`), atPrefix];
    }

    // 補完対象なし
    return [[], line];
  };
}

/**
 * 部分パスからファイル/ディレクトリ候補を返す。
 *
 * 例: "src/cl" → ["src/cli/"]
 *     "src/cli/re" → ["src/cli/renderer.ts", "src/cli/repl.ts"]
 *     "" → ["src/", "tests/", "package.json", ...]
 */
function completeFilePath(partial: string, cwd: string): string[] {
  try {
    // partial の親ディレクトリとプレフィックスを分離
    const dir = path.dirname(partial);
    const prefix = path.basename(partial);
    const targetDir = path.resolve(cwd, dir === "." && partial === "" ? "." : dir);

    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      return [];
    }

    // partial が "/" で終わっていたらディレクトリ内のエントリすべて
    const isExactDir = partial.endsWith("/") || partial.endsWith("\\");
    let searchDir: string;
    let searchPrefix: string;

    if (isExactDir) {
      searchDir = path.resolve(cwd, partial);
      searchPrefix = "";
    } else {
      searchDir = targetDir;
      searchPrefix = prefix;
    }

    if (!fs.existsSync(searchDir) || !fs.statSync(searchDir).isDirectory()) {
      return [];
    }

    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // 隠しファイルは除外
      if (searchPrefix && !entry.name.startsWith(searchPrefix)) continue;

      const relativePath = isExactDir
        ? `${partial}${entry.name}`
        : dir === "."
          ? entry.name
          : `${dir}/${entry.name}`;

      if (entry.isDirectory()) {
        results.push(`${relativePath}/`);
      } else {
        results.push(relativePath);
      }
    }

    return results.sort();
  } catch {
    return [];
  }
}
