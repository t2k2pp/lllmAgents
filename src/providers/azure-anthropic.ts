/**
 * Azure 上の Anthropic Messages API (Claude) 用プロバイダー。
 *
 * ユーザー提供のエンドポイント例:
 *   https://<resource>.services.ai.azure.com/anthropic/v1/messages
 *
 * curl 例 (公式):
 *   curl -X POST "https://...azure.com/anthropic/v1/messages" \
 *     -H "Content-Type: application/json" \
 *     -H "x-api-key: YOUR_API_KEY" \
 *     -H "anthropic-version: 2023-06-01" \
 *     -d '{ "max_tokens": 1000, "system": "...", "messages": [...], "model": "claude-sonnet-4-5" }'
 *
 * Anthropic Messages API は OpenAI Chat Completions API とは:
 *   - エンドポイントパス: /v1/messages (chat/completions ではない)
 *   - 認証: x-api-key ヘッダー (Bearer ではない)
 *   - ボディ: system はトップレベル分離、 max_tokens 必須
 *   - レスポンス: SSE event = message_start / content_block_delta / message_delta / message_stop など
 *   - tool 形式: content の中に tool_use / tool_result ブロックを混ぜる (OpenAI の tool_calls 配列ではない)
 *
 * 本クラスは内部で OpenAI 形式 ↔ Anthropic 形式の変換を行い、 LLMProvider インターフェースを満たす。
 */

import type {
  LLMProvider,
  ChatParams,
  ChatWithToolsParams,
  VisionChatParams,
  ChatChunk,
  Message,
  ToolDefinition,
  ToolCall,
} from "./base-provider.js";
import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
import { httpPostStream } from "../utils/http-client.js";
import { getOpsLogger } from "../utils/ops-logger.js";

interface AzureAnthropicConfig {
  /** ホスト部のみ または /anthropic/v1/messages を含む完全URL (内部で base に正規化) */
  endpoint: string;
  /** Azure 上の Claude モデル ID (例: claude-sonnet-4-5) */
  model: string;
  /** Azure サブスクリプションキー */
  apiKey: string;
  /** Anthropic API バージョン (デフォルト: 2023-06-01) */
  anthropicVersion?: string;
  /** デフォルト max_tokens (Anthropic は必須フィールド)。 ChatParams.maxTokens で上書き可 */
  defaultMaxTokens?: number;
  /**
   * プロンプトキャッシュ (コスト削減)。 docs/prompt-cache-cost-reduction.md
   * 既定 enabled=true。 system+tools と会話履歴に cache_control を付与し入力課金を 0.1× に下げる。
   */
  promptCache?: { enabled?: boolean; ttl?: "5m" | "1h" };
}

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
// Claude 4 系 (Sonnet 4.5/4.6, Opus 4.7, Haiku 4.5) の Anthropic Messages API における
// max_tokens の上限 = 64000。 これ以上は API が 400 BadRequest で弾く。
// 中途半端に小さい値を入れると「上限が近い」 とモデルが察知して出力を急ぐ (= 圧縮/省略) 挙動が
// 出やすいため、 既定値は **モデルの最大値そのもの** を使う。 持て余すのは構わない。
const MODEL_OUTPUT_HARD_LIMIT = 64000;
const DEFAULT_MAX_TOKENS = MODEL_OUTPUT_HARD_LIMIT;

export class AzureAnthropicProvider implements LLMProvider {
  readonly providerType: SecondLLMProviderType = "azure-anthropic";
  protected config: AzureAnthropicConfig;
  protected baseUrl: string;

  constructor(config: AzureAnthropicConfig) {
    this.config = config;
    this.baseUrl = AzureAnthropicProvider.normalizeEndpoint(config.endpoint);
  }

  /**
   * Messages API のパス。 Azure 経由は `/anthropic/v1/messages`、
   * 公式 Anthropic API (api.anthropic.com) は `/v1/messages`。
   * AnthropicProvider が override して公式パスに切り替える。
   */
  protected getMessagesPath(): string {
    return "/anthropic/v1/messages";
  }

