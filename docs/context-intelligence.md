# コンテキストインテリジェンス設計書

## 背景と課題

### 課題1: 意図分類がテキストマッチング依存

`agent-loop.ts` の `isTaskRequest()` / `isCompletionResponse()` は正規表現のキーワードマッチのみ。

**問題:**
- 偽陽性: 「ファイルの場所を教えて」→「ファイル」マッチ → タスクリクエスト誤判定
- 偽陰性: 「このエラーなんとかして」→ パターン不一致 → 見逃し
- 言語の表現バリエーションに弱い（日英のみ、口語・敬語の揺れ非対応）

### 課題2: コンテキスト圧縮が単純すぎる

`context-manager.ts` の `compress()` は古いメッセージを1つの要約に一括置換するだけ。

**問題:**
- ユーザー発言もAI応答も同じ重みで要約される
- 繰り返し圧縮で「要約の要約」が劣化する（情報の不可逆消失）
- ファイルパス・コード変更・決定事項などの構造化情報が溶ける
- 階層なし — 詳細に遡る手段がない

---

## 設計方針

### A. 意図分類: LLM判定 + ヒューリスティック併用

正規表現を完全に廃止するのではなく、**高速ヒューリスティック → LLM判定のフォールバック**構造にする。

#### 分類フロー

```
ユーザーメッセージ
  │
  ├─ 明白なケース（ヒューリスティック）→ 即判定、LLM不要
  │   例: ツール名直接指定、コードブロック付き、「こんにちは」のみ
  │
  └─ 曖昧なケース → LLM分類（軽量プロンプト）
      入力: ユーザーメッセージ + 直近の文脈（2-3往復）
      出力: { type: "task" | "question" | "conversation", confidence: number }
```

#### LLM分類プロンプト（軽量）

```
ユーザーの入力を分類してください。JSONのみ返してください。
- "task": 実装・修正・作成など、ツール操作を伴うリクエスト
- "question": 説明・質問（ツール操作不要で回答可能）
- "conversation": 挨拶・雑談・フィードバック

入力: "{userMessage}"
直近の文脈: "{recentContext}"
```

#### isCompletionResponse も同様

```
AIの応答がタスク完了を宣言しているか判定してください。JSONのみ返してください。
- "completed": タスク完了を明示的に宣言している
- "in_progress": まだ作業中、または次のステップを示している
- "other": タスク完了とは無関係

応答: "{assistantResponse}"
```

#### パフォーマンス考慮

- LLM分類は `maxTokens: 50, temperature: 0` で呼ぶ（最小コスト）
- ヒューリスティックで判定できるケースはLLMを呼ばない
- 分類結果のキャッシュは不要（同一入力の再分類はない）

---

### B. 階層的コンテキスト圧縮

#### コアコンセプト: 記憶のグラデーション

```
┌─────────────────────────────────────────────────┐
│  Layer 0: 生データ（直近 keepRecentMessages 件） │  ← 現在の文脈、そのまま保持
├─────────────────────────────────────────────────┤
│  Layer 1: 詳細要約（ブロック単位）               │  ← 誰が何を求め、何を変更したか
├─────────────────────────────────────────────────┤
│  Layer 2: 圧縮要約（キーワード+制約のみ）        │  ← 決定事項・ファイルパス・制約
└─────────────────────────────────────────────────┘
```

#### データ構造

```typescript
interface SummaryBlock {
  id: string;                    // ブロック識別子
  layer: 0 | 1 | 2;             // 圧縮レベル
  messageRange: [number, number]; // 元メッセージのインデックス範囲
  summary: string;               // 要約テキスト
  keyFacts: string[];            // 抽出されたキーファクト
  tokenCount: number;            // このブロックのトークン数
  createdAt: number;             // タイムスタンプ
}

interface ContextState {
  summaryBlocks: SummaryBlock[];  // Layer 1-2 の要約ブロック群
  rawMessages: Message[];         // Layer 0 の生メッセージ
}
```

#### 圧縮フロー

```
トークン上限の80%に到達
  │
  ▼
Step 1: ブロック分割
  古いメッセージを BLOCK_SIZE (例: 10メッセージ) 単位で分割
  │
  ▼
Step 2: ブロック単位の重み付き要約（Layer 0 → Layer 1）
  LLMに以下の優先度で要約させる:
    1. ユーザーの明示的な命令・制約（最優先）
    2. 固有名詞・ファイルパス・コード変更の具体内容
    3. 未解決の問題・次のステップに必要な情報
    4. 解決済みの議論（最小限のみ）
  ユーザー発言は詳細に、AI応答は要点のみ保持
  │
  ▼
Step 3: Layer 1 が増えすぎたら → Layer 2 に昇格
  複数のLayer 1ブロックをまとめてキーワード+制約のみに圧縮
  │
  ▼
Step 4: メッセージ履歴の再構成
  [Layer 2 要約] + [Layer 1 要約群] + [Layer 0 生メッセージ]
  をシステムメッセージとして注入
```

#### 要約プロンプト（Layer 0 → Layer 1）

