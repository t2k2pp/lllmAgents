/**
 * コンテキスト戦略 — 区切りでの圧縮・忘却・Clear の使い分け
 *
 * 従来はコンテキスト操作の発火条件が「推定トークンが閾値を超えたとき」 の 1 つしかなく、
 * 作業の最中に突然走っていた。 本モジュールは **作業の区切り**を検出し、
 * 区切りの強さと使用量に応じて 5 つのアクションを使い分ける。
 *
 * 同じ「削る」 でも、 いつやるかで削れる量と失うものが桁違いに変わる、 が中心思想。
 *
 * docs/context-strategy.md が正本。
 */
import * as logger from "../utils/logger.js";

// ─── 型 ───

/** 区切りで取り得るアクション (docs §2)。 上から順に失うものが大きい */
export type StrategyAction = "none" | "forget-thinking" | "forget" | "compress" | "clear";

/**
 * 区切りの種類。 決定表 (docs §4.1) の列に対応する。
 *  - weak: 探索の過程は捨ててよいが話の筋は要る
 *  - strong: 前のタスクの詳細をほぼ全部捨ててよい
 *  - peak: これから重くなる (山場の直前)。 枠を空けつつ文脈は保ちたい
 */
export type BreakKind = "weak" | "strong" | "peak";

/** config.context.strategy.mode (docs §5.1) */
export type StrategyMode = "off" | "auto" | "aggressive";

export interface BreakSignalDef {
  kind: BreakKind;
  /** ユーザーへの報告に出す短いラベル */
  label: string;
}

/**
 * 区切り / 山場のシグナル定義 (docs §3.1 / §3.2)。
 * ID は設計書の表と 1:1 で対応させてある (実装と設計書を突き合わせやすくするため)。
 */
export const BREAK_SIGNALS = {
  B1: { kind: "strong", label: "ToDo が全て完了" },
  B2: { kind: "strong", label: "git commit" },
  B3: { kind: "strong", label: "Goal 達成" },
  B4: { kind: "weak", label: "ToDo を 1 つ完了" },
  B5: { kind: "weak", label: "応答完了" },
  B6: { kind: "weak", label: "話題の切り替わり" },
  P1: { kind: "peak", label: "多段の ToDo を作成" },
  P2: { kind: "peak", label: "計画から実装へ移行" },
  P3: { kind: "peak", label: "複雑なタスクの依頼" },
} as const satisfies Record<string, BreakSignalDef>;

export type BreakSignalId = keyof typeof BREAK_SIGNALS;

/** シグナルの強さ順 (待ち行列から 1 つ選ぶときに強い方を優先する) */
const KIND_PRIORITY: Record<BreakKind, number> = { weak: 0, peak: 1, strong: 2 };

/** 待ち行列に積まれた 1 件。 fingerprint は「同じ区切り」 を識別する指紋 (docs §5.2) */
export interface PendingBreak {
  signal: BreakSignalId;
  fingerprint: string;
}

/** 複数のシグナルが同時に立ったら、 より強いものを採用する (docs §3.2) */
export function pickStrongest(pending: PendingBreak[]): PendingBreak | null {
  let best: PendingBreak | null = null;
  for (const p of pending) {
    if (!best || KIND_PRIORITY[BREAK_SIGNALS[p.signal].kind] > KIND_PRIORITY[BREAK_SIGNALS[best.signal].kind]) {
      best = p;
    }
  }
  return best;
}

// ─── 決定表 (docs §4.1) ───

/** 使用率の境界。 40% 未満は「削る必要が無いのに削ると損」 なので何もしない */
export const USAGE_BANDS = { low: 0.4, mid: 0.6, high: 0.75 } as const;

/**
 * 使用率 (tokens / contextWindow) と区切りの強さからアクションを決める。
 *
 * | 使用率 | 弱い区切り | 強い区切り | 山場の直前 |
 * |--------|-----------|-----------|-----------|
 * | 〜40%  | none            | none            | none            |
 * | 40〜60%| forget-thinking | forget-thinking | forget-thinking |
 * | 60〜75%| forget-thinking | forget          | forget          |
 * | 75%〜  | forget          | clear           | compress        |
 */
export function decideAction(usageRatio: number, kind: BreakKind): StrategyAction {
  if (!Number.isFinite(usageRatio) || usageRatio < USAGE_BANDS.low) return "none";
  if (usageRatio < USAGE_BANDS.mid) return "forget-thinking";
  if (usageRatio < USAGE_BANDS.high) return kind === "weak" ? "forget-thinking" : "forget";
  if (kind === "weak") return "forget";
  // 山場では「これから大量に読む」。 clear すると入口で迷子になるので要約で枠を確保する
  return kind === "peak" ? "compress" : "clear";
}

// ─── ガード (docs §4.3) ───

/** 直前のコンテキスト操作からこのターン数未満なら見送る (連続発火で毎ターン待たされるのを防ぐ) */
export const MIN_INTERVAL_TURNS = 3;

