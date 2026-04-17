import type { LLMProvider } from "../providers/base-provider.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
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
export declare class Evaluator {
    private secondLLMManager;
    private mainProvider;
    private mainModel;
    private source;
    constructor(secondLLMManager: SecondLLMManager | null, mainProvider: LLMProvider, mainModel: string);
    /**
     * 成果物を評価し、フィード���ックを返す。
     * secondLLMが使える場合はエージェンティック（ツール付きループ）で評価。
     * そうでなければmainLLMで1回呼び切りのフォールバック。
     */
    evaluate(params: {
        filePaths: string[];
        originalRequest: string;
        assistantResponse?: string;
    }): Promise<EvaluatorResult>;
    /**
     * エージェンティック評価: secondLLMがfile_read/grep/globを使って自律的にレビュー
     */
    private evaluateAgentic;
    /**
     * フォールバック評価: mainLLMで1回呼び切り（ファイル内容はプロンプトに埋め込み）
     */
    private evaluateFallback;
    private buildAgenticPrompt;
    private logResult;
    private parseEvaluatorResponse;
    /**
     * 評価結果をメインLLMへの注入テキストにフォー���ットする
     */
    static formatForInjection(result: EvaluatorResult): string;
}
//# sourceMappingURL=evaluator.d.ts.map