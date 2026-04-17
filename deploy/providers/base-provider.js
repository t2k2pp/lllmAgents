export async function collectResponse(gen) {
    let content = "";
    const toolCalls = [];
    let finishReason = "stop";
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
                break;
            case "error":
                throw new Error(chunk.error ?? "Unknown LLM error");
        }
    }
    return { content, toolCalls, finishReason };
}
//# sourceMappingURL=base-provider.js.map