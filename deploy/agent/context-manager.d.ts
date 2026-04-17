import type { LLMProvider } from "../providers/base-provider.js";
import type { MessageHistory } from "./message-history.js";
export declare class ContextManager {
    private contextWindow;
    private threshold;
    private keepRecentMessages;
    private compressor;
    constructor(provider: LLMProvider, model: string, contextWindow: number, threshold?: number, keepRecentMessages?: number);
    setContextWindow(value: number): void;
    shouldCompress(history: MessageHistory): boolean;
    compress(history: MessageHistory): Promise<void>;
}
//# sourceMappingURL=context-manager.d.ts.map