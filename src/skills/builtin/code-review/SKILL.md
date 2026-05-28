---
name: code-review
description: 任意ファイル・任意範囲のコードレビュー。 ユーザーが「コードをレビューして」 「品質を見て」 「バグがないか確認して」 と任意のコードに対してチェックを依頼した時に使用する。 PR 単位のレビューは `/pr-review`、 メインLLM が別コンテキストでレビューしたい時は task ツールの `code-reviewer` サブエージェント、 lllmAgents の能力を超える深堀りは `/claude-code-driver --prompt "/ultrareview"` を使い分ける。
---

# Code Review

## 手順

1. **対象の把握**: `file_read` / `glob` / `grep` でレビュー対象ファイルと影響範囲を確認
2. **観点に従って指摘**: 下記のコア観点 + 詳細リファレンス
3. **重要度を付与**: Critical / High / Medium / Low の 4 段階
4. **報告**: 重要度の高い順にまとめる

## コア観点 (SKILL.md 本体に明記)

リファレンス丸投げではなく、 **最低これは見る** という観点:

### 1. Correctness (正しさ)

- 境界条件: off-by-one、 空入力、 null/undefined、 空配列
- エラーハンドリング: 想定外パスで落ちないか、 ただし**過剰な防御は減点**
- 型安全: `any` で逃げていないか、 unsafe な型アサーションをしていないか
- 非同期: race、 unhandled rejection、 await 漏れ

### 2. Security

- 入力検証 (system boundary のみ — 内部で過剰検証しない)
- コマンドインジェクション、 SQL インジェクション、 XSS、 path traversal
- 秘密情報の漏洩 (env / 認証情報をログ出力していないか)
- lllmAgents 固有: bash ツールで実行されるコマンドの組み立てに user 入力が混入していないか (`src/security/rules.ts` の 50+ パターンと整合)

### 3. Code quality

- DRY: 同じロジックの重複 (ただし 3 つ未満なら早すぎる抽象化は減点)
- 命名: 識別子だけで何をするか分かるか
- コメント: WHAT ではなく WHY が書かれているか (CLAUDE.md / システムプロンプト準拠)
- 不要なバックワード互換シム・未使用エクスポート

### 4. Tests

- テストがあるか (TDD 文脈なら `/tdd` 参照)
- カバレッジが意味のある分岐を踏んでいるか
- vitest 規約 (`.js` 拡張子 import、 `vi.mock` / `vi.fn`)

### 5. lllmAgents 固有の規約

- 絶対パス利用 (相対パス禁止)
- ファイル操作は専用ツール (bash の cat/sed 等を使っていないか)
- 機能追加なら `docs/<feature>-design.md` が伴っているか
- 設計書とコードの整合 (片方だけ更新で齟齬していないか)

## 詳細観点

より細かい観点は **`references/code-review-criteria.md`** を参照。 重大度の判定基準、 出力フォーマット例、 個別チェックリストが揃っている。

## 出力フォーマット

```
## レビュー結果

### Critical (致命的、 即修正必要)
- src/foo.ts:42 — `JSON.parse(userInput)` が try/catch なし。 不正入力で全体落ちる
  修正案: try/catch で wrapping、 もしくは validation でガード

### High (重要、 短期に修正すべき)
- ...

### Medium (改善推奨)
- ...

### Low (好み・微調整)
- ...

### 全体所感
- 良い点: ...
- 全体傾向: ...
```

## 用途分担

| ツール | 使う場面 |
|--------|---------|
| `code-review` (本スキル) | user が任意ファイル/任意範囲のレビューを明示依頼 |
| `pr-review` (skill) | git diff ベースの PR レビュー |
| `code-reviewer` (task ツール `subagent_type=code-reviewer` 経由) | メイン LLM が自律判断で別コンテキスト走行させたい時 |
| `/claude-code-driver --prompt "/ultrareview"` | lllmAgents の能力では深堀りきれない、 マルチエージェント分析が欲しい時 (コスト高) |

## 完了条件

- [ ] レビュー対象を file_read で実際に読んだ (推測で指摘していない)
- [ ] コア観点 1-5 を一通りチェックした
- [ ] 重大度を付与した
- [ ] 修正案を添えた (指摘だけで終わらない)
