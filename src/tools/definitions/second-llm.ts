import type { ToolHandler, ToolResult } from "../tool-registry.js";
import type { SecondLLMManager } from "../../second-llm/second-llm-manager.js";

let secondLLMManager: SecondLLMManager | null = null;

export function setSecondLLMManager(manager: SecondLLMManager): void {
  secondLLMManager = manager;
}

export const secondLLMConsultTool: ToolHandler = {
  name: "second_llm_consult",
  definition: {
    type: "function",
    function: {
      name: "second_llm_consult",
      description:
        "セカンドLLM に単発の質問・相談を投げる。ツール実行は伴わない。\n" +
        "[使うべき場面] (1) コードレビュー・方針の壁打ち・別視点が欲しい時。 " +
        "(2) 大きな調査結果や長文の要約 (コンテキスト節約)。 " +
        "(3) セカンドLLM の特性 (高速・専門性等) が活きる単発推論。\n" +
        "[使うべきでない] (1) ファイル操作やコマンド実行が必要 → second_llm_agent。 " +
        "(2) 自分でも数秒で答えられる些末な確認 → 自分で考える方が速い。 " +
        "(3) 多段階の作業 → 1回の consult で済まないなら最初から second_llm_agent。\n" +
        "[よくある誤用] (a) コンテキストを渡し忘れ → セカンドLLMには会話履歴が無い。背景を prompt に同梱。 " +
        "(b) 同じ質問を細切れに何度も投げる → まとめて1回で。",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "セカンドLLMへの質問。背景・コンテキストを具体的に含めること。",
          },
        },
        required: ["prompt"],
      },
    }
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!secondLLMManager || !secondLLMManager.isAvailable()) {
      return { success: false, output: "", error: "Error: Second LLM is not configured or not enabled." };
    }
    const prompt = params.prompt as string;
    try {
      const result = await secondLLMManager.consult(prompt);
      return { success: true, output: result };
    } catch (e) {
      return { success: false, output: "", error: `Error from Second LLM: ${String(e)}` };
    }
  },
};

export const secondLLMAgentTool: ToolHandler = {
  name: "second_llm_agent",
  definition: {
    type: "function",
    function: {
      name: "second_llm_agent",
      description:
        "セカンドLLM をサブエージェント化して独立タスクを委任する (ツール実行可)。\n" +
        "[委任の3条件] 以下のいずれかが満たされる時に使う:\n" +
        "  (a) コンテキスト保護: 大量ファイル読込で本セッションのコンテキストを消費したくない。\n" +
        "  (b) 並列性: 複数の独立調査を同時に走らせたい。\n" +
        "  (c) 専門性: セカンドLLMの特性 (例: 高速 / 別モデル強み) が活きるタスク。\n" +
        "[使うべきでない] (1) 自分が直接やった方が早いタスク。 " +
        "(2) 数秒で済む単純操作 → bash や file_read で直接。 " +
        "(3) 連続委任 (同じファイルへの修正を細切れに3回以上委任) → 修正リストを集約して1回で渡す。\n" +
        "[重要原則] 一度委任したら **そのタスクの完成までを 1 回の委任内で完結** させる。" +
        "完成物に対する細かな修正を別の second_llm_agent 呼び出しに分けると、コンテキストが分散して非効率。\n" +
        "[よくある誤用] (a) 1500行のコード生成→修正指示→修正指示と細切れ委任 (= 丸投げ連鎖)。 " +
        "(b) ファイル探索のような軽作業を毎回委任 → glob/bash で十分。 " +
        "(c) 委任先での状態 (ファイル作成等) を自分で検証しない → 委任結果に対し file_read 等で確認を。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "セカンドLLMに実行させるタスクの詳細な説明。必要なコンテキスト・制約を全て含めること。",
          },
        },
        required: ["task"],
      },
    }
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!secondLLMManager || !secondLLMManager.isAvailable()) {
      return { success: false, output: "", error: "Error: Second LLM is not configured or not enabled." };
    }
    const task = params.task as string;
    try {
      const result = await secondLLMManager.runAsAgent(task);
      return { success: true, output: result };
    } catch (e) {
      return { success: false, output: "", error: `Error from Second LLM: ${String(e)}` };
    }
  },
};
