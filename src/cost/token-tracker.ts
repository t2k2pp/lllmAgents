import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface TokenUsageRecord {
  timestamp: string;         // ISO 8601
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  sessionId?: string;
}

export interface SessionTotal {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  recordCount: number;
}

const USAGE_DIR = path.join(os.homedir(), ".localllm", "usage");

export class TokenTracker {
  private sessionRecords: TokenUsageRecord[] = [];

  /** API呼び出し後にトークン使用量を記録 */
  record(usage: TokenUsageRecord): void {
    this.sessionRecords.push(usage);
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

  /** 月次ログファイルに永続化 */
  flush(): void {
    if (this.sessionRecords.length === 0) return;

    try {
      if (!fs.existsSync(USAGE_DIR)) {
        fs.mkdirSync(USAGE_DIR, { recursive: true });
      }

      const now = new Date();
      const filename = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}.jsonl`;
      const filePath = path.join(USAGE_DIR, filename);

      const lines = this.sessionRecords
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";

      fs.appendFileSync(filePath, lines, "utf-8");
    } catch {
      // 永続化エラーは無視（データ損失は許容）
    }
  }
}
