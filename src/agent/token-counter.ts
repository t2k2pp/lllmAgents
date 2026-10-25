import type { Message, ToolDefinition } from "../providers/base-provider.js";

/**
 * Simple token counter using character-based estimation.
 * For more accurate counting, a model-specific tokenizer could be used,
 * but for local LLMs the exact tokenizer is often unavailable.
 *
 * Heuristic: ~4 characters per token for English, ~2 for Japanese/CJK.
 */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK characters and other multi-byte: ~1 token each
    if (code > 0x2e80) {
      count += 1;
    } else {
      count += 0.25; // ~4 chars per token for ASCII
    }
  }
  // Add overhead for message framing
  return Math.ceil(count * 1.1);
}

export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    // Role overhead
    total += 4;
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    total += estimateTokens(content);
    if (msg.tool_calls) {
      total += estimateTokens(JSON.stringify(msg.tool_calls));
    }
  }
  return total;
}

/**
 * ツール定義 (provider に tools として渡す JSON) の推定トークン数。
 * estimateMessageTokens はメッセージだけを数えるので、 プロンプト全体の推定にはこれを足す
 * (docs/context-reduction-redesign.md §4.1 の P)。
 */
export function estimateToolDefinitionTokens(tools: ToolDefinition[]): number {
  if (tools.length === 0) return 0;
  return estimateTokens(JSON.stringify(tools));
}
