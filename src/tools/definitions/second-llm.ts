import type { ToolHandler, ToolResult } from "../tool-registry.js";
import type { SecondLLMManager } from "../../second-llm/second-llm-manager.js";

let secondLLMManager: SecondLLMManager | null = null;

export function setSecondLLMManager(manager: SecondLLMManager): void {
  secondLLMManager = manager;
}

/**
 * Phase 5 第4ラウンド (課題Q1): セカンドLLM 失敗のエラーカテゴリを判別。
 * カテゴリごとに対処手順が異なるため、 ハーネス側で 3 択提示するための情報源。
 */
type SecondLLMFailureCategory =
  | "RATE_LIMIT"   // 429 / Quota exceeded
  | "AUTH"         // 401 / 403 / API key invalid
  | "NOT_FOUND"    // 404 / Resource not found / model not deployed
  | "BAD_REQUEST"  // 400 / 422 / 不正なリクエスト
  | "SERVER_ERROR" // 5xx
  | "TIMEOUT"      // ECONNABORTED, ETIMEDOUT
  | "NETWORK"      // ECONNREFUSED, ENOTFOUND
  | "UNKNOWN";

function classifySecondLLMError(e: unknown): SecondLLMFailureCategory {
  const s = String(e);
  if (/HTTP 429|RateLimit|Rate limit|TPM|RPM|Quota.*exceed/i.test(s)) return "RATE_LIMIT";
  if (/HTTP 40[13]|Unauthorized|Forbidden|invalid api key|invalid_api_key/i.test(s)) return "AUTH";
  if (/HTTP 404|Resource not found|deployment.*not found|model.*not found/i.test(s)) return "NOT_FOUND";
  if (/HTTP 4(00|22)|Bad Request|invalid_request|invalid argument/i.test(s)) return "BAD_REQUEST";
  if (/HTTP 5\d\d|server error|service unavailable|bad gateway/i.test(s)) return "SERVER_ERROR";
  if (/timeout|ECONNABORTED|ETIMEDOUT|aborted/i.test(s)) return "TIMEOUT";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(s)) return "NETWORK";
  return "UNKNOWN";
}

/** カテゴリごとの対処ガイダンス (tool 自身の声で同梱、 ハーネス後付けではない) */
function categoryGuidance(category: SecondLLMFailureCategory): string {
  switch (category) {
    case "RATE_LIMIT":
      return "TPM/RPM クォータ超過。 数十秒〜数分待ってリトライが第一選択。 連続発生なら別モデルへの切替を検討。";
    case "AUTH":
      return "API Key が無効/期限切れ/権限不足。 /second status で現在の保存形式を確認、 /second setup azure-* で再設定。";
    case "NOT_FOUND":
      return "endpoint URL の path / deployment 名 / model 名が不一致。 Azure Portal で正確な値を確認、 /second setup で再設定。";
    case "BAD_REQUEST":
      return "リクエスト形式の不適合。 model 名や endpoint パスが古い API バージョンの可能性。 /second status で確認。";
    case "SERVER_ERROR":
      return "サーバ側障害。 数分待ってリトライ。 継続するなら Azure 側の障害を疑う。";
    case "TIMEOUT":
      return "応答タイムアウト。 大きいプロンプトなら分割、 短時間ならリトライ。";
    case "NETWORK":
      return "ネットワーク到達不能。 endpoint URL のホスト名/プロキシを確認。";
    default:
      return "原因不明。 エラー本文を確認して /second status で設定確認。";
  }
}

/**
 * ツール実行が失敗した時の error 文字列を組み立てる (tool 自身の声)。
 *
 * Phase 5 第9ラウンド (Gate 3): ユーザーが委任を明示している場合に備え、 ガイダンスを
 * 同梱する。 これは「ハーネス後付け警告」 (Round 8 で全廃) ではなく、 **tool 自身の声**:
 * 「私 (second_llm_agent) は失敗した。 こういう原因が考えられる。 こう対処を」 という
 * tool 内エラー応答。 file_read の自助エラー (候補/親dir 提示) と同じ性格。
 *
 * 補足: ユーザーが「セカンドLLMで」 等の委任意図を示している場合、 agent-loop の Gate 2
 * (delegationLockUntil) が file_write/file_edit を 2 分間 tool 層で拒否する。 ここでの
 * 文言はあくまで model への気づきの提供で、 実際の hard barrier は agent-loop 側。
 */
function buildSecondLLMFailureError(toolName: string, e: unknown): string {
  const category = classifySecondLLMError(e);
  const marker = `[セカンドLLM失敗:${category}]`;
  const guidance = categoryGuidance(category);
  return (
    `${marker} ${toolName} の呼び出しが失敗: ${String(e)}\n` +
    `[原因] ${guidance}\n` +
    `[対処] ユーザーが委任を明示している場合は、 ask_user で 3 択を提示すること:\n` +
    `  (a) リトライする (${category === "RATE_LIMIT" || category === "TIMEOUT" || category === "SERVER_ERROR" ? "推奨" : "効果薄"})\n` +
    `  (b) メイン側で実行 (ユーザーが許可する場合のみ)\n` +
    `  (c) モデル設定を見直す (/second status / /second setup azure-*)\n` +
    `[禁忌] 独断でメイン側にフォールバック (= file_write/file_edit を直接呼ぶ) は意図違反。 委任意図がある状況ではハーネス側の hard gate で拒否される。`
  );
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
      return {
        success: false,
        output: "",
        error: buildSecondLLMFailureError("second_llm_consult", e),
      };
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
          reason: {
            type: "string",
            enum: ["context_protection", "parallelism", "specialty"],
            description:
              "委任の理由 (3 条件のいずれか)。 [Phase 5-B3 ハードガード] " +
              "context_protection=大量ファイル読込で本セッションのコンテキスト消費を避ける / " +
              "parallelism=独立した複数タスクを同時に走らせる / " +
              "specialty=セカンドLLMの特性 (高速・別モデル強み等) が活きるタスク。 " +
              "3 条件のいずれにも該当しない委任は禁止 (= インライン処理が適切)。",
          },
        },
        required: ["task", "reason"],
      },
    }
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!secondLLMManager || !secondLLMManager.isAvailable()) {
      return { success: false, output: "", error: "Error: Second LLM is not configured or not enabled." };
    }
    // Phase 5-B3: 委任理由ハードガード — 3 条件のいずれかでなければ拒否
    const VALID_REASONS = ["context_protection", "parallelism", "specialty"] as const;
    const reason = params.reason as string | undefined;
    if (!reason || !VALID_REASONS.includes(reason as typeof VALID_REASONS[number])) {
      return {
        success: false,
        output: "",
        error:
          `[Phase 5-B3 ハードガード] second_llm_agent の reason 引数は必須で、 ` +
          `次のいずれかでなければなりません: ${VALID_REASONS.join(" / ")}\n` +
          `→ context_protection (大量読込でコンテキスト消費を避ける) / parallelism (独立並列タスク) / specialty (セカンドLLMの特性が活きる)\n` +
          `3 条件いずれにも該当しないなら、 インラインで処理してください (file_read / bash / glob / grep などで十分なはず)。`,
      };
    }
    const task = params.task as string;
    try {
      const result = await secondLLMManager.runAsAgent(task);
      return { success: true, output: result };
    } catch (e) {
      return {
        success: false,
        output: "",
        error: buildSecondLLMFailureError("second_llm_agent", e),
      };
    }
  },
};
