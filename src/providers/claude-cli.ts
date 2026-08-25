/**
 * Claude Code CLI (`claude -p`) をサブプロセスで呼ぶ Provider。
 *
 * API キー不要 (claude が独自に管理する subscription / oauth セッションを利用)。
 *
 * アーキテクチャ:
 *  - lllmAgents の messages を 1 本のテキストプロンプトに flatten して `claude -p` の引数 (stdin) に渡す
 *  - `--output-format stream-json --verbose` で line-delimited JSON を受け取り、
 *    `assistant` イベントの text content を text chunk として yield
 *  - tool 呼び出しは claude 内部で完結 (lllmAgents の tool 機構には橋渡ししない)
 *  - 最終的に `result` イベントで usage と finish_reason を yield
 *
 * 制約:
 *  - lllmAgents の tool calling は橋渡しせず、 tools が渡された場合は明示エラーで止める
 *    (claude -p には外部 tool 定義を注入する経路が無いため)。
 *    ツール付きエージェントループには `anthropic` または `claude-agent-sdk` プロバイダを使う
 *  - max_tokens / temperature 等のサンプリングパラメータは無視される (claude 側が制御)
 *  - 認証は claude CLI が事前に `claude login` 済みである必要がある
 */

import { spawn } from "node:child_process";
import type {
  LLMProvider,
  ChatParams,
  ChatWithToolsParams,
  VisionChatParams,
  ChatChunk,
  Message,
} from "./base-provider.js";
import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
import { CLAUDE_MODELS } from "../config/types.js";
import { getOpsLogger } from "../utils/ops-logger.js";

interface ClaudeCliProviderConfig {
  /** 使うモデル ID (CLAUDE_MODELS の id か alias)。 例: "claude-opus-4-7" / "sonnet" */
  model: string;
  /** `claude` バイナリへのパス。 未指定なら PATH から `claude` を探す */
  binPath?: string;
  /** claude に追加で渡したい引数 (例: ["--disallowedTools", "*"]) */
  extraArgs?: string[];
  /** false の場合、 claude 内部のツール実行を一切無効化する (= 純粋なテキスト生成器として使う)。 デフォルト: true (claude 標準挙動) */
  allowTools?: boolean;
}

const DEFAULT_BIN = "claude";

export class ClaudeCliProvider implements LLMProvider {
  readonly providerType: SecondLLMProviderType = "claude-cli";
  private config: ClaudeCliProviderConfig;

  constructor(config: ClaudeCliProviderConfig) {
    this.config = config;
  }

  async testConnection(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.config.binPath ?? DEFAULT_BIN, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.on("error", () => resolve(false));
      proc.on("exit", (code) => resolve(code === 0));
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS.map((m) => ({
      name: m.id,
      size: 0,
      contextLength: m.contextWindow,
      supportsVision: true,
      supportsFunctionCalling: false, // CLI 経由では lllmAgents 側のツール機構には橋渡ししない
    }));
  }

  async getModelInfo(modelName: string): Promise<ModelDetail> {
    const found = CLAUDE_MODELS.find((m) => m.id === modelName || m.cliAlias === modelName);
    const ctx = found?.contextWindow ?? 200_000;
    return {
      name: modelName,
      size: 0,
      contextLength: ctx,
      supportsVision: true,
      supportsFunctionCalling: false,
      format: "claude-cli",
    };
  }

  async supportsVision(_modelName: string): Promise<boolean> {
    return true;
  }

