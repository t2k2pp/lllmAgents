/**
 * @ファイル/フォルダ参照の解決
 *
 * ユーザー入力中の @path/to/file や @src/cli/ を検出し、
 * ファイルなら内容をインライン展開、フォルダならファイル一覧に展開する。
 *
 * 例:
 *   "このファイルを見て @src/cli/repl.ts"
 *   → "このファイルを見て\n\n--- @src/cli/repl.ts ---\n<ファイル内容>\n--- end ---"
 *
 *   "@src/cli/ のファイル構成を教えて"
 *   → "\n\n--- @src/cli/ ---\nrepl.ts\nrenderer.ts\ninput-resolver.ts\n--- end ---\n のファイル構成を教えて"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";

/** @mention にマッチする正規表現。@ の直後に . / または英数字で始まるパスを検出 */
const AT_MENTION_RE = /(?:^|\s)@((?:\.{1,2}\/|[a-zA-Z0-9_])[^\s]*)/g;

export interface ResolvedMention {
  /** 元のマッチ文字列 (例: "@src/cli/repl.ts") */
  original: string;
  /** 解決された絶対パス */
  absolutePath: string;
  /** ファイルかディレクトリか */
  type: "file" | "directory" | "not_found";
  /** 展開されたコンテンツ */
  content: string;
}

/**
 * ユーザー入力中の @path 参照をすべて解決して展開済みテキストを返す。
 * 見つからないパスはそのまま残す。
 */
export function resolveAtMentions(
  input: string,
  cwd: string = process.cwd(),
): { resolved: string; mentions: ResolvedMention[] } {
  const mentions: ResolvedMention[] = [];
  const seen = new Set<string>();

  // まず全メンションを収集
  let match: RegExpExecArray | null;
  const regex = new RegExp(AT_MENTION_RE.source, AT_MENTION_RE.flags);
  while ((match = regex.exec(input)) !== null) {
    const rawPath = match[1];
    if (seen.has(rawPath)) continue;
    seen.add(rawPath);

    const absolutePath = path.resolve(cwd, rawPath);
    const mention = resolveSingleMention(rawPath, absolutePath);
    mentions.push(mention);
  }

  if (mentions.length === 0) {
    return { resolved: input, mentions };
  }

  // テキスト末尾にファイル内容を付与する形式（Claude Code方式）
  let resolved = input;
  const attachments: string[] = [];

  for (const m of mentions) {
    if (m.type === "not_found") {
      // 見つからない場合はそのまま残す（LLMに「見つかりませんでした」は伝えない）
      continue;
    }

    // 元の @path をテキストから除去 (元テキストは読みづらくなるだけ)
    // → 残すほうが自然。ユーザーが「@repl.ts を修正して」と言ったら、その文脈は残す
    attachments.push(formatAttachment(m));
  }

  if (attachments.length > 0) {
    resolved = resolved + "\n\n" + attachments.join("\n\n");
  }

  return { resolved, mentions };
}

function resolveSingleMention(rawPath: string, absolutePath: string): ResolvedMention {
  try {
    const stat = fs.statSync(absolutePath);

    if (stat.isFile()) {
      const content = readFileSafe(absolutePath);
      return {
        original: `@${rawPath}`,
        absolutePath,
        type: "file",
        content,
      };
    }

    if (stat.isDirectory()) {
      const entries = readDirectorySafe(absolutePath);
      return {
        original: `@${rawPath}`,
        absolutePath,
        type: "directory",
        content: entries,
      };
    }
  } catch {
    // ファイルが見つからない
  }

  return {
    original: `@${rawPath}`,
    absolutePath,
    type: "not_found",
    content: "",
  };
}

function readFileSafe(filePath: string, maxBytes: number = 100_000): string {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      // 大きすぎるファイルは先頭だけ読む
      const buf = Buffer.alloc(maxBytes);
      const fd = fs.openSync(filePath, "r");
      fs.readSync(fd, buf, 0, maxBytes, 0);
      fs.closeSync(fd);
      const truncated = buf.toString("utf-8");
      return truncated + `\n\n... (${(stat.size / 1024).toFixed(0)}KB — 先頭${(maxBytes / 1024).toFixed(0)}KBのみ表示)`;
    }
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return `(読み取りエラー: ${e instanceof Error ? e.message : String(e)})`;
  }
}

function readDirectorySafe(dirPath: string, maxEntries: number = 100): string {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const lines: string[] = [];

    // ソート: ディレクトリ優先 → ファイル
    const sorted = entries
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of sorted.slice(0, maxEntries)) {
      const suffix = entry.isDirectory() ? "/" : "";
      lines.push(`  ${entry.name}${suffix}`);
    }

    if (sorted.length > maxEntries) {
      lines.push(`  ... (他 ${sorted.length - maxEntries} 件)`);
    }

    return lines.join("\n");
  } catch (e) {
    return `(読み取りエラー: ${e instanceof Error ? e.message : String(e)})`;
  }
}

function formatAttachment(mention: ResolvedMention): string {
  const label = mention.type === "file" ? "File" : "Directory";
  return `--- ${label}: ${mention.original} ---\n${mention.content}\n--- end ---`;
}

/**
 * @メンションが含まれている場合にユーザーへフィードバックを表示する
 */
export function printMentionFeedback(mentions: ResolvedMention[]): void {
  for (const m of mentions) {
    if (m.type === "file") {
      console.log(chalk.dim(`  📎 ${m.original} (file)`));
    } else if (m.type === "directory") {
      console.log(chalk.dim(`  📂 ${m.original} (directory)`));
    } else {
      console.log(chalk.yellow(`  ⚠ ${m.original} が見つかりません`));
    }
  }
}
