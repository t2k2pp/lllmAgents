/**
 * ツール呼び出しとエラー結果を画面用にサマリ整形する。
 * 既存のメモリ上データ（toolCall.function.arguments、result.output）を
 * 文字列加工するだけで、追加のLLM呼び出しや I/O は発生しない。
 */

import type { ToolCall } from "../providers/base-provider.js";

const MAX_SUMMARY_LEN = 70;
const MAX_ERROR_TAIL_LINES = 4;
const MAX_ERROR_LINE_LEN = 120;

/** 改行・連続空白を1スペースに畳んで、最大長を超える場合は末尾を省略する */
function flatten(s: string, max: number = MAX_SUMMARY_LEN): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

/** バイト数を人間可読形式に整形 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 絶対パスをCWD相対に縮める（表示幅削減用）。失敗したら元の文字列をそのまま返す */
function shortenPath(p: string): string {
  if (!p) return p;
  try {
    const cwd = process.cwd();
    if (p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[\\/]+/, "");
      return rel || ".";
    }
  } catch { /* ignore */ }
  return p;
}

/**
 * ツール呼び出しの主要引数をサマリ文字列にする。
 * 例: `file_write(src/foo.ts, 1.2KB)` / `bash(npm run build)` / `exit_plan_mode("◯◯を実装…")`
 */
export function formatToolCall(toolCall: ToolCall): string {
  const name = toolCall.function.name;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments ?? "{}");
  } catch {
    return name;
  }

  switch (name) {
    case "file_write": {
      const p = shortenPath((args.file_path ?? args.path ?? "") as string);
      const content = (args.content ?? "") as string;
      const size = Buffer.byteLength(content, "utf-8");
      return `${name}(${flatten(p, 50)}, ${formatBytes(size)})`;
    }
    case "file_read": {
      const p = shortenPath((args.file_path ?? args.path ?? "") as string);
      const extras: string[] = [];
      if (args.offset !== undefined) extras.push(`@${args.offset}`);
      if (args.limit !== undefined) extras.push(`×${args.limit}`);
      const suffix = extras.length > 0 ? ` ${extras.join(" ")}` : "";
      return `${name}(${flatten(p, 55)}${suffix})`;
    }
    case "file_edit": {
      const p = shortenPath((args.file_path ?? args.path ?? "") as string);
      return `${name}(${flatten(p, 60)})`;
    }
    case "bash": {
      const cmd = (args.command ?? "") as string;
      return `${name}(${flatten(cmd, 65)})`;
    }
    case "glob": {
      const pat = (args.pattern ?? "") as string;
      return `${name}(${flatten(pat, 60)})`;
    }
    case "grep": {
      const pat = (args.pattern ?? "") as string;
      const glob = (args.glob ?? "") as string;
      const suffix = glob ? ` in ${flatten(glob, 20)}` : "";
      return `${name}(${flatten(pat, 40)}${suffix})`;
    }
    case "web_fetch": {
      const url = (args.url ?? "") as string;
      return `${name}(${flatten(url, 60)})`;
    }
    case "web_search": {
      const q = (args.query ?? "") as string;
      return `${name}(${flatten(q, 60)})`;
    }
    case "exit_plan_mode": {
      const plan = (args.plan_content ?? args.plan ?? "") as string;
      const firstLine = plan.split("\n").find((l) => l.trim()) ?? "";
      return `${name}("${flatten(firstLine, 55)}")`;
    }
    case "enter_plan_mode":
      return name;
    default: {
      // 未知のツール: 文字列型の最初のキーを表示
      const firstStringKey = Object.keys(args).find((k) => typeof args[k] === "string");
      if (!firstStringKey) return name;
      return `${name}(${flatten(String(args[firstStringKey]), 60)})`;
    }
  }
}

/**
 * ツールエラー結果を整形する。
 * `error` メッセージに加えて、`output`（stderr含む）の末尾数行も表示する。
 * 例: `Exit code: 49 — ⏎ error: cannot find module 'foo'`
 */
export function formatToolError(errorMsg: string | undefined, output: string | undefined): string {
  const err = (errorMsg ?? "").trim();
  const parts: string[] = [];
  if (err) parts.push(err);

  if (output) {
    const lines = output
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim().length > 0);

    // errorMsgに既に含まれている行は除外（重複表示を避ける）
    const uniqueTail = lines.filter((l) => !err.includes(l.trim()));
    const tail = uniqueTail.slice(-MAX_ERROR_TAIL_LINES);
    if (tail.length > 0) {
      const rendered = tail.map((l) => flatten(l, MAX_ERROR_LINE_LEN)).join(" ⏎ ");
      parts.push(rendered);
    }
  }

  return parts.join(" — ");
}
