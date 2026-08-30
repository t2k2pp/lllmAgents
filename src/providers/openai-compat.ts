import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
import type {
  LLMProvider,
  ChatParams,
  ChatWithToolsParams,
  VisionChatParams,
  ChatChunk,
  Message,
  ToolDefinition,
  TokenUsage,
} from "./base-provider.js";
import { httpGet, httpPostStream } from "../utils/http-client.js";
import { inferContextLength } from "./utils/context-length.js";

interface OpenAIModelResponse {
  data: Array<{ id: string; object: string }>;
}

interface SSEDelta {
  content?: string;
  /** Qwen3等のthinkingモデルが思考トークンを送信するフィールド (vLLM --enable-reasoning, OpenRouter等) */
  reasoning_content?: string;
  /** LM Studio等が使用する reasoning フィールド (reasoning_content の別名) */
  reasoning?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface SSEChoice {
  index: number;
  delta: SSEDelta;
  finish_reason: string | null;
}

interface SSEUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * プロンプトキャッシュ読込トークン (OpenAI/vLLM)。 prompt_tokens の **内数**。
   * クラウド OpenAI / 一部 vLLM は自動キャッシュし `prompt_tokens_details.cached_tokens` で返す
   * (docs/prompt-cache-cost-reduction.md)。
   */
  prompt_tokens_details?: { cached_tokens?: number };
}

interface SSEChunk {
  choices: SSEChoice[];
  usage?: SSEUsage;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly providerType: SecondLLMProviderType;
  protected baseUrl: string;

  constructor(providerType: SecondLLMProviderType, baseUrl: string) {
    this.providerType = providerType;
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  protected getModelsUrl(): string {
    return `${this.baseUrl}/v1/models`;
  }

  protected getChatUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  protected async getRequestHeaders(): Promise<Record<string, string>> {
    return {};
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await httpGet(this.getModelsUrl(), 5000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await httpGet<OpenAIModelResponse>(this.getModelsUrl());
    if (!res.ok || !res.data?.data) {
      return [];
    }
    return res.data.data.map((m) => ({
      name: m.id,
      size: 0,
      contextLength: 0,
      supportsVision: false,
      supportsFunctionCalling: true,
    }));
  }

  async getModelInfo(modelName: string): Promise<ModelDetail> {
    const models = await this.listModels();
    const found = models.find((m) => m.name === modelName);
    const ctxFromList = found?.contextLength ?? 0;
    const contextLength = ctxFromList > 0 ? ctxFromList : inferContextLength(modelName);
    return {
      name: modelName,
      size: found?.size ?? 0,
      contextLength,
      supportsVision: found?.supportsVision ?? false,
      supportsFunctionCalling: found?.supportsFunctionCalling ?? true,
    };
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params);
  }

  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params);
  }

  async supportsVision(_modelName: string): Promise<boolean> {
    return false;
  }

  async *chatWithVision(params: VisionChatParams): AsyncGenerator<ChatChunk> {
    yield* this.chat(params);
  }

  protected async *doChat(
    params: ChatParams & { tools?: ToolDefinition[]; toolChoice?: ChatWithToolsParams["toolChoice"] },
  ): AsyncGenerator<ChatChunk> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: mergeSystemMessages(params.messages).map((m) => this.formatMessage(m)),
      stream: true,
      // ストリーミングでusage情報を取得するためのオプション
      stream_options: { include_usage: true },
    };
    // サンプリングパラメータ: 設定値がある場合のみ送信。未指定ならサーバー側デフォルトに委ねる
    // (モデルの generation_config.json / Modelfile 等の推奨値がそのまま使われる)
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.top_k !== undefined) body.top_k = params.top_k;
    if (params.repetition_penalty !== undefined) body.repetition_penalty = params.repetition_penalty;
    // max_tokens は呼び出し側が明示指定したときだけ送信する。
    //
    // 重要: 「contextWindow をそのまま渡してサーバが自動調整する」 と思い込んではいけない。
    // OpenAI 互換サーバの大半 (vLLM / Azure AI Foundry / llama.cpp 等) は max_tokens を
    // **完了側専用枠** として扱い、 input + max_tokens > context_length で 400 を返す。
    //   実例: Kimi-K2 (262144 ctx) で input=13991, max_tokens=256000 → 400 BadRequest
    // 省略すればサーバ既定値 = 「残コンテキスト全部」 が使われるため、 上限まで出力させたい
    // ケースこそ省略が正解。 finish_reason="length" が返った場合はエージェント側で自動継続する。
    if (params.maxTokens) {
      body.max_tokens = params.maxTokens;
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools;
      body.tool_choice = params.toolChoice ?? "auto";
    }

    let streamBody: ReadableStream<Uint8Array>;
    const chatUrl = this.getChatUrl();
    try {
      const headers = await this.getRequestHeaders();
      if (process.env.LLM_DEBUG_HTTP) {
        console.error(
          `[LLM_DEBUG_HTTP] POST ${chatUrl}  model=${body.model}  msgs=${(body.messages as unknown[])?.length}`,
        );
      }
      streamBody = await httpPostStream(chatUrl, body, undefined, undefined, headers, params.signal);
    } catch (e) {
      // 失敗時は URL と model を含めて原因特定を容易にする (404/401/403 デバッグ向け)
      yield {
        type: "error",
        error: `${String(e)} [provider=${this.providerType} url=${chatUrl} model=${body.model}]`,
      };
      return;
    }

    // Track partial tool calls across SSE chunks
    const partialToolCalls = new Map<number, { id: string; name: string; args: string }>();
    // Track usage from streaming response
    let lastUsage: TokenUsage | undefined;

    const reader = streamBody.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") {
            // Emit any completed tool calls
            for (const [, tc] of partialToolCalls) {
              yield {
                type: "tool_call",
                toolCall: {
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: sanitizeToolCallArgs(tc.args) },
                },
              };
            }
            yield { type: "done", finishReason: "stop", usage: lastUsage };
            return;
          }

          let chunk: SSEChunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }

          // ストリームからusage情報を抽出
          if (chunk.usage) {
            // 自動プロンプトキャッシュのヒット分 (cached_tokens は prompt_tokens の内数)。
            // 報告があればコスト計算で割引単価に回す (docs/prompt-cache-cost-reduction.md)。
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
            lastUsage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              ...(typeof cached === "number" && cached > 0 ? { cachedTokens: cached } : {}),
            };
          }

          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;

            // Thinking content (Qwen3等のthinkingモデル / LM Studio)
            if (delta.reasoning_content || delta.reasoning) {
              yield { type: "thinking", text: delta.reasoning_content ?? delta.reasoning ?? "" };
            }

            // Text content
            if (delta.content) {
              yield { type: "text", text: delta.content };
            }

            // Tool calls (streamed incrementally)
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!partialToolCalls.has(idx)) {
                  partialToolCalls.set(idx, { id: tc.id ?? "", name: "", args: "" });
                }
                const partial = partialToolCalls.get(idx)!;
                if (tc.id) partial.id = tc.id;
                if (tc.function?.name) partial.name += tc.function.name;
                if (tc.function?.arguments) partial.args += tc.function.arguments;
              }
            }

            // Finish reason
            if (choice.finish_reason) {
              if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") {
                for (const [, tc] of partialToolCalls) {
                  yield {
                    type: "tool_call",
                    toolCall: {
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: sanitizeToolCallArgs(tc.args) },
                    },
                  };
                }
                partialToolCalls.clear();
              }
              yield { type: "done", finishReason: choice.finish_reason, usage: lastUsage };
            }
          }
        }
      }
    } catch (e) {
      // アイドルタイムアウトやAbortによるストリーム切断をわかりやすいエラーに変換
      const err = e instanceof Error ? e : new Error(String(e));
      if (params.signal?.aborted) {
        // ユーザー中断 (Esc): エラーではないので黙って終了する (呼び出し側が中断処理を行う)
        return;
      }
      if (err.name === "AbortError" || err.message.includes("abort")) {
        yield {
          type: "error",
          error:
            "ストリーム読み取りタイムアウト: LLMサーバーから一定時間データが受信できませんでした。サーバーの状態を確認してください。",
        };
      } else {
        yield { type: "error", error: err.message };
      }
      return;
    } finally {
      // releaseLock だけでは接続が残る。 cancel で wrapWithIdleTimeout → res.body →
      // undici へ伝播させて接続を確実に閉じる (正常終了後の cancel は no-op)。
      void reader.cancel().catch(() => {});
    }
  }

  protected formatMessage(msg: Message): Record<string, unknown> {
    const formatted: Record<string, unknown> = { role: msg.role };

    if (typeof msg.content === "string") {
      formatted.content = msg.content;
    } else {
      formatted.content = msg.content;
    }

    if (msg.tool_call_id) {
      formatted.tool_call_id = msg.tool_call_id;
    }
    if (msg.tool_calls) {
      // tool_calls の arguments が有効なJSONか検証し、不正な場合は修復する
      formatted.tool_calls = msg.tool_calls.map((tc) => {
        const sanitized = sanitizeToolCallArgs(tc.function.arguments);
        if (sanitized !== tc.function.arguments) {
          return { ...tc, function: { ...tc.function, arguments: sanitized } };
        }
        return tc;
      });
    }

    return formatted;
  }
}

