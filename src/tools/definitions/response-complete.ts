import type { ToolHandler, ToolResult } from "../tool-registry.js";

/**
 * response_complete: ユーザーへの応答が完了したことを宣言するツール。
 *
 * ハーネスは「自己点検」メッセージを注入してLLMに追加作業の要否を問う。
 * LLMが作業完了と判断したら、このツールを呼ぶことで自己点検ループから抜ける。
 *
 * このツールを呼ばず、かつツールも呼ばずテキスト応答だけを返すと、
 * ハーネスが自己点検を最大3回まで要求する。上限到達でターン終了。
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
        "これを呼ばずテキストのみで返すと、ハーネスは最大3回まで自己点検を要求する。",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "今回のターンで行った作業の要約（1-2文）。ユーザーへの最終メッセージとして表示される。",
          },
        },
        required: ["summary"],
      },
    },
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const summary = (params.summary as string) ?? "";
    return {
      success: true,
      output: `[response_complete] ${summary}`,
    };
  },
};
