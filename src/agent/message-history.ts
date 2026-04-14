import type { Message, ToolCall, ContentPart } from "../providers/base-provider.js";

/** アシスタントメッセージ追加時のコールバック */
export type AssistantMessageCallback = (content: string, toolCalls?: ToolCall[]) => void;

export class MessageHistory {
  private messages: Message[] = [];
  private systemPrompt: string;
  private onAssistantMessage: AssistantMessageCallback | null = null;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  setAssistantMessageCallback(cb: AssistantMessageCallback | null): void {
    this.onAssistantMessage = cb;
  }

  getMessages(): Message[] {
    return [{ role: "system", content: this.systemPrompt }, ...this.messages];
  }

  getRawMessages(): Message[] {
    return [...this.messages];
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  addUserMessage(content: string | ContentPart[]): void {
    this.messages.push({ role: "user", content });
  }

  addAssistantMessage(content: string, toolCalls?: ToolCall[]): void {
    const msg: Message = { role: "assistant", content };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    this.messages.push(msg);
    this.onAssistantMessage?.(content, toolCalls);
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({
      role: "tool",
      content,
      tool_call_id: toolCallId,
    });
  }

  replaceOlderMessages(summary: string, keepRecent: number): void {
    if (this.messages.length <= keepRecent) return;

    const recent = this.messages.slice(-keepRecent);
    this.messages = [
      { role: "system", content: `[会話履歴の要約]\n${summary}` },
      ...recent,
    ];
  }

  /** 直近 N 往復の会話テキストを返す（意図分類の文脈提供用） */
  getRecentContext(turns: number): string {
    const recent = this.messages.slice(-(turns * 2));
    return recent
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${m.role}]: ${content}`;
      })
      .join("\n");
  }

  getFullText(): string {
    return this.messages
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${content}`;
      })
      .join("\n");
  }

  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  clear(): void {
    this.messages = [];
  }
}
