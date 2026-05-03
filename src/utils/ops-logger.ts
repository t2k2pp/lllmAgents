/**
 * 運用ログ (ops-logger)
 *
 * セッションJSONL とは別系統の「人間がトレースする」ためのログ。
 * 設計詳細: docs/llm-logging.md
 *
 * - 出力先: ~/.localllm/logs/ops/<sid>.jsonl
 * - レベル: TRACE / DEBUG / INFO / WARN / ERROR (level=TRACE が最も詳細、ERROR が最も粗い)
 * - 設定された level 以上のレコードのみ書き出す (例: level=INFO なら INFO/WARN/ERROR が出る)
 * - JSONL 形式に固定 (jq でフィルタ可能)
 *
 * セッションJSONL とは独立。失敗しても本体処理は止めない。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type OpsLogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<OpsLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface OpsLogEntry {
  ts: string;
  level: OpsLogLevel;
  agentId: string;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export class OpsLogger {
  private filePath: string | null;
  private level: OpsLogLevel;
  private enabled: boolean;
  private agentId: string;

  constructor(opts: {
    sessionId: string;
    agentId?: string;
    level?: OpsLogLevel;
    enabled?: boolean;
    pathOverride?: string;
  }) {
    this.agentId = opts.agentId ?? "main";
    this.level = opts.level ?? "info";
    this.enabled = opts.enabled ?? true;

    if (!this.enabled) {
      this.filePath = null;
      return;
    }

    const dir = path.join(os.homedir(), ".localllm", "logs", "ops");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 失敗時は書き込み試行で再度エラーになるので、ここでは黙る
    }
    const safeSid = opts.sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    this.filePath = opts.pathOverride ?? path.join(dir, `${safeSid}.jsonl`);
  }

  setLevel(level: OpsLogLevel): void {
    this.level = level;
  }

  getLevel(): OpsLogLevel {
    return this.level;
  }

  setAgentId(agentId: string): void {
    this.agentId = agentId;
  }

  /** クローン: 別 agentId で書き込みたい sub-agent 用 (ファイルは同じ) */
  forAgent(agentId: string): OpsLogger {
    const cloned = Object.create(OpsLogger.prototype) as OpsLogger;
    cloned.filePath = this.filePath;
    cloned.level = this.level;
    cloned.enabled = this.enabled;
    cloned.agentId = agentId;
    return cloned;
  }

  trace(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("trace", category, message, data);
  }
  debug(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("debug", category, message, data);
  }
  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("info", category, message, data);
  }
  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("warn", category, message, data);
  }
  error(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("error", category, message, data);
  }

  private log(level: OpsLogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.enabled || !this.filePath) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const entry: OpsLogEntry = {
      ts: new Date().toISOString(),
      level,
      agentId: this.agentId,
      category,
      message,
      data,
    };
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // 書き込み失敗は本体処理を止めない
    }
  }

  getFilePath(): string | null {
    return this.filePath;
  }
}

// ── グローバルインスタンス ────────────────────────────────────────
//
// プロセス全体で1つの OpsLogger を共有する。
// セッション開始時 (index.ts) に initOpsLogger() で初期化、
// 各モジュールは getOpsLogger() で取得して使う。
// 初期化前に getOpsLogger() を呼んだ場合は no-op の dummy を返す。

let globalOpsLogger: OpsLogger | null = null;

export function initOpsLogger(opts: {
  sessionId: string;
  level?: OpsLogLevel;
  enabled?: boolean;
  pathOverride?: string;
}): OpsLogger {
  globalOpsLogger = new OpsLogger(opts);
  return globalOpsLogger;
}

const dummyLogger: OpsLogger = (() => {
  const d = Object.create(OpsLogger.prototype) as OpsLogger;
  // @ts-expect-error - 内部フィールドを直接初期化 (enabled=false で全 log が no-op になる)
  d.filePath = null;
  // @ts-expect-error
  d.level = "info";
  // @ts-expect-error
  d.enabled = false;
  // @ts-expect-error
  d.agentId = "uninitialized";
  return d;
})();

export function getOpsLogger(): OpsLogger {
  return globalOpsLogger ?? dummyLogger;
}

/** 動的に level を変更 (REPL の /loglevel コマンド用) */
export function setOpsLogLevel(level: OpsLogLevel): void {
  if (globalOpsLogger) {
    globalOpsLogger.setLevel(level);
  }
}

export function parseOpsLogLevel(input: string): OpsLogLevel | null {
  const lower = input.trim().toLowerCase();
  if (lower === "trace" || lower === "debug" || lower === "info" || lower === "warn" || lower === "error") {
    return lower;
  }
  return null;
}

/** API キー等の機密ヘッダをマスクする */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "authorization" || lk === "x-api-key" || lk === "api-key") {
      masked[k] = "***";
    } else {
      masked[k] = v;
    }
  }
  return masked;
}
