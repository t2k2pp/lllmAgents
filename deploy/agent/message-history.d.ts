import type { Message, ToolCall, ContentPart } from "../providers/base-provider.js";
/** アシスタントメッセージ追加時のコールバック */
export type AssistantMessageCallback = (content: string, toolCalls?: ToolCall[]) => void;
export declare class MessageHistory {
    private messages;
    private systemPrompt;
    private onAssistantMessage;
    constructor(systemPrompt: string);
    setAssistantMessageCallback(cb: AssistantMessageCallback | null): void;
    getMessages(): Message[];
    getRawMessages(): Message[];
    getMessageCount(): number;
    addUserMessage(content: string | ContentPart[]): void;
    addAssistantMessage(content: string, toolCalls?: ToolCall[]): void;
    addToolResult(toolCallId: string, content: string): void;
    replaceOlderMessages(summary: string, keepRecent: number): void;
    /** 直近 N 往復の会話テキストを返す（意図分類の文脈提供用） */
    getRecentContext(turns: number): string;
    getFullText(): string;
    updateSystemPrompt(prompt: string): void;
    clear(): void;
}
//# sourceMappingURL=message-history.d.ts.map