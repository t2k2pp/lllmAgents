import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

/**
 * 書き込み後の構文チェック。エラーがあればメッセージを返す。
 * チェック対象: .js, .mjs, .json
 */
function syntaxCheck(filePath: string, content: string): string | null {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    try {
      JSON.parse(content);
    } catch (e) {
      return `JSON構文エラー: ${(e as Error).message}`;
    }
    return null;
  }

  if (ext === ".js" || ext === ".mjs") {
    try {
      execFileSync(process.execPath, ["--check", filePath], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const stderr = (e as { stderr?: string }).stderr ?? "";
      // node --check の出力からエラー箇所を抽出
      const lines = stderr.split("\n").filter(l => l.trim()).slice(0, 5);
      return `JavaScript構文エラー:\n${lines.join("\n")}`;
    }
    return null;
  }

  return null;
}

/**
 * JS/TS ファイルの export / class / function 宣言を抽出して要約を返す。
 * 後続ファイル作成時にインターフェースを参照できるようにする。
 */
function extractInterfaceSummary(filePath: string, content: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (![".js", ".mjs", ".ts", ".mts", ".jsx", ".tsx"].includes(ext)) return null;

  const signatures: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // export default class/function
    // export class Foo { / export function bar(
    // export const/let/var name =
    // class Foo { (non-export, still useful)
    // function foo( (top-level)
    if (/^export\s+(default\s+)?(class|function|const|let|var|async\s+function)\s/.test(trimmed)) {
      // 関数/クラスのシグネチャ部分だけ抽出（{以降を除去）
      const sig = trimmed.replace(/\{[\s\S]*$/, "").replace(/=[\s\S]*$/, "").trim();
      signatures.push(sig);
    } else if (/^(class|function|async\s+function)\s/.test(trimmed)) {
      const sig = trimmed.replace(/\{[\s\S]*$/, "").trim();
      signatures.push(sig);
    } else if (/^module\.exports\s*=/.test(trimmed)) {
      signatures.push(trimmed.slice(0, 80));
    }
  }

  if (signatures.length === 0) return null;
  // 長すぎる場合は先頭10件に制限
  const limited = signatures.slice(0, 10);
  return limited.join("; ");
}

export const fileWriteTool: ToolHandler = {
  name: "file_write",
  definition: {
    type: "function",
    function: {
      name: "file_write",
      description:
        "ファイルを作成または全体上書きする。親ディレクトリは自動作成。\n" +
        "[使うべき場面] 新規ファイル作成、既存ファイルを大幅に書き換える時 (file_edit が連続失敗した後の復旧含む)。\n" +
        "[使うべきでない] 既存ファイルの一部修正 → file_edit の方がコンテキスト省力。 " +
        "ディレクトリ作成のみ → 空ファイル書き込みより bash mkdir。\n" +
        "[よくある誤用] (1) 既存ファイルを Read せず上書き → 重要部分の喪失。 " +
        "(2) 巨大ファイルを毎回全体書き換え → コンテキスト浪費。一部分は file_edit で。 " +
        "[副次情報] 成功時は bytes/lines/mtime/構文チェック結果を返す。",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "書き込むファイルの絶対パス",
          },
          content: {
            type: "string",
            description: "書き込む内容",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = path.resolve(params.file_path as string);
    const content = params.content as string;

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // diff用: 上書き前の内容を保持
    const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;

    fs.writeFileSync(filePath, content, "utf-8");

    // Phase 5-C1: 副次情報の標準同梱
    const stat = fs.statSync(filePath);
    const bytes = stat.size;
    const mtime = stat.mtime.toISOString();
    const lineCount = content.split("\n").length;
    const mode = oldContent === null ? "created" : "overwritten";
    const meta = `[file_write] ${mode}: ${filePath} | ${bytes} bytes | ${lineCount} lines | mtime=${mtime}`;

    // 構文チェック
    const syntaxError = syntaxCheck(filePath, content);
    if (syntaxError) {
      return {
        success: true,
        output: `${meta}\n⚠ ${syntaxError}\n[次の手] エラー箇所を file_read で確認 → file_edit/file_write で修正。`,
      };
    }

    const summary = extractInterfaceSummary(filePath, content);
    const output = summary
      ? `${meta}\nExports: ${summary}`
      : meta;
    return {
      success: true,
      output,
      userDisplay: {
        type: "write-diff",
        filePath,
        oldContent,
        newContent: content,
      },
    };
  },
};