  async *chatWithVision(params: VisionChatParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params);
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params);
  }

  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    // claude -p (--print) は外部 tool 定義を注入できない (内部ツールのみで完結する)。
    // tools を渡されても claude には届かないため、 サイレント degrade せず Fail loud。
    // ツール委任前提のループに使うなら 'anthropic' か 'claude-agent-sdk' プロバイダへ。
    if (params.tools && params.tools.length > 0) {
      yield {
        type: "error",
        error:
          `[claude-cli] このプロバイダは tool calling を橋渡ししません ` +
          `(claude -p の仕様上、外部 tool 定義を注入する経路がありません)。\n` +
          `[対処] ツール付きエージェントループには次のいずれかを使ってください:\n` +
          `  - 'anthropic' プロバイダ (API キー必要、 ネイティブ tool 対応)\n` +
          `  - 'claude-agent-sdk' プロバイダ (subscription 再利用、 in-process MCP で tool 対応)\n` +
          `  → /model setup claude-agent-sdk / /second setup claude-agent-sdk で切替可能`,
      };
      return;
    }
    yield* this.doChat(params);
  }

  protected async *doChat(params: ChatParams): AsyncGenerator<ChatChunk> {
    const prompt = flattenMessagesToPrompt(params.messages);
    const modelArg = resolveClaudeModelArg(params.model || this.config.model);

    const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", modelArg];
    if (this.config.allowTools === false) {
      args.push("--disallowedTools", "*");
    }
    if (this.config.extraArgs && this.config.extraArgs.length > 0) {
      args.push(...this.config.extraArgs);
    }

    if (process.env.LLM_DEBUG_HTTP) {
      console.error(
        `[LLM_DEBUG_HTTP] spawn ${this.config.binPath ?? DEFAULT_BIN} ${args.join(" ")}  promptLen=${prompt.length}`,
      );
    }

    let proc;
    try {
      proc = spawn(this.config.binPath ?? DEFAULT_BIN, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        signal: params.signal,
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      getOpsLogger().error("stream", `${this.providerType} spawn failed`, {
        provider: this.providerType,
        bin: this.config.binPath ?? DEFAULT_BIN,
        error: err.message,
      });
      yield { type: "error", error: `claude CLI 起動失敗: ${err.message}` };
      return;
    }

    // プロンプトを stdin に書き込んで close
    proc.stdin.write(prompt);
    proc.stdin.end();

    const stderrChunks: string[] = [];
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"));
    });

    let buffer = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let finishReason: string | undefined;
    let yieldedAnyText = false;
    let exitCode: number | null = null;
    let processClosed = false;

    const exitPromise = new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        exitCode = code;
        processClosed = true;
        resolve();
      });
      proc.on("error", () => {
        processClosed = true;
        resolve();
      });
    });

    try {
      for await (const chunk of proc.stdout) {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;

          let event: ClaudeStreamEvent;
          try {
            event = JSON.parse(line) as ClaudeStreamEvent;
          } catch {
            continue;
          }

          switch (event.type) {
            case "assistant": {
              const content = event.message?.content ?? [];
              for (const block of content) {
                if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
                  yieldedAnyText = true;
                  yield { type: "text", text: block.text };
                }
                // tool_use ブロックは無視 (claude 内部で完結)
              }
              const u = event.message?.usage;
              if (u) {
                if (typeof u.input_tokens === "number") promptTokens = u.input_tokens;
                if (typeof u.output_tokens === "number") completionTokens = u.output_tokens;
                if (typeof u.cache_read_input_tokens === "number") cachedTokens = u.cache_read_input_tokens;
              }
              break;
            }
            case "result": {
              if (typeof event.stop_reason === "string") finishReason = event.stop_reason;
              const u = event.usage;
              if (u) {
                if (typeof u.input_tokens === "number") promptTokens = u.input_tokens;
                if (typeof u.output_tokens === "number") completionTokens = u.output_tokens;
                if (typeof u.cache_read_input_tokens === "number") cachedTokens = u.cache_read_input_tokens;
              }
              // result イベントに最終 text がある場合があり (assistant イベントを出さない短絡経路)、
              // まだ何も yield していなければ result.result をテキストとして出力する
              if (!yieldedAnyText && typeof event.result === "string" && event.result.length > 0) {
                yield { type: "text", text: event.result };
                yieldedAnyText = true;
              }
              break;
            }
            // system/init, rate_limit_event, user(tool_result) 等は無視
          }
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      yield { type: "error", error: `claude CLI 読み取り失敗: ${err.message}` };
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      return;
    }

    if (!processClosed) {
      await exitPromise;
    }

    if (exitCode !== 0) {
      const stderr = stderrChunks.join("").trim();
      const msg = stderr || `claude CLI が exit code ${exitCode} で終了しました`;
      getOpsLogger().error("stream", `${this.providerType} non-zero exit`, {
        provider: this.providerType,
        exitCode,
        stderr: stderr.slice(0, 500),
      });
      yield { type: "error", error: `[claude-cli] ${msg}` };
      return;
    }

    yield {
      type: "done",
      finishReason: mapClaudeStopReason(finishReason),
      usage: {
        promptTokens,
        completionTokens,
        cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
      },
    };
  }
}

// ── 内部ヘルパー ─────────────────────────────────────────

interface ClaudeContentBlock {
  type: string;
  text?: string;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeStreamEvent {
  type: string;
  message?: {
    content?: ClaudeContentBlock[];
    usage?: ClaudeUsage;
  };
  usage?: ClaudeUsage;
  stop_reason?: string;
  result?: string;
}

/**
 * lllmAgents の messages を 1 本のテキストプロンプトに変換する。
 * 末尾の user message を「指示」 とし、 それ以外を「会話履歴」 として claude に渡す。
 * system message は --append-system-prompt に切り出すと長すぎて argv 上限を超えるため、
 * SYSTEM: ヘッダで本文に混ぜる方式にする。
 */
function flattenMessagesToPrompt(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content ?? [])
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
    if (!text) continue;
    switch (m.role) {
      case "system":
        parts.push(`SYSTEM:\n${text}`);
        break;
      case "user":
        parts.push(`USER:\n${text}`);
        break;
      case "assistant":
        parts.push(`ASSISTANT:\n${text}`);
        break;
      case "tool":
        parts.push(`TOOL_RESULT (id=${m.tool_call_id ?? ""}):\n${text}`);
        break;
    }
  }
  return parts.join("\n\n");
}

/**
 * モデル ID (claude-opus-4-7 等) か alias (opus/sonnet/haiku) のどちらでも
 * claude --model に渡せる形に正規化する。
 *  - alias がそのまま使えるものは alias のまま (より短く UI 表示しやすい)
 *  - id 形式ならそのまま透過
 */
function resolveClaudeModelArg(modelInput: string): string {
  const trimmed = modelInput.trim();
  // alias マッチ (cliAlias) があれば alias を優先 (claude CLI も認識する)
  const entry = CLAUDE_MODELS.find((m) => m.id === trimmed);
  if (entry?.cliAlias) return entry.cliAlias;
  return trimmed;
}

function mapClaudeStopReason(reason: string | undefined): string {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "stop_sequence":
      return "stop";
    default:
      return reason ?? "stop";
  }
}
