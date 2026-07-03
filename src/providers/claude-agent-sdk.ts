/**
 * Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) を in-process で使う Provider。
 *
 * 設計: docs/claude-agent-sdk-provider-design.md
 *
 * claude-cli プロバイダとの違い:
 *  - subprocess を spawn せず、 lllmAgent と同じ Node プロセス内で SDK を実行
 *  - lllmAgent のツールを in-process MCP server として SDK に公開 (createSdkMcpServer)
 *  - tool calling が「動く」: tool 呼び出しは SDK 内部で MCP 経由で lllmAgent の
 *    ToolExecutor に届き、 結果が Claude に返される
 *  - 認証は claude login 済みの subscription を継承 (API キー不要)
 *
 * 制約:
 *  - claude バイナリ (SDK バンドル or 別途インストール) が動くプラットフォームに依存
 *  - rate limit / クォータは Anthropic subscription のものを消費
 *  - サンプリングパラメータ (temperature 等) は SDK が制御し、 ChatParams.temperature は無視
 */

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  LLMProvider,
  ChatParams,
  ChatWithToolsParams,
  VisionChatParams,
  ChatChunk,
  Message,
  ToolCall,
} from "./base-provider.js";
import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
import { CLAUDE_MODELS } from "../config/types.js";
import type { ToolExecutor } from "../tools/tool-executor.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { getOpsLogger } from "../utils/ops-logger.js";

interface ClaudeAgentSdkProviderConfig {
  model: string;
  /** claude バイナリへのパス (SDK のバンドルが動かない環境向け) */
  pathToClaudeCodeExecutable?: string;
  /**
   * lllmAgent ツールを SDK に公開する際に使う ToolRegistry。
   * 未指定なら lllmagents MCP server は登録せず、 SDK の built-in ツールのみを使う。
   */
  toolRegistry?: ToolRegistry;
  /**
   * lllmAgent ツール実行に使う ToolExecutor。
   * toolRegistry を渡すなら必須 (権限チェック / hook を通すため)。
   */
  toolExecutor?: ToolExecutor;
}

export class ClaudeAgentSdkProvider implements LLMProvider {
  readonly providerType: SecondLLMProviderType = "claude-agent-sdk";
  private config: ClaudeAgentSdkProviderConfig;

  constructor(config: ClaudeAgentSdkProviderConfig) {
    this.config = config;
  }

  /**
   * 2026-05-23 改訂以降は no-op に近い。 旧実装では SDK 内部 MCP server に
   * lllmAgent ツールを公開していたが、 SDK 内部ループが起きず tool_use が
   * テキストとして outer にリークする問題があったため、 tool 実行は outer
   * agent-loop に戻した (docs/claude-agent-sdk-provider-design.md 改訂節)。
   *
   * 後方互換のため method は残す。 渡された registry / executor は参照のみ
   * 保持し、 doChat では使わない。
   */
  attachToolBridge(registry: ToolRegistry, executor: ToolExecutor): void {
    this.config.toolRegistry = registry;
    this.config.toolExecutor = executor;
  }

