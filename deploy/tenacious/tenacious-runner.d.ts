/**
 * Tenacious Runner - 試行錯誤モードのオーケストレーター
 *
 * 設計思想:
 * - Karpathy/autoresearch: 固定試行予算、スコアで保持/破棄を決定
 * - Anthropic harness design: Generator/Evaluator分離、コンテキストリセット
 *
 * フロー:
 * 1. Planner（サブエージェント）が「完成の定義」と評価チェックリストを生成
 * 2. Generator（サブエージェント）がタスクを実装 ← 新鮮なコンテキスト
 * 3. Evaluator（サブエージェント）が実際のファイルを確認しスコアリング ← 自己評価バイアスなし
 * 4. スコア >= PASS_SCORE なら完了、そうでなければフィードバックを次のGeneratorに渡して繰り返す
 */
import type { SubAgentManager } from "../agent/sub-agent.js";
export interface AttemptResult {
    attempt: number;
    generatorSummary: string;
    evaluatorScore: number;
    evaluatorFeedback: string;
    passed: boolean;
}
export interface TenaciousRunResult {
    success: boolean;
    totalAttempts: number;
    attempts: AttemptResult[];
    finalScore: number;
}
export interface TenaciousOptions {
    prompt: string;
    maxAttempts: number;
}
export declare function runTenacious(options: TenaciousOptions, subAgentManager: SubAgentManager): Promise<TenaciousRunResult>;
//# sourceMappingURL=tenacious-runner.d.ts.map