```
以下の会話ブロックを要約してください。

## 優先度ルール（厳守）
1. **ユーザーの指示・制約**: 「〜して」「〜しないで」等の命令は原文のまま保持
2. **固有名詞・パス・コード**: ファイルパス、関数名、変数名、具体的な数値は省略しない
3. **未解決事項**: まだ完了していないタスク、保留中の判断は詳細に残す
4. **解決済み事項**: 結論のみ1行で（過程は不要）

## 出力形式
以下のJSON形式で返してください:
{
  "summary": "要約テキスト（ユーザー発言を厚めに、AI応答は結論のみ）",
  "keyFacts": ["決定事項1", "ファイルパス: xxx", "未解決: yyy"]
}

## 会話ブロック
{block}
```

#### 要約プロンプト（Layer 1 → Layer 2）

```
以下は過去の会話要約ブロック群です。これらを統合して、
今後の作業に必要な最小限の情報に圧縮してください。

## 保持すべき情報
- ユーザーが設定した制約・ルール
- プロジェクトの重要な決定事項
- 未解決のタスクや問題
- 重要なファイルパスと変更内容

## 削除してよい情報
- 解決済みの議論の詳細
- AIの思考過程や説明
- 試行錯誤の経緯（最終結果のみ残す）

{layer1Blocks}
```

---

## 変更対象ファイル

### 新規作成
- `src/agent/intent-classifier.ts` — 意図分類モジュール
- `src/agent/hierarchical-compressor.ts` — 階層的圧縮モジュール

### 変更
- `src/agent/agent-loop.ts` — isTaskRequest/isCompletionResponse を IntentClassifier に置換
- `src/agent/context-manager.ts` — compress() を HierarchicalCompressor に委譲
- `src/agent/message-history.ts` — SummaryBlock 対応の履歴管理メソッド追加

---

## ログ分析で発見した追加課題と対処（2026-04-14）

### 課題D: リプロンプトが元の意図を喪失
固定文言「ツールを呼び出して実装を開始してください」がモデルを誤誘導。
→ **対処**: リプロンプト文言に `userMessageText` の先頭200文字を含める。

### 課題E: 空応答（text空+tools空）の検出漏れ
`hasStartedOutput=true`（ストリーム中に何か出力した）だが最終テキスト・ツールとも空のケースが、
空応答リトライ（`!hasStartedOutput` チェック）をすり抜けて `return` していた。
→ **対処**: `textContent.trim().length === 0 && toolCalls.length === 0` を独立条件として追加。

### 課題F: 空応答リトライのナッジメッセージも意図喪失
「続けてください。次に必要なアクションを実行してください。」は汎用的すぎる。
→ **対処**: ナッジにも元のユーザー依頼を含める。

---

## コンテキストモード廃止とスキル化（2026-04-14）

### 廃止理由

旧 `/mode` コマンド（dev/review/research）はシステムプロンプトに「Preferred tools」と
DEV_STRATEGY を常時注入する設計だった。以下の問題があった:

1. **ツール制限が不自然**: 人間は開発中にもWeb検索し、調査中にもメモを書く。モードでツールを区切る意味がない
2. **対症療法**: DEV_STRATEGYは27Bモデルの弱点を補うワークアラウンドでシステムプロンプトに埋め込まれていた
3. **常時トークン消費**: 使わない場面でもコンテキストを消費し続ける
4. **Claude Codeにも存在しない仕組み**: 業界標準でもない

### 対処

- `src/context/context-mode.ts` の参照を全削除（ContextModeManager, /mode コマンド, config.contextMode）
- DEV_STRATEGYの内容を `src/skills/builtin/dev-workflow/SKILL.md` にスキルとして移行
- review/research の行動指針も `code-review/SKILL.md`, `research/SKILL.md` にスキル化
- LLMが必要に応じてスキルを選択する形に変更（常時注入から着脱可能に）

### 削除したファイル参照（コードは残存、参照なし）
- `src/context/context-mode.ts` — 次回クリーンアップで物理削除可

### 新規スキル
- `src/skills/builtin/dev-workflow/SKILL.md` — 開発ワークフロー（旧DEV_STRATEGY）
- `src/skills/builtin/code-review/SKILL.md` — コードレビュー手順
- `src/skills/builtin/research/SKILL.md` — 調査・探索手順

---

## ランタイム状態の永続化（2026-04-14）

再起動でリセットされていた以下の状態を `config.json` に保存するように変更:

| 項目 | config キー | コマンド |
|------|-----------|---------|
| autorunモード | `autorunMode` | `/autorun on/off` |
| 並列ツール数 | `maxParallelTools` | `/parallel <N>` |

起動時に復元し、非デフォルト値がある場合はウェルカムメッセージに `Restored: ...` を表示。

---

## 実装順序

1. **intent-classifier.ts** を新規作成、agent-loop.ts から呼び出し変更 ✅
2. **hierarchical-compressor.ts** を新規作成 ✅
3. **message-history.ts** に getRecentContext 追加 ✅
4. **context-manager.ts** を新コンプレッサーに接続 ✅
5. リプロンプト文言にユーザー意図を保持 ✅
6. 空応答（text空+tools空）の検出と対処 ✅
7. コンテキストモード廃止 + スキル化 ✅
8. ランタイム状態永続化（autorun, parallel） ✅
9. 動作テスト（パイプモード）
