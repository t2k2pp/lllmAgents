import { OpenAICompatProvider } from "./openai-compat.js";
export class VLLMProvider extends OpenAICompatProvider {
    constructor(baseUrl) {
        super("vllm", baseUrl);
    }
    async supportsVision(modelName) {
        const lower = modelName.toLowerCase();
        return (lower.includes("llava") ||
            lower.includes("qwen-vl") ||
            lower.includes("qwen2-vl") ||
            lower.includes("phi-3.5-vision") ||
            lower.includes("pixtral") ||
            lower.includes("internvl"));
    }
    /**
     * chat() をオーバーライドして thinking タグをフィルタリングする。
     * Qwen3, Mistral Small 4 (ハイブリッド) 等に対応。
     */
    async *chat(params) {
        yield* this.applyThinkFilter(super.chat(params));
    }
    async *chatWithTools(params) {
        yield* this.applyThinkFilter(super.chatWithTools(params));
    }
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
    async *applyThinkFilter(gen) {
        const BUFFER_LIMIT = 2000;
        const CLOSE_TAGS = ["</think>", "</thinking>"];
        let buffer = "";
        let thinkFilterDone = false;
        let firstChunkSeen = false;
        // 反復崩壊検出用
        let recentText = "";
        let repetitionAborted = false;
        for await (const chunk of gen) {
            if (repetitionAborted) {
                // 反復崩壊検出済み: done チャンクだけ流して終了
                if (chunk.type === "done")
                    yield chunk;
                continue;
            }
            if (chunk.type === "text" && chunk.text && !thinkFilterDone) {
                // 最初のチャンクが '<' で始まらない → thinking なし、即 flush してストリーミングへ
                if (!firstChunkSeen) {
                    firstChunkSeen = true;
                    if (!chunk.text.trimStart().startsWith("<")) {
                        thinkFilterDone = true;
                        recentText += chunk.text;
                        yield chunk;
                        continue;
                    }
                }
                buffer += chunk.text;
                // いずれかの終了タグを探す
                let closeIdx = -1;
                let closeTagLen = 0;
                for (const tag of CLOSE_TAGS) {
                    const idx = buffer.indexOf(tag);
                    if (idx !== -1 && (closeIdx === -1 || idx < closeIdx)) {
                        closeIdx = idx;
                        closeTagLen = tag.length;
                    }
                }
                if (closeIdx !== -1) {
                    // 終了タグ発見 → 以降のみ yield してストリーミング再開
                    thinkFilterDone = true;
                    const afterThink = buffer.slice(closeIdx + closeTagLen);
                    buffer = "";
                    if (afterThink) {
                        recentText += afterThink;
                        yield { ...chunk, text: afterThink };
                    }
                }
                else if (buffer.length >= BUFFER_LIMIT) {
                    // バッファ上限超過 → thinking なしと判断してストリーミングに切り替え
                    thinkFilterDone = true;
                    recentText += buffer;
                    yield { ...chunk, text: buffer };
                    buffer = "";
                }
                // else: まだバッファリング中（終了タグ待ち）
            }
            else if (chunk.type === "text" && chunk.text && thinkFilterDone) {
                // thinking フィルタ済み: 反復崩壊チェックしてから yield
                recentText += chunk.text;
                // 最新 300 文字だけ保持
                if (recentText.length > 300)
                    recentText = recentText.slice(-300);
                if (isRepetitionLoop(recentText)) {
                    repetitionAborted = true;
                    // ストリームを打ち切る (done は上のループで流す)
                    continue;
                }
                yield chunk;
            }
            else {
                if (!thinkFilterDone && buffer && chunk.type === "done") {
                    // ストリーム完了まで終了タグが来なかった → バッファをそのまま yield
                    thinkFilterDone = true;
                    yield { type: "text", text: buffer };
                    buffer = "";
                }
                yield chunk;
            }
        }
    }
}
/**
 * テキストが反復崩壊に入っているか判定する。
 * スペース区切りトークン（英語）と CJK 文字列の両方に対応。
 *
 * 直近 200 文字の中に同じ単語（2文字以上）が 4 回以上出現したら崩壊と判定。
 */
function isRepetitionLoop(text) {
    if (text.length < 40)
        return false;
    const check = text.slice(-200);
    // スペース・句読点で分割して単語カウント
    const tokens = check.split(/[\s、。！？,.!?\n]+/).filter((w) => w.length >= 2);
    if (tokens.length < 8)
        return false;
    const counts = new Map();
    for (const t of tokens) {
        const c = (counts.get(t) ?? 0) + 1;
        counts.set(t, c);
        if (c >= 4)
            return true;
    }
    return false;
}
//# sourceMappingURL=vllm.js.map