export interface GuardInput {
  mode: StrategyMode;
  /** 直前にコンテキスト操作を実行してからのターン数 */
  turnsSinceLastAction: number;
  /** 未完了の ToDo に in_progress があるか */
  hasInProgressTodo: boolean;
  /** Goal Seek 実行中か */
  goalActive: boolean;
  /** clear の確認が取れるか (TTY かつ CLI 発話) */
  canConfirm: boolean;
  /** span の途中か (ツール実行の合間)。 途中では履歴を消さない */
  midSpan: boolean;
}

export interface GuardOutcome {
  action: StrategyAction;
  /** 格下げの記録。 黙って弱いアクションに落とさないため必ずユーザーにも見せる */
  downgrades: string[];
  /** ガードにより見送ったか */
  skipped: boolean;
}

/**
 * 決定表の結果にガードを適用する。
 * clear は失うものが最大なので、 少しでも危うい条件が揃っていたら格下げする。
 */
export function applyGuards(action: StrategyAction, input: GuardInput): GuardOutcome {
  const downgrades: string[] = [];
  if (action === "none") return { action, downgrades, skipped: false };

  // 最短間隔: 区切りが立て続けに来ても毎ターン整理はしない
  if (input.turnsSinceLastAction < MIN_INTERVAL_TURNS) {
    return {
      action: "none",
      downgrades,
      skipped: true,
    };
  }

  let current: StrategyAction = action;
  const downgrade = (to: StrategyAction, reason: string): void => {
    downgrades.push(`${current} → ${to}: ${reason}`);
    current = to;
  };

  if (current === "clear" && input.midSpan) {
    // 作業の合間に履歴を変更すると、モデルが今やっていることの文脈を失い得る。
    downgrade("none", "作業の途中 (ツール実行の合間) のため履歴変更を見送ります");
  }
  if (current === "clear" && input.hasInProgressTodo) {
    downgrade("none", "着手中の ToDo が残っているため履歴変更を見送ります");
  }
  if (current === "clear" && input.goalActive) {
    downgrade("none", "Goal Seek 実行中のため履歴変更を見送ります");
  }
  // 確認が必要なのに取れない場合は、別の履歴変更へ自動で切り替えず見送る。
  // aggressive は確認そのものが不要なので対象外。
  if (current === "clear" && input.mode === "auto" && !input.canConfirm) {
    downgrade("none", "確認を取れない経路 (非 TTY / Discord / Slack) のため履歴変更を見送ります");
  }

  return { action: current, downgrades, skipped: false };
}

/** clear の実行前にユーザー確認が要るか (docs §5.1) */
export function needsConfirmation(action: StrategyAction, mode: StrategyMode): boolean {
  return action === "clear" && mode === "auto";
}

// ─── 判断ログ ───

export interface StrategyDecision {
  at: number;
  signal: BreakSignalId;
  signalLabel: string;
  kind: BreakKind;
  usageRatio: number;
  /** 決定表が返した素の判断 */
  proposed: StrategyAction;
  /** ガード適用後の最終判断 */
  action: StrategyAction;
  downgrades: string[];
  skipped: boolean;
  /** 見送り / 格下げの補足 */
  note?: string;
}

/** 判断ログの保持件数 (/context strategy の表示用。 増やしても価値が薄いので直近のみ) */
const MAX_DECISION_LOG = 20;

// ─── 表示文言 ───

export const ACTION_LABELS: Record<StrategyAction, string> = {
  none: "何もしませんでした",
  "forget-thinking": "探索の記録を忘却しました",
  forget: "忘却でコンテキストを整理しました",
  compress: "履歴を圧縮しました",
  clear: "引き継ぎメモを残して履歴をリセットしました",
};

export const ACTION_DESCRIPTIONS: Record<StrategyAction, string> = {
  none: "何もしない",
  "forget-thinking": "読取系ツールの結果本文と思考を機械的に落とす (LLM 呼び出しなし)",
  forget: "何を残すかをモデルに選ばせて忘却する (LLM 1 回)",
  compress: "古い履歴を要約に置き換える (LLM 4〜5 回)",
  clear: "引き継ぎメモを残して履歴をリセットする (LLM 1 回)",
};

export const MODE_DESCRIPTIONS: Record<StrategyMode, string> = {
  off: "区切り検出を行わない (従来通り閾値のみ)",
  auto: "区切りで自動実行。 ただし clear は確認を取る (既定)",
  aggressive: "clear も確認なしで実行",
};

const pct = (ratio: number): string => `${Math.round(Math.max(0, ratio) * 100)}%`;

/**
 * アクション実行後の 1 行報告 (docs §6)。
 * 黙って履歴が変わることがあってはならないので、 走ったら必ずこれを出す。
 */
export function formatStrategyReport(params: {
  signalLabel: string;
  action: StrategyAction;
  freedTokens: number;
  beforeRatio: number;
  afterRatio: number;
}): string {
  const freed = Math.max(0, Math.round(params.freedTokens));
  return (
    `区切りを検出 (${params.signalLabel}) — ${ACTION_LABELS[params.action]} ` +
    `(-${freed.toLocaleString("en-US")} トークン / 使用率 ${pct(params.beforeRatio)} → ${pct(params.afterRatio)})`
  );
}

