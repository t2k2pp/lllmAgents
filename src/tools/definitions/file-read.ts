import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const fileReadTool: ToolHandler = {
  name: "file_read",
  definition: {
    type: "function",
    function: {
      name: "file_read",
      description:
        "ファイルの内容を行番号付きで読み取る。\n" +
        "[使うべき場面] テキスト/コードファイルの内容確認、既存ファイルの編集前の現状把握。\n" +
        "[使うべきでない] (1) ディレクトリ一覧 → glob を使う。 " +
        "(2) ファイルを書き換える → file_edit/file_write。 " +
        "(3) 大量ファイルの横断調査 → grep。\n" +
        "[よくある誤用] 拡張子の推測 (.txt と思って失敗) → 失敗時のエラーで近隣候補を提示するのでそれを参考に。",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "読み取るファイルの絶対パス",
          },
          offset: {
            type: "number",
            description: "読み取り開始行番号 (1-based)。省略時は先頭から。",
          },
          limit: {
            type: "number",
            description: "読み取る行数。省略時は最大2000行。",
          },
        },
        required: ["file_path"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = path.resolve(params.file_path as string);
    const offset = (params.offset as number) ?? 1;
    const limit = (params.limit as number) ?? 2000;

    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        output: "",
        error: buildNotFoundError(filePath),
      };
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      // ディレクトリの場合は中身ヒントを返す
      const hint = listDirShort(filePath);
      return {
        success: false,
        output: "",
        error: `Path is a directory: ${filePath}\n${hint}\n[次の手] ファイルを指定して再実行、または glob で絞り込み。`,
      };
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;
    const startIdx = Math.max(0, offset - 1);
    const endIdx = Math.min(totalLines, startIdx + limit);
    const selected = lines.slice(startIdx, endIdx);

    const numbered = selected
      .map((line, i) => {
        const lineNum = String(startIdx + i + 1).padStart(5, " ");
        const truncated = line.length > 2000 ? line.slice(0, 2000) + "..." : line;
        return `${lineNum}\t${truncated}`;
      })
      .join("\n");

    // 観察可能性: ファイル全体情報を末尾に付ける (Phase 5-C)
    const truncatedNote =
      endIdx < totalLines
        ? `\n[file_read] ${endIdx}/${totalLines} 行表示 (残り ${totalLines - endIdx} 行)。続きは offset=${endIdx + 1} で読み取り。`
        : `\n[file_read] 全 ${totalLines} 行を表示完了。`;

    return { success: true, output: numbered + truncatedNote };
  },
};

/**
 * File not found 時の自助情報生成 (Phase 5-A1)
 *  - 同 stem の他拡張子候補
 *  - 親ディレクトリの軽量 ls (上位 8 件)
 *  - 名前が似ているファイル (大文字小文字違い等)
 */
function buildNotFoundError(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const stem = base.replace(/\.[^.]+$/, "");
  const lines: string[] = [`File not found: ${filePath}`];

  if (!fs.existsSync(dir)) {
    // 親 dir 自体が無い → 一段上を見せる
    const parentDir = path.dirname(dir);
    if (fs.existsSync(parentDir)) {
      lines.push(`[親ディレクトリも存在しない] ${dir}`);
      const parentList = listDirShort(parentDir);
      lines.push(`[ひとつ上 (${parentDir}) の中身]\n${parentList}`);
    } else {
      lines.push(`[親ディレクトリも存在しない] ${dir}`);
    }
    lines.push(`[次の手] パスのタイポを疑う。bash で 'find <root> -name "${base}"' を試す、または glob で広く探す。`);
    return lines.join("\n");
  }

  // 同 stem の他拡張子候補
  try {
    const entries = fs.readdirSync(dir);
    const stemMatches = entries.filter((e) => {
      const eStem = e.replace(/\.[^.]+$/, "");
      return eStem === stem && e !== base;
    });
    if (stemMatches.length > 0) {
      lines.push(
        `[同名・別拡張子の候補あり] ${stemMatches.map((e) => path.join(dir, e)).join(", ")}`,
      );
      lines.push(`[次の手] 上記いずれかのパスで file_read を再試行。`);
      return lines.join("\n");
    }

    // 大文字小文字違い等
    const lowerBase = base.toLowerCase();
    const caseMatches = entries.filter((e) => e.toLowerCase() === lowerBase);
    if (caseMatches.length > 0) {
      lines.push(
        `[大文字小文字違いの候補] ${caseMatches.map((e) => path.join(dir, e)).join(", ")}`,
      );
      return lines.join("\n");
    }

    // 部分一致候補 (stem 一部一致)
    const partial = entries.filter((e) => {
      const eStem = e.replace(/\.[^.]+$/, "").toLowerCase();
      return stem.length >= 3 && eStem.includes(stem.toLowerCase().slice(0, Math.min(stem.length, 6)));
    });
    if (partial.length > 0 && partial.length <= 6) {
      lines.push(
        `[名前が似た候補] ${partial.map((e) => path.join(dir, e)).join(", ")}`,
      );
    }

    lines.push(`[親ディレクトリ ${dir} の中身]\n${listDirShort(dir)}`);
    lines.push(`[次の手] (1) 上記の候補で再試行  (2) glob で広く探索  (3) bash で find を実行。`);
  } catch {
    // ディレクトリ走査失敗 (権限等)
    lines.push(`[ディレクトリ走査に失敗 — 権限を確認]`);
  }

  return lines.join("\n");
}

/** 軽量 ls (最大8件、ファイル/ディレクトリの区別付き) */
function listDirShort(dir: string): string {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 8);
    const formatted = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("  ");
    const total = fs.readdirSync(dir).length;
    return total > 8 ? `${formatted}  ... (計 ${total} 件)` : formatted;
  } catch {
    return "(走査失敗)";
  }
}
