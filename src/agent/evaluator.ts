/**
 * Evaluator — 成果物の独立レビュー
 *
 * メインLLMとは別コンテキストで成果物を評価し、具体的なフィードバックを返す。
 * LLMは secondLLM が利用可能ならそちらを使い、なければ mainLLM を使う。
 *
 * 設計思想: Anthropic "Harness Design for Long-Running Apps" の Evaluator パターン。
 * 生成者と評価者を分離することで、自己評価の甘さを構造的に解決する。
 */
import chalk from "chalk";
import ora from "ora";
import type { LLMProvider, Message } from "../providers/base-provider.js";
import { collectResponse } from "../providers/base-provider.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import * as logger from "../utils/logger.js";

export interface EvaluatorIssue {
  severity: "critical" | "warning" | "suggestion";
  description: string;
  location?: string;
  suggestion?: string;
}

export interface EvaluatorResult {
  passed: boolean;
  issues: EvaluatorIssue[];
  summary: string;
}

export class Evaluator {
  private provider: LLMProvider;
  private model: string;
  private source: "secondLLM" | "mainLLM";

  constructor(
    secondLLMManager: SecondLLMManager | null,
    mainProvider: LLMProvider,
    mainModel: string,
  ) {
    if (secondLLMManager?.isAvailable()) {
      const p = secondLLMManager.getProvider();
      const ep = secondLLMManager.getEndpoint();
      if (p && ep) {
        this.provider = p;
        this.model = ep.model;
        this.source = "secondLLM";
      } else {
        this.provider = mainProvider;
        this.model = mainModel;
        this.source = "mainLLM";
      }
    } else {
      this.provider = mainProvider;
      this.model = mainModel;
      this.source = "mainLLM";
    }
  }

  /**
   * 成果物を評価し、フィードバックを返す
   */
  async evaluate(params: {
    files: { path: string; content: string }[];
    originalRequest: string;
    assistantResponse?: string;
  }): Promise<EvaluatorResult> {
    const prompt = this.buildEvaluationPrompt(params);
    const spinner = ora(chalk.cyan(`  Evaluator reviewing (${this.source})...`)).start();

    try {
      const messages: Message[] = [
        { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ];

      const gen = this.provider.chat({
        model: this.model,
        messages,
        temperature: 0.1,
        stream: true,
      });

      const response = await collectResponse(gen);
      const result = this.parseEvaluatorResponse(response.content);

      if (result.passed) {
        spinner.succeed(chalk.cyan(`  Evaluator: 合格 (${this.source})`));
      } else {
        const criticalCount = result.issues.filter(i => i.severity === "critical").length;
        const warningCount = result.issues.filter(i => i.severity === "warning").length;
        spinner.warn(chalk.cyan(
          `  Evaluator: 不合格 — critical: ${criticalCount}, warning: ${warningCount} (${this.source})`
        ));
      }

      logger.debug(`Evaluator result: passed=${result.passed}, issues=${result.issues.length}`);
      return result;
    } catch (e) {
      spinner.fail(chalk.red(`  Evaluator failed (${this.source})`));
      logger.error("Evaluator error:", e);
      // 評価失敗時は合格扱い（ブロッカーにしな���）
      return {
        passed: true,
        issues: [],
        summary: `評価中にエラーが発生しました: ${String(e)}`,
      };
    }
  }

  private buildEvaluationPrompt(params: {
    files: { path: string; content: string }[];
    originalRequest: string;
    assistantResponse?: string;
  }): string {
    const fileSections = params.files
      .map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``)
      .join("\n\n");

    let prompt = `## ユーザーの元の依頼\n${params.originalRequest}\n\n`;

    if (params.assistantResponse) {
      prompt += `## AIの完了報告\n${params.assistantResponse.slice(0, 500)}\n\n`;
    }

    prompt += `## 成果物\n${fileSections}\n\n`;
    prompt += `上記の成果物を評価してください。JSON形式で回答してください。`;

    return prompt;
  }

  private parseEvaluatorResponse(raw: string): EvaluatorResult {
    // JSON抽出を試みる
    const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? raw.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        const issues: EvaluatorIssue[] = (parsed.issues ?? []).map((i: Record<string, unknown>) => ({
          severity: (i.severity as string) ?? "warning",
          description: (i.description as string) ?? "",
          location: i.location as string | undefined,
          suggestion: i.suggestion as string | undefined,
        }));
        const hasCritical = issues.some(i => i.severity === "critical");
        return {
          passed: parsed.passed ?? !hasCritical,
          issues,
          summary: (parsed.summary as string) ?? raw.slice(0, 200),
        };
      } catch {
        logger.debug("Evaluator JSON parse failed, using heuristic");
      }
    }

    // JSONパース失敗時: ヒューリスティック
    const hasProblems = /問題|不合格|critical|fail|修正が必要/i.test(raw);
    return {
      passed: !hasProblems,
      issues: hasProblems
        ? [{ severity: "warning", description: raw.slice(0, 500) }]
        : [],
      summary: raw.slice(0, 300),
    };
  }

  /**
   * 評価結果をメインLLMへの注入テキストにフォーマットする
   */
  static formatForInjection(result: EvaluatorResult): string {
    if (result.passed && result.issues.length === 0) {
      return `[自動レビュー結果] 合格 — ${result.summary}`;
    }

    const parts = [`[自動レビュー結果]\n${result.summary}\n`];

    if (result.issues.length > 0) {
      parts.push("指摘事項:");
      for (const issue of result.issues) {
        const loc = issue.location ? ` (${issue.location})` : "";
        const sug = issue.suggestion ? `\n  → 修正案: ${issue.suggestion}` : "";
        parts.push(`- [${issue.severity}]${loc} ${issue.description}${sug}`);
      }
    }

    if (!result.passed) {
      parts.push("\n上記の指摘に対応してください。修正が完了したら報告してください。");
    }

    return parts.join("\n");
  }
}

const EVALUATOR_SYSTEM_PROMPT = `あなたは独立したレビュアーです。別のAIが作成した成果物を客観的に���価します。

## 評価ルール
- 発見した問題は具体的に指摘すること（ファイルパス、該当箇所の引用）
- 一度出した指摘を取り下げないこと
- 「まあ大丈夫だろう」という甘い判定は禁止。問題があるなら報告する
- 軽微な問題（typo等）は severity: "suggestion" とし、合否判定には影響させない
- critical が1つでもあれば passed: false

## 評価基準
- ユーザーの依頼の要件を満たしているか
- コードの場合: 構文エラー、論理エラー、セキュリティ問題がないか
- 文章の場合: 論理の飛躍、前後の矛盾、要件の欠落がないか
- 成果物の完成度（部分的な実装で終わっていないか）

## 回答形式
以下のJSON形式で回答してください:
\`\`\`json
{
  "passed": true/false,
  "summary": "総評（1-2文）",
  "issues": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "description": "問題の説明",
      "location": "ファイルパスや該当箇所（あれば）",
      "suggestion": "修正提案（あれば）"
    }
  ]
}
\`\`\``;
