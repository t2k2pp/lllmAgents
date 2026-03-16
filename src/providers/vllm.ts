import { OpenAICompatProvider } from "./openai-compat.js";
import type {
  ChatParams,
  ChatWithToolsParams,
  ChatChunk,
  ToolCall,
  ToolDefinition,
  Message,
  TokenUsage,
} from "./base-provider.js";
import { httpPost } from "../utils/http-client.js";

export class VLLMProvider extends OpenAICompatProvider {
  private _toolCallSupported: boolean | null = null;

  constructor(baseUrl: string) {
    super("vllm", baseUrl);
  }

  async supportsVision(modelName: string): Promise<boolean> {
    const lower = modelName.toLowerCase();
    return (
      lower.includes("llava") ||
      lower.includes("qwen-vl") ||
      lower.includes("qwen2-vl") ||
      lower.includes("phi-3.5-vision") ||
      lower.includes("pixtral") ||
      lower.includes("internvl")
    );
  }

  /**
   * chat() をオーバーライドして vLLM 特有の </think> タグをフィルタリングする。
   * Qwen3 等のモデルは <think> タグなしで thinking コンテンツを出力し、
   * </think> だけで区切るため、標準フィルタでは除去できない。
   */
  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* this.applyThinkFilter(super.chat(params));
  }

  /**
   * vLLMサーバーがOpenAIネイティブのツールコールをサポートしているか確認する。
   * --enable-auto-tool-choice と --tool-call-parser が設定されているか検出する。
   * 結果はキャッシュして再確認しない。
   */
  private async checkToolCallSupport(modelName: string): Promise<boolean> {
    if (this._toolCallSupported !== null) return this._toolCallSupported;

    try {
      const res = await httpPost(
        this.getChatUrl(),
        {
          model: modelName,
          messages: [{ role: "user", content: "test" }],
          tools: [
            {
              type: "function",
              function: {
                name: "test",
                description: "test",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          tool_choice: "auto",
          max_tokens: 1,
          stream: false,
        },
        10_000,
      );
      this._toolCallSupported = res.ok;
    } catch {
      this._toolCallSupported = false;
    }

    return this._toolCallSupported;
  }

  /**
   * ツールコールをサポートしている場合はOpenAI互換APIを使用し、
   * サポートしていない場合はテキストベースフォールバックを使用する。
   */
  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    const supported = await this.checkToolCallSupport(params.model);
    if (supported) {
      yield* this.applyThinkFilter(super.chatWithTools(params));
    } else {
      yield* this.textBasedChatWithTools(params);
    }
  }

  /**
   * ストリームから </think> タグより前のコンテンツ（thinking部分）を除去するフィルタ。
   * Qwen3系モデルが <think> タグなしで thinking content を content フィールドに含める場合に対応。
   * </think> が出現するまでのテキストをバッファリングして捨てる。
   */
  private async *applyThinkFilter(gen: AsyncGenerator<ChatChunk>): AsyncGenerator<ChatChunk> {
    let thinkFilterDone = false;
    let buffer = "";

    for await (const chunk of gen) {
      if (chunk.type === "text" && chunk.text && !thinkFilterDone) {
        buffer += chunk.text;
        const closeIdx = buffer.indexOf("</think>");
        if (closeIdx !== -1) {
          thinkFilterDone = true;
          const afterThink = buffer.slice(closeIdx + 8);
          buffer = "";
          if (afterThink) {
            yield { ...chunk, text: afterThink };
          }
        }
        // </think> がまだ来ていない → バッファリング継続（yield しない）
      } else {
        // thinking 処理済み or 非テキストチャンクはそのまま通す
        if (!thinkFilterDone && buffer && chunk.type === "done") {
          // ストリーム完了まで </think> が来なかった → バッファ内容をそのまま yield
          thinkFilterDone = true;
          yield { type: "text", text: buffer };
          buffer = "";
        }
        yield chunk;
      }
    }
  }

  /**
   * vLLMがツールコール非対応の場合のテキストベースフォールバック。
   * ツール定義をシステムプロンプトに埋め込み、XMLフォーマットでツールコールを行う。
   */
  private async *textBasedChatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    const toolsDescription = this.formatToolsForPrompt(params.tools);
    const messages = this.prepareTextBasedMessages(params.messages, toolsDescription);

    let fullText = "";
    let lastUsage: TokenUsage | undefined;

    // applyThinkFilter を通してから収集する
    for await (const chunk of this.applyThinkFilter(
      this.doChat(params.model, messages, params.temperature, params.maxTokens, true),
    )) {
      if (chunk.type === "text" && chunk.text) {
        // テキストをバッファリング（ツールコール部分を除去してから yield するため）
        fullText += chunk.text;
      } else if (chunk.type === "thinking") {
        yield chunk;
      } else if (chunk.type === "done") {
        lastUsage = chunk.usage;
      } else if (chunk.type === "error") {
        yield chunk;
        return;
      }
    }

    // テキストからツールコールをパース
    const toolCalls = parseTextToolCalls(fullText);

    if (toolCalls.length > 0) {
      // ツールコール部分を除去したテキストを yield
      const cleanText = fullText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
      if (cleanText) {
        yield { type: "text", text: cleanText };
      }
      for (const tc of toolCalls) {
        yield { type: "tool_call", toolCall: tc };
      }
      yield { type: "done", finishReason: "tool_calls", usage: lastUsage };
    } else {
      yield { type: "text", text: fullText };
      yield { type: "done", finishReason: "stop", usage: lastUsage };
    }
  }

  /**
   * テキストベースフォールバック用にメッセージを変換する。
   * - システムプロンプトにツール定義を追加
   * - assistant の tool_calls フィールドを XML フォーマットに変換
   * - role: "tool" をユーザーメッセージ（テキスト）に変換
   */
  private prepareTextBasedMessages(messages: Message[], toolsDescription: string): Message[] {
    const result: Message[] = [];
    let hasSystem = false;

    for (const msg of messages) {
      if (msg.role === "system") {
        hasSystem = true;
        const existing = typeof msg.content === "string" ? msg.content : "";
        result.push({ ...msg, content: existing + "\n\n" + toolsDescription });
      } else if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        // tool_calls を XML フォーマットに変換してテキストに埋め込む
        const toolCallText = msg.tool_calls
          .map(
            (tc) =>
              `<tool_call>\n{"name": "${tc.function.name}", "parameters": ${tc.function.arguments}}\n</tool_call>`,
          )
          .join("\n");
        const textPart = typeof msg.content === "string" ? msg.content : "";
        result.push({
          role: "assistant",
          content: textPart ? `${textPart}\n${toolCallText}` : toolCallText,
        });
      } else if (msg.role === "tool") {
        // ツール実行結果をユーザーメッセージに変換
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        result.push({
          role: "user",
          content: `[ツール実行結果]\n${content}`,
        });
      } else {
        result.push(msg);
      }
    }

    // システムプロンプトがなければ先頭に追加
    if (!hasSystem) {
      result.unshift({ role: "system", content: toolsDescription });
    }

    return result;
  }

  /** ツール定義をシステムプロンプト用テキストフォーマットに変換する */
  private formatToolsForPrompt(tools: ToolDefinition[]): string {
    const toolList = tools
      .map((t) => {
        const params = JSON.stringify(t.function.parameters, null, 2);
        return `### ${t.function.name}\n説明: ${t.function.description}\nパラメータ:\n\`\`\`json\n${params}\n\`\`\``;
      })
      .join("\n\n");

    return `# ツール使用方法
ツールを使用する場合は、以下のJSONフォーマットで記述してください:

<tool_call>
{"name": "ツール名", "parameters": {"パラメータ名": "値"}}
</tool_call>

複数のツールを呼び出す場合は、複数の <tool_call> ブロックを記述してください。
ツールの結果は次のターンで [ツール実行結果] として提供されます。
ツール呼び出しの前後にテキストを含めることができます。

# 利用可能なツール

${toolList}`;
  }
}

/** テキストから <tool_call>...</tool_call> ブロックを抽出してツールコールリストを返す */
function parseTextToolCalls(text: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { name: string; parameters?: Record<string, unknown> };
      if (!parsed.name) continue;
      toolCalls.push({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        type: "function",
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.parameters ?? {}),
        },
      });
    } catch {
      // JSON パースエラーは無視
    }
  }

  return toolCalls;
}
