import type { LLMProvider } from "../providers/base-provider.js";
import type { MessageHistory } from "./message-history.js";
import type { ForgettingConfig, ReductionMode } from "../config/types.js";
import { estimateMessageTokens } from "./token-counter.js";
import { HierarchicalCompressor } from "./hierarchical-compressor.js";
import { ForgettingEngine, DEFAULT_KEEP_RECENT_SEGMENTS, forgetThinking } from "./forgetting.js";
import type { ForgetDryRunReport, ForgetResult, ForgetThinkingResult } from "./forgetting.js";
import { runHandoff, type HandoffResult, type HandoffOptions } from "./handoff.js";
import type { StrategyAction } from "./context-strategy.js";
import * as logger from "../utils/logger.js";

/** 目標削減量を閾値の何ポイント下に置くか (docs/context-forgetting.md §6.1) */
const DEFAULT_TARGET_MARGIN_RATIO = 0.15;
/** hybrid で圧縮まで続行するかの判定比 (目標に対する達成率) */
const DEFAULT_SUFFICIENCY_RATIO = 0.6;
/** 自動忘却の最短間隔 (ターン数、 docs §10) */
const DEFAULT_MIN_INTERVAL_TURNS = 3;

/** reduce() が実際に何をしたか。 silent な欠損を作らないため呼び出し側で必ず提示する */
export interface ReduceOutcome {
  method: "forget" | "compress" | "forget+compress" | "none";
  /** 忘却を試みた場合の結果 (試みていなければ null) */
  forget: ForgetResult | null;
  /** 圧縮を実行したか (チャットログのパート分割判定に使う) */
  compressed: boolean;
  beforeTokens: number;
  afterTokens: number;
  /** 何もしなかった / 部分的に終わった理由 */
  note?: string;
}

/** ReduceOutcome を 1 行のユーザー向け文言にする */
export function formatReduceOutcome(outcome: ReduceOutcome): string {
  const freed = Math.max(0, outcome.beforeTokens - outcome.afterTokens);
  const freedText = `約 ${freed.toLocaleString("en-US")} トークン削減`;
  switch (outcome.method) {
    case "forget": {
      const f = outcome.forget;
      return `コンテキストを忘却で整理しました (thin ${f?.thinnedSegments ?? 0} / drop ${f?.droppedSegments ?? 0}、 ${freedText})`;
    }
    case "forget+compress": {
      const f = outcome.forget;
      return `忘却 (thin ${f?.thinnedSegments ?? 0} / drop ${f?.droppedSegments ?? 0}) + 圧縮でコンテキストを整理しました (${freedText})`;
    }
    case "compress":
      return `コンテキストを圧縮しました (${freedText})`;
    default:
      return `コンテキストは整理できませんでした${outcome.note ? ` (${outcome.note})` : ""}`;
  }
}

/** applyStrategy() が実際に何をしたか (docs/context-strategy.md §6 の報告に使う) */
export interface StrategyOutcome {
  action: StrategyAction;
  applied: boolean;
  beforeTokens: number;
  afterTokens: number;
  freedTokens: number;
  beforeRatio: number;
  afterRatio: number;
  /** 適用しなかった / 部分的に終わった理由 */
  note?: string;
  forget: ForgetResult | null;
  thinking: ForgetThinkingResult | null;
  handoff: HandoffResult | null;
}

export class ContextManager {
  private contextWindow: number;
  private threshold: number;
  private keepRecentMessages: number;
  private compressor: HierarchicalCompressor;
  private forgetter: ForgettingEngine;
  /** 引き継ぎメモ生成用。 compressor / forgetter と同じ provider を使う */
  private provider: LLMProvider;
  private model: string;
  private reductionMode: ReductionMode;
  private forgettingConfig: ForgettingConfig;
  /** 直近で忘却を実行したターン番号 (最短間隔の判定用)。 未実行なら -Infinity */
  private lastForgetTurn = Number.NEGATIVE_INFINITY;
  /** AgentLoop が反復ごとに進めるターンカウンタ */
  private turn = 0;

