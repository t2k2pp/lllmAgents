import type { Message } from "../providers/base-provider.js";
/**
 * Simple token counter using character-based estimation.
 * For more accurate counting, a model-specific tokenizer could be used,
 * but for local LLMs the exact tokenizer is often unavailable.
 *
 * Heuristic: ~4 characters per token for English, ~2 for Japanese/CJK.
 */
export declare function estimateTokens(text: string): number;
export declare function estimateMessageTokens(messages: Message[]): number;
//# sourceMappingURL=token-counter.d.ts.map