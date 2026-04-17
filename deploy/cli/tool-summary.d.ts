/**
 * ツール呼び出しとエラー結果を画面用にサマリ整形する。
 * 既存のメモリ上データ（toolCall.function.arguments、result.output）を
 * 文字列加工するだけで、追加のLLM呼び出しや I/O は発生しない。
 */
import type { ToolCall } from "../providers/base-provider.js";
/**
 * ツール呼び出しの主要引数をサマリ文字列にする。
 * 例: `file_write(src/foo.ts, 1.2KB)` / `bash(npm run build)` / `exit_plan_mode("◯◯を実装…")`
 */
export declare function formatToolCall(toolCall: ToolCall): string;
/**
 * ツールエラー結果を整形する。
 * `error` メッセージに加えて、`output`（stderr含む）の末尾数行も表示する。
 * 例: `Exit code: 49 — ⏎ error: cannot find module 'foo'`
 */
export declare function formatToolError(errorMsg: string | undefined, output: string | undefined): string;
//# sourceMappingURL=tool-summary.d.ts.map