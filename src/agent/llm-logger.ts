/**
 * LLM I/O ロガー
 *
 * 各セッションのリクエスト・レスポンスを JSONL 形式で保存する。
 * エージェントごとにファイルを分離し、thinking content も含めて生データを保存。
 *
 * 保存先: ~/.localllm/logs/sessions/<sessionId>_<agentId>.jsonl
 *
 * 将来のビューワー向けに削らずに保存する方針。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface LLMRequestLog {
  ts: string;
  turn: number;
  agentId: string;
  type: "request";
  model: string;
  messages: unknown[];
  tools?: unknown[];
}

export interface LLMResponseLog {
  ts: string;
  turn: number;
  agentId: string;
  type: "response";
  model: string;
  thinking?: string;
  text?: string;
  toolCalls?: unknown[];
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
}

export type LLMLogEntry = LLMRequestLog | LLMResponseLog;

export class LLMLogger {
  private readonly filePath: string;
  private turn: number = 0;
  private requestStartMs: number = 0;

  constructor(
    private readonly agentId: string = "main",
    sessionId?: string,
  ) {
    const logsDir = path.join(os.homedir(), ".localllm", "logs", "sessions");
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch {
      // ディレクトリ作成失敗はサイレントに無視
    }
    const sid = sessionId ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.filePath = path.join(logsDir, `${sid}_${safeName}.jsonl`);
  }

  /** ターン番号をインクリメント（LLM呼び出し前に呼ぶ） */
  nextTurn(): void {
    this.turn++;
    this.requestStartMs = Date.now();
  }

  /** LLM リクエストをログに記録 */
  logRequest(messages: unknown[], model: string, tools?: unknown[]): void {
    this.write({
      ts: new Date().toISOString(),
      turn: this.turn,
      agentId: this.agentId,
      type: "request",
      model,
      messages,
      tools,
    });
  }

  /** LLM レスポンスをログに記録（thinking content 含む） */
  logResponse(data: {
    model: string;
    thinking?: string;
    text?: string;
    toolCalls?: unknown[];
    tokensIn?: number;
    tokensOut?: number;
    finishReason?: string;
  }): void {
    this.write({
      ts: new Date().toISOString(),
      turn: this.turn,
      agentId: this.agentId,
      type: "response",
      durationMs: this.requestStartMs ? Date.now() - this.requestStartMs : undefined,
      ...data,
    });
  }

  getFilePath(): string {
    return this.filePath;
  }

  getAgentId(): string {
    return this.agentId;
  }

  private write(entry: LLMLogEntry): void {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // ログ書き込み失敗はサイレントに無視（本体処理に影響させない）
    }
  }
}

/**
 * セッション ID を生成する。
 * AgentLoop インスタンス生成時に一度だけ呼び出し、
 * メインと全サブエージェントで共有することでログファイル名を揃える。
 */
export function createSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
