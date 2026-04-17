import { httpGet, httpPostStream } from "../utils/http-client.js";
export class OpenAICompatProvider {
    providerType;
    baseUrl;
    constructor(providerType, baseUrl) {
        this.providerType = providerType;
        // Remove trailing slash
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }
    getModelsUrl() {
        return `${this.baseUrl}/v1/models`;
    }
    getChatUrl() {
        return `${this.baseUrl}/v1/chat/completions`;
    }
    async getRequestHeaders() {
        return {};
    }
    async testConnection() {
        try {
            const res = await httpGet(this.getModelsUrl(), 5000);
            return res.ok;
        }
        catch {
            return false;
        }
    }
    async listModels() {
        const res = await httpGet(this.getModelsUrl());
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
    async getModelInfo(modelName) {
        const models = await this.listModels();
        const found = models.find((m) => m.name === modelName);
        return {
            name: modelName,
            size: found?.size ?? 0,
            contextLength: found?.contextLength ?? 4096,
            supportsVision: found?.supportsVision ?? false,
            supportsFunctionCalling: found?.supportsFunctionCalling ?? true,
        };
    }
    async *chat(params) {
        yield* this.doChat(params);
    }
    async *chatWithTools(params) {
        yield* this.doChat(params);
    }
    async supportsVision(_modelName) {
        return false;
    }
    async *chatWithVision(params) {
        yield* this.chat(params);
    }
    async *doChat(params) {
        const body = {
            model: params.model,
            messages: params.messages.map((m) => this.formatMessage(m)),
            stream: true,
            // ストリーミングでusage情報を取得するためのオプション
            stream_options: { include_usage: true },
        };
        // サンプリングパラメータ: 設定値がある場合のみ送信。未指定ならサーバー側デフォルトに委ねる
        // (モデルの generation_config.json / Modelfile 等の推奨値がそのまま使われる)
        if (params.temperature !== undefined)
            body.temperature = params.temperature;
        if (params.top_p !== undefined)
            body.top_p = params.top_p;
        if (params.top_k !== undefined)
            body.top_k = params.top_k;
        if (params.repetition_penalty !== undefined)
            body.repetition_penalty = params.repetition_penalty;
        // max_tokens: 設定のcontextWindowから渡されたモデルのコンテキストサイズを使用する。
        // サーバーは入力トークン+max_tokensがコンテキストを超えないよう自動調整するため、
        // コンテキストサイズをそのまま渡しても問題ない。
        // finish_reason="length" が返った場合はエージェント側で自動継続する。
        if (params.maxTokens) {
            body.max_tokens = params.maxTokens;
        }
        if (params.tools && params.tools.length > 0) {
            body.tools = params.tools;
            body.tool_choice = params.toolChoice ?? "auto";
        }
        let streamBody;
        try {
            const headers = await this.getRequestHeaders();
            streamBody = await httpPostStream(this.getChatUrl(), body, undefined, undefined, headers);
        }
        catch (e) {
            yield { type: "error", error: String(e) };
            return;
        }
        // Track partial tool calls across SSE chunks
        const partialToolCalls = new Map();
        // Track usage from streaming response
        let lastUsage;
        const reader = streamBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data: "))
                        continue;
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
                    let chunk;
                    try {
                        chunk = JSON.parse(payload);
                    }
                    catch {
                        continue;
                    }
                    // ストリームからusage情報を抽出
                    if (chunk.usage) {
                        lastUsage = {
                            promptTokens: chunk.usage.prompt_tokens,
                            completionTokens: chunk.usage.completion_tokens,
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
                                const partial = partialToolCalls.get(idx);
                                if (tc.id)
                                    partial.id = tc.id;
                                if (tc.function?.name)
                                    partial.name += tc.function.name;
                                if (tc.function?.arguments)
                                    partial.args += tc.function.arguments;
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
        }
        catch (e) {
            // アイドルタイムアウトやAbortによるストリーム切断をわかりやすいエラーに変換
            const err = e instanceof Error ? e : new Error(String(e));
            if (err.name === "AbortError" || err.message.includes("abort")) {
                yield {
                    type: "error",
                    error: "ストリーム読み取りタイムアウト: LLMサーバーから一定時間データが受信できませんでした。サーバーの状態を確認してください。",
                };
            }
            else {
                yield { type: "error", error: err.message };
            }
            return;
        }
        finally {
            reader.releaseLock();
        }
    }
    formatMessage(msg) {
        const formatted = { role: msg.role };
        if (typeof msg.content === "string") {
            formatted.content = msg.content;
        }
        else {
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
 * ツール呼び出し引数からモデルのトークンアーティファクトを除去し、有効なJSONに修復する。
 *
 * 各種LLMが特殊トークン（ChatML: <|im_start|>, Llama: <|eot_id|>, その他 <|...|> 形式）を
 * ツール引数に混入させることがある。これらが JSON 内のエスケープシーケンスと干渉して
 * JSON全体を壊すため、汎用的に除去・修復する。
 */
function sanitizeToolCallArgs(args) {
    // まず有効なJSONならそのまま返す
    try {
        JSON.parse(args);
        return args;
    }
    catch {
        // 修復を試みる
    }
    let cleaned = args;
    // Phase 1: 特殊トークンの汎用除去
    // <|...|> 形式のトークン全般 (例: <|im_start|>, <|eot_id|>, <|"|>, <|\"|>)
    cleaned = cleaned.replace(/<\|[^<]*?\|>/g, '');
    // [INST], [/INST] 等のメタタグ
    cleaned = cleaned.replace(/\[\/?INST\]/g, '');
    // 残った <|...（閉じ |> がないもの）: <| + バックスラッシュ + 引用符 → 引用符に
    cleaned = cleaned.replace(/<\|\\"/g, '"');
    // <| + バックスラッシュ + 非引用符文字 → バックスラッシュごと除去
    cleaned = cleaned.replace(/<\|\\(.)/g, '$1');
    // 残った <| → 除去
    cleaned = cleaned.replace(/<\|/g, '');
    // 孤立した |> → 除去
    cleaned = cleaned.replace(/\|>/g, '');
    try {
        JSON.parse(cleaned);
        return cleaned;
    }
    catch {
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
    }
    catch {
        // Phase 3 へ
    }
    // Phase 3: JSON で無効なエスケープシーケンスの修復
    // 有効: \n \r \t \b \f \u \\ \/ \"  → それ以外の \X は \\X に（バックスラッシュを保持）
    // 例: \U → \\U (Windowsパス C:\Users 等を壊さない)、\p → \\p
    cleaned = cleaned.replace(/\\([^nrtbfu\\/"])/g, '\\\\$1');
    try {
        JSON.parse(cleaned);
        return cleaned;
    }
    catch {
        // Phase 4 へ
    }
    // Phase 4: 括弧バランスの修復（末尾が途切れている場合）
    const openBraces = (cleaned.match(/{/g) || []).length;
    const closeBraces = (cleaned.match(/}/g) || []).length;
    const openBrackets = (cleaned.match(/\[/g) || []).length;
    const closeBrackets = (cleaned.match(/]/g) || []).length;
    for (let i = 0; i < openBrackets - closeBrackets; i++)
        cleaned += "]";
    for (let i = 0; i < openBraces - closeBraces; i++)
        cleaned += "}";
    try {
        JSON.parse(cleaned);
        return cleaned;
    }
    catch {
        // 修復不能: 空のオブジェクトを返す（ツール実行側でエラーになる）
        return "{}";
    }
}
//# sourceMappingURL=openai-compat.js.map