/**
 * Phase E-2: federated_delegate ツール — supervisor (= main LLM) と worker (= second LLM)
 * の協調パターンを構造化する。
 *
 * docs/multi-tier-harness-roadmap.md §4 Phase E-2 参照。
 *
 * 既存の second_llm_agent との違い:
 *   - second_llm_agent: 委任理由 (context_protection / parallelism / specialty) ベース
 *   - federated_delegate: **明示的な「期待出力」 + worker 結果の自動 validation**
 *     (例: 期待ファイルが存在するか、 期待 grep パターンが含まれるか)
 *
 * 使い所:
 *   - main = T1 (Claude / GPT-5)、 worker = T2/T3 (ローカル LLM) の構成で、
 *     main が「これは routine な実装」 と判断したら worker に委譲
 *   - validation で fail なら main 側でやり直す or 別 worker を試す
 *   - main は推論・統合に集中し、 worker は決まりきった作業を回す
 *
 * 哲学: T1 が単独で速く正確にこなせるタスクをわざわざ delegate しない。
 *      T1 の context を汚さない / コストを下げる目的でだけ使う。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolHandler, ToolResult, ToolExecutionContext } from "../tool-registry.js";
import type { SecondLLMManager } from "../../second-llm/second-llm-manager.js";
import { ROOT_ANCESTORS } from "../../agent/delegation-context.js";

let secondLLMManager: SecondLLMManager | null = null;

export function setFederatedSecondLLMManager(manager: SecondLLMManager): void {
  secondLLMManager = manager;
}

/**
 * 期待出力の検証仕様。 worker のレスポンスと sandbox 状態を組み合わせて検証する。
 */
interface ExpectedOutput {
  /** 期待ファイル絶対パス (作られたか / 存在するか) */
  expected_file_path?: string;
  /** 期待ファイル内に grep でマッチすべき pattern (正規表現) */
  expected_file_contains?: string;
  /** worker 返却テキストに含まれるべき pattern (正規表現) */
  expected_response_contains?: string;
  /** ファイルサイズの最小バイト (空ファイルでないことを保証) */
  expected_min_bytes?: number;
}

interface ValidationResult {
  passed: boolean;
  reasons: string[];
}

