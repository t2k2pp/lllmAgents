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
import chalk from "chalk";
/** 合格ライン（10点満点） */
const PASS_SCORE = 7;
export async function runTenacious(options, subAgentManager) {
    const { prompt, maxAttempts } = options;
    const results = [];
    console.log(chalk.cyan(`\n  ┌─ 試行錯誤モード (最大${maxAttempts}回) ─────────────────`));
    console.log(chalk.dim(`  │ タスク: ${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}`));
    console.log(chalk.cyan(`  └──────────────────────────────────────────────────\n`));
    // ── Step 1: 成功基準の策定 ────────────────────────────
    console.log(chalk.dim("  [準備] 成功基準を策定中..."));
    const planResult = await subAgentManager.launchForeground("plan", "成功基準策定", buildPlannerPrompt(prompt));
    const criteria = planResult.result;
    console.log(chalk.dim("  [準備] 成功基準の策定完了\n"));
    let lastFeedback = "";
    // ── Step 2: 試行ループ ────────────────────────────────
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(chalk.cyan(`  ┌─ 試行 ${attempt}/${maxAttempts} ${"─".repeat(40)}`));
        // Generator: 実装（毎回新鮮なコンテキスト = コンテキストリセット）
        console.log(chalk.dim(`  │ [Generator] 実装中...`));
        const genResult = await subAgentManager.launchForeground("general-purpose", `実装 #${attempt}`, buildGeneratorPrompt(prompt, criteria, lastFeedback, attempt));
        // Evaluator: 実際のファイルを確認してスコアリング（Generator とは別エージェント）
        console.log(chalk.dim(`  │ [Evaluator] 成果物を評価中...`));
        const evalResult = await subAgentManager.launchForeground("plan", `評価 #${attempt}`, buildEvaluatorPrompt(prompt, criteria, genResult.result));
        const { score, feedback } = parseEvaluatorOutput(evalResult.result);
        const passed = score >= PASS_SCORE;
        results.push({
            attempt,
            generatorSummary: genResult.result.slice(0, 500),
            evaluatorScore: score,
            evaluatorFeedback: feedback,
            passed,
        });
        const scoreLabel = passed
            ? chalk.green(`${score}/10 ✓ 合格`)
            : chalk.yellow(`${score}/10 ✗ 未達成`);
        console.log(chalk.dim(`  │ [Evaluator] スコア: `) + scoreLabel);
        console.log(chalk.cyan(`  └${"─".repeat(50)}\n`));
        if (passed) {
            console.log(chalk.green(`  ✓ ${attempt}回目の試行で成功しました！\n`));
            return { success: true, totalAttempts: attempt, attempts: results, finalScore: score };
        }
        lastFeedback = feedback;
        if (attempt < maxAttempts) {
            console.log(chalk.dim(`  → フィードバックを次の試行に引き継ぎます\n`));
        }
    }
    const finalScore = results[results.length - 1]?.evaluatorScore ?? 0;
    console.log(chalk.yellow(`  ${maxAttempts}回試行しましたが合格スコア(${PASS_SCORE}/10)に達しませんでした`));
    console.log(chalk.dim(`  最終スコア: ${finalScore}/10\n`));
    return { success: false, totalAttempts: maxAttempts, attempts: results, finalScore };
}
// ── プロンプトビルダー ────────────────────────────────────
function buildPlannerPrompt(originalPrompt) {
    return `以下のタスクを実行する前に「完成の定義」を策定してください。

## タスク
${originalPrompt}

## 出力形式（この形式を厳守してください）

### 成功基準チェックリスト
1. [具体的・検証可能な確認項目]
2. [具体的・検証可能な確認項目]
...（5〜8項目）

### 評価方法
各項目を 0-10 でスコアリングする具体的な方法を記述する。
合格ライン: 平均 ${PASS_SCORE}/10 以上

ファイル作成を伴うタスクの場合は「ファイルが実際に存在すること」を必須基準に含めること。`;
}
function buildGeneratorPrompt(originalPrompt, criteria, lastFeedback, attempt) {
    const parts = [
        `## タスク\n${originalPrompt}`,
        `## 成功基準\n${criteria}`,
    ];
    if (attempt > 1 && lastFeedback) {
        parts.push(`## 前回の試行(#${attempt - 1})の評価フィードバック\n${lastFeedback}\n\n` +
            `上記の問題点を修正した上で再実装してください。前回と同じ失敗を繰り返さないよう注意してください。`);
    }
    parts.push(`成功基準を全て満たすよう丁寧に実装してください。` +
        `特にファイルの作成は必ずfile_writeツールを呼び出して実際に保存してください。`);
    return parts.join("\n\n");
}
function buildEvaluatorPrompt(originalPrompt, criteria, genSummary) {
    return `以下の実装を評価してください。実際のファイルを確認した上でスコアをつけてください。

## 元のタスク
${originalPrompt}

## 成功基準
${criteria}

## 実装エージェントの作業ログ（要約）
${genSummary.slice(0, 2000)}${genSummary.length > 2000 ? "\n...(省略)" : ""}

## 評価手順
1. glob や file_read ツールを使って実際にファイルが存在するか確認する
2. ファイルの内容を確認して品質を評価する
3. 各成功基準に対して 0-10 でスコアをつける

## 出力形式（必ずこの形式で出力すること）

### 各基準のスコア
- [基準名]: X/10 - [理由]

### TOTAL_SCORE: X.X

### 改善が必要な点
- [具体的な改善点]`;
}
// ── 評価結果パーサー ─────────────────────────────────────
function parseEvaluatorOutput(text) {
    const scoreMatch = text.match(/TOTAL_SCORE:\s*(\d+(?:\.\d+)?)/i);
    let score = 4; // デフォルト（見つからない場合は低めに）
    if (scoreMatch) {
        score = Math.min(10, Math.max(0, parseFloat(scoreMatch[1])));
    }
    return { score, feedback: text };
}
//# sourceMappingURL=tenacious-runner.js.map