/**
 * 複数の system メッセージ (MessageHistory.getMessages() が prompt cache 最適化のため
 * stable/dynamic に分割して返す, docs/prompt-cache-cost-reduction.md) を 1 通に統合する。
 *
 * Qwen系のチャットテンプレートは messages[0] のみを system として取り出し、
 * それ以降に role=system が現れると raise_exception('System message must be at
 * the beginning.') で拒否する (Gemma等の他テンプレートにはこの制約がない)。
 * OpenAI互換API (llama.cpp/vLLM/LM Studio/Ollama等) はサーバ側でjinjaテンプレートを
 * 適用するため、送信前にここで単一の system メッセージへ統合する。
 */
function mergeSystemMessages(messages: Message[]): Message[] {
  const systemParts: string[] = [];
  const rest: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content.length > 0) systemParts.push(m.content);
    } else {
      rest.push(m);
    }
  }
  if (systemParts.length === 0) return rest;
  return [{ role: "system", content: systemParts.join("\n\n") }, ...rest];
}

/**
 * ツール呼び出し引数からモデルのトークンアーティファクトを除去し、有効なJSONに修復する。
 *
 * 各種LLMが特殊トークン（ChatML: <|im_start|>, Llama: <|eot_id|>, その他 <|...|> 形式）を
 * ツール引数に混入させることがある。これらが JSON 内のエスケープシーケンスと干渉して
 * JSON全体を壊すため、汎用的に除去・修復する。
 */
function sanitizeToolCallArgs(args: string): string {
  // まず有効なJSONならそのまま返す
  try {
    JSON.parse(args);
    return args;
  } catch {
    // 修復を試みる
  }

  let cleaned = args;

  // Phase 1: 特殊トークンの汎用除去
  // <|...|> 形式のトークン全般 (例: <|im_start|>, <|eot_id|>, <|"|>, <|\"|>)
  cleaned = cleaned.replace(/<\|[^<]*?\|>/g, "");
  // [INST], [/INST] 等のメタタグ
  cleaned = cleaned.replace(/\[\/?INST\]/g, "");
  // 残った <|...（閉じ |> がないもの）: <| + バックスラッシュ + 引用符 → 引用符に
  cleaned = cleaned.replace(/<\|\\"/g, '"');
  // <| + バックスラッシュ + 非引用符文字 → バックスラッシュごと除去
  cleaned = cleaned.replace(/<\|\\(.)/g, "$1");
  // 残った <| → 除去
  cleaned = cleaned.replace(/<\|/g, "");
  // 孤立した |> → 除去
  cleaned = cleaned.replace(/\|>/g, "");

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // Phase 2 へ
  }

  // Phase 2: トークン除去で生じた残骸の修復
  // 二重引用符 "" → " （文字列の開始/終了位置で発生）
  cleaned = cleaned.replace(/: ""/g, ': "');
  cleaned = cleaned.replace(/"",/g, '",');
  cleaned = cleaned.replace(/""\}/g, '"}');
  // 引用符に挟まれた孤立パイプ: "|" → "
  cleaned = cleaned.replace(/"\|"/g, '"');
  // 文字列末尾の孤立パイプ: |", → ",  |"} → "}
  cleaned = cleaned.replace(/\|",/g, '",');
  cleaned = cleaned.replace(/\|"\}/g, '"}');

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // Phase 3 へ
  }

  // Phase 3: JSON で無効なエスケープシーケンスの修復
  // 有効: \n \r \t \b \f \u \\ \/ \"  → それ以外の \X は \\X に（バックスラッシュを保持）
  // 例: \U → \\U (Windowsパス C:\Users 等を壊さない)、\p → \\p
  cleaned = cleaned.replace(/\\([^nrtbfu\\/"])/g, "\\\\$1");

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // Phase 4 へ
  }

  // Phase 4: 括弧バランスの修復（末尾が途切れている場合）
  const openBraces = (cleaned.match(/{/g) || []).length;
  const closeBraces = (cleaned.match(/}/g) || []).length;
  const openBrackets = (cleaned.match(/\[/g) || []).length;
  const closeBrackets = (cleaned.match(/]/g) || []).length;

  for (let i = 0; i < openBrackets - closeBrackets; i++) cleaned += "]";
  for (let i = 0; i < openBraces - closeBraces; i++) cleaned += "}";

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // 修復不能: 空のオブジェクトを返す（ツール実行側でエラーになる）
    return "{}";
  }
}