function validateOutput(workerResponse: string, expected: ExpectedOutput): ValidationResult {
  const reasons: string[] = [];
  if (expected.expected_file_path) {
    const p = path.resolve(expected.expected_file_path);
    if (!fs.existsSync(p)) {
      reasons.push(`expected_file_path not found: ${p}`);
    } else {
      const stat = fs.statSync(p);
      if (expected.expected_min_bytes && stat.size < expected.expected_min_bytes) {
        reasons.push(`expected_file is ${stat.size} bytes, less than expected_min_bytes=${expected.expected_min_bytes}`);
      }
      if (expected.expected_file_contains) {
        const content = fs.readFileSync(p, "utf-8");
        try {
          const re = new RegExp(expected.expected_file_contains);
          if (!re.test(content)) {
            reasons.push(`expected_file_contains pattern "${expected.expected_file_contains}" not matched`);
          }
        } catch (err) {
          reasons.push(`invalid regex for expected_file_contains: ${err}`);
        }
      }
    }
  }
  if (expected.expected_response_contains) {
    try {
      const re = new RegExp(expected.expected_response_contains);
      if (!re.test(workerResponse)) {
        reasons.push(`expected_response_contains pattern "${expected.expected_response_contains}" not in worker response`);
      }
    } catch (err) {
      reasons.push(`invalid regex for expected_response_contains: ${err}`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

export const federatedDelegateTool: ToolHandler = {
  name: "federated_delegate",
  definition: {
    type: "function",
    function: {
      name: "federated_delegate",
      description:
        "Supervisor (= あなた = main LLM) が routine な実装を Worker (= second LLM) に委譲し、 期待出力で自動 validate する。 " +
        "second_llm_agent との違いは「期待出力の明示」 と「結果の自動検証」。 worker が期待を満たさなければ自動で失敗を返し、 supervisor がやり直しを判断できる。\n" +
        "[使うべき場面] (1) 自分 (T1) のコンテキスト消費が惜しい routine 実装。 (2) 期待出力が明確に検証可能 (= ファイル生成 + 中身パターン)。 (3) 失敗時に supervisor が引き取れる粒度。\n" +
        "[使うべきでない] (1) 設計判断・複雑な推論 → supervisor 自身でやる。 (2) 期待出力が曖昧 → second_llm_agent (期待検証なし) を使う。 (3) second LLM 未設定 → エラーになるので /second setup を先に。\n" +
        "[期待出力の例] expected_file_path=/abs/main.py + expected_file_contains=\"def main\" + expected_min_bytes=100。\n" +
        "[validation 失敗時] worker のレスポンス本文 + 失敗理由が返る。 supervisor は: (a) より具体的な指示で再委譲 / (b) 自分でやり直し / (c) ask_user で確認。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "worker (= second LLM) に実行させるタスクの完全な指示。 必要なコンテキスト・制約・保存先パスを全て含める。",
          },
          expected_file_path: {
            type: "string",
            description: "[validation 用・任意] worker が作成すべきファイルの絶対パス。 これが存在しなければ validation 失敗。",
          },
          expected_file_contains: {
            type: "string",
            description: "[validation 用・任意] expected_file_path の中身に正規表現でマッチすべき pattern。 例: \"def main\\\\(\" や \"<title>\"。",
          },
          expected_response_contains: {
            type: "string",
            description: "[validation 用・任意] worker の return テキストに含まれるべき正規表現 pattern。 worker が「完了サマリ」 をどう書くべきか規定する。",
          },
          expected_min_bytes: {
            type: "number",
            description: "[validation 用・任意] expected_file_path の最小バイト数。 空ファイル/極小ファイルを失敗にする。",
          },
        },
        required: ["task"],
      },
    },
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!secondLLMManager || !secondLLMManager.isAvailable()) {
      return {
        success: false,
        output: "",
        error:
          "Error: federated_delegate は second LLM が必要ですが未設定/未起動です。 /second setup で構成するか、 supervisor 自身でタスクを実行してください。",
      };
    }
    const task = String(params.task ?? "").trim();
    if (!task) {
      return { success: false, output: "", error: "Error: task は必須です。" };
    }

    const expected: ExpectedOutput = {
      expected_file_path: typeof params.expected_file_path === "string" ? params.expected_file_path : undefined,
      expected_file_contains: typeof params.expected_file_contains === "string" ? params.expected_file_contains : undefined,
      expected_response_contains: typeof params.expected_response_contains === "string" ? params.expected_response_contains : undefined,
      expected_min_bytes: typeof params.expected_min_bytes === "number" ? params.expected_min_bytes : undefined,
    };

    // Worker への指示に validation 仕様も伝える (= worker が何を作ればよいか明確になる)
    const workerPrompt = buildWorkerPrompt(task, expected);

    // Phase E-2: ancestors を D1 経路で伝播 (= worker 内で task / second_llm_* が呼ばれるのを構造的に防ぐ)
    const parentAncestors = context?.ancestors ?? ROOT_ANCESTORS;

    let workerResponse = "";
    try {
      workerResponse = await secondLLMManager.runAsAgent(workerPrompt, parentAncestors);
    } catch (e) {
      return {
        success: false,
        output: "",
        error: `[federated_delegate] worker が失敗しました: ${e}`,
      };
    }

    // 自動 validation
    const v = validateOutput(workerResponse, expected);
    const validationSummary = expected.expected_file_path || expected.expected_file_contains || expected.expected_response_contains
      ? `\n\n[federated_delegate validation] ${v.passed ? "PASSED" : "FAILED"}${v.reasons.length > 0 ? "\n  - " + v.reasons.join("\n  - ") : ""}`
      : "\n\n[federated_delegate validation] (no expected output specified — worker response not validated)";

    if (!v.passed) {
      return {
        success: false,
        output: workerResponse + validationSummary,
        error:
          `[federated_delegate] 期待出力の validation が失敗しました。\n` +
          v.reasons.map((r) => `  - ${r}`).join("\n") +
          `\n\nsupervisor (= あなた) の対応案: (a) より具体的な task 指示で再委譲 / (b) 自分でやり直し / (c) ask_user で確認`,
      };
    }
    return {
      success: true,
      output: workerResponse + validationSummary,
    };
  },
};

function buildWorkerPrompt(task: string, expected: ExpectedOutput): string {
  const constraints: string[] = [];
  if (expected.expected_file_path) {
    constraints.push(`必ず file_write で次のパスにファイルを作成: ${expected.expected_file_path}`);
  }
  if (expected.expected_file_contains) {
    constraints.push(`ファイル内容は次のパターンを含むこと (正規表現): /${expected.expected_file_contains}/`);
  }
  if (expected.expected_response_contains) {
    constraints.push(`return テキストに次のパターンを必ず含めること: /${expected.expected_response_contains}/`);
  }
  if (expected.expected_min_bytes) {
    constraints.push(`ファイルサイズは最低 ${expected.expected_min_bytes} bytes 以上`);
  }
  if (constraints.length === 0) {
    return task;
  }
  return (
    `${task}\n\n` +
    `# 期待出力の制約 (supervisor が validation する)\n` +
    constraints.map((c) => `- ${c}`).join("\n") +
    `\n\nこれらが守られないと supervisor 側で失敗扱いになります。 必ず守ること。`
  );
}
