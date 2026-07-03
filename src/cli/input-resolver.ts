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

/** @mention にマッチする正規表現。@ の直後に . / または英数字で始まるパスを検出。不正な空白含みパスを避けるため厳密化 */
const AT_MENTION_RE = /(?:^|\s)@((?:\.{1,2}\/|[a-zA-Z0-9_])[a-zA-Z0-9_./\\-]*)/g;

export interface ResolvedMention {
  /** 元のマッチ文字列 (例: "@src/cli/repl.ts") */
  original: string;
  /** 解決された絶対パス */
  absolutePath: string;
  /** ファイルかディレクトリか。画像ファイルの場合は file_image */
  type: "file" | "file_image" | "directory" | "not_found";
  /** 展開されたコンテンツ (テキストまたは画像Base64情報) */
  content: string;
  /** 画像の場合はmime-type */
  mimeType?: string;
}

import type { ContentPart } from "../providers/base-provider.js";

/**
 * ユーザー入力中の @path 参照をすべて解決して展開済みテキスト（または ContentPart配列）を返す。
 * 見つからないパスはそのまま残す。
 */
export function resolveAtMentions(
  input: string,
  cwd: string = process.cwd(),
): { resolved: string | ContentPart[]; mentions: ResolvedMention[] } {
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

  // 画像が含まれているかどうかで戻り値の型（string | ContentPart[]）を変える
  const hasImage = mentions.some((m) => m.type === "file_image");

  if (!hasImage) {
    // 従来のテキストのみの展開（Claude Code方式）
    let resolved = input;
    const attachments: string[] = [];

    for (const m of mentions) {
      if (m.type === "not_found") {
        // @パスが見つからない場合も @ を除去してパスのみ残す（モデルの混乱を防ぐ）
        const rawPath = m.original.slice(1);
        resolved = resolved.split(m.original).join(rawPath);
        continue;
      }

      const rawPath = m.original.slice(1);
      resolved = resolved.split(m.original).join(rawPath);
      attachments.push(formatAttachment(m));
    }

    if (attachments.length > 0) {
      resolved = resolved + "\n\n" + attachments.join("\n\n");
    }

    return { resolved, mentions };
  } else {
    // 画像が含まれる場合は ContentPart[] を構築する
    const parts: ContentPart[] = [];
    let remainingInput = input;

    for (const m of mentions) {
      if (m.type === "not_found") continue;

      // メンションの位置を探して分割
      const idx = remainingInput.indexOf(m.original);
      if (idx !== -1) {
        const textBefore = remainingInput.slice(0, idx);
        if (textBefore.trim()) {
          parts.push({ type: "text", text: textBefore });
        }

        const rawPath = m.original.slice(1);
        if (m.type === "file_image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${m.mimeType};base64,${m.content}` },
          });
          // ファイル名テキストもちょっと挟んでおく
          parts.push({ type: "text", text: ` [Image: ${rawPath}] ` });
        } else {
          // 画像以外のファイル/フォルダをテキストパーツとして追加する
          parts.push({
            type: "text",
            text: `\n\n--- ${m.type === "file" ? "File" : "Directory"}: ${rawPath} ---\n${m.content}\n--- end ---\n`,
          });
        }

        remainingInput = remainingInput.slice(idx + m.original.length);
      }
    }

    if (remainingInput.trim()) {
      parts.push({ type: "text", text: remainingInput });
    }

    // 連続するテキストパーツを結合してきれいに保つ（必要であれば）
    const mergedParts: ContentPart[] = [];
    for (const p of parts) {
      if (p.type === "text") {
        const last = mergedParts[mergedParts.length - 1];
        if (last && last.type === "text" && last.text !== undefined && p.text !== undefined) {
          last.text += p.text;
        } else {
          mergedParts.push({ ...p });
        }
      } else {
        mergedParts.push(p);
      }
    }

    return { resolved: mergedParts, mentions };
  }
}

function resolveSingleMention(rawPath: string, absolutePath: string): ResolvedMention {
  try {
    const stat = fs.statSync(absolutePath);

    if (stat.isFile()) {
      const ext = path.extname(absolutePath).toLowerCase();
      if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
        // 画像はBase64で読む
        const base64 = readFileAsBase64Safe(absolutePath);
        const mimeType = ext === ".jpg" ? "image/jpeg" : `image/${ext.slice(1)}`;
        return {
          original: `@${rawPath}`,
          absolutePath,
          type: "file_image",
          content: base64,
          mimeType,
        };
      }

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

function readFileAsBase64Safe(filePath: string, maxBytes: number = 10 * 1024 * 1024): string {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      return ""; // 10MBを超える画像は無視（エラーで返すより安全）
    }
    return fs.readFileSync(filePath, "base64");
  } catch {
    return "";
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
  const rawPath = mention.original.slice(1);
  return `--- ${label}: ${rawPath} ---\n${mention.content}\n--- end ---`;
}

/**
 * @メンションが含まれている場合にユーザーへフィードバックを表示する
 */
export function printMentionFeedback(mentions: ResolvedMention[]): void {
  for (const m of mentions) {
    if (m.type === "file") {
      console.log(chalk.dim(`  📎 ${m.original} (file)`));
    } else if (m.type === "file_image") {
      console.log(chalk.dim(`  🖼️  ${m.original} (image)`));
    } else if (m.type === "directory") {
      console.log(chalk.dim(`  📂 ${m.original} (directory)`));
    } else {
      console.log(chalk.yellow(`  ⚠ ${m.original} が見つかりません`));
    }
  }
}
