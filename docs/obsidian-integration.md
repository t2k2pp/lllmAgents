# Obsidian連携設計書 — ナレッジベース統合

> **ステータス**: 設計レビュー中

## 目的

lllmAgentsが調査・収集した情報を、Obsidian Vault に構造化されたナレッジとして蓄積する。
エージェントも人も後から検索・参照できる「書庫」を実現する。

## ユースケース

1. **Web検索結果の自動記録** — `web_search` / `web_fetch` で得た情報をナレッジノートとして自動保存
2. **調査メモの構造化** — エージェントが調査過程でまとめた知見をタグ付きで保存
3. **ナレッジ検索** — 過去に記録したノートをエージェントが検索・参照して回答に活用
4. **人間による閲覧** — Obsidianのグラフビュー、タグ検索、全文検索で人が知識を探索

## 設計方針

### 段階的アプローチ

| Phase | 内容 | Obsidianプラグイン | Obsidian起動 |
|-------|------|-------------------|-------------|
| **Phase 1** | Vault直接書き込み + ファイル検索 | 不要 | 不要 |
| **Phase 2** | Local REST API連携 (検索強化) | 必要 | 必要 |

Phase 1 だけで実用に足りる。Phase 2 はオプション拡張。

### なぜ直接ファイル書き込みか

- Obsidian Vault は単なるMarkdownファイルのフォルダ。特殊なDBやバイナリ形式はない
- ファイルを追加すればObsidianが自動検出してインデックスに反映する
- Obsidianが起動していなくても書き込める
- frontmatter (YAML) でメタデータを付与すればObsidianのDataview等で検索可能
- 既存の `file_write` インフラをそのまま活用できる

## Phase 1 設計

### 設定 (`config.json`)

Vault パスは CLI コマンド `/knowledge vault <path>` で設定する（config.json を直接編集しても可）。

```json
{
  "obsidian": {
    "vaultPath": "D:/Obsidian/MyVault",
    "knowledgeDir": "Knowledge",
    "defaultTags": ["lllmagents"]
  }
}
```

| キー | 型 | デフォルト | 説明 |
|------|-----|----------|------|
| `vaultPath` | string | — | Obsidian Vaultの絶対パス。`/knowledge vault <path>` で設定 |
| `knowledgeDir` | string | `"Knowledge"` | ナレッジノートの保存先ディレクトリ (vault相対) |
| `defaultTags` | string[] | `["lllmagents"]` | 全ノートに自動付与するタグ |

ノート本文の言語は日本語固定。

### 保存タイミング

自動キャプチャは行わない。以下の場合にのみナレッジを保存する:
- ユーザーが明示的に「記録して」「ナレッジに保存して」等と指示した場合
- エージェントが調査完了時にユーザーへ「ナレッジに保存しますか？」と確認した場合
- `/knowledge save` コマンドで手動保存する場合

### Vault内ディレクトリ構造

```
MyVault/
  Knowledge/
    web/                  # Web検索・取得結果
      2026-04-13_react-server-components.md
      2026-04-13_vllm-sampling-params.md
    research/             # 調査まとめ（複数ソースを統合）
      typescript-decorator-patterns.md
    reference/            # リファレンス・チートシート
      git-rebase-cheatsheet.md
    _index.md             # 自動生成: タグ別・日付別インデックス
```

サブディレクトリは `type` フィールドに対応。エージェントがノートの性質に応じて自動選択。

### ノートフォーマット

```markdown
---
title: "React Server Components の仕組み"
type: web
source: "https://react.dev/blog/2025/04/server-components"
query: "React Server Components 仕組み 2025"
tags:
  - lllmagents
  - react
  - server-components
  - frontend
created: 2026-04-13T14:30:00+09:00
agent_session: "abc123"
---

# React Server Components の仕組み

## 要約

React Server Components (RSC) は、サーバー側でレンダリングされるコンポーネント...

## 主要ポイント

- サーバーコンポーネントはクライアントバンドルに含まれない
- `"use client"` ディレクティブでクライアントコンポーネントを明示
- ...

## 詳細

（Web取得内容の構造化テキスト、または調査の詳細）

## ソース

- [React公式ブログ](https://react.dev/blog/2025/04/server-components)

## 関連

- [[typescript-decorator-patterns]]
```

#### frontmatter フィールド定義

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `title` | string | Yes | ノートのタイトル |
| `type` | `"web"` \| `"research"` \| `"reference"` | Yes | ノート種別 → 保存先サブディレクトリに対応 |
| `source` | string \| string[] | No | 情報のソースURL |
| `query` | string | No | 元の検索クエリ |
| `tags` | string[] | Yes | Obsidianタグ (階層タグ対応: `programming/typescript`) |
| `created` | ISO 8601 | Yes | 作成日時 |
| `agent_session` | string | No | 作成元のセッションID |
| `updated` | ISO 8601 | No | 更新日時 (追記時に付与) |
| `aliases` | string[] | No | Obsidianエイリアス (別名でリンク可能にする) |

### 新規ツール

#### `knowledge_save` — ナレッジ保存

