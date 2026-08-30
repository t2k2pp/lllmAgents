import type { ToolHandler, ToolResult, ToolExecutionContext } from "../tool-registry.js";
import type { SecondLLMManager } from "../../second-llm/second-llm-manager.js";
import { ROOT_ANCESTORS } from "../../agent/delegation-context.js";

let secondLLMManager: SecondLLMManager | null = null;

export function setSecondLLMManager(manager: SecondLLMManager): void {
  secondLLMManager = manager;
}

/**
 * Phase 5 第4ラウンド (課題Q1): セカンドLLM 失敗のエラーカテゴリを判別。
 * カテゴリごとに対処手順が異なるため、 ハーネス側で 3 択提示するための情報源。
 */
type SecondLLMFailureCategory =
  | "RATE_LIMIT" // 429 / Quota exceeded
  | "AUTH" // 401 / 403 / API key invalid
  | "NOT_FOUND" // 404 / Resource not found / model not deployed
  | "BAD_REQUEST" // 400 / 422 / 不正なリクエスト
  | "SERVER_ERROR" // 5xx
  | "TIMEOUT" // ECONNABORTED, ETIMEDOUT
  | "NETWORK" // ECONNREFUSED, ENOTFOUND
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
  // ID-001 §2 (2026-04-30): system-prompt から「ユーザー指示の経路を勝手に変えない」 セクションを
  // 削除した代わりに、 ここで明示する (= ユーザー委任意図がある場合の対処の核)。
  return (
    `${marker} ${toolName} の呼び出しが失敗: ${String(e)}\n` +
    `[原因] ${guidance}\n` +
    `[原則] ユーザーが特定の経路 (例: 「セカンドLLM で」「task で並列に」「Kimi に頼んで」 等) を **明示指示** している場合、 ` +
    `失敗してもメインが独断で経路変更 (= 自分でやる) してはいけない。 必ず ask_user で 3 択を提示:\n` +
    `  (a) リトライする (${category === "RATE_LIMIT" || category === "TIMEOUT" || category === "SERVER_ERROR" ? "推奨" : "効果薄"})\n` +
    `  (b) メイン側で実行 (ユーザーが許可する場合のみ)\n` +
    `  (c) モデル設定を見直す (/second status / /second setup azure-* 等)\n` +
    `[禁止] 経路を自分で選んだ場合も、失敗をメイン側の実行や別モデルで自動代替してはいけない。 ` +
    `同じ経路を再試行するか、経路変更前に ask_user で許可を得る。`
  );
}

export const secondLLMAgentTool: ToolHandler = {
  name: "second_llm_agent",
  definition: {
    type: "function",
    function: {
      name: "second_llm_agent",
      description:
        "セカンドLLM をサブエージェントとして使う。道具を使う多段の作業も、道具の要らない単発の相談も、これ1本。\n" +
        "[いつ使う] 次のいずれか: (a) コンテキスト保護=大量読込で本セッションの文脈を消費したくない / " +
        "(b) 並列=独立した複数タスクを同時に走らせたい / (c) 別モデルの特性=セカンドLLMの強み (速い・別視点等) が活きる。\n" +
        "[道具なしの相談・レビュー・要約] `no_tools: true` を付ける (この場合 reason は不要)。" +
        "セカンドLLM が道具を使わず一発で答える (コードレビュー・方針の壁打ち・長文要約など)。\n" +
        "[使うべきでない] (1) 自分でやった方が早い。 (2) 数秒で済む単純操作 → bash / file_read で直接。 " +
        "(3) 同じ成果物への細切れ修正の連続委任 → 修正をまとめて1回で渡す。\n" +
        "[重要原則] 一度委任したら **そのタスクの完成までを 1 回の委任内で完結** させる (細切れ委任は文脈が分散して非効率)。\n" +
        "[よくある誤用] (a) 会話履歴を渡し忘れ → セカンドLLMに履歴は無い。背景を task に同梱。 " +
        "(b) 委任先の状態 (ファイル作成等) を自分で検証しない → 結果を file_read 等で確認。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "依頼内容の詳細。必要な背景・制約を全て含める (no_tools の相談では質問・相談内容をここに書く)。",
          },
          reason: {
            type: "string",
            enum: ["context_protection", "parallelism", "specialty"],
            description:
              "委任の理由 (道具を使う委任では必須。no_tools の単発相談では不要)。 " +
              "context_protection=大量読込で本セッションの文脈消費を避ける / " +
              "parallelism=独立した複数タスクを同時に走らせる / " +
              "specialty=セカンドLLMの特性 (速い・別モデル強み等) が活きる。",
          },
          no_tools: {
            type: "boolean",
            description:
              "道具を使わない単発の相談・レビュー・要約なら true。この場合セカンドLLMは道具を使わず一発で答え、reason は不要。",
          },
        },
        required: ["task"],
      },
    },
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!secondLLMManager || !secondLLMManager.isAvailable()) {
      return { success: false, output: "", error: "Error: Second LLM is not configured or not enabled." };
    }
    const task = params.task as string;
    // D1: 呼出元の ancestors を SecondLLMManager に伝播
    const parentAncestors = context?.ancestors ?? ROOT_ANCESTORS;

    // 道具なしの単発相談 (旧 second_llm_consult を畳んだ経路)。reason ガードは課さない。
    if (params.no_tools === true) {
      try {
        const result = await secondLLMManager.consult(task, parentAncestors);
        return { success: true, output: result };
      } catch (e) {
        return { success: false, output: "", error: buildSecondLLMFailureError("second_llm_agent", e) };
      }
    }

    // 道具ありの委任: 委任理由ハードガード — 3 条件のいずれかでなければ拒否 (Phase 5-B3)
    const VALID_REASONS = ["context_protection", "parallelism", "specialty"] as const;
    const reason = params.reason as string | undefined;
    if (!reason || !VALID_REASONS.includes(reason as (typeof VALID_REASONS)[number])) {
      return {
        success: false,
        output: "",
        error:
          `second_llm_agent の reason 引数は必須で、 次のいずれかでなければなりません: ${VALID_REASONS.join(" / ")}\n` +
          `→ context_protection (大量読込で文脈消費を避ける) / parallelism (独立並列タスク) / specialty (セカンドLLMの特性が活きる)\n` +
          `3 条件いずれにも該当しないなら、 自分で処理してください (file_read / bash / glob / grep などで十分なはず)。\n` +
          `※ 道具の要らない単発の相談・レビュー・要約なら no_tools: true を付ければ reason は不要です。`,
      };
    }
    try {
      const result = await secondLLMManager.runAsAgent(task, parentAncestors);
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
