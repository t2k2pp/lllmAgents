import { appendUsageRecord } from "./usage-store.js";

/** named model slot / subagent も集計軸に出せるよう、予約値以外の文字列も許容する。 */
export type UsageSlot = "main" | "second" | "vision" | "image" | "subagent" | (string & {});

export interface TokenUsageRecord {
  timestamp: string; // ISO 8601
  provider: string;
  model: string;
  /** どのスロットの消費か。 未指定は "main" 扱い (後方互換) */
  slot?: UsageSlot;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  /** 画像生成 (slot="image") の生成枚数。docs/image-generation.md §6 */
  imageCount?: number;
  sessionId?: string;
}

export interface SessionTotal {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  recordCount: number;
}

export class TokenTracker {
  private sessionRecords: TokenUsageRecord[] = [];

  /** API呼び出し後にトークン使用量を記録 (in-memory + 月次 jsonl へインクリメンタル永続化) */
  record(usage: TokenUsageRecord): void {
    this.sessionRecords.push(usage);
    // 永続化は best-effort (失敗してもセッション表示には影響させない)
    appendUsageRecord(usage);
  }

  /** in-memory のセッションレコードをクリア (/cost reset 用) */
  clearSession(): void {
    this.sessionRecords = [];
  }

  /** セッション全体のトークン合計・コスト合計を取得 */
  getSessionTotal(): SessionTotal {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    for (const r of this.sessionRecords) {
      totalInputTokens += r.inputTokens;
      totalOutputTokens += r.outputTokens;
      totalCostUsd += r.estimatedCostUsd;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      recordCount: this.sessionRecords.length,
    };
  }

  /** セッション内の全レコードを取得 */
  getRecords(): readonly TokenUsageRecord[] {
    return this.sessionRecords;
  }
}

export const globalTokenTracker = new TokenTracker();
