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
    // P2-B: 旧 0.8 → 0.7 に前倒し。 80% 到達時の圧縮は対象が大きく遅延が嵩むため、
    // 早めに小さく頻繁に圧縮する方が体感が良い。 docs/agent-loop-efficiency-review.md §4.8 参照。
    threshold = 0.7,
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

  /**
   * Phase C-5: 圧縮閾値を変更する。 model 切替で能力ティアが変わったとき、
   * AgentLoop から capability.compressionThreshold を流し込む用途。
   */
  setThreshold(value: number): void {
    this.threshold = value;
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
