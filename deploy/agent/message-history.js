export class MessageHistory {
    messages = [];
    systemPrompt;
    onAssistantMessage = null;
    constructor(systemPrompt) {
        this.systemPrompt = systemPrompt;
    }
    setAssistantMessageCallback(cb) {
        this.onAssistantMessage = cb;
    }
    getMessages() {
        return [{ role: "system", content: this.systemPrompt }, ...this.messages];
    }
    getRawMessages() {
        return [...this.messages];
    }
    getMessageCount() {
        return this.messages.length;
    }
    addUserMessage(content) {
        this.messages.push({ role: "user", content });
    }
    addAssistantMessage(content, toolCalls) {
        const msg = { role: "assistant", content };
        if (toolCalls && toolCalls.length > 0) {
            msg.tool_calls = toolCalls;
        }
        this.messages.push(msg);
        this.onAssistantMessage?.(content, toolCalls);
    }
    addToolResult(toolCallId, content) {
        this.messages.push({
            role: "tool",
            content,
            tool_call_id: toolCallId,
        });
    }
    replaceOlderMessages(summary, keepRecent) {
        if (this.messages.length <= keepRecent)
            return;
        const recent = this.messages.slice(-keepRecent);
        this.messages = [
            { role: "system", content: `[会話履歴の要約]\n${summary}` },
            ...recent,
        ];
    }
    /** 直近 N 往復の会話テキストを返す（意図分類の文脈提供用） */
    getRecentContext(turns) {
        const recent = this.messages.slice(-(turns * 2));
        return recent
            .map((m) => {
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `[${m.role}]: ${content}`;
        })
            .join("\n");
    }
    getFullText() {
        return this.messages
            .map((m) => {
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `${m.role}: ${content}`;
        })
            .join("\n");
    }
    updateSystemPrompt(prompt) {
        this.systemPrompt = prompt;
    }
    clear() {
        this.messages = [];
    }
}
//# sourceMappingURL=message-history.js.map