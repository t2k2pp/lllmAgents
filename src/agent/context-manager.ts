import type { LLMProvider } from "../providers/base-provider.js";
import type { MessageHistory } from "./message-history.js";
import { estimateMessageTokens } from "./token-counter.js";
import { collectResponse } from "../providers/base-provider.js";
import * as logger from "../utils/logger.js";

export class ContextManager {
  private contextWindow: number;
  private threshold: number;
  private keepRecentMessages: number;

  constructor(
    private provider: LLMProvider,
    private model: string,
    contextWindow: number,
    threshold = 0.8,
    keepRecentMessages = 10,
  ) {
    this.contextWindow = contextWindow;
    this.threshold = threshold;
    this.keepRecentMessages = keepRecentMessages;
  }

  shouldCompress(history: MessageHistory): boolean {
    const messages = history.getMessages();
    const tokens = estimateMessageTokens(messages);
    const limit = this.contextWindow * this.threshold;
    logger.debug(`Context usage: ${tokens}/${this.contextWindow} tokens (${Math.round((tokens / this.contextWindow) * 100)}%)`);
    return tokens > limit;
  }

  async compress(history: MessageHistory): Promise<void> {
    const messages = history.getRawMessages();
    if (messages.length <= this.keepRecentMessages) return;

    const olderMessages = messages.slice(0, -this.keepRecentMessages);

    // Build text to summarize
    const textToSummarize = olderMessages
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${m.role}]: ${content}`;
      })
      .join("\n\n");

    logger.info(`Compressing context: ${olderMessages.length} older messages...`);

    // Ask LLM to summarize
    const summaryGen = this.provider.chat({
      model: this.model,
      messages: [
        {
          role: "system",
          content: "あなたは会話履歴を要約するアシスタントです。",
        },
        {
          role: "user",
          content: `以下の会話履歴を簡潔に要約してください。重要な決定事項、ファイルパス、コード変更、ユーザーの要求を漏らさず含めてください。\n\n${textToSummarize}`,
        },
      ],
      temperature: 0.3,
      maxTokens: 2000,
      stream: true,
    });

    const response = await collectResponse(summaryGen);
    history.replaceOlderMessages(response.content, this.keepRecentMessages);
    logger.info("Context compressed successfully.");
  }
}
