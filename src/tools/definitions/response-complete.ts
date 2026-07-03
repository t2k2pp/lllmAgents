import type { ToolHandler, ToolResult } from "../tool-registry.js";
import { getTodos, formatTodos } from "./todo-write.js";

/**
 * response_complete: ユーザーへの応答が完了したことを宣言するツール。
 *
 * ハーネスは「自己点検」メッセージを注入してLLMに追加作業の要否を問う。
 * LLMが作業完了と判断したら、このツールを呼ぶことで自己点検ループから抜ける。
 *
 * このツールを呼ばず、かつツールも呼ばずテキスト応答だけを返すと、
 * ハーネスが自己点検を最大3回まで要求する。上限到達でターン終了。
 *
 * Phase 5-O2: Acceptance Checklist (todo_write) に未完了項目があれば警告を返し、
 * 完了報告をブロック。 「ファイル存在 = 完了」 のような薄い完了報告を防ぐ。
 */
export const responseCompleteTool: ToolHandler = {
  name: "response_complete",
  definition: {
    type: "function",
    function: {
      name: "response_complete",
      description:
        "ユーザーの依頼を完了した、または追加作業が不要と判断した場合に呼ぶ。" +
        "自己点検メッセージ（[自己点検 N/3]）への応答として、作業完了を宣言するためのツール。" +
        "これを呼ばずテキストのみで返すと、ハーネスは最大3回まで自己点検を要求する。" +
        "[ゲート] todo_append で立てた完了条件リストに未完了項目があると警告を返す。 " +
        "force=true で強制完了可能だがその場合「未完了で完了報告した」 ことが ユーザーへの summary に反映される。",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "今回のターンで行った作業の要約（1-2文）。ユーザーへの最終メッセージとして表示される。",
          },
          force: {
            type: "boolean",
            description:
              "完了条件リストが未消化でも強制的に完了報告する場合 true。 ユーザーが部分完成を許容している場合などに使用",
          },
        },
        required: ["summary"],
      },
    },
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const summary = (params.summary as string) ?? "";
    const force = (params.force as boolean) ?? false;

    // Phase 5-O2: Acceptance Checklist のゲートチェック
    const todos = getTodos();
    const open = todos.filter((t) => t.status !== "completed");
    if (todos.length > 0 && open.length > 0 && !force) {
      // 未完了 todo があれば警告を返して、 LLM が再考できるようにする
      return {
        success: false,
        output: "",
        error:
          `[完了条件リスト 未消化] todo_append で立てた ${todos.length} 項目中 ${open.length} 項目が未完了です。\n` +
          `${formatTodos()}\n` +
          `\n[次の手] (1) 残項目を実装/検証して todo を completed にする  (2) 部分完成で報告するなら force=true で再呼び出し (理由を summary に明記)。\n` +
          `[原則] 「ファイル存在 = 完了」 のような薄い完了報告は禁止。 standard 以上では完了条件を満たしてから完了とする。`,
      };
    }

    const meta =
      todos.length > 0
        ? force && open.length > 0
          ? `[response_complete] (force, ${open.length}/${todos.length} 未完) ${summary}`
          : `[response_complete] (${todos.length}/${todos.length} ✓) ${summary}`
        : `[response_complete] ${summary}`;
    return { success: true, output: meta };
  },
};
