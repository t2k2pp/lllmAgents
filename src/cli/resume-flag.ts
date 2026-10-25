import type { SessionData } from "../agent/session-manager.js";

/**
 * 起動フラグ `--resume` の解釈 (docs/todo-legacy-ways-cleanup.md 決定 C2)。
 *
 * REPL の `/resume <id>` / `/resume latest` と同じ意味・同じ書き方に揃える。
 *   --resume <id>     → 指定 ID のセッションを復元
 *   --resume latest   → 最新セッションを復元
 * REPL の引数なし `/resume` は picker を開くが、 起動時は REPL 開始前で picker を出せないため
 * 引数なし `--resume` は使い方エラーにする (黙って新規セッションで始めない)。
 * 見つからない ID・保存セッション無しも同様にエラーとして知らせ、 終了コード 1 で終わる。
 */
export type ResumeFlag =
  | { kind: "none" }
  | { kind: "latest" }
  | { kind: "id"; id: string }
  | { kind: "error"; message: string };

export const RESUME_FLAG_USAGE = [
  "使い方:",
  "  --resume <session-id>   指定したセッションを復元して起動",
  "  --resume latest         一番新しいセッションを復元して起動",
  "セッション ID は REPL の /resume list で確認できます。",
].join("\n");

export function parseResumeFlag(args: readonly string[]): ResumeFlag {
  const indexes = args.flatMap((a, i) => (a === "--resume" ? [i] : []));
  if (indexes.length === 0) return { kind: "none" };
  if (indexes.length > 1) {
    return { kind: "error", message: "--resume は 1 回だけ指定してください。" };
  }
  const value = args[indexes[0] + 1];
  if (value === undefined || value.startsWith("-") || value.trim() === "") {
    return { kind: "error", message: "--resume には復元するセッション ID か latest を指定してください。" };
  }
  if (value.toLowerCase() === "latest") return { kind: "latest" };
  return { kind: "id", id: value };
}

export interface ResumeFlagDeps {
  loadSession: (id: string) => SessionData | null;
  getLatestSession: () => SessionData | null;
}

export type ResumeResolution =
  | { kind: "none" }
  | { kind: "session"; session: SessionData }
  | { kind: "error"; message: string };

/** 解釈済みフラグから復元するセッションを読み込む。 見つからなければエラーを返す。 */
export function resolveResumeFlag(flag: ResumeFlag, deps: ResumeFlagDeps): ResumeResolution {
  switch (flag.kind) {
    case "none":
      return { kind: "none" };
    case "error":
      return { kind: "error", message: `${flag.message}\n${RESUME_FLAG_USAGE}` };
    case "latest": {
      const latest = deps.getLatestSession();
      if (!latest) {
        return {
          kind: "error",
          message:
            "--resume latest: 復元できる保存セッションがありません。\n" +
            "新しいセッションで始める場合は --resume を付けずに起動してください。",
        };
      }
      return { kind: "session", session: latest };
    }
    case "id": {
      const session = deps.loadSession(flag.id);
      if (!session) {
        return {
          kind: "error",
          message:
            `--resume: セッション ${flag.id} が見つかりません。\n` +
            "REPL の /resume list で一覧を確認するか、 --resume latest で最新を復元してください。",
        };
      }
      return { kind: "session", session };
    }
  }
}