  /**
   * 完全URL (例: https://x.azure.com/anthropic/v1/messages) または
   * ホスト URL (例: https://x.azure.com) のどちらが入力されても、
   * 最終的に "https://x.azure.com" の base 部分のみを返す。
   * その後 chatUrl() で /anthropic/v1/messages を結合する。
   */
  static normalizeEndpoint(input: string): string {
    const trimmed = input.trim().replace(/\/$/, "");
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}`;
    } catch {
      return trimmed;
    }
  }

  protected chatUrl(): string {
    return `${this.baseUrl}${this.getMessagesPath()}`;
  }

  async testConnection(): Promise<boolean> {
    // Anthropic Messages API は GET モデル一覧を提供しないので、
    // 最小ペイロードで POST し HTTP ステータスのみ見る (失敗してもエラー本文は読まない)
    try {
      const body = {
        model: this.config.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      };
      const res = await fetch(this.chatUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      // 200 系または 4xx でも認証失敗以外なら接続自体は OK
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{
      name: this.config.model,
      size: 0,
      contextLength: 200_000,
      supportsVision: true,
      supportsFunctionCalling: true,
    }];
  }

  async getModelInfo(_modelName: string): Promise<ModelDetail> {
    return {
      name: this.config.model,
      size: 0,
      contextLength: 200_000,
      supportsVision: true,
      supportsFunctionCalling: true,
      parameterSize: undefined,
      quantizationLevel: undefined,
      format: "anthropic-messages-api",
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
    yield* this.doChat(params);
  }

  // ── 内部 ────────────────────────────────────────────────────────

  protected headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey,
      "anthropic-version": this.config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
    };
  }

  /** OpenAI 形式の ChatParams を Anthropic Messages API のリクエストボディに変換 */
  private buildRequestBody(
    params: ChatParams & { tools?: ToolDefinition[] },
  ): Record<string, unknown> {
    // 1. system messages を抽出してトップレベル system に集約。
    // system[0] = 安定 base (MessageHistory が stable/dynamic を別メッセージで返す)。
    const systemMessages = params.messages.filter((m) => m.role === "system");
    const nonSystem = params.messages.filter((m) => m.role !== "system");
    const systemBlocksText = systemMessages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((s) => s.length > 0);

    // 2. user/assistant/tool messages を Anthropic 形式に変換
    const anthMessages = convertOpenAIMessagesToAnthropic(nonSystem);

    const requestedMaxTokens = params.maxTokens ?? this.config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    // モデル出力上限を超えると Anthropic が 400 を返すので必ずクランプ。
    // 同時に 1 未満は不正なため最低 1 を保証。
    const clampedMaxTokens = Math.max(1, Math.min(requestedMaxTokens, MODEL_OUTPUT_HARD_LIMIT));

    // プロンプトキャッシュ (docs/prompt-cache-cost-reduction.md)。 既定 ON。
    const cacheEnabled = this.config.promptCache?.enabled !== false;
    const cacheControl: Record<string, unknown> | undefined = cacheEnabled
      ? (this.config.promptCache?.ttl === "1h"
          ? { type: "ephemeral", ttl: "1h" }
          : { type: "ephemeral" })
      : undefined;

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: clampedMaxTokens,
      messages: anthMessages,
      stream: params.stream,
    };
    // system: キャッシュ ON のときは text ブロック配列にし、 先頭(安定 base)に cache_control を付与。
    // レンダリング順は tools → system なので、 system[0] の breakpoint で tools+system[0] がキャッシュされる。
    // 末尾 (dynamic = 現在日時/goal/todo) はキャッシュ境界より後ろなので毎ターン再処理 (=正しい)。
    if (systemBlocksText.length > 0) {
      if (cacheControl) {
        body.system = systemBlocksText.map((text, i) => {
          const block: Record<string, unknown> = { type: "text", text };
          if (i === 0) block.cache_control = cacheControl;
          return block;
        });
      } else {
        body.system = systemBlocksText.join("\n\n");
      }
    }
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.top_k !== undefined) body.top_k = params.top_k;
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    // 会話履歴のローリング breakpoint: 最後のメッセージの最終ブロックに cache_control を付与。
    // これで履歴プレフィクスが毎ターン読込 (0.1×) され、 新規分のみ書込になる。
    // 最小キャッシュ長 (Opus/Haiku 4096 / Sonnet 2048 tok) 未満は無音で非キャッシュ = 無害。
    if (cacheControl && anthMessages.length > 0) {
      applyCacheControlToLastBlock(anthMessages[anthMessages.length - 1], cacheControl);
    }

    return body;
  }

  /** ストリーミングチャット本体 */
  protected async *doChat(
    params: ChatParams & { tools?: ToolDefinition[] },
  ): AsyncGenerator<ChatChunk> {
    const body = this.buildRequestBody({ ...params, stream: true });
    const url = this.chatUrl();

    if (process.env.LLM_DEBUG_HTTP) {
      console.error(`[LLM_DEBUG_HTTP] POST ${url}  model=${body.model}  msgs=${(body.messages as unknown[])?.length}`);
    }

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await httpPostStream(url, body, undefined, undefined, this.headers());
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // 運用ログ ERROR: ネットワーク失敗・HTTP 非200 を context 付きで記録
      getOpsLogger().error("stream", `${this.providerType} request failed`, {
        provider: this.providerType,
        url,
        model: body.model,
        error: err.message,
        stack: err.stack,
      });
      yield {
        type: "error",
        error: `${err.message} [provider=${this.providerType} url=${url} model=${body.model}]`,
      };
      return;
    }

    yield* parseAnthropicStream(stream, this.providerType, body.model as string);
  }
}

// ── ヘルパー: OpenAI ↔ Anthropic メッセージ形式変換 ────────────────

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: { type: "base64" | "url"; media_type?: string; data?: string; url?: string };
  /** プロンプトキャッシュ breakpoint (docs/prompt-cache-cost-reduction.md) */
  cache_control?: Record<string, unknown>;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/**
 * メッセージの「最終 content ブロック」 に cache_control を付与する (ローリング履歴キャッシュ用)。
 * content が文字列の場合は単一 text ブロックの配列に変換してから付与する。 空文字列はスキップ。
 */
function applyCacheControlToLastBlock(
  msg: AnthropicMessage,
  cacheControl: Record<string, unknown>,
): void {
  if (typeof msg.content === "string") {
    if (msg.content.length === 0) return;
    msg.content = [{ type: "text", text: msg.content, cache_control: cacheControl }];
    return;
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    msg.content[msg.content.length - 1].cache_control = cacheControl;
  }
}

/**
 * OpenAI 形式 (system 除く) を Anthropic 形式に変換。
 * - role=tool → user の content に tool_result ブロック
 * - assistant.tool_calls → content に tool_use ブロックを追加
 * - 連続する同じ role の messages はそのまま (Anthropic は許容)
 *
 * 注意: Anthropic は messages の role が user / assistant の **交互** であることを要求するが、
 * 同 role が連続しても多くの場合エラーにせず、 連結 or 個別解釈してくれる。 ただし
 * tool_result は user role に配置する必要がある (OpenAI の role=tool に相当)。
 */
function convertOpenAIMessagesToAnthropic(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "tool") {
      // tool 結果 → user content に tool_result ブロック
      const toolContent: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      };
      // 直前が user で content が配列なら追記、 さもなくば新規 user message
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(toolContent);
      } else {
        out.push({ role: "user", content: [toolContent] });
      }
      continue;
    }

    if (msg.role === "user") {
      const content = normalizeContentToAnthropic(msg.content);
      out.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      // assistant message は text + tool_use ブロックの混合になり得る
      const blocks: AnthropicContentBlock[] = [];

      // テキスト部分
      const textPart = typeof msg.content === "string"
        ? msg.content
        : (msg.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      if (textPart && textPart.length > 0) {
        blocks.push({ type: "text", text: textPart });
      }

      // tool_calls → tool_use ブロック
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let parsedInput: unknown = {};
          try {
            parsedInput = JSON.parse(tc.function.arguments ?? "{}");
          } catch { /* keep empty */ }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }

      out.push({
        role: "assistant",
        content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text! : blocks,
      });
      continue;
    }
  }

  // 空の messages 配列は Anthropic がエラーにするので保護
  if (out.length === 0) {
    out.push({ role: "user", content: "(empty)" });
  }
  return out;
}

function normalizeContentToAnthropic(content: string | { type: string; text?: string; image_url?: { url: string } }[]): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  const blocks: AnthropicContentBlock[] = [];
  for (const p of content) {
    if (p.type === "text" && p.text) {
      blocks.push({ type: "text", text: p.text });
    } else if (p.type === "image_url" && p.image_url?.url) {
      // data: URL → base64、 http(s) URL → そのまま
      const url = p.image_url.url;
      if (url.startsWith("data:")) {
        const m = url.match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: m[1], data: m[2] },
          });
        }
      } else {
        blocks.push({
          type: "image",
          source: { type: "url", url },
        });
      }
    }
  }
  return blocks.length === 0 ? "(empty)" : blocks;
}

// ── ストリーミングパーサ: Anthropic SSE → ChatChunk ──────────────

/**
 * Anthropic Messages API の SSE ストリームを ChatChunk に変換する。
 *
 * 主要イベント:
 * - message_start: 全体の開始 + 初期 usage
 * - content_block_start: テキストブロックまたは tool_use ブロックの開始
 * - content_block_delta: テキスト追記 (text_delta) または tool_use の引数追記 (input_json_delta)
 * - content_block_stop: ブロック終了
 * - message_delta: stop_reason + 最終 usage (output_tokens)
 * - message_stop: 全体終了
 * - ping: 無視
 * - error: エラー
 */
async function* parseAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  providerType: string = "azure-anthropic",
  model: string = "",
): AsyncGenerator<ChatChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // tool_use の組み立て: index → { id, name, partialJson }
  const toolUses = new Map<number, { id: string; name: string; partialJson: string }>();
  let promptTokens = 0;
  let completionTokens = 0;
  // プロンプトキャッシュ usage (docs/prompt-cache-cost-reduction.md)。
  // input_tokens(=promptTokens) はこれら 2 つを **含まない** 非キャッシュ残。
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let stopReason: string | undefined;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE のイベントは "event: <name>\ndata: <json>\n\n" の形式
      let eventEnd: number;
      while ((eventEnd = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);

        let eventName = "";
        let dataText = "";
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataText += line.slice(5).trim();
          }
        }
        if (!eventName || !dataText) continue;

        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(dataText);
        } catch {
          continue;
        }

        switch (eventName) {
          case "message_start": {
            const m = (data.message ?? {}) as {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
            promptTokens = m.usage?.input_tokens ?? 0;
            completionTokens = m.usage?.output_tokens ?? 0;
            cacheReadTokens = m.usage?.cache_read_input_tokens ?? 0;
            cacheCreationTokens = m.usage?.cache_creation_input_tokens ?? 0;
            break;
          }
          case "content_block_start": {
            const idx = data.index as number;
            const block = (data.content_block ?? {}) as {
              type?: string;
              id?: string;
              name?: string;
              input?: unknown;
            };
            if (block.type === "tool_use") {
              toolUses.set(idx, {
                id: block.id ?? "",
                name: block.name ?? "",
                partialJson: typeof block.input === "object" ? JSON.stringify(block.input) : "",
              });
            }
            break;
          }
          case "content_block_delta": {
            const idx = data.index as number;
            const delta = (data.delta ?? {}) as {
              type?: string;
              text?: string;
              partial_json?: string;
            };
            if (delta.type === "text_delta" && delta.text) {
              yield { type: "text", text: delta.text };
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const t = toolUses.get(idx);
              if (t) t.partialJson += delta.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const idx = data.index as number;
            const t = toolUses.get(idx);
            if (t) {
              const toolCall: ToolCall = {
                id: t.id,
                type: "function",
                function: {
                  name: t.name,
                  arguments: t.partialJson || "{}",
                },
              };
              yield { type: "tool_call", toolCall };
              toolUses.delete(idx);
            }
            break;
          }
          case "message_delta": {
            const delta = (data.delta ?? {}) as { stop_reason?: string };
            const usage = (data.usage ?? {}) as {
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            if (typeof usage.output_tokens === "number") completionTokens = usage.output_tokens;
            // 一部応答は message_delta 側で cache usage を確定させる (あれば上書き)
            if (typeof usage.cache_read_input_tokens === "number") cacheReadTokens = usage.cache_read_input_tokens;
            if (typeof usage.cache_creation_input_tokens === "number") cacheCreationTokens = usage.cache_creation_input_tokens;
            if (delta.stop_reason) stopReason = delta.stop_reason;
            break;
          }
          case "message_stop": {
            yield {
              type: "done",
              finishReason: mapAnthropicStopReason(stopReason),
              // cacheCreationTokens を必ず載せる (undefined でないこと) ことで、 コスト計算側が
              // 「Anthropic セマンティクス (promptTokens は非キャッシュ残)」 と判別できる。
              usage: { promptTokens, completionTokens, cachedTokens: cacheReadTokens, cacheCreationTokens },
            };
            break;
          }
          case "error": {
            const err = data.error as { type?: string; message?: string } | undefined;
            // 運用ログ ERROR: SSE error イベントを context 付きで記録
            getOpsLogger().error("stream", "anthropic SSE error event", {
              provider: providerType,
              model,
              errorType: err?.type,
              errorMessage: err?.message,
              raw: data,
            });
            yield {
              type: "error",
              error: `[anthropic] ${err?.type ?? "error"}: ${err?.message ?? JSON.stringify(data)}`,
            };
            break;
          }
          // ping / その他は無視
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function mapAnthropicStopReason(reason: string | undefined): string {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "stop_sequence": return "stop";
    default: return reason ?? "stop";
  }
}
