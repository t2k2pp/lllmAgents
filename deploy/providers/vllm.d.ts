import { OpenAICompatProvider } from "./openai-compat.js";
import type { ChatParams, ChatWithToolsParams, ChatChunk } from "./base-provider.js";
export declare class VLLMProvider extends OpenAICompatProvider {
    constructor(baseUrl: string);
    supportsVision(modelName: string): Promise<boolean>;
    /**
     * chat() をオーバーライドして thinking タグをフィルタリングする。
     * Qwen3, Mistral Small 4 (ハイブリッド) 等に対応。
     */
    chat(params: ChatParams): AsyncGenerator<ChatChunk>;
    chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk>;
    /**
     * thinking タグまでのコンテンツを除去するフィルタ。
     * 対応タグ: </think>, </thinking>
     *
     * Qwen3, Mistral Small 4 (ハイブリッド), DeepSeek-R1 等に対応。
     *
     * 動作:
     * 1. 最初のテキストチャンクが '<' で始まらない
     *    → thinking なしと即判断してバッファリングせずストリーミング継続
     * 2. '<' で始まる場合は BUFFER_LIMIT まで終了タグを待つ
     *    - 終了タグ発見 → thinking 部分を捨て、以降をストリーミング再開
     *    - BUFFER_LIMIT 超過 → thinking なしと判断してバッファを flush
     * 3. ストリーム完了まで終了タグが来なかった → バッファをそのまま yield
     * 4. 反復崩壊を検出したらストリームを打ち切る (4bit量子化モデル対策)
     */
    private applyThinkFilter;
}
//# sourceMappingURL=vllm.d.ts.map