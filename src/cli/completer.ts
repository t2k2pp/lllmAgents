/**
 * 入力補完・メニュー候補プロバイダー
 *
 * - createCommandMenuProvider: /コマンドのドロップダウン候補（説明付き）
 * - createFileMenuProvider: @ファイルパスのドロップダウン候補
 * - createCompleter: readline用Tab補完（フォールバック用）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CompleterResult } from "node:readline";
import type { MenuItem, MenuProvider } from "./interactive-input.js";

// ─── コマンド定義（説明付き） ────────────────────────────

interface CommandDef {
  command: string;
  description: string;
}

const BUILTIN_COMMAND_DEFS: CommandDef[] = [
  { command: "/help", description: "ヘルプ表示" },
  { command: "/quit", description: "終了" },
  { command: "/exit", description: "終了" },
  { command: "/clear", description: "会話履歴クリア" },
  { command: "/context", description: "コンテキスト使用状況" },
  { command: "/compact", description: "コンテキスト圧縮" },
  { command: "/model", description: "モデル情報" },
  { command: "/model list", description: "利用可能モデル一覧" },
  { command: "/todo", description: "タスクリスト" },
  { command: "/sessions", description: "セッション一覧" },
  { command: "/resume", description: "セッション復元" },
  { command: "/continue", description: "最新セッション復元" },
  { command: "/memory", description: "メモリ表示" },
  { command: "/remember", description: "メモリに追記" },
  { command: "/diff", description: "git diff" },
  { command: "/plan", description: "プランモード" },
  { command: "/skills", description: "スキル一覧" },
  { command: "/status", description: "ステータス" },
  { command: "/mode", description: "コンテキストモード" },
];

// ─── MenuProvider（InteractiveInput用ドロップダウン） ────

/**
 * /コマンドのドロップダウン候補プロバイダーを生成。
 * partial は "/" の後の文字列（例: "he" → /help がマッチ）
 */
export function createCommandMenuProvider(
  skillTriggers: { trigger: string; description: string }[] = [],
): MenuProvider {
  const allDefs: CommandDef[] = [
    ...BUILTIN_COMMAND_DEFS,
    ...skillTriggers.map((s) => ({
      command: s.trigger,
      description: s.description,
    })),
  ];

  return (partial: string): MenuItem[] => {
    return allDefs
      .filter((d) => d.command.slice(1).startsWith(partial.toLowerCase()))
      .map((d) => ({
        label: d.command,
        value: d.command,
        description: d.description,
      }));
  };
}

/**
 * @ファイルパスのドロップダウン候補プロバイダーを生成。
 * partial は "@" の後の文字列（例: "src/cl" → src/cli/ がマッチ）
 */
export function createFileMenuProvider(
  cwd: string = process.cwd(),
): MenuProvider {
  return (partial: string): MenuItem[] => {
    const paths = completeFilePath(partial, cwd);
    return paths.map((p) => ({
      label: p,
      value: p,
      description: p.endsWith("/") ? "📂" : "📄",
    }));
  };
}

// ─── readline completer（フォールバック用） ──────────────

const BUILTIN_COMMANDS = BUILTIN_COMMAND_DEFS.map((d) => d.command);

export interface CompleterOptions {
  skillTriggers?: string[];
  cwd?: string;
}

export function createCompleter(
  options: CompleterOptions = {},
): (line: string) => CompleterResult {
  const { skillTriggers = [], cwd = process.cwd() } = options;
  const allCommands = [...BUILTIN_COMMANDS, ...skillTriggers];

  return (line: string): CompleterResult => {
    if (line.startsWith("/")) {
      const matches = allCommands.filter((cmd) => cmd.startsWith(line));
      return [matches, line];
    }

    const atMatch = line.match(/@([^\s]*)$/);
    if (atMatch) {
      const partial = atMatch[1];
      const completions = completeFilePath(partial, cwd);
      const atPrefix = `@${partial}`;
      return [completions.map((c) => `@${c}`), atPrefix];
    }

    return [[], line];
  };
}

// ─── ファイルパス補完（共通ロジック） ────────────────────

function completeFilePath(partial: string, cwd: string): string[] {
  try {
    const dir = path.dirname(partial);
    const prefix = path.basename(partial);
    const targetDir = path.resolve(cwd, dir === "." && partial === "" ? "." : dir);

    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      return [];
    }

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
      if (entry.name.startsWith(".")) continue;
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
