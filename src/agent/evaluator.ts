/**
 * Evaluator — 成果物の独立レビュー
 *
 * メインLLMとは別コンテキストで成果物を評価し、具体的なフィードバックを返す。
 * secondLLMが利用可能な場合: エージェントループ（file_read, grep, glob）で自律的にレビュー。
 * secondLLMが利用不可の場合: mainLLMで1回呼び切りのフォールバック。
 *
 * 設計思想: Anthropic "Harness Design for Long-Running Apps" の Evaluator パターン。
 * 生成者と評価者を分離することで、自己評価の甘さを構造的に解決する。
 */
import chalk from "chalk";
import { createSpinner } from "../utils/spinner.js";
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
  /** レビュー対象ファイルパス一覧 */
  reviewedFiles?: string[];
}

export class Evaluator {
  private secondLLMManager: SecondLLMManager | null;
  private mainProvider: LLMProvider;
  private mainModel: string;
  private source: "secondLLM" | "mainLLM";

  constructor(secondLLMManager: SecondLLMManager | null, mainProvider: LLMProvider, mainModel: string) {
    this.secondLLMManager = secondLLMManager;
    this.mainProvider = mainProvider;
    this.mainModel = mainModel;
    this.source = secondLLMManager?.isAvailable() ? "secondLLM" : "mainLLM";
  }

  setMainProvider(provider: LLMProvider, model: string): void {
    this.mainProvider = provider;
    this.mainModel = model;
    this.source = this.secondLLMManager?.isAvailable() ? "secondLLM" : "mainLLM";
  }

  /**
   * 成果物を評価し、フィードバックを返す。
   * secondLLMが使える場合はエージェンティック（ツール付きループ）で評価。
   * そうでなければmainLLMで1回呼び切りのフォールバック。
   */
  async evaluate(params: {
    filePaths: string[];
    originalRequest: string;
    assistantResponse?: string;
  }): Promise<EvaluatorResult> {
    if (this.secondLLMManager?.isAvailable()) {
      return this.evaluateAgentic(params);
    }
    return this.evaluateFallback(params);
  }

  /**
   * エージェンティック評価: secondLLMがfile_read/grep/globを使って自律的にレビュー
   */
  private async evaluateAgentic(params: {
    filePaths: string[];
    originalRequest: string;
    assistantResponse?: string;
  }): Promise<EvaluatorResult> {
    const userPrompt = this.buildAgenticPrompt(params);

    try {
      const rawResponse = await this.secondLLMManager!.runAsEvaluator({
        systemPrompt: EVALUATOR_SYSTEM_PROMPT_AGENTIC,
        userPrompt,
      });

      const result = this.parseEvaluatorResponse(rawResponse);
      result.reviewedFiles = params.filePaths;
      this.logResult(result, params.filePaths.length);
      return result;
    } catch (e) {
      logger.error("Evaluator (agentic) error:", e);
      return {
        passed: true,
        issues: [],
        summary: `評価中にエラーが発生しました: ${String(e)}`,
        reviewedFiles: params.filePaths,
      };
    }
  }

