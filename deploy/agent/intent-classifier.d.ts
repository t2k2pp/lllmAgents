/**
 * Intent Classifier — ユーザーメッセージの意図分類 & AI応答の完了判定
 *
 * ヒューリスティック（高速） → LLM判定（曖昧なケース）の2段構え。
 */
import type { LLMProvider } from "../providers/base-provider.js";
export type IntentType = "task" | "question" | "conversation";
export type CompletionType = "completed" | "in_progress" | "other";
export declare class IntentClassifier {
    private provider;
    private model;
    constructor(provider: LLMProvider, model: string);
    /**
     * ユーザーメッセージがタスクリクエストか判定する。
     * ヒューリスティック → LLM の2段構え。
     */
    classifyIntent(userMessage: string, recentContext?: string): Promise<IntentType>;
    /**
     * AI応答がタスク完了を宣言しているか判定する。
     */
    classifyCompletion(assistantResponse: string): Promise<CompletionType>;
    /**
     * isTaskRequest の置き換え（同期的にヒューリスティックのみ使用するケース用）
     */
    isObviousTask(text: string): boolean;
    /**
     * isCompletionResponse の置き換え（同期的にヒューリスティックのみ使用するケース用）
     */
    isObviousCompletion(text: string): boolean;
}
//# sourceMappingURL=intent-classifier.d.ts.map