/**
 * LLM I/O ロガー
 *
 * 各セッションのリクエスト・レスポンスを JSONL 形式で保存する。
 * 機密値をマスクし、リクエスト履歴は前回からの差分だけを記録する。
 *
 * 保存先: ~/.localllm/logs/sessions/<sessionId>_<agentId>.jsonl
 *
 * 肥大化が本体を圧迫しないよう、単一ファイルにも上限を設ける。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CacheMissDiagnosis } from "./cache-miss.js";
import type { ReductionEventRecord } from "./reduction-event.js";
import type { SideCallRecord } from "./side-call.js";

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
  /**
   * messages が履歴全体の何番目から始まるか。v2 ログの差分復元用。
   * 前回 request と最初に食い違った位置。 前回の messageTotal より小さければ、 既存メッセージが
   * 書き換わった (= 前方一致キャッシュが外れた) ことを示す (docs/prompt-prefix-stability.md §4.1)。
   */
  messageOffset?: number;
  /** このリクエスト時点の履歴総件数。 */
  messageTotal?: number;
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
  /** プロンプトキャッシュで再利用された入力トークン数 (サーバが報告した時だけ)。 */
  tokensCached?: number;
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

/**
 * 送信済みの部分 (前回 request の列) が今回の request で変わった記録 = プロンプトキャッシュが外れた記録。
 * reasons が空なら、 理由の分かっている書き換え (忘却・圧縮 等) ではない「予期しない破壊」。
 * docs/prompt-prefix-stability.md §7。
 */
export interface LLMPrefixBreakLog extends LogContext {
  ts: string;
  turn: number;
  agentId: string;
  type: "prefix_break";
  /** 前回 request と最初に食い違った位置 */
  messageOffset: number;
  /** 前回 request の件数 */
  previousTotal: number;
  /** tools 定義が変わったか */
  toolsChanged: boolean;
  /** 履歴側が申告した書き換え理由 (ephemeral-purge / thinking-clear / replace / compress / system-prompt / clear) */
  reasons: string[];
  /** 理由の申告が無い = 予期しない破壊 */
  unexpected: boolean;
}

/**
 * 脇の呼び出し (本体の会話ループ以外の LLM 呼び出し) 1 件の記録。 src/agent/side-call.ts の入口が書く。
 * docs/context-reduction-redesign.md §10.3。
 */
export interface LLMSideCallLog extends LogContext, SideCallRecord {
  ts: string;
  turn: number;
  agentId: string;
  type: "side_call";
}

/**
 * 本体呼び出しでプロンプトキャッシュが外れた記録。 原因は前回の本体呼び出しからの間に起きたこと。
 * docs/context-reduction-redesign.md §10.2。
 */
export interface LLMCacheMissLog extends LogContext, CacheMissDiagnosis {
  ts: string;
  turn: number;
  agentId: string;
  type: "cache_miss";
}

/**
 * 整理イベント 1 件の記録 (成功・失敗のどちらも)。 docs/context-reduction-redesign.md §10.1。
 */
export interface LLMReductionEventLog extends LogContext, ReductionEventRecord {
  ts: string;
  turn: number;
  agentId: string;
  type: "reduction_event";
}

/** logRequest() の返り値。 前方一致が保たれたかを呼び出し側が判定するのに使う。 */
export interface RequestPrefixInfo {
  messageOffset: number;
  previousTotal: number;
  toolsChanged: boolean;
}

export type LLMLogEntry =
  | LLMRequestLog
  | LLMResponseLog
  | LLMToolResultLog
  | LLMPrefixBreakLog
  | LLMSideCallLog
  | LLMCacheMissLog
  | LLMReductionEventLog;

export interface LLMLoggerOptions {
  logsDir?: string;
  /** 単一 JSONL の最大容量。既定 32 MiB。 */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_STRING_CHARS = 128 * 1024;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\b(?:xox[baprs]-)[A-Za-z0-9-]{10,}/gi,
];

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "webhook" ||
    normalized === "webhookurl" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

/** ログ用に機密値と極端に長い文字列を除去する。入力オブジェクトは変更しない。 */
export function sanitizeLogValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (isSecretKey(key)) return "[REDACTED]";
  if (typeof value === "string") {
    let sanitized = value;
    for (const pattern of SECRET_VALUE_PATTERNS) sanitized = sanitized.replace(pattern, "[REDACTED]");
    return sanitized.length > MAX_STRING_CHARS
      ? `${sanitized.slice(0, MAX_STRING_CHARS)}\n... [log value truncated]`
      : sanitized;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item, "", seen));
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeLogValue(childValue, childKey, seen);
  }
  return out;
}

export class LLMLogger {
  private readonly filePath: string;
  private turn: number = 0;
  private requestStartMs: number = 0;
  /** 前回 request の各メッセージの JSON。 最初に食い違った位置を求めるために保持する。 */
  private previousMessageJsons: string[] = [];
  private previousToolsJson?: string;
  private readonly maxFileBytes: number;
  private bytesWritten = 0;
  private limitReached = false;
  /** 書き込み時に roomId/surface を引くプロバイダ (AgentLoop が設定)。 5.5。 */
  private contextProvider?: () => LogContext;

  constructor(
    private readonly agentId: string = "main",
    sessionId?: string,
    options: LLMLoggerOptions = {},
  ) {
    const logsDir = options.logsDir ?? path.join(os.homedir(), ".localllm", "logs", "sessions");
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch {
      // ディレクトリ作成失敗はサイレントに無視
    }
    const sid = sessionId ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.filePath = path.join(logsDir, `${sid}_${safeName}.jsonl`);
    try {
      this.bytesWritten = fs.statSync(this.filePath).size;
    } catch {
      this.bytesWritten = 0;
    }
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
  logRequest(messages: unknown[], model: string, tools?: unknown[]): RequestPrefixInfo {
    // 件数ではなく内容で比べる: 件数だけだと既存メッセージの書き換えが記録に残らず、
    // キャッシュが外れた原因も、 ログからの再現も分からなくなる。
    const messageJsons = messages.map((m) => JSON.stringify(m));
    const prev = this.previousMessageJsons;
    let messageOffset = 0;
    while (
      messageOffset < prev.length &&
      messageOffset < messageJsons.length &&
      prev[messageOffset] === messageJsons[messageOffset]
    ) {
      messageOffset++;
    }
    const messageDelta = messages.slice(messageOffset);
    const previousTotal = prev.length;
    this.previousMessageJsons = messageJsons;
    const toolsJson = tools === undefined ? undefined : JSON.stringify(sanitizeLogValue(tools));
    const changedTools = toolsJson !== this.previousToolsJson ? tools : undefined;
    this.previousToolsJson = toolsJson;
    this.write({
      ts: new Date().toISOString(),
      turn: this.turn,
      agentId: this.agentId,
      type: "request",
      model,
      messages: messageDelta,
      messageOffset,
      messageTotal: messages.length,
      tools: changedTools,
    });
    return { messageOffset, previousTotal, toolsChanged: previousTotal > 0 && changedTools !== undefined };
  }

  /**
   * 前方一致が崩れたことを記録する。 info は logRequest() の返り値、 reasons は履歴側が申告した書き換え理由。
   * 崩れていなければ何もせず false を返す。 予期しない破壊なら true を返す (呼び出し側が警告する)。
   */
  logPrefixBreak(info: RequestPrefixInfo, reasons: string[]): boolean {
    const messagesBroken = info.previousTotal > 0 && info.messageOffset < info.previousTotal;
    if (!messagesBroken && !info.toolsChanged) return false;
    const unexpected = messagesBroken && reasons.length === 0;
    this.write({
      ts: new Date().toISOString(),
      turn: this.turn,
      agentId: this.agentId,
      type: "prefix_break",
      messageOffset: info.messageOffset,
      previousTotal: info.previousTotal,
      toolsChanged: info.toolsChanged,
      reasons,
      unexpected,
    });
    return unexpected;
  }

  /** 脇の呼び出しを記録する (turn は直近の本体呼び出しの番号)。 */
  logSideCall(record: SideCallRecord): void {
    this.write({ ts: new Date().toISOString(), turn: this.turn, agentId: this.agentId, type: "side_call", ...record });
  }

  /** 本体呼び出しでキャッシュが外れたことを記録する。 */
  logCacheMiss(diagnosis: CacheMissDiagnosis): void {
    this.write({
      ts: new Date().toISOString(),
      turn: this.turn,
      agentId: this.agentId,
      type: "cache_miss",
      ...diagnosis,
    });
  }

  /** 整理イベントを記録する (turn は直前の本体呼び出しの番号)。 */
  logReductionEvent(record: ReductionEventRecord): void {
    this.write({
      ts: new Date().toISOString(),
      turn: this.turn,
      agentId: this.agentId,
      type: "reduction_event",
      ...record,
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
    tokensCached?: number;
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
    if (this.limitReached) return;
    try {
      // roomId/surface を書き込み時に注入 (undefined は JSON.stringify が省く＝旧挙動と互換)。
      const ctx = this.contextProvider?.() ?? {};
      const enriched = sanitizeLogValue({ ...entry, roomId: ctx.roomId, surface: ctx.surface });
      const line = `${JSON.stringify(enriched)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf-8");
      if (this.maxFileBytes > 0 && this.bytesWritten + lineBytes > this.maxFileBytes) {
        const marker = `${JSON.stringify({
          ts: new Date().toISOString(),
          turn: this.turn,
          agentId: this.agentId,
          type: "log_limit",
          maxFileBytes: this.maxFileBytes,
        })}\n`;
        if (this.bytesWritten + Buffer.byteLength(marker, "utf-8") <= this.maxFileBytes) {
          fs.appendFileSync(this.filePath, marker, "utf-8");
        }
        this.limitReached = true;
        return;
      }
      fs.appendFileSync(this.filePath, line, "utf-8");
      this.bytesWritten += lineBytes;
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
