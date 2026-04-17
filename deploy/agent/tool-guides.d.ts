/**
 * ツール初回使用時に注入するガイドテキスト（段階的開示）
 *
 * システムプロンプトの肥大化を防ぐため、詳細なガイドは
 * ツール初回使用時にツール結果へ付加する形で遅延注入する。
 */
/**
 * ツール初回使用時のガイドテキストを取得する。
 * 2回目以降は null を返す。
 */
export declare function getFirstUseGuide(toolName: string): string | null;
/**
 * ガイド追跡状態をリセットする（セッション復元時等）
 */
export declare function resetToolGuides(): void;
//# sourceMappingURL=tool-guides.d.ts.map