  constructor(
    provider: LLMProvider,
    model: string,
    contextWindow: number,
    // P2-B: 旧 0.8 → 0.7 に前倒し。 80% 到達時の圧縮は対象が大きく遅延が嵩むため、
    // 早めに小さく頻繁に圧縮する方が体感が良い。 docs/agent-loop-efficiency-review.md §4.8 参照。
    threshold = 0.7,
    keepRecentMessages = 10,
    reductionMode: ReductionMode = "hybrid",
    forgettingConfig: ForgettingConfig = {},
  ) {
    this.contextWindow = contextWindow;
    this.threshold = threshold;
    this.keepRecentMessages = keepRecentMessages;
    this.provider = provider;
    this.model = model;
    this.compressor = new HierarchicalCompressor(provider, model);
    this.reductionMode = reductionMode;
    this.forgettingConfig = forgettingConfig;
    this.forgetter = new ForgettingEngine(provider, model, {
      keepRecentSegments: forgettingConfig.keepRecentSegments ?? DEFAULT_KEEP_RECENT_SEGMENTS,
    });
  }

  setContextWindow(value: number): void {
    this.contextWindow = value;
  }

  /**
   * Phase C-5: 圧縮閾値を変更する。 model 切替で能力ティアが変わったとき、
   * AgentLoop から capability.compressionThreshold を流し込む用途。
   */
  setThreshold(value: number): void {
    this.threshold = value;
  }

  /**
   * Phase D-4: 圧縮時に残す直近メッセージ数を変更。 短 ctx の T3 では 5 まで切り詰める。
   */
  setKeepRecentMessages(value: number): void {
    if (value > 0) this.keepRecentMessages = value;
  }

  setProvider(provider: LLMProvider, model: string): void {
    this.provider = provider;
    this.model = model;
    this.compressor.setProvider(provider, model);
    this.forgetter.setProvider(provider, model);
  }

  /** 縮約手段の切替 (/forget mode)。 docs/context-forgetting.md §6 */
  setReductionMode(mode: ReductionMode): void {
    this.reductionMode = mode;
  }

  getReductionMode(): ReductionMode {
    return this.reductionMode;
  }

  /** /forget status 用。 直近の忘却実績 */
  getLastForgetResult(): { result: ForgetResult; at: number } | null {
    return this.forgetter.getLastResult();
  }

  /** AgentLoop が反復ごとに呼ぶ。 忘却の最短間隔判定に使う */
  noteTurn(): void {
    this.turn++;
  }

  shouldCompress(history: MessageHistory): boolean {
    const messages = history.getMessages();
    const tokens = estimateMessageTokens(messages);
    const limit = this.contextWindow * this.threshold;
    logger.debug(
      `Context usage: ${tokens}/${this.contextWindow} tokens (${Math.round((tokens / this.contextWindow) * 100)}%)`,
    );
    return tokens > limit;
  }

  /** shouldCompress の別名。 縮約手段が圧縮固定でなくなったので意味に合う名前を用意する */
  shouldReduce(history: MessageHistory): boolean {
    return this.shouldCompress(history);
  }

  /** コンテキスト使用率 (0.0〜1.0)。 区切り判断の入力 (docs/context-strategy.md §4.1) */
  getUsageRatio(history: MessageHistory): number {
    if (this.contextWindow <= 0) return 0;
    return estimateMessageTokens(history.getMessages()) / this.contextWindow;
  }

  /**
   * 目標削減トークン数 (docs §6.1)。
   *   targetTokens = 現在の推定トークン - contextWindow * (threshold - margin)
   * 閾値ちょうどを狙うと次ターンで即再発火するため、 余裕を持って落とす。
   */
  computeTargetTokens(history: MessageHistory): number {
    const current = estimateMessageTokens(history.getMessages());
    const margin = this.forgettingConfig.targetMarginRatio ?? DEFAULT_TARGET_MARGIN_RATIO;
    const goal = this.contextWindow * Math.max(0.05, this.threshold - margin);
    return Math.max(0, Math.ceil(current - goal));
  }