  async testConnection(): Promise<boolean> {
    // SDK 経由は claude login 済みかどうかが実態。
    // ここでは bundled native binary が解決可能かのみ概算チェック (SDK が import できれば true)
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS.map((m) => ({
      name: m.id,
      size: 0,
      contextLength: m.contextWindow,
      supportsVision: true,
      supportsFunctionCalling: true,
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
      supportsFunctionCalling: true,
      format: "claude-agent-sdk",
    };
  }

  async supportsVision(_modelName: string): Promise<boolean> {
    return true;
  }

  async *chatWithVision(params: VisionChatParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params, []);
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params, []);
  }

  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    // tools は SDK 側の MCP 経由で公開する (ChatParams.tools の ToolDefinition[] ではなく
    // ToolRegistry / ToolExecutor 経由で渡す設計)。
    // ChatParams.tools は agent-loop からの定義リストだが、 ここでは ToolRegistry をそのまま使う。
    yield* this.doChat(
      params,
      params.tools.map((t) => t.function.name),
    );
  }

  /**
   * SDK の query() を呼んで stream を ChatChunk に変換する。
   *
   * @param params - ChatParams (messages / model / sampling)
   * @param toolNames - agent-loop が選別済みのツール名リスト (空なら全消去 — 純テキスト生成器として動作)
   */
  protected async *doChat(params: ChatParams, _toolNames: string[]): AsyncGenerator<ChatChunk> {
    const { systemPrompt, prompt } = flattenMessages(params.messages);
    const modelArg = resolveClaudeModelArg(params.model || this.config.model);

    const options: Options = {
      model: modelArg,
      // built-in ツール (Read/Write/Bash/...) は全消去し、 lllmAgent ツールのみ使わせる。
      // 理由: lllmAgent の権限チェック / hook を通したい / 名前衝突回避 (docs/claude-agent-sdk-provider-design.md §3.1)
      tools: [],
    };

    if (systemPrompt) {
      options.systemPrompt = systemPrompt;
    }

    if (this.config.pathToClaudeCodeExecutable) {
      options.pathToClaudeCodeExecutable = this.config.pathToClaudeCodeExecutable;
    }

    // 2026-05-23 改訂: SDK 内部 MCP server (mcpServers / allowedTools) は使用しない。
    // tool 実行は outer agent-loop に戻し、 convertSdkMessage が tool_use を
    // ChatChunk.tool_call として yield する設計に切り替えた。
    // 旧実装の渡し方では SDK 内部ループが起きず tool_use がテキストにリークしていた
    // (~/.localllm/logs/sessions/2026-05-22T16-13-10_main.jsonl 等で確認、 self-check
    // 3 連発で LLM コスト 3 倍 + response_complete が呼ばれない症状)。

    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let finishReason: string | undefined;

    try {
      const q = query({ prompt, options });

      for await (const msg of q) {
        yield* this.convertSdkMessage(msg);

        // usage / finish_reason は result メッセージから採取
        if (msg.type === "result") {
          if (msg.usage) {
            promptTokens = msg.usage.input_tokens ?? 0;
            completionTokens = msg.usage.output_tokens ?? 0;
            cachedTokens = msg.usage.cache_read_input_tokens ?? 0;
          }
          if (msg.subtype === "success") {
            finishReason = msg.stop_reason ?? undefined;
          } else {
            finishReason = msg.subtype; // error_during_execution など
          }
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      getOpsLogger().error("stream", `claude-agent-sdk query failed`, {
        provider: this.providerType,
        model: modelArg,
        error: err.message,
        stack: err.stack,
      });
      yield {
        type: "error",
        error: `[claude-agent-sdk] ${err.message}`,
      };
      return;
    }

    yield {
      type: "done",
      finishReason: mapStopReason(finishReason),
      usage: {
        promptTokens,
        completionTokens,
        cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
      },
    };
  }

  /**
   * SDKMessage を ChatChunk に変換。
   *  - assistant message の text content block → text chunk
   *  - assistant message の tool_use block → tool_call chunk (outer agent-loop で実行)
   *  - result message は doChat 側で usage 採取するため、 ここでは何も yield しない
   *  - その他 (system/auth/notification 等) は無視
   *
   * 2026-05-23 改訂: 旧実装は tool_use を "[tool: name(...)]" テキスト化していたが、
   * SDK 内部 MCP ループが起きないため self-check ループの原因になっていた。
   */
  private async *convertSdkMessage(msg: SDKMessage): AsyncGenerator<ChatChunk> {
    if (msg.type === "assistant") {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;

      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          yield { type: "text", text: block.text };
        } else if (block.type === "tool_use") {
          const toolCall: ToolCall = {
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          };
          yield { type: "tool_call", toolCall };
        }
      }

      // assistant_error は usage 不足や rate_limit を示す。 ここでは error chunk として通知
      if (msg.error) {
        yield {
          type: "error",
          error: `[claude-agent-sdk] assistant error: ${msg.error}`,
        };
      }
    }
  }
}

// ── 内部ヘルパー ─────────────────────────────────────────

/**
 * lllmAgent の messages を SDK の (systemPrompt, prompt) ペアに分解する。
 * - system messages は連結して systemPrompt に切り出す (SDK の claude_code preset を抑制)
 * - 残りは role ラベル付きで 1 本のテキストに連結 (claude-cli の flatten と同じ方式)
 *
 * 2026-05-23 改訂: assistant の tool_calls もテキスト化して履歴に含める。
 * outer agent-loop で tool 実行する方式に切り替えたため、 SDK が「過去のターンで
 * 何のツールを呼んで何が返ったか」 を読めるようにする必要がある。
 */
function flattenMessages(messages: Message[]): { systemPrompt: string; prompt: string } {
  const systemParts: string[] = [];
  const convoParts: string[] = [];

  for (const m of messages) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content ?? [])
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");

    switch (m.role) {
      case "system":
        if (text) systemParts.push(text);
        break;
      case "user":
        if (text) convoParts.push(`USER:\n${text}`);
        break;
      case "assistant": {
        const parts: string[] = [];
        if (text) parts.push(text);
        if (m.tool_calls && m.tool_calls.length > 0) {
          for (const tc of m.tool_calls) {
            parts.push(`[tool_call id=${tc.id} name=${tc.function.name}]\n${tc.function.arguments}`);
          }
        }
        if (parts.length > 0) {
          convoParts.push(`ASSISTANT:\n${parts.join("\n")}`);
        }
        break;
      }
      case "tool":
        if (text) convoParts.push(`TOOL_RESULT (id=${m.tool_call_id ?? ""}):\n${text}`);
        break;
    }
  }

  return {
    systemPrompt: systemParts.join("\n\n"),
    prompt: convoParts.join("\n\n"),
  };
}

/**
 * モデル ID (claude-opus-4-7 等) か alias (opus/sonnet/haiku) のどちらでも
 * SDK に渡せる形に正規化する。 alias 解決ロジックは claude-cli プロバイダと同一。
 */
function resolveClaudeModelArg(modelInput: string): string {
  const trimmed = modelInput.trim();
  const entry = CLAUDE_MODELS.find((m) => m.id === trimmed);
  if (entry?.cliAlias) return entry.cliAlias;
  return trimmed;
}

function mapStopReason(reason: string | undefined): string {
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
