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
  { command: "/discord", description: "Discord通知の設定" },
  { command: "/permission", description: "権限設定" },
  { command: "/permission list", description: "権限設定一覧" },
  { command: "/permission auto-add", description: "CLI自動許可に追加" },
  { command: "/permission auto-remove", description: "CLI自動許可から削除" },
  { command: "/permission require-add", description: "CLI確認必要に追加" },
  { command: "/permission require-remove", description: "CLI確認必要から削除" },
  { command: "/permission discord-add", description: "Discord許可に追加" },
  { command: "/permission discord-remove", description: "Discord許可から削除" },
  { command: "/permission rules", description: "パターンルール一覧" },
  { command: "/permission rule-add allow", description: "allowルールを追加" },
  { command: "/permission rule-add deny", description: "denyルールを追加" },
  { command: "/permission rule-add ask", description: "askルールを追加" },
  { command: "/permission rule-remove allow", description: "allowルールを削除" },
  { command: "/permission rule-remove deny", description: "denyルールを削除" },
  { command: "/permission rule-remove ask", description: "askルールを削除" },
];


// ─── MenuProvider（InteractiveInput用ドロップダウン） ────

/**
 * /コマンドのドロップダウン候補プロバイダーを生成。
 * partial は "/" の後の文字列（例: "he" → /help がマッチ）
 */
export function createCommandMenuProvider(
  skillTriggers: { trigger: string; description: string }[] = [],
  toolNames: string[] = [],
): MenuProvider {
  const allDefs: CommandDef[] = [
    ...BUILTIN_COMMAND_DEFS,
    ...skillTriggers.map((s) => ({
      command: s.trigger,
      description: s.description,
    })),
  ];

  return (partial: string): MenuItem[] => {
    // /permission <subcommand> <tool名> のツール名補完
    // partial 例: "permission auto-add ba"
    const permToolMatch = partial.match(
      /^(permission (auto-add|auto-remove|require-add|require-remove|discord-add|discord-remove) )(.*)$/,
    );
    if (permToolMatch && toolNames.length > 0) {
      const cmdPrefix = permToolMatch[1]; // "permission auto-add "
      const toolPrefix = permToolMatch[3]; // 入力中のツール名プレフィックス
      return toolNames
        .filter((n) => n.startsWith(toolPrefix))
        .sort()
        .map((n) => ({
          label: `/${cmdPrefix}${n}`,
          value: `/${cmdPrefix}${n}`,
          description: "ツール名",
        }));
    }

    // 通常コマンドマッチ
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
  toolNames?: string[];
  cwd?: string;
}

export function createCompleter(
  options: CompleterOptions = {},
): (line: string) => CompleterResult {
  const { skillTriggers = [], cwd = process.cwd() } = options;
  const allCommands = [...BUILTIN_COMMANDS, ...skillTriggers];
  const toolNames = options.toolNames ?? [];

  return (line: string): CompleterResult => {
    if (line.startsWith("/")) {
      // /permission <subcommand> <tool名> のツール名補完
      const permToolMatch = line.match(
        /^(\/permission (?:auto-add|auto-remove|require-add|require-remove|discord-add|discord-remove) )(.*)$/,
      );
      if (permToolMatch && toolNames.length > 0) {
        const cmdPrefix = permToolMatch[1];
        const toolPrefix = permToolMatch[2];
        const matches = toolNames.filter((n) => n.startsWith(toolPrefix)).map((n) => `${cmdPrefix}${n}`);
        return [matches, line];
      }
      const matches = allCommands.filter((cmd) => cmd.startsWith(line));
      return [matches, line];
    }

    const atMatch = line.match(/@([a-zA-Z0-9_./\\-]*)$/);
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