  async compress(history: MessageHistory): Promise<void> {
    const messages = history.getRawMessages();
    if (messages.length <= this.keepRecentMessages) return;

    const olderMessages = messages.slice(0, -this.keepRecentMessages);

    logger.info(`Compressing context: ${olderMessages.length} older messages → hierarchical summary...`);

    // 階層的圧縮を実行
    const summary = await this.compressor.compress(olderMessages);

    // 圧縮結果で古いメッセージを置き換え
    history.replaceOlderMessages(summary, this.keepRecentMessages);
    logger.info("Context compressed successfully (hierarchical).");
  }

  /**
   * 忘却のみを実行する (/forget)。 mode に関係なく忘却を試みる。
   * 失敗しても履歴は変わらない (ForgettingEngine 側でロールバック済み)。
   */
  async forget(history: MessageHistory, targetTokens?: number): Promise<ForgetResult> {
    const target = targetTokens ?? Math.max(1, this.computeTargetTokens(history));
    const result = await this.forgetter.forget(history, target);
    if (result.applied) this.lastForgetTurn = this.turn;
    return result;
  }

  /** 忘却プランだけ出して適用しない (/forget dry) */
  async forgetDryRun(history: MessageHistory, targetTokens?: number): Promise<ForgetDryRunReport> {
    const target = targetTokens ?? Math.max(1, this.computeTargetTokens(history));
    return await this.forgetter.dryRun(history, target);
  }

  /**
   * 区切りアクションの実行口 (docs/context-strategy.md §7)。
   * 5 つのアクションをここに一本化し、 呼び出し側 (AgentLoop / /handoff) は
   * 「何をするか」 だけを決めて「どうやるか」 は知らなくてよい形にする。
   *
   * clear は引き継ぎメモの生成に成功したときだけ履歴を消す。 失敗時は履歴に触れず
   * applied=false で返し、呼び出し側は履歴を保持して失敗を報告する (docs §8)。
   */
  async applyStrategy(
    history: MessageHistory,
    action: StrategyAction,
    opts: HandoffOptions = {},
  ): Promise<StrategyOutcome> {
    const beforeTokens = estimateMessageTokens(history.getMessages());
    const finish = (
      partial: Pick<StrategyOutcome, "applied" | "note" | "forget" | "thinking" | "handoff">,
    ): StrategyOutcome => {
      const afterTokens = estimateMessageTokens(history.getMessages());
      return {
        action,
        beforeTokens,
        afterTokens,
        freedTokens: Math.max(0, beforeTokens - afterTokens),
        beforeRatio: this.contextWindow > 0 ? beforeTokens / this.contextWindow : 0,
        afterRatio: this.contextWindow > 0 ? afterTokens / this.contextWindow : 0,
        ...partial,
      };
    };
    const empty = { forget: null, thinking: null, handoff: null } as const;

    switch (action) {
      case "none":
        return finish({ applied: false, ...empty });

      case "forget-thinking": {
        // LLM を呼ばない決定論的な忘却。 待ち時間がほぼ無いのでこれが第一選択
        const result = forgetThinking(
          history,
          this.forgettingConfig.keepRecentSegments ?? DEFAULT_KEEP_RECENT_SEGMENTS,
        );
        return finish({ applied: result.applied, note: result.reason, ...empty, thinking: result });
      }

      case "forget": {
        const result = await this.forget(history);
        return finish({ applied: result.applied, note: result.reason, ...empty, forget: result });
      }

      case "compress": {
        await this.compress(history);
        this.lastForgetTurn = this.turn; // 圧縮も「整理した」 に数え、 直後の再発火を防ぐ
        return finish({ applied: true, ...empty });
      }

      case "clear": {
        const result = await runHandoff(this.provider, this.model, history, opts);
        if (result.applied) this.lastForgetTurn = this.turn;
        return finish({ applied: result.applied, note: result.reason, ...empty, handoff: result });
      }

      default: {
        // 網羅性チェック (新しいアクションを足したらここで型エラーになる)
        const exhaustive: never = action;
        logger.warn(`[strategy] 未知のアクション: ${String(exhaustive)}`);
        return finish({ applied: false, note: "未知のアクション", ...empty });
      }
    }
  }

