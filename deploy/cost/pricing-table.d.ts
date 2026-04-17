export interface ModelPricing {
    inputPerMToken: number;
    outputPerMToken: number;
    cachedInputPerMToken?: number;
}
export declare const BUILTIN_PRICING: Record<string, ModelPricing>;
/**
 * 料金テーブルをロード。
 * ユーザーカスタム単価 (~/.localllm/pricing.json) があれば組み込みを上書き。
 */
export declare function loadPricing(): Record<string, ModelPricing>;
/**
 * モデル名から料金を取得。
 * 部分一致も試行する（例: "gemini-3-flash-001" → "gemini-3-flash"）。
 */
export declare function getModelPricing(model: string): ModelPricing | null;
//# sourceMappingURL=pricing-table.d.ts.map