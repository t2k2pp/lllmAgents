/**
 * Goal Slot — Goal Seek mode の不変量を保持する singleton モジュール。
 *
 * `todo-write.ts` の `getTodos()` と同じ思想で、 メッセージ履歴の外側に持つ。
 * これにより HierarchicalCompressor の圧縮対象から外れ、 long session でも
 * goal が劣化せず保持される。
 *
 * 関連: docs/goal-seek-mode-design.md §3.2
 */

export interface GoalDefinition {
  /** 自然言語の goal 記述 (user 入力をベース + AI 要約) */
  statement: string;
  /** 検証可能な acceptance 観点。 AI が要約し user が承認した形 */
  acceptance_criteria: string[];
  /** ms epoch — goal 作成時刻 */
  created_at: number;
  /** goal 入口時の register (style 連動の記録用) */
  register_at_creation: string;
  /**
   * goal-loop (決定的検証ゲート型ループ) でのみ設定される検証コマンド。
   * 設定時は exit 0 が達成条件。通常の /goal-seek では undefined。
   * 設計: docs/goal-loop-deterministic-check-design.md
   */
  check_command?: string;
}

export interface EvaluationRecord {
  iteration: number;
  /** 0.0-1.0 の総合スコア (全 criterion 平均) */
  overall_score: number;
  /** criterion ごとの達成度 (0.0=未着手, 1.0=完了) */
  per_criterion: number[];
  /** 未達成の criterion 自然言語記述 */
  unmet: string[];
  /** 次にやるべきことの 1-2 文ヒント */
  gap_hint: string;
  /** 全項目 ≥ 0.8 で true */
  passed: boolean;
  /** ms epoch */
  recorded_at: number;
}

/** モジュールスコープの singleton 状態 */
let _goal: GoalDefinition | null = null;
let _history: EvaluationRecord[] = [];

export function setGoal(goal: GoalDefinition): void {
  _goal = goal;
  _history = [];
}

export function getGoal(): GoalDefinition | null {
  return _goal;
}

export function hasGoal(): boolean {
  return _goal !== null;
}

export function appendEvaluation(record: EvaluationRecord): void {
  _history.push(record);
}

export function getEvaluationHistory(): EvaluationRecord[] {
  return [..._history];
}

export function getLatestEvaluation(): EvaluationRecord | null {
  return _history.length > 0 ? _history[_history.length - 1] : null;
}

export function clearGoal(): void {
  _goal = null;
  _history = [];
}

/**
 * Session resume 用。 setGoal() は history を [] リセットするため復元には使えない。
 * docs/todo-goal-lifecycle.md §2.3 参照。
 */
export function restoreGoalState(goal: GoalDefinition, history: EvaluationRecord[]): void {
  _goal = goal;
  _history = [...history];
}

/**
 * 収穫逓減 (diminishing returns) 検出。
 * 直近 N 反復で平均スコアが ε 未満しか改善せず、 unmet 集合が変わっていない場合 true。
 * 設計書 §3.5 参照。
 */
export function isDiminishingReturns(windowSize: number = 3, epsilon: number = 0.02): boolean {
  if (_history.length < windowSize) return false;
  const window = _history.slice(-windowSize);
  const scores = window.map((r) => r.overall_score);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  if (maxScore - minScore >= epsilon) return false;
  // unmet 集合が同一か
  const firstUnmet = JSON.stringify([...window[0].unmet].sort());
  return window.every((r) => JSON.stringify([...r.unmet].sort()) === firstUnmet);
}

/**
 * Goal Slot を system prompt に注入するためのセクションを構築する。
 * goal が無ければ空文字列を返す (forward mode 互換)。
 */
export function buildGoalSlotSection(): string {
  if (!_goal) return "";
  const lines: string[] = [];
  lines.push("# 現在の Goal (Goal Seek mode)");
  lines.push("");
  lines.push(`## Goal`);
  lines.push(_goal.statement);
  lines.push("");
  lines.push(`## Acceptance Criteria (全項目を満たすまで作業継続)`);
  for (let i = 0; i < _goal.acceptance_criteria.length; i++) {
    lines.push(`${i + 1}. ${_goal.acceptance_criteria[i]}`);
  }
  if (_goal.check_command) {
    lines.push("");
    lines.push(`## 検証コマンド (ground-truth ゲート)`);
    lines.push(`\`${_goal.check_command}\` が exit 0 になることが達成条件 (ハーネスが毎反復実行する)。`);
  }

  const latest = getLatestEvaluation();
  if (latest) {
    lines.push("");
    lines.push(`## 直近の評価 (iteration ${latest.iteration}, score ${latest.overall_score.toFixed(2)})`);
    if (latest.unmet.length > 0) {
      lines.push(`未達成項目:`);
      for (const u of latest.unmet) {
        lines.push(`- ${u}`);
      }
    }
    if (latest.gap_hint) {
      lines.push(`次の一手のヒント: ${latest.gap_hint}`);
    }
  }

  lines.push("");
  lines.push("[Goal Seek mode 中の方針]");
  lines.push("- 全 Acceptance Criteria を満たすまで response_complete は呼ばない (ハーネスが拒否する)");
  lines.push(
    "- 各反復は goal に近づくツール呼出を優先する (forward-chaining の思いつき優先より、 criteria 充足を優先)",
  );
  lines.push("- 行き詰まった場合は ask_user で user に相談");

  return lines.join("\n");
}
