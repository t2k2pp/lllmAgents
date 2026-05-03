# システムプロンプト最適化設計書

## 目的

システムプロンプトのトークン消費を削減し、コンテキストウィンドウを有効活用する。
ガイドの内容は一切失わず、表示タイミングと記述密度を最適化する。

## 施策

### 1. 段階的開示（B方式: ツール初回使用時ガイド注入）

**対象セクション**:
- セカンドLLMガイド (~350 tok)
- Obsidian Knowledgeガイド (~400 tok)

**方針**:
- システムプロンプトにはツールの存在だけを1行で記載
- 詳細ガイドはツール初回使用時にツール結果に付加して注入
- 2回目以降は注入しない（`usedToolGuides: Set<string>` で追跡）

**注入タイミング**: `executeSingleTool` / `executeToolsParallel` 内で `enrichToolResult` の後に実行

**対象ツール名 → ガイドキーのマッピング**:
- `second_llm_consult`, `second_llm_agent` → `"secondLLM"`
- `knowledge_save`, `knowledge_search` → `"obsidian"`

**実装箇所**:
- `src/agent/tool-guides.ts` (新規): ガイドテキスト定数 + 取得関数
- `src/agent/agent-loop.ts`: 初回使用判定 + 結果にガイド付加
- `src/agent/system-prompt.ts`: 対象セクションを1行要約に置換

### 2. 構造化圧縮（2a: 散文→箇条書き）

**対象セクション**:
- 実装→検証→修正サイクル (~500 tok → ~250 tok)
- コアアイデンティティ冒頭の散文

**方針**:
- 原則・具体例・禁止事項はすべて残す
- 散文を箇条書き/テーブル形式に変換
- 冗長な説明文を削除し、キーワードで伝える

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/agent/tool-guides.ts` | 新規: ガイドテキスト定数 + `getFirstUseGuide()` |
| `src/agent/agent-loop.ts` | `usedToolGuides` Set追加、初回注入ロジック |
| `src/agent/system-prompt.ts` | セカンドLLM/Obsidianセクション簡潔化、実装サイクル圧縮 |

## 期待効果

- 固定部分: ~1150 tok → ~810 tok (約-340 tok)
- セカンドLLM+Obsidian有効時: ~750 tok が初回使用まで遅延
- 合計: 全機能有効時に約1000トークン削減
