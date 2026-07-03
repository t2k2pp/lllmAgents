/**
 * Goal Loop Runner — 決定的検証ゲート型の OUTER ループ。
 *
 * 設計: docs/goal-loop-deterministic-check-design.md
 *
 * 記事「Write Loops Not Prompts」の思想を体現する:
 *   - ループ (このコード) が制御を所有し、AgentLoop.run() をサブルーチンとして呼ぶ
 *   - 停止ゲートは LLM の自己判断でなく、検証コマンドの exit code (ground-truth)
 *   - 失敗時は出力を次反復に注入し、exit 0 / 反復上限 / abort / 同一失敗反復 で止まる
 *
 * 既存資産の再利用:
 *   - goal-slot: goal + 検証履歴を履歴の外に持つ (圧縮耐性)。enterGoalSeek(seedTodos=false) で
 *     既存 todo gate と競合させない。
 *   - AgentLoop.run() / isAborted() はそのまま使う (forward mode に回帰を入れない)。
 */

import chalk from "chalk";
import type { AgentLoop } from "../agent/agent-loop.js";
import { appendEvaluation, type GoalDefinition } from "../agent/goal-slot.js";
import { runCheck, type CheckResult } from "./check-runner.js";

export interface GoalLoopOptions {
  /** タスク記述 (@メンション解決済みを想定) */
  prompt: string;
  /** ground-truth ゲートとなる検証コマンド (exit 0 で達成) */
  checkCommand: string;
  /** 最大反復回数 */
  maxIterations: number;
  /** 検証コマンドの cwd (既定 process.cwd()) */
  cwd?: string;
  /** 検証コマンドの timeout (ms) */
  timeoutMs?: number;
}

export interface GoalLoopResult {
  success: boolean;
  iterations: number;
  finalCheck: CheckResult | null;
}

/** 失敗出力から次反復向けのヒント (gap_hint) を作る */
function hintFromCheck(check: CheckResult): string {
  const body = (check.stderrTail || check.stdoutTail).trim();
  return body.split("\n").slice(-12).join("\n").slice(0, 1500);
}

/** 2 反復目以降の再試行プロンプトを組む (前回の失敗出力を明示) */
function buildRetryPrompt(prompt: string, checkCommand: string, check: CheckResult): string {
  const out = (check.stderrTail || check.stdoutTail).trim();
  const label = check.timedOut ? "タイムアウトしました" : `exit code ${check.exitCode} で失敗しました`;
  return [
    prompt,
    "",
    "---",
    `**前回の検証結果:** 検証コマンド \`${checkCommand}\` は ${label}。`,
    "出力 (末尾):",
    "```",
    out.split("\n").slice(-30).join("\n").slice(0, 2500),
    "```",
    `上記の失敗を解消してください。\`${checkCommand}\` が exit 0 になることがゴールです。`,
  ].join("\n");
}

/**
 * 決定的検証ゲート型ループを回す。
 * 完了 (exit 0) で success=true。それ以外は exitGoalSeek("abort") して success=false。
 */
export async function runGoalLoop(opts: GoalLoopOptions, agent: AgentLoop): Promise<GoalLoopResult> {
  const { prompt, checkCommand, maxIterations } = opts;

  const goal: GoalDefinition = {
    statement: prompt,
    acceptance_criteria: [`検証コマンド \`${checkCommand}\` が exit 0 で成功する`],
    created_at: Date.now(),
    register_at_creation: "standard",
    check_command: checkCommand,
  };
  // seedTodos=false: 検証ゲートは exit code が握る。todo gate と二重化させない。
  agent.enterGoalSeek(goal, false);

  let lastCheck: CheckResult | null = null;
  let prevFailureTail: string | null = null;
  let sameFailureStreak = 0;

  try {
    for (let i = 1; i <= maxIterations; i++) {
      if (agent.isAborted()) break;

      console.log(chalk.cyan(`  ── goal-loop 反復 ${i}/${maxIterations} ${"─".repeat(34)}`));

      const promptForIteration = i === 1 || !lastCheck ? prompt : buildRetryPrompt(prompt, checkCommand, lastCheck);

      await agent.run(promptForIteration);
      if (agent.isAborted()) break;

      // ── ハーネス自身が検証コマンドを実行 (LLM 非経由 = ground-truth ゲート) ──
      console.log(chalk.dim(`  │ 検証コマンド実行: ${checkCommand}`));
      lastCheck = await runCheck(checkCommand, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });

      // 決定的レコードを goal-slot に積む (圧縮耐性 + 次反復の system prompt 注入)
      appendEvaluation({
        iteration: i,
        overall_score: lastCheck.passed ? 1 : 0,
        per_criterion: [lastCheck.passed ? 1 : 0],
        unmet: lastCheck.passed ? [] : [`\`${checkCommand}\` exit ${lastCheck.exitCode}`],
        gap_hint: lastCheck.passed ? "" : hintFromCheck(lastCheck),
        passed: lastCheck.passed,
        recorded_at: Date.now(),
      });

      if (lastCheck.passed) {
        console.log(chalk.green(`  ✓ 検証成功 (exit 0) — 反復 ${i} で完了\n`));
        agent.exitGoalSeek("completed");
        return { success: true, iterations: i, finalCheck: lastCheck };
      }

      const failLabel = lastCheck.timedOut ? "timeout" : `exit ${lastCheck.exitCode}`;
      console.log(chalk.yellow(`  ✗ 検証失敗 (${failLabel})`));

      // 同一失敗が続く場合は無限ループ防止のため打ち切る (silent でなく明示して停止)
      const curTail = (lastCheck.stderrTail || lastCheck.stdoutTail).trim();
      if (prevFailureTail !== null && curTail === prevFailureTail) {
        sameFailureStreak++;
      } else {
        sameFailureStreak = 0;
      }
      prevFailureTail = curTail;
      if (sameFailureStreak >= 2) {
        console.log(chalk.yellow(`  ⚠ 同一の失敗が ${sameFailureStreak + 1} 回続いています。ループを打ち切ります。\n`));
        break;
      }

      if (i < maxIterations) {
        console.log(chalk.dim(`  → 失敗内容を次の反復に渡します\n`));
      }
    }
  } finally {
    // 完了 (return) しなかった場合のみ到達。完了時は既に forward なので no-op。
    if (agent.getMode() === "goal-seek") {
      agent.exitGoalSeek("abort");
    }
  }

  if (lastCheck && !agent.isAborted()) {
    console.log(chalk.yellow(`  ${maxIterations} 反復で検証を通せませんでした (最終: exit ${lastCheck.exitCode})`));
    const tail = (lastCheck.stderrTail || lastCheck.stdoutTail).trim();
    if (tail) console.log(chalk.dim(tail.split("\n").slice(-10).join("\n")));
    console.log();
  }

  return { success: false, iterations: maxIterations, finalCheck: lastCheck };
}