エージェントが調査結果やWebコンテンツをObsidian Vaultに保存する。

```typescript
{
  name: "knowledge_save",
  parameters: {
    title: string,          // ノートタイトル
    content: string,        // 本文 (Markdown)
    type: "web" | "research" | "reference",
    tags: string[],         // タグ配列
    source?: string | string[],  // ソースURL
    query?: string,         // 元の検索クエリ
  }
}
```

処理フロー:
1. `config.obsidian.vaultPath` の存在確認
2. frontmatter YAML を構築
3. ファイル名生成: `{date}_{slug}.md` (タイトルからslug化)
4. 既存ファイルチェック (同名があれば `_2` 等の連番付加)
5. ファイル書き込み
6. `_index.md` の更新

#### `knowledge_search` — ナレッジ検索

Vault内のナレッジノートを検索し、関連情報を返す。

```typescript
{
  name: "knowledge_search",
  parameters: {
    query: string,           // 検索キーワード
    tags?: string[],         // タグフィルタ
    type?: "web" | "research" | "reference",
    limit?: number,          // 最大件数 (デフォルト: 10)
  }
}
```

処理フロー:
1. `knowledgeDir` 配下のmdファイルをglob
2. frontmatter解析 → tags/type でフィルタ
3. 本文のキーワードマッチ (単純な文字列検索)
4. マッチしたノートの frontmatter + 先頭N行を返却

ファイルシステム操作のみ。外部依存なし。

### `/knowledge` CLIコマンド

```
/knowledge                    設定状態の表示 (Vaultパス、ノート数)
/knowledge vault <path>       Vaultパスの設定
/knowledge tags               よく使うタグの一覧
/knowledge recent [N]         最近のナレッジノート一覧 (デフォルト10件)
/knowledge search <query>     ナレッジ検索
/knowledge open               Vault フォルダをエクスプローラーで開く
```

### 変更ファイル一覧 (実装計画)

| ファイル | 変更 |
|---------|------|
| `src/config/types.ts` | `ObsidianConfig` 型追加、`Config.obsidian` フィールド |
| `src/tools/definitions/knowledge-save.ts` | **新規** — ナレッジ保存ツール |
| `src/tools/definitions/knowledge-search.ts` | **新規** — ナレッジ検索ツール |
| `src/tools/tool-registry.ts` | knowledge_save, knowledge_search の登録 |
| `src/cli/repl.ts` | `/knowledge` コマンド追加 |
| `src/agent/system-prompt.ts` | ナレッジツールの使用ガイドをシステムプロンプトに追加 |
| `docs/config-reference.md` | obsidian設定セクション追加 |

## Phase 2 設計 (将来)

### Obsidian Local REST API 連携

Obsidianの [Local REST API プラグイン](https://github.com/coddingtonbear/obsidian-local-rest-api) を使用。

追加設定:
```json
{
  "obsidian": {
    "restApi": {
      "enabled": true,
      "url": "https://localhost:27124",
      "apiKey": "your-api-key-here"
    }
  }
}
```

Phase 2 で追加される機能:
- **全文検索の強化** — REST APIの `/search/` エンドポイントでObsidianのインデックスを活用
- **既存ノートへの追記** — 同じトピックのノートに情報を追加
- **リンク自動生成** — 既存ノートとの関連を解析して `[[wikilink]]` を自動挿入
- **グラフ情報の活用** — ノート間のリンク構造を参照して関連知識を推薦

Phase 1 の直接ファイル書き込みと REST API を切り替え可能にする (REST API接続失敗時は自動フォールバック)。

## タグ設計ガイドライン

ナレッジの整理・検索に一貫性を持たせるため、以下のタグ体系を推奨:

### 階層構造

```
technology/              # 技術分野
  technology/frontend
  technology/backend
  technology/devops
  technology/ai

language/                # プログラミング言語
  language/typescript
  language/python
  language/rust

framework/               # フレームワーク
  framework/react
  framework/nextjs

concept/                 # 概念・パターン
  concept/architecture
  concept/security
  concept/testing

status/                  # ノートの状態
  status/draft           # 下書き (自動キャプチャ直後)
  status/reviewed        # 人がレビュー済み
  status/archived        # アーカイブ
```

### 自動タグ付けロジック

エージェントが `knowledge_save` 時にコンテンツを分析し、上記の階層タグを自動付与する。
これはLLMの通常の推論として行い、追加のAPI呼び出しは不要 (エージェントが `tags` パラメータに適切な値を渡すだけ)。

## 懸念事項・制約

1. **Vault パスのクロスプラットフォーム** — Windows (`D:\Obsidian\Vault`) と Linux/macOS (`~/Obsidian/Vault`) の違い。`path.resolve` で正規化
2. **ファイル名の制約** — Obsidianは `:`, `|`, `\` 等をファイル名に使えない。slug化時にサニタイズ
3. **重複検出** — 同じURLのコンテンツを何度も保存しないよう、source URLで既存チェック
5. **Vault の容量** — ナレッジノートは数KB/件なので容量問題は実質なし
