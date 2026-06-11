/**
 * チャネル会話の分離とリクエストキュー (A-5: docs/channel-session-queue-design.md)
 *
 * - ConversationStore: 会話キー (Slack スレッド / Discord チャンネル) → 会話状態の in-memory LRU
 * - ChannelRunQueue: チャネル依頼の FIFO 直列実行 (拒否せず並ばせる)
 * - waitForAgentIdle: CLI 操作中はジョブ開始を待つ
 */

import type { ConversationState } from "./agent-loop.js";

/** 会話キー単位の in-memory LRU ストア。 プロセス再起動で消える (設計書 §4) */
export class ConversationStore {
  private map = new Map<string, ConversationState>();

  constructor(private maxConversations = 20) {}

  get(key: string): ConversationState | null {
    const state = this.map.get(key);
    if (!state) return null;
    // LRU: アクセスで末尾 (最新) に移動
    this.map.delete(key);
    this.map.set(key, state);
    return state;
  }

  set(key: string, state: ConversationState): void {
    this.map.delete(key);
    this.map.set(key, state);
    // 上限超過: 最も古い会話を破棄
    while (this.map.size > this.maxConversations) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * チャネル依頼の FIFO キュー。 Promise チェーンで 1 件ずつ直列実行する。
 * ジョブの失敗はチェーンを壊さない (次のジョブは実行される)。
 */
export class ChannelRunQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;

  /** 現在キューにある (実行中含む) ジョブ数 */
  get pending(): number {
    return this.pendingCount;
  }

  /**
   * ジョブを積む。 position = 自分より前に並んでいるジョブ数 (0 = 即実行)。
   * result はジョブ自身の完了 Promise (呼び出し元がエラー処理する)。
   */
  enqueue<T>(job: () => Promise<T>): { position: number; result: Promise<T> } {
    const position = this.pendingCount;
    this.pendingCount++;
    const result = this.chain.then(job, job); // 前ジョブの成否に関わらず実行
    this.chain = result
      .catch(() => undefined)
      .finally(() => {
        this.pendingCount--;
      });
    return { position, result };
  }
}

/**
 * CLI 操作 (isProcessing=true) が終わるまで待つ。 CLI 優先 (設計書 §3)。
 * チャネルジョブの冒頭で呼ぶ。 ジョブ自身が run() を開始すると isProcessing が
 * true になるため、 このチェックはジョブ開始前にのみ意味を持つ。
 */
export async function waitForAgentIdle(
  agent: { isProcessing: boolean },
  pollMs = 500,
): Promise<void> {
  while (agent.isProcessing) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
