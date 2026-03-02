import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const grepTool: ToolHandler = {
  name: "grep",
  definition: {
    type: "function",
    function: {
      name: "grep",
      description: "正規表現パターンでファイル内容を検索します。",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "検索する正規表現パターン",
          },
          path: {
            type: "string",
            description: "検索ディレクトリまたはファイル（省略時はカレントディレクトリ）",
          },
          glob: {
            type: "string",
            description: "ファイルフィルター（例: *.ts, *.py）",
          },
          case_insensitive: {
            type: "boolean",
            description: "大文字小文字を無視（デフォルト: false）",
          },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchPath = path.resolve((params.path as string) ?? process.cwd());
    const fileGlob = params.glob as string | undefined;
    const caseInsensitive = (params.case_insensitive as boolean) ?? false;

    // Try to use ripgrep first, fall back to node-native search
    try {
      const args = ["rg", "--no-heading", "--line-number", "--max-count", "100"];
      if (caseInsensitive) args.push("-i");
      if (fileGlob) args.push("--glob", fileGlob);
      args.push("--", pattern, searchPath);

      const output = execSync(args.join(" "), {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: 30000,
      });
      return { success: true, output: output.trim() || "No matches found." };
    } catch {
      // Fall back to native search
      return nativeGrep(pattern, searchPath, fileGlob, caseInsensitive);
    }
  },
};

function nativeGrep(
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  caseInsensitive: boolean,
): ToolResult {
  const regex = new RegExp(pattern, caseInsensitive ? "gi" : "g");
  const results: string[] = [];
  const maxResults = 100;

  function searchFile(filePath: string): void {
    if (results.length >= maxResults) return;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        if (regex.test(lines[i])) {
          results.push(`${filePath}:${i + 1}:${lines[i]}`);
        }
        regex.lastIndex = 0;
      }
    } catch {
      // Skip unreadable files
    }
  }

  function searchDir(dirPath: string): void {
    if (results.length >= maxResults) return;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          searchDir(fullPath);
        } else if (entry.isFile()) {
          if (fileGlob) {
            const ext = fileGlob.replace("*", "");
            if (!entry.name.endsWith(ext)) continue;
          }
          searchFile(fullPath);
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  const stat = fs.statSync(searchPath);
  if (stat.isFile()) {
    searchFile(searchPath);
  } else {
    searchDir(searchPath);
  }

  return {
    success: true,
    output: results.length > 0 ? results.join("\n") : "No matches found.",
  };
}
