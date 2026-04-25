import type { LLMProvider } from "../providers/base-provider.js";
import type { MessageHistory } from "./message-history.js";
import { estimateMessageTokens } from "./token-counter.js";
import { HierarchicalCompressor } from "./hierarchical-compressor.js";
import * as logger from "../utils/logger.js";

export class ContextManager {
  private contextWindow: number;
  private threshold: number;
  private keepRecentMessages: number;
  private compressor: HierarchicalCompressor;

  constructor(
    provider: LLMProvider,
    model: string,
    contextWindow: number,
    threshold = 0.8,
    keepRecentMessages = 10,
  ) {
    this.contextWindow = contextWindow;
    this.threshold = threshold;
    this.keepRecentMessages = keepRecentMessages;
    this.compressor = new HierarchicalCompressor(provider, model);
  }

  setContextWindow(value: number): void {
    this.contextWindow = value;
  }

  setProvider(provider: LLMProvider, model: string): void {
    this.compressor.setProvider(provider, model);
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

    logger.info(`Compressing context: ${olderMessages.length} older messages → hierarchical summary...`);

    // 階層的圧縮を実行
    const summary = await this.compressor.compress(olderMessages);

    // 圧縮結果で古いメッセージを置き換え
    history.replaceOlderMessages(summary, this.keepRecentMessages);
    logger.info("Context compressed successfully (hierarchical).");
  }
}
