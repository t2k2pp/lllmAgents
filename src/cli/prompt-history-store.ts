import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 入力欄の ↑↓ 履歴を作業フォルダ単位で永続化する (docs/prompt-history-resume.md)。
 *
 * Claude Code の ~/.claude/history.jsonl と同じ考え方で、 確定した入力を 1 行 1 JSON で
 * 追記し、 起動時は同じ作業フォルダの分だけを読み戻す。 session には紐付けないので、
 * resume の有無に関わらず前回までの入力を呼び出せる。
 */

export const PROMPT_HISTORY_FILE = path.join(os.homedir(), ".localllm", "history.jsonl");
/** 入力欄へ読み込む件数の上限 (新しい側を残す)。 ファイル自体は削らない。 */
export const MAX_LOADED_PROMPT_HISTORY = 1000;

interface PromptHistoryEntry {
  display: string;
  project: string;
  timestamp: number;
}

/** Windows はパスの大文字小文字を区別しないため、 比較用キーを正規化する。 */
function projectKey(project: string): string {
  const resolved = path.resolve(project);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface LoadedPromptHistory {
  entries: string[];
  /** JSON として読めず読み飛ばした行数 (呼び出し側で利用者へ知らせる) */
  invalidLines: number;
}

/** 作業フォルダ `project` で過去に確定した入力を古い順に返す。 ファイルが無ければ空。 */
export function loadPromptHistory(
  project: string,
  filePath: string = PROMPT_HISTORY_FILE,
  limit: number = MAX_LOADED_PROMPT_HISTORY,
): LoadedPromptHistory {
  if (!fs.existsSync(filePath)) return { entries: [], invalidLines: 0 };
  const key = projectKey(project);
  const entries: string[] = [];
  let invalidLines = 0;
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<PromptHistoryEntry>;
      if (typeof parsed.display !== "string" || typeof parsed.project !== "string") {
        invalidLines++;
        continue;
      }
      if (projectKey(parsed.project) === key) entries.push(parsed.display);
    } catch {
      invalidLines++;
    }
  }
  return { entries: entries.slice(-limit), invalidLines };
}

/** 確定した入力を 1 件追記する。 */
export function appendPromptHistory(display: string, project: string, filePath: string = PROMPT_HISTORY_FILE): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const entry: PromptHistoryEntry = { display, project: path.resolve(project), timestamp: Date.now() };
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
}