/** 格下げの通知文 (docs §4.3 — 「clear するはずが compress になった」 を黙って起こさない) */
export function formatDowngradeNotice(decision: StrategyDecision): string | null {
  if (decision.downgrades.length === 0) return null;
  return `コンテキスト戦略: 判断を格下げしました (${decision.downgrades.join(" / ")})`;
}

// ─── 本体 ───

export interface ContextStrategyOptions {
  mode?: StrategyMode;
  minIntervalTurns?: number;
}

/**
 * 区切りシグナルを受け取り、 何をするかを決める。
 * 実行そのものは行わない (ContextManager.applyStrategy が実行口)。
 */
export class ContextStrategy {
  private mode: StrategyMode;
  private minIntervalTurns: number;
  /** AgentLoop が反復ごとに進めるターンカウンタ */
  private turn = 0;
  /** 直近でアクションを実行したターン。 未実行なら -Infinity */
  private lastActionTurn = Number.NEGATIVE_INFINITY;
  private decisions: StrategyDecision[] = [];
  /** 「何もしない」 を選ばれた区切りの指紋。 同じ区切りでは二度と聞かない (docs §5.2) */
  private declined = new Set<string>();

  constructor(opts: ContextStrategyOptions = {}) {
    this.mode = opts.mode ?? "auto";
    this.minIntervalTurns = opts.minIntervalTurns ?? MIN_INTERVAL_TURNS;
  }

  getMode(): StrategyMode {
    return this.mode;
  }

  setMode(mode: StrategyMode): void {
    this.mode = mode;
  }

  isEnabled(): boolean {
    return this.mode !== "off";
  }

  /** AgentLoop が反復ごとに呼ぶ */
  noteTurn(): void {
    this.turn++;
  }

  /** ユーザーが「何もしない」 を選んだ区切りを記録する */
  decline(fingerprint: string): void {
    this.declined.add(fingerprint);
  }

  isDeclined(fingerprint: string): boolean {
    return this.declined.has(fingerprint);
  }

  /** アクションを実行し終えたら呼ぶ (最短間隔の起点になる) */
  noteApplied(): void {
    this.lastActionTurn = this.turn;
  }

  getDecisions(): StrategyDecision[] {
    return [...this.decisions];
  }

  /**
   * 区切りシグナルに対する判断を返す。 判断は必ずログに残す
   * (何が起きたか / 何が起きなかったかを後から追えるようにする)。
   */
  decide(input: {
    signal: BreakSignalId;
    fingerprint: string;
    usageRatio: number;
    hasInProgressTodo: boolean;
    goalActive: boolean;
    canConfirm: boolean;
    midSpan: boolean;
  }): StrategyDecision {
    const def = BREAK_SIGNALS[input.signal];
    const base: StrategyDecision = {
      at: Date.now(),
      signal: input.signal,
      signalLabel: def.label,
      kind: def.kind,
      usageRatio: input.usageRatio,
      proposed: "none",
      action: "none",
      downgrades: [],
      skipped: false,
    };

    if (this.mode === "off") {
      return this.record({ ...base, skipped: true, note: "mode=off" });
    }

    const proposed = decideAction(input.usageRatio, def.kind);
    if (proposed === "none") {
      return this.record({ ...base, proposed, note: "使用率が低く整理不要" });
    }

    const guarded = applyGuards(proposed, {
      mode: this.mode,
      turnsSinceLastAction: this.turn - this.lastActionTurn,
      hasInProgressTodo: input.hasInProgressTodo,
      goalActive: input.goalActive,
      canConfirm: input.canConfirm,
      midSpan: input.midSpan,
    });

    if (guarded.skipped) {
      return this.record({
        ...base,
        proposed,
        skipped: true,
        note: `直前の整理から ${this.minIntervalTurns} ターン未満`,
      });
    }

    // 同じ区切りで一度「何もしない」 を選ばれていたら、別の履歴変更も自動実行しない。
    let action = guarded.action;
    const downgrades = [...guarded.downgrades];
    if (action === "clear" && this.isDeclined(input.fingerprint)) {
      downgrades.push("clear → none: 同じ区切りで既に見送りを選択済み");
      action = "none";
    }

    return this.record({ ...base, proposed, action, downgrades });
  }

  private record(decision: StrategyDecision): StrategyDecision {
    this.decisions.push(decision);
    if (this.decisions.length > MAX_DECISION_LOG) this.decisions.shift();
    logger.info(
      `[strategy] ${decision.signal}(${decision.signalLabel}) 使用率=${pct(decision.usageRatio)} ` +
        `提案=${decision.proposed} 実行=${decision.skipped ? "見送り" : decision.action}` +
        (decision.downgrades.length > 0 ? ` 格下げ=[${decision.downgrades.join(" / ")}]` : "") +
        (decision.note ? ` (${decision.note})` : ""),
    );
    return decision;
  }
}