  /**
   * 閾値超過時の縮約本体。 mode に応じて忘却・圧縮を選ぶ (docs §6)。
   *
   * forget は指定された手段だけを実行し、失敗時に別手段へ自動で切り替えない。
   * hybrid はユーザーが明示的に選んだ複合手段として、忘却後の圧縮までを一つの処理として扱う。
   */
  async reduce(history: MessageHistory): Promise<ReduceOutcome> {
    const beforeTokens = estimateMessageTokens(history.getMessages());
    const target = Math.max(1, this.computeTargetTokens(history));

    if (this.reductionMode === "compress") {
      await this.compress(history);
      return {
        method: "compress",
        forget: null,
        compressed: true,
        beforeTokens,
        afterTokens: estimateMessageTokens(history.getMessages()),
      };
    }

    // 毎ターン忘却が走ると LLM 呼び出しが毎ターン増えるため最短間隔を設ける (docs §10)。
    // forget 単独モードでは、間隔内に別手段へ切り替えず理由を明示して停止する。
    const minInterval = this.forgettingConfig.minIntervalTurns ?? DEFAULT_MIN_INTERVAL_TURNS;
    if (this.turn - this.lastForgetTurn < minInterval) {
      if (this.reductionMode === "forget") {
        throw new Error(
          `contextReduction=forget は直近の忘却から ${minInterval} ターン未満のため実行できません。 ` +
            "間隔を空けるか、複合処理を許可する場合は contextReduction=hybrid を明示してください。",
        );
      }

      logger.info(`[hybrid] 直近の忘却から ${minInterval} ターン未満のため、明示された複合処理の圧縮段階を実行します`);
      await this.compress(history);
      return {
        method: "compress",
        forget: null,
        compressed: true,
        beforeTokens,
        afterTokens: estimateMessageTokens(history.getMessages()),
        note: "hybrid の忘却最短間隔内のため圧縮段階を実行",
      };
    }

    const forgetResult = await this.forget(history, target);
    const afterForget = estimateMessageTokens(history.getMessages());
    const freed = Math.max(0, beforeTokens - afterForget);

    if (this.reductionMode === "forget" && !forgetResult.applied) {
      throw new Error(
        `contextReduction=forget を適用できませんでした: ${forgetResult.reason ?? "理由不明"}。 ` +
          "履歴は保持しました。圧縮も許可する場合は contextReduction=hybrid を明示してください。",
      );
    }

    // hybrid は明示された複合処理として、削減が目標に届かなければ圧縮段階へ進む。
    const sufficiency = this.forgettingConfig.sufficiencyRatio ?? DEFAULT_SUFFICIENCY_RATIO;
    const needCompress = this.reductionMode === "hybrid" && (!forgetResult.applied || freed < target * sufficiency);

    if (!needCompress) {
      return {
        method: "forget",
        forget: forgetResult,
        compressed: false,
        beforeTokens,
        afterTokens: afterForget,
      };
    }

    logger.info(
      `[forget] 削減 ${freed} / 目標 ${target} トークン → 圧縮を続行します (mode=${this.reductionMode}, applied=${forgetResult.applied})`,
    );
    await this.compress(history);
    return {
      method: forgetResult.applied ? "forget+compress" : "compress",
      forget: forgetResult,
      compressed: true,
      beforeTokens,
      afterTokens: estimateMessageTokens(history.getMessages()),
      note: forgetResult.applied ? "忘却だけでは目標に届かず圧縮を追加" : (forgetResult.reason ?? "忘却に失敗"),
    };
  }
}
