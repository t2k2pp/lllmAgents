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

/**
 * 全レコード共通の文脈タグ (docs/async-surface-permission-delivery-design.md R-4/5.5)。
 * roomId = この run がロードしている Room (A/B/C)。 surface = 発信面 (cli/discord/slack)。
 * 単一 AgentLoop を全 Room/面で共有するため、 これが無いと「この run は REPL か Discord か /
 * どの Room か」を事後解析で判別できない。 書き込み時に AgentLoop の状態から注入する。
 */
export interface LogContext {
  roomId?: string;
  surface?: string;
}

export interface LLMRequestLog extends LogContext {
  ts: string;
  turn: number;
  agentId: string;
  type: "request";
  model: string;
  messages: unknown[];
  tools?: unknown[];
}

export interface LLMResponseLog extends LogContext {
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
  finishReason?: string;
}

/**
 * ツール実行結果ログ。
 *
 * セッション resume 時にツール往復を再生するために必要。
 * input は JSON.parse 試行、失敗時は raw string を入れる。
 */
export interface LLMToolResultLog extends LogContext {
  ts: string;
  turn: number;
  agentId: string;
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

export type LLMLogEntry = LLMRequestLog | LLMResponseLog | LLMToolResultLog;

export class LLMLogger {
  private readonly filePath: string;
  private turn: number = 0;
  private requestStartMs: number = 0;
  /** 書き込み時に roomId/surface を引くプロバイダ (AgentLoop が設定)。 5.5。 */
  private contextProvider?: () => LogContext;

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

  /** roomId/surface を書き込み時に引くためのプロバイダを設定する (5.5)。 */
  setContext(provider: () => LogContext): void {
    this.contextProvider = provider;
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

  /**
   * ツール実行結果をログに記録。
   * セッション resume 時にツール往復を再生するために必須。
   */
  logToolResult(data: {
    toolCallId: string;
    toolName: string;
    rawArguments: string;
    output: string;
    success: boolean;
    error?: string;
    durationMs: number;
  }): void {
    let input: unknown = data.rawArguments;
    try {
      input = JSON.parse(data.rawArguments || "{}");
    } catch {
      // パース失敗は raw string のまま記録
    }
    this.write({
      ts: new Date().toISOString(),
      turn: this.turn,
      agentId: this.agentId,
      type: "tool_result",
      toolCallId: data.toolCallId,
      toolName: data.toolName,
      input,
      output: data.output,
      success: data.success,
      error: data.error,
      durationMs: data.durationMs,
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
      // roomId/surface を書き込み時に注入 (undefined は JSON.stringify が省く＝旧挙動と互換)。
      const ctx = this.contextProvider?.() ?? {};
      const enriched = { ...entry, roomId: ctx.roomId, surface: ctx.surface };
      fs.appendFileSync(this.filePath, JSON.stringify(enriched) + "\n", "utf-8");
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
