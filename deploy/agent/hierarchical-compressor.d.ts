/**
 * Hierarchical Compressor — 階層的コンテキスト圧縮
 *
 * 3層のグラデーション:
 *   Layer 0: 生データ（直近メッセージ）
 *   Layer 1: ブロック単位の重み付き要約（ユーザー発言優先）
 *   Layer 2: キーワード+制約のみの圧縮要約
 */
import type { LLMProvider, Message } from "../providers/base-provider.js";
export interface SummaryBlock {
    id: string;
    layer: 1 | 2;
    summary: string;
    keyFacts: string[];
    tokenCount: number;
    createdAt: number;
}
export declare class HierarchicalCompressor {
    private provider;
    private model;
    private summaryBlocks;
    constructor(provider: LLMProvider, model: string);
    getSummaryBlocks(): SummaryBlock[];
    /**
     * 階層的圧縮を実行する。
     * 古いメッセージをブロック単位で要約し、要約ブロックとして管理する。
     *
     * @returns 圧縮結果のテキスト（メッセージ履歴の先頭に注入する用）
     */
    compress(olderMessages: Message[]): Promise<string>;
    /** メッセージブロック → Layer 1 要約 */
    private summarizeToLayer1;
    /** Layer 1 ブロック群 → Layer 2 に統合 */
    private promoteToLayer2;
    /** 現在の要約ブロック群からメッセージ履歴に注入するテキストを構築 */
    buildContextSummary(): string;
}
//# sourceMappingURL=hierarchical-compressor.d.ts.map