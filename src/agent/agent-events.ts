/**
 * AgentEventBus — AgentLoop のイベント境界 (docs/agent-events-design.md)
 *
 * 「何が起きたか (イベント)」 と 「どう見せるか (レンダリング)」 を分離し、
 * Slack / Discord 等のチャネルを 「もう一つのフロントエンド」 として扱うための基盤。
 *
 * Phase 1: AgentLoop が発火し、 チャネルアダプタが購読する (CLI 表示は従来どおりインライン)。
 * Phase 2 (A-4): CLI レンダリングを購読者へ移設。
 * Phase 3 (A-2/A-3): InteractionBridge (Promise 返却型の対話) を接続。
 */

import type { RequestSource } from "../security/permission-manager.js";
import * as logger from "../utils/logger.js";

/** run() 全体の終了区分。 docs/agent-events-design.md §3.1 */
export type TaskOutcome =
  | "completed"
  | "aborted"
  | "error"
  | "max_iterations"
  | "incomplete";

export interface AgentEventMap {
  /** run() 開始 */
  task_start: {
    source: RequestSource;
    /** ユーザー入力のテキスト部分 */
    prompt: string;
    timestamp: number;
  };
  /**
   * アシスタントテキストの確定。 think タグ除去済み。
   * final=true: ユーザー向け最終応答 (CLI の白/Markdown 表示に対応)
   * final=false: 中間ナレーション (CLI の灰色表示に対応)
   */
  assistant_text: {
    text: string;
    final: boolean;
  };
  /** ツール実行直前 (単発・並列両ルート) */
  tool_start: {
    callId: string;
    name: string;
    /** formatToolCall による 1 行サマリ (例: "file_read src/index.ts") */
    summary: string;
  };
  /** ツール実行完了 */
  tool_end: {
    callId: string;
    name: string;
    summary: string;
    success: boolean;
    durationMs: number;
    error?: string;
  };
  /** ハーネス介入・診断の主要通知 (自己点検 / 接続リトライ / ソフトキャップ / stuck-loop 等) */
  harness_notice: {
    level: "info" | "warn" | "error";
    message: string;
  };
  /** run() 終了 (finally で必ず発火) */
  task_complete: {
    source: RequestSource;
    outcome: TaskOutcome;
    /** ユーザー向け最終テキスト (response_complete の summary または最終応答)。 error/aborted 系は空 */
    finalResponse: string;
    /** 消費した反復数 */
    iterations: number;
    durationMs: number;
    /** 実行したツール呼び出し数 */
    toolsExecuted: number;
    /** この run で file_write / file_edit が成功したファイル (重複なし)。 A-6 完了報告用 */
    filesChanged: string[];
    /** この run の累計トークン (provider が usage を報告した分のみ) */
    tokensIn: number;
    tokensOut: number;
    /** この run の推定コスト USD (コスト単価未登録モデルは 0) */
    costUsd: number;
  };
}

export type AgentEventName = keyof AgentEventMap;

export type AgentEventListener<E extends AgentEventName> = (
  payload: AgentEventMap[E],
) => void | Promise<void>;

/** 購読解除関数 */
export type Unsubscribe = () => void;

/**
 * 型付きイベントバス。
 *
 * - リスナー例外は隔離する (チャネル側の障害でエージェント本体を止めない)
 * - 同期 dispatch。 async リスナーは fire-and-forget (順序保証は購読側で直列化する)
 * - node:events を使わない理由: 型安全 / 依存最小 / "error" イベントの暗黙 throw 仕様の回避
 */
export class AgentEventBus {
  private listeners = new Map<AgentEventName, Set<AgentEventListener<AgentEventName>>>();

  on<E extends AgentEventName>(event: E, listener: AgentEventListener<E>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as AgentEventListener<AgentEventName>);
    return () => this.off(event, listener);
  }

  off<E extends AgentEventName>(event: E, listener: AgentEventListener<E>): void {
    this.listeners.get(event)?.delete(listener as AgentEventListener<AgentEventName>);
  }

  emit<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // emit 中の on/off で iteration が壊れないようスナップショットを取る
    for (const listener of [...set]) {
      try {
        const r = (listener as AgentEventListener<E>)(payload) as unknown;
        // async リスナーの未捕捉 rejection も握りつぶさず debug ログへ
        if (r instanceof Promise) {
          r.catch((e) =>
            logger.debug(`AgentEventBus async listener error (${event}): ${e}`),
          );
        }
      } catch (e) {
        logger.debug(`AgentEventBus listener error (${event}): ${e}`);
      }
    }
  }

  listenerCount(event: AgentEventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 (A-2/A-3) への seam — 型定義のみ。 まだどこからも接続されない。
// イベント (通知・一方向) と対話 (要求・応答) は別機構として扱う。
// docs/agent-events-design.md §4.1
// ─────────────────────────────────────────────────────────────────────────────

export interface PermissionRequest {
  toolName: string;
  params: Record<string, unknown>;
  source: RequestSource;
  /** 権限確認文に出す 1 行サマリ */
  summary: string;
}

export type PermissionDecision = "allow_once" | "allow_session" | "deny";

export interface AskUserRequest {
  question: string;
  choices?: string[];
  source: RequestSource;
}

export interface AskUserResponse {
  answer: string;
}

/**
 * チャネル経由の対話ブリッジ (A-2: 権限確認 / A-3: ask_user)。
 * 未設定時は従来の headless 動作 (拒否 / ツール非公開) にフォールバックする。
 * 実装はタイムアウト付き Promise を返すこと (タイムアウト時は deny / 空回答)。
 */
export interface InteractionBridge {
  requestPermission?(req: PermissionRequest): Promise<PermissionDecision>;
  askUser?(req: AskUserRequest): Promise<AskUserResponse>;
}
