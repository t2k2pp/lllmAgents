import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /**
   * 思考保全 (Phase 2 本実装): モデルが reasoning/thinking で返した内部思考。
   * 内部ストレージ専用フィールドで、 provider への送信時は MessageHistory.getMessages() が
   * content に inline 化して送る (provider に未対応フィールドを渡さないため)。
   * 終わった依頼の思考は、 次の整理イベントの前処理で消す (応答のたびには消さない。
   * docs/context-reduction-redesign.md §5.2 / §6.2)。 docs/ephemeral-context-design.md §7 参照。
   */
  thinking?: string;
  /**
   * ハーネスが添付した状態通知 (現在日時 / Goal / ToDo)。 内部ストレージ専用フィールドで、
   * provider への送信時は MessageHistory.getMessages() が本文の後ろに連結して送る。
   * 一度送ったメッセージには付け直さない (前方一致キャッシュを壊さないため)。
   * docs/prompt-prefix-stability.md 参照。
   */
  contextNote?: string;
  /**
   * ハーネスが入れた揮発メッセージ (依頼の中だけで使う促し・点検の催促・空応答の置き場など) の印。
   * 内部ストレージ専用フィールドで、 provider への送信時は toSentMessage() (message-history.ts) が外す。
   * 終わった依頼の揮発メッセージは、 次の整理イベントの前処理で除く (docs/context-reduction-redesign.md §6.2)。
   * セッションに保存されるので、 保存・再開をはさんでも印は残る。
   */
  ephemeral?: boolean;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatParams {
  model: string;
  messages: Message[];
  maxTokens?: number;
  stream: boolean;
  // サンプリングパラメータ: 設定値がある場合のみ送信。未指定ならサーバー側デフォルトに委ねる
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  /**
   * true のとき、 思考 (reasoning) を出さずに直接答えるようサーバへ求める。
   * 分類・JSON 抽出のような短い内部タスク用。 思考モデルは「思考は短く」 という
   * 指示を守らず maxTokens を思考だけで使い切り、 本文が空になることがある
   * (2026-10-15 忘却選択で顕在化。 docs/archive/context-forgetting.md §4.2)。
   * 対応: llama.cpp / vLLM (chat_template_kwargs.enable_thinking=false)。
   * 未対応 provider は無視してよい (従来挙動)。
   */
  disableThinking?: boolean;
  /**
   * ユーザー中断 (Esc) を HTTP 層まで伝播させるためのシグナル。
   * これが無いと中断後も接続が残り、 llama.cpp 等のサーバが生成を続けて
   * 後続リクエストが詰まる (2026-06-12 に 557 秒の応答遅延として顕在化)。
   * 未対応 provider は無視してよい (従来挙動)。
   */
  signal?: AbortSignal;
}

export interface ChatWithToolsParams extends ChatParams {
  tools: ToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

export interface VisionChatParams extends ChatParams {
  // Messages already contain image content parts
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /**
   * キャッシュ読込トークン数 (cache hit)。
   * - Anthropic 系: `cache_read_input_tokens`。 promptTokens(=input_tokens) には含まれない内数外。
   * - OpenAI 系: `prompt_tokens_details.cached_tokens`。 promptTokens(=prompt_tokens) の内数。
   * セマンティクス差はコスト計算側で cacheCreationTokens の有無により分岐する。
   */
  cachedTokens?: number;
  /**
   * キャッシュ書込トークン数 (cache write, 1.25× 課金)。 Anthropic 系のみ報告
   * (`cache_creation_input_tokens`)。 このフィールドの有無で「Anthropic セマンティクス
   * (promptTokens は非キャッシュ残)」 か「OpenAI セマンティクス (promptTokens は cached を内包)」 を判別する。
   */
  cacheCreationTokens?: number;
}

export interface ChatChunk {
  type: "text" | "thinking" | "tool_call" | "done" | "error";
  text?: string;
  toolCall?: ToolCall;
  finishReason?: string;
  error?: string;
  usage?: TokenUsage;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  /** ストリーム終端でプロバイダーが返した使用量。委任経路でも課金集計を失わないため保持する。 */
  usage?: TokenUsage;
}

export interface LLMProvider {
  readonly providerType: SecondLLMProviderType;

  testConnection(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  getModelInfo(modelName: string): Promise<ModelDetail>;

  chat(params: ChatParams): AsyncGenerator<ChatChunk>;
  chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk>;

  supportsVision(modelName: string): Promise<boolean>;
  chatWithVision(params: VisionChatParams): AsyncGenerator<ChatChunk>;
}

export async function collectResponse(gen: AsyncGenerator<ChatChunk>): Promise<ChatResponse> {
  let content = "";
  const toolCalls: ToolCall[] = [];
  let finishReason = "stop";
  let usage: TokenUsage | undefined;

  for await (const chunk of gen) {
    switch (chunk.type) {
      case "text":
        content += chunk.text ?? "";
        break;
      case "tool_call":
        if (chunk.toolCall) {
          toolCalls.push(chunk.toolCall);
        }
        break;
      case "done":
        finishReason = chunk.finishReason ?? "stop";
        usage = chunk.usage ?? usage;
        break;
      case "error":
        throw new Error(chunk.error ?? "Unknown LLM error");
    }
  }

  return { content, toolCalls, finishReason, usage };
}
