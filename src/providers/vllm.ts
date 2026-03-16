import { OpenAICompatProvider } from "./openai-compat.js";
import type { ChatParams, ChatWithToolsParams, ChatChunk } from "./base-provider.js";

export class VLLMProvider extends OpenAICompatProvider {
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
   * Qwen3 等のモデルは vLLM で --enable-reasoning 未設定時に <think> タグなしで
   * thinking コンテンツを content フィールドに出力し、</think> だけで区切る。
   */
  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* this.applyThinkFilter(super.chat(params));
  }

  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    yield* this.applyThinkFilter(super.chatWithTools(params));
  }

  /**
   * </think> タグまでのコンテンツ（thinking部分）を除去するフィルタ。
   *
   * 最初の BUFFER_LIMIT 文字まで </think> を待ちバッファリングする。
   * - </think> が見つかった → それ以前を捨て、以降をストリーミング
   * - BUFFER_LIMIT を超えた → thinking なしと判断、バッファを flush して通常ストリーミングに切り替え
   * これにより非 thinking モデルではストリーミング感が維持される。
   */
  private async *applyThinkFilter(gen: AsyncGenerator<ChatChunk>): AsyncGenerator<ChatChunk> {
    const BUFFER_LIMIT = 2000;
    let buffer = "";
    let thinkFilterDone = false;

    for await (const chunk of gen) {
      if (chunk.type === "text" && chunk.text && !thinkFilterDone) {
        buffer += chunk.text;
        const closeIdx = buffer.indexOf("</think>");
        if (closeIdx !== -1) {
          // </think> 発見 → 以降のみ yield してストリーミング再開
          thinkFilterDone = true;
          const afterThink = buffer.slice(closeIdx + 8);
          buffer = "";
          if (afterThink) {
            yield { ...chunk, text: afterThink };
          }
        } else if (buffer.length >= BUFFER_LIMIT) {
          // バッファ上限超過 → thinking なしと判断してストリーミングに切り替え
          thinkFilterDone = true;
          yield { ...chunk, text: buffer };
          buffer = "";
        }
        // else: まだバッファリング中（</think> 待ち）
      } else {
        if (!thinkFilterDone && buffer && chunk.type === "done") {
          // ストリーム完了まで </think> が来なかった → バッファをそのまま yield
          thinkFilterDone = true;
          yield { type: "text", text: buffer };
          buffer = "";
        }
        yield chunk;
      }
    }
  }
}