  /**
   * フォールバック評価: mainLLMで1回呼び切り（ファイル内容はプロンプトに埋め込み）
   */
  private async evaluateFallback(params: {
    filePaths: string[];
    originalRequest: string;
    assistantResponse?: string;
  }): Promise<EvaluatorResult> {
    const spinner = createSpinner(chalk.cyan(`  Evaluator reviewing (mainLLM fallback)...`)).start();

    try {
      // フォールバック時はファイルを読み込んでプロンプトに埋め込む
      const fs = await import("fs");
      const fileContents: { path: string; content: string }[] = [];
      for (const filePath of params.filePaths) {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          fileContents.push({ path: filePath, content });
        } catch {
          /* skip unreadable files */
        }
      }

      const fileSections = fileContents.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n");

      const fileList = fileContents.map((f) => `- ${f.path}`).join("\n");

      let prompt = `## ユーザーの元の依頼\n${params.originalRequest}\n\n`;
      if (params.assistantResponse) {
        prompt += `## AIの完了報告\n${params.assistantResponse.slice(0, 800)}\n\n`;
      }
      prompt += `## レビュー対象ファイル一覧\n${fileList}\n\n`;
      prompt += `## 成果物の内容\n${fileSections}\n\n`;
      prompt += `上記の全成果物を総合的に評価してください。JSON形式で回答してください。`;

      const messages: Message[] = [
        { role: "system", content: EVALUATOR_SYSTEM_PROMPT_FALLBACK },
        { role: "user", content: prompt },
      ];

      const gen = this.mainProvider.chat({
        model: this.mainModel,
        messages,
        temperature: 0.1,
        stream: true,
      });

      const response = await collectResponse(gen);
      const result = this.parseEvaluatorResponse(response.content);
      result.reviewedFiles = params.filePaths;
      this.logResult(result, params.filePaths.length);
      spinner.stop();
      return result;
    } catch (e) {
      spinner.fail(chalk.red(`  Evaluator failed (mainLLM fallback)`));
      logger.error("Evaluator (fallback) error:", e);
      return {
        passed: true,
        issues: [],
        summary: `評価中にエラーが発生しました: ${String(e)}`,
        reviewedFiles: params.filePaths,
      };
    }
  }

  private buildAgenticPrompt(params: {
    filePaths: string[];
    originalRequest: string;
    assistantResponse?: string;
  }): string {
    const fileList = params.filePaths.map((f) => `- ${f}`).join("\n");

    let prompt = `## ユーザーの元の依頼\n${params.originalRequest}\n\n`;

    if (params.assistantResponse) {
      prompt += `## AIの完了報告\n${params.assistantResponse.slice(0, 800)}\n\n`;
    }

    prompt += `## レビュー対象ファイル\n${fileList}\n\n`;
    prompt += `上記ファイルをツール（file_read, grep, glob）を使って確認し、評価してください。\n`;
    prompt += `必要に応じてファイルの特定の関数やクラスをgrepで検索して確認してください。\n`;
    prompt += `全ファイルの確認が完了したら、最終的な評価をJSON形式で回答してください。`;

    return prompt;
  }

  private logResult(result: EvaluatorResult, fileCount: number): void {
    if (result.passed) {
      console.log(chalk.cyan(`  ✔ Evaluator: 合格 — ${fileCount}件レビュー (${this.source})`));
    } else {
      const criticalCount = result.issues.filter((i) => i.severity === "critical").length;
      const warningCount = result.issues.filter((i) => i.severity === "warning").length;
      console.log(
        chalk.cyan(
          `  ⚠ Evaluator: 不合格 — critical: ${criticalCount}, warning: ${warningCount}, ${fileCount}件レビュー (${this.source})`,
        ),
      );
    }
    logger.debug(`Evaluator result: passed=${result.passed}, issues=${result.issues.length}, files=${fileCount}`);
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
        const hasCritical = issues.some((i) => i.severity === "critical");
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
      issues: hasProblems ? [{ severity: "warning", description: raw.slice(0, 500) }] : [],
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

    // レビュー対象ファイルを明示（メインLLMが何が評価されたか把握できるように）
    if (result.reviewedFiles && result.reviewedFiles.length > 0) {
      parts.push(`レビュー対象: ${result.reviewedFiles.join(", ")}\n`);
    }

    if (result.issues.length > 0) {
      parts.push("指摘事項:");
      for (const issue of result.issues) {
        const loc = issue.location ? ` (${issue.location})` : "";
        const sug = issue.suggestion ? `\n  → 修正案: ${issue.suggestion}` : "";
        parts.push(`- [${issue.severity}]${loc} ${issue.description}${sug}`);
      }
    }

    if (!result.passed) {
      parts.push(
        "\n上記の指摘事項を修正してください。該当ファイルをfile_edit/file_writeで修正し、修正完了後に報告してください。",
      );
    }

    return parts.join("\n");
  }
}

/**
 * ID-015 (2026-04-30): AGENTIC / FALLBACK の 95% 重複を共通部分の切り出しで解消。
 * ID-016 (2026-04-30): 同時に文字化け (`���`) を全箇所修正。
 *
 * 共通: 立場 / 評価ルール / 評価基準 / JSON 形式
 * 個別: AGENTIC は作業手順 (ツール利用可) と location: ファイル:行 の例
 *       FALLBACK は作業前提 (ツール不可) と location 表記
 */

const EVALUATOR_COMMON = `あなたは独立したコードレビュアーです。別のAIが作成した成果物を客観的に評価します。

## 評価ルール
- 提示された全ファイルを総合的に評価する
- 発見した問題は具体的に指摘すること (ファイルパス、 該当箇所の引用)
- 一度出した指摘を取り下げないこと
- 「まあ大丈夫だろう」 という甘い判定は禁止。 問題があるなら報告する
- 軽微な問題 (typo 等) は severity: "suggestion" とし、 合否判定には影響させない
- critical が 1 つでもあれば passed: false
- warning のみの場合: 修正可能な実質的問題がある場合は passed: false、 些末な場合は passed: true

## 評価基準
- ユーザーの依頼の要件を全ファイルの総合として満たしているか
- コードの場合: 構文エラー、 論理エラー、 インポート不整合、 未定義参照がないか
- 設計書 + コードの場合: 設計書の内容がコードに反映されているか
- 文章の場合: 論理の飛躍、 前後の矛盾、 要件の欠落がないか
- 成果物の完成度 (部分的な実装で終わっていないか)

## 回答形式
以下の JSON 形式で評価を出力してください:
\`\`\`json
{
  "passed": true/false,
  "summary": "総評 (1-2文)",
  "issues": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "description": "問題の説明",
      "location": "ファイルパス[:行番号] や該当箇所 (あれば)",
      "suggestion": "修正提案 (あれば)"
    }
  ]
}
\`\`\``;

/** エージェンティック版: ツール (file_read, grep, glob) を使って自律的にレビュー */
const EVALUATOR_SYSTEM_PROMPT_AGENTIC = `${EVALUATOR_COMMON}

## あなたの作業手順
1. まずレビュー対象ファイル一覧を確認する
2. file_read でファイル内容を読む。 大きいファイルは必要な箇所を grep で特定してから読む
3. 複数ファイルがある場合、 ファイル間の整合性 (import / クラス参照 / 関数呼び出し) もチェックする
4. 全ファイルの確認が完了したら、 最終評価を上記 JSON 形式で出力する`;

/** フォールバック版: ツールなし、 ファイル内容をプロンプトに埋め込んで 1 回で評価 */
const EVALUATOR_SYSTEM_PROMPT_FALLBACK = `${EVALUATOR_COMMON}

## 作業前提 (ツール利用不可)
- 提示されたコード本文 (プロンプトに埋め込み済み) のみを読み、 上記 JSON 形式で出力する`;
