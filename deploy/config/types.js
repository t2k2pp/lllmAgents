// ヘルパー: セカンドLLMがクラウドかローカルかを判定
export function isCloudProvider(type) {
    return ["vertex-ai", "azure-openai", "azure-claude"].includes(type);
}
/**
 * 人間可読なトークン数表記をパースする。
 * "128k" → 128000, "256K" → 256000, "1m" → 1000000, "4096" → 4096
 * パース不能なら NaN を返す。
 */
export function parseTokenCount(input) {
    const trimmed = input.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
    if (!match)
        return NaN;
    const num = parseFloat(match[1]);
    const suffix = match[2];
    if (suffix === "k")
        return Math.round(num * 1000);
    if (suffix === "m")
        return Math.round(num * 1000000);
    return Math.round(num);
}
export const DEFAULT_PORTS = {
    ollama: 11434,
    lmstudio: 1234,
    llamacpp: 8080,
    vllm: 8000,
};
export const PROVIDER_LABELS = {
    ollama: "Ollama",
    lmstudio: "LM Studio",
    llamacpp: "llama.cpp",
    vllm: "vLLM",
};
export function getDefaultConfig() {
    return {
        mainLLM: {
            providerType: "ollama",
            baseUrl: "http://localhost:11434",
            model: "",
        },
        visionLLM: null,
        secondLLM: null,
        security: {
            allowedDirectories: [],
            blockedCommands: [],
            autoApproveTools: [
                "file_read", "glob", "grep", "browser_snapshot", "vision_analyze",
                "ask_user", "todo_write", "enter_plan_mode", "exit_plan_mode", "task_output",
                "web_search", "web_fetch",
            ],
            requireApprovalTools: ["file_write", "file_edit", "bash", "browser_navigate", "browser_click", "browser_type"],
            discordAutoApproveTools: [
                "file_read", "glob", "grep",
                "web_search", "web_fetch",
                "browser_snapshot", "vision_analyze",
                "current_datetime", "sandbox_info",
            ],
            slackAutoApproveTools: [
                "file_read", "glob", "grep",
                "web_search", "web_fetch",
                "browser_snapshot", "vision_analyze",
                "current_datetime", "sandbox_info",
            ],
            rules: {
                allow: [],
                deny: [],
                ask: [],
            },
            streamCommandOutput: true,
        },
        context: {
            compressionThreshold: 0.8,
            maxHistoryMessages: 100,
        },
        discord: {
            enabled: false,
            webhookUrl: "",
            interactionPort: 3003,
            listenEnabled: false,
        },
        slack: {
            enabled: false,
            webhookUrl: "",
        },
    };
}
//# sourceMappingURL=types.js.map