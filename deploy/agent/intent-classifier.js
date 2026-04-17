import { collectResponse } from "../providers/base-provider.js";
import * as logger from "../utils/logger.js";
// ─── ヒューリスティック（明白なケースのみ） ───
/** 明らかにタスクではない入力 */
const CONVERSATION_ONLY_PATTERNS = [
    /^(こんにちは|おはよう|こんばんは|やあ|ども|よろしく|ありがとう|お疲れ|さようなら|おやすみ)\s*[。！!]?$/,
    /^(hi|hello|hey|thanks|thank you|bye|good morning|good night)\s*[.!]?$/i,
    /^(はい|いいえ|ok|yes|no|うん|ううん)\s*[。！!.]?$/i,
];
/** 明らかにタスクリクエストである入力 */
const OBVIOUS_TASK_PATTERNS = [
    /```[\s\S]+```/, // コードブロック付き → 実装関連の可能性が高い
    /(?:を|して|に)(実装|作成|修正|変更|追加|削除|リファクタ|書き換え|直して)/,
    /(?:implement|create|fix|modify|add|delete|refactor|write|build)\s+/i,
];
function heuristicIntentClassify(text) {
    const trimmed = text.trim();
    // 短い挨拶・返事
    if (CONVERSATION_ONLY_PATTERNS.some((p) => p.test(trimmed))) {
        return "conversation";
    }
    // 明らかなタスク指示
    if (OBVIOUS_TASK_PATTERNS.some((p) => p.test(trimmed))) {
        return "task";
    }
    // 判定不能 → LLMに委ねる
    return null;
}
/** 明らかな完了宣言 */
const OBVIOUS_COMPLETION_PATTERNS = [
    /完了(しました|いたしました|です|致しました)/,
    /以上で.*(?:完了|完成|終了|実装)/,
    /すべて.*(?:実装済み|完了|完成)/,
    /task\s+(?:complete|done|finished)/i,
    /all\s+.*(?:implemented|complete|done)/i,
];
/** 明らかに作業中 */
const OBVIOUS_IN_PROGRESS_PATTERNS = [
    /次[にはの]|続[けい]て|これから/,
    /next\s+(?:step|I'll|we)/i,
    /now\s+(?:let me|I'll|working)/i,
];
function heuristicCompletionClassify(text) {
    if (OBVIOUS_COMPLETION_PATTERNS.some((p) => p.test(text))) {
        return "completed";
    }
    if (OBVIOUS_IN_PROGRESS_PATTERNS.some((p) => p.test(text))) {
        return "in_progress";
    }
    return null;
}
// ─── LLM分類 ───
const INTENT_CLASSIFY_PROMPT = `ユーザーの入力を分類してください。JSONのみ返してください。他のテキストは不要です。

分類:
- "task": 実装・修正・作成・操作など、ツール操作を伴うリクエスト
- "question": 説明・質問（回答のみで完了するもの）
- "conversation": 挨拶・雑談・承認・フィードバック

直近の文脈:
{context}

ユーザー入力:
{input}

JSONのみ:`;
const COMPLETION_CLASSIFY_PROMPT = `AIの応答がタスク完了を宣言しているか判定してください。JSONのみ返してください。

分類:
- "completed": タスクが完了したことを明示的に宣言している
- "in_progress": まだ作業途中、または次のステップがある
- "other": タスク完了とは無関係な応答

AI応答（末尾200文字）:
{response}

JSONのみ:`;
function extractClassification(raw, validValues) {
    // JSON パース試行
    const jsonMatch = raw.match(/\{[^}]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const type = parsed.type ?? parsed.classification ?? parsed.result ?? parsed.intent;
            if (type && validValues.includes(type)) {
                return type;
            }
        }
        catch { /* fall through */ }
    }
    // 引用符付きの値を直接探す
    for (const v of validValues) {
        if (raw.includes(`"${v}"`))
            return v;
    }
    return null;
}
export class IntentClassifier {
    provider;
    model;
    constructor(provider, model) {
        this.provider = provider;
        this.model = model;
    }
    /**
     * ユーザーメッセージがタスクリクエストか判定する。
     * ヒューリスティック → LLM の2段構え。
     */
    async classifyIntent(userMessage, recentContext = "") {
        // Step 1: ヒューリスティック
        const heuristic = heuristicIntentClassify(userMessage);
        if (heuristic !== null) {
            logger.debug(`Intent classified by heuristic: ${heuristic}`);
            return heuristic;
        }
        // Step 2: LLM判定
        try {
            const prompt = INTENT_CLASSIFY_PROMPT
                .replace("{context}", recentContext.slice(-500) || "(なし)")
                .replace("{input}", userMessage.slice(0, 300));
            const gen = this.provider.chat({
                model: this.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0,
                maxTokens: 50,
                stream: true,
            });
            const response = await collectResponse(gen);
            const result = extractClassification(response.content, ["task", "question", "conversation"]);
            if (result) {
                logger.debug(`Intent classified by LLM: ${result}`);
                return result;
            }
        }
        catch (e) {
            logger.debug(`Intent LLM classification failed: ${e}`);
        }
        // フォールバック: 判定不能ならタスクとして扱う（安全側に倒す）
        logger.debug("Intent classification fallback: task");
        return "task";
    }
    /**
     * AI応答がタスク完了を宣言しているか判定する。
     */
    async classifyCompletion(assistantResponse) {
        // Step 1: ヒューリスティック
        const heuristic = heuristicCompletionClassify(assistantResponse);
        if (heuristic !== null) {
            logger.debug(`Completion classified by heuristic: ${heuristic}`);
            return heuristic;
        }
        // Step 2: LLM判定
        try {
            const prompt = COMPLETION_CLASSIFY_PROMPT
                .replace("{response}", assistantResponse.slice(-200));
            const gen = this.provider.chat({
                model: this.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0,
                maxTokens: 50,
                stream: true,
            });
            const response = await collectResponse(gen);
            const result = extractClassification(response.content, ["completed", "in_progress", "other"]);
            if (result) {
                logger.debug(`Completion classified by LLM: ${result}`);
                return result;
            }
        }
        catch (e) {
            logger.debug(`Completion LLM classification failed: ${e}`);
        }
        // フォールバック: 判定不能なら「その他」（リプロンプト発動側に倒す）
        logger.debug("Completion classification fallback: other");
        return "other";
    }
    /**
     * isTaskRequest の置き換え（同期的にヒューリスティックのみ使用するケース用）
     */
    isObviousTask(text) {
        return heuristicIntentClassify(text) === "task";
    }
    /**
     * isCompletionResponse の置き換え（同期的にヒューリスティックのみ使用するケース用）
     */
    isObviousCompletion(text) {
        return heuristicCompletionClassify(text) === "completed";
    }
}
//# sourceMappingURL=intent-classifier.js.map