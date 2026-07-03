import { glob as globFn } from "glob";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const globTool: ToolHandler = {
  name: "glob",
  definition: {
    type: "function",
    function: {
      name: "glob",
      description:
        "glob パターンでファイルパスを検索する。\n" +
        "[使うべき場面] ファイル名や拡張子で絞り込んだ列挙。例:\n" +
        '  pattern="**/*.ts"            (全 ts ファイル)\n' +
        '  pattern="src/**/test*.ts"    (src/ 配下の test* で始まる ts)\n' +
        '  pattern="**/{*.tsx,*.jsx}"   (拡張子 OR)\n' +
        '  pattern="docs/**/2026-*.md"  (前方一致と階層)\n' +
        "[使うべきでない] (1) ファイル中身検索 → grep。 " +
        "(2) 単一ファイル読込 → file_read。 " +
        "(3) コマンド実行 → bash。\n" +
        "[よくある誤用] (a) 拡張子省略 (`*.txt` だが実態は `*.html`)。 " +
        "(b) ルート相対と絶対パスの混同 — path 引数で起点を明示。 " +
        "(c) `**` を 1 階層しか掘らない誤解 — `**` は再帰、`*` は単階層。",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "glob パターン (例: '**/*.ts', 'src/**/*.tsx', '**/{*.json,*.yaml}')",
          },
          path: {
            type: "string",
            description: "検索起点ディレクトリ。省略時はカレントディレクトリ。",
          },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const cwd = (params.path as string) ?? process.cwd();
    const cwdResolved = path.resolve(cwd);

    try {
      const matches = await globFn(pattern, {
        cwd: cwdResolved,
        absolute: true,
        nodir: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
      });

      if (matches.length === 0) {
        // Phase 5-E1: ヒット 0 時は親ディレクトリの軽量 ls と pattern ヒントを併記
        const hint = buildNoMatchHint(pattern, cwdResolved);
        return { success: true, output: `No matching files for pattern: ${pattern} (cwd: ${cwdResolved})\n${hint}` };
      }

      const output = matches.slice(0, 200).join("\n");
      const suffix = matches.length > 200 ? `\n... and ${matches.length - 200} more` : "";
      const meta = `\n[glob] ${matches.length} 件ヒット (cwd: ${cwdResolved})`;
      return { success: true, output: output + suffix + meta };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};

/**
 * Phase 5-E1: ヒット 0 件時の自助情報。
 * - 検索した cwd の中身一覧 (上位 12 件、ディレクトリ優先)
 * - pattern の主要拡張子を抽出して、cwd 配下に存在する拡張子集合を提示
 * - よくあるリカバリ手段の提示
 */
function buildNoMatchHint(pattern: string, cwd: string): string {
  const lines: string[] = [];

  if (!fs.existsSync(cwd)) {
    lines.push(`[起点ディレクトリが存在しない] ${cwd}`);
    lines.push(`[次の手] path 引数の typo を確認。bash で 'pwd' / 'ls <候補>' で位置確認。`);
    return lines.join("\n");
  }

  // cwd の浅い ls
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name + "/");
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const summary: string[] = [];
    if (dirs.length > 0)
      summary.push(`dirs: ${dirs.slice(0, 8).join("  ")}${dirs.length > 8 ? `  ... (計 ${dirs.length} dirs)` : ""}`);
    if (files.length > 0)
      summary.push(
        `files: ${files.slice(0, 8).join("  ")}${files.length > 8 ? `  ... (計 ${files.length} files)` : ""}`,
      );
    if (summary.length > 0) {
      lines.push(`[起点 ${cwd} の浅い中身]`);
      summary.forEach((s) => lines.push("  " + s));
    } else {
      lines.push(`[起点 ${cwd} は空ディレクトリ]`);
    }

    // pattern の拡張子と実在拡張子の比較
    const patExtMatch = pattern.match(/\.([a-zA-Z0-9]+)(?:[},\s]|$)/);
    if (patExtMatch) {
      const patExt = patExtMatch[1].toLowerCase();
      // cwd 配下の浅い+1階層分の拡張子集合を取る (再帰は重いので 2 階層まで)
      const extSet = collectExts(cwd, 2);
      if (!extSet.has(patExt) && extSet.size > 0) {
        const sample = Array.from(extSet).slice(0, 8).join(", ");
        lines.push(`[警告] pattern が要求する拡張子 .${patExt} は起点配下に存在しないかも。実在拡張子例: ${sample}`);
      }
    }
  } catch {
    lines.push(`[起点ディレクトリ走査失敗 — 権限を確認]`);
  }

  lines.push(
    `[次の手] (1) pattern の拡張子・前方一致を見直す  ` +
      `(2) より広く: pattern="**/*"  ` +
      `(3) bash で 'find <root> -name "<キーワード>*"' を試す`,
  );
  return lines.join("\n");
}

/** 浅い再帰で拡張子集合を取得 (depth まで)。重くなりすぎないよう 200 ファイル上限。 */
function collectExts(dir: string, depth: number): Set<string> {
  const set = new Set<string>();
  let count = 0;
  function walk(d: string, remaining: number) {
    if (remaining < 0 || count > 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count > 200) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      if (e.isFile()) {
        const m = e.name.match(/\.([a-zA-Z0-9]+)$/);
        if (m) set.add(m[1].toLowerCase());
        count++;
      } else if (e.isDirectory() && remaining > 0) {
        walk(path.join(d, e.name), remaining - 1);
      }
    }
  }
  walk(dir, depth);
  return set;
}
