/**
 * ツール初回使用時に注入するガイドテキスト（段階的開示）
 *
 * システムプロンプトの肥大化を防ぐため、詳細なガイドは
 * ツール初回使用時にツール結果へ付加する形で遅延注入する。
 */
/** ガイドキー → 対象ツール名のマッピング */
const TOOL_GUIDE_MAP = {
    secondLLM: ["second_llm_consult", "second_llm_agent"],
    obsidian: ["knowledge_save", "knowledge_search"],
};
/** ツール名 → ガイドキーの逆引き */
const TOOL_TO_GUIDE = new Map();
for (const [guideKey, toolNames] of Object.entries(TOOL_GUIDE_MAP)) {
    for (const name of toolNames) {
        TOOL_TO_GUIDE.set(name, guideKey);
    }
}
/** ガイドテキスト本体 */
const GUIDE_TEXTS = {
    secondLLM: `[ガイド: セカンドLLMの使い方]
以下の場面で自発的に使用すること:
- コンテキスト節約: 大きなファイルの調査や要約など、メインの会話履歴を消費したくない作業を委任
- コードレビュー: 自分が書いたコードの品質チェックを別の視点で確認
- 方針の壁打ち: 実装アプローチに迷った時に相談

使い分け:
- second_llm_consult: 単発の質問（分析・要約・レビュー）
- second_llm_agent: ツールを使った複合タスク委任（ファイル調査+レポート等）

注意: 単純なファイル読み書きなど自分で直接できるタスクには使わない。`,
    obsidian: `[ガイド: ナレッジベース（Obsidian連携）の使い方]
## knowledge_save — 保存
ユーザーが「記録して」「ナレッジに保存して」等と指示した場合のみ使用する。自動的には保存しない。
- ノート本文は日本語で書く
- 推奨構成: ## 要約 → ## 主要ポイント → ## 詳細 → ## ソース
- タグは階層構造: technology/frontend, language/typescript, framework/react 等
- type: web (Web検索結果), research (調査まとめ), reference (チートシート)
- ソースURLがある場合は必ず source に含める

## knowledge_search — 検索
過去に保存したナレッジを検索して回答に活用する。
- タグフィルタで絞り込み可能（前方一致: "technology" で "technology/frontend" もマッチ）`,
};
/** 使用済みガイドキーを追跡する Set */
const usedGuides = new Set();
/**
 * ツール初回使用時のガイドテキストを取得する。
 * 2回目以降は null を返す。
 */
export function getFirstUseGuide(toolName) {
    const guideKey = TOOL_TO_GUIDE.get(toolName);
    if (!guideKey)
        return null;
    if (usedGuides.has(guideKey))
        return null;
    usedGuides.add(guideKey);
    return GUIDE_TEXTS[guideKey] ?? null;
}
/**
 * ガイド追跡状態をリセットする（セッション復元時等）
 */
export function resetToolGuides() {
    usedGuides.clear();
}
//# sourceMappingURL=tool-guides.js.map