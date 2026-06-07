# opt-in 入力圧縮モード (2026-06)

## 背景・前提

`system-prompt.ts` は以前、project指示 (tier別 3000字等) とメモ (2000字等) を **silent に
truncate** していた。これは「黙って欠損させる」技術的負債だったため撤廃し、**デフォルトは
全量注入＋容量超過は API エラーで顕在化**とした (commit 518c4a0)。

本機能はその上に乗る **opt-in の代替経路**。「容量超過でエラーになるより、意図を保ったまま
圧縮して入れたい」ユーザーのための機能。**既定 OFF**、ユーザーが有効化したときだけ動く。

### 軸 (ユーザー確認済み)
- **目的は「コンテキスト肥大化の防止」**。入力を構造化して読みやすくするのが目的ではない
  (構造化は圧縮の手段として起こりうるが、目標ではない)。
- **全会話で行わない**。**以前 truncate していた閾値を超えたときだけ**発動する。
- **圧縮前の原文は常に保持**する (使う/使わないに関わらず)。

## Claude Code 対比
- Claude Code は会話履歴を auto-compaction するが、**CLAUDE.md は圧縮しない**。
- 本機能で project/メモを圧縮するのは CC からの意図的な **opt-in 拡張**。既定 OFF・可視・原文保持
  なら妥当。既存の `HierarchicalCompressor` (履歴の自動圧縮) が CC の auto-compaction 相当を
  既に担うので、本機能はそれと**棲み分ける** (対象=履歴ではなく超過した入力塊)。

## 発動条件
- モード ON **かつ** 対象塊が tier別閾値を超過したときのみ。閾値は旧 truncate 値を踏襲:
  - project指示: T3=1500 / T1=4000 / T2=3000 字
  - メモ: T3=1000 / T1=3000 / T2=2000 字
- モード OFF (既定): 圧縮しない。全量注入し、容量超過は API エラーで顕在化。

## 設計核心

### 1. 圧縮は「塊ごとに個別」に行う
複数の異質な塊 (project指示・メモ・生入力) を 1 つにまとめて要約すると、受け手が感じる意図が
変質する。塊単位で独立に圧縮する。

### 2. LLM 呼び出しの置き場所とキャッシュ
- 圧縮は LLM 呼び出しを伴うため、**純粋同期関数 `buildSystemPrompt` の中では行わない**。
- project/メモは毎ターン不変なので**毎ターン圧縮は無駄**。**起動時/モデル切替時に一度だけ**
  圧縮し、結果をキャッシュする pre-step を `AgentLoop` 側 (provider を持つ層) に置く。
- `buildSystemPrompt` は純粋なまま、**圧縮済み文字列を受け取れるよう引数を拡張**する
  (内部 loadMemory/loadProjectInstructions の結果を、与えられたら override)。
- 圧縮呼び出しは **会話履歴を含まないクリーンな単発呼び出し** (`collectResponse` 直接)。
  メイン会話のコンテキストを汚さない・費やさない。

### 2.5 再ビルド経路での圧縮状態の引き継ぎ (silent 復帰の防止)
`updateLLMProfiles` (/model description 等) や `restoreSession` は system prompt を再ビルドする。
ここで圧縮 overrides を渡し忘れると、 **圧縮 ON のまま裏で全量へ戻る** silent な不整合になる
(実装レビューで検出)。対策: 圧縮済みテキストを `compressionState.compressedText` にキャッシュし、
`currentCompressionOverrides()` で LLM 再呼出なしに overrides を復元、 全再ビルド経路で渡す。

### 3. サイズガード (必須)
- 圧縮後トークン (または文字) が **圧縮前以上なら、圧縮を破棄して原文を使う**。
  縮まないのに lossy にするのは最悪。比較は必ず行う。

### 4. 原文の保持と可視化
- 圧縮を行った塊は `{ label, original, compressed, beforeTokens, afterTokens }` を保持。
- `/context` に「圧縮中: <対象> X→Y tokens (原文保持)」を表示し、原文も確認できるようにする
  (例: `/context memory` は圧縮版＋原文の両方、または原文を明示)。
- 圧縮実行時はその場でも before/after を表示 (silent にしない)。

### 5. 圧縮プロンプトの方針
- 目標は「制約・意図を保ったままトークンを減らす」。`HierarchicalCompressor` の LAYER1 方針
  (ユーザー指示・パス・コード・数値・未解決事項は原文保持、冗長は削る) を流用する。
- 共通ユーティリティ `compressText(provider, model, label, text): Promise<{text, before, after, applied}>`
  として切り出し、project/メモ/生入力で共用。

## 段階導入
- **第1段 (本タスク)**: project指示・メモの圧縮。静的・再利用・opt-in でリスク最小。
- **第2段 (別タスク)**: 生入力の圧縮。リスク非対称 (生入力を言い換えるとメインLLMがユーザーの
  実文を一度も見ない / オフハンドな一言に宿る意図を落としうる) のため保守的に:
  - **容量を実際に超えるときだけ**発動 (先回りしない)
  - 原文を必ず保持し復元可能
  - before/after diff を可視化
  サイズ閾値では検出できない**意味の欠損**があるため、第1段の手応えを見てから着手。

## 設定・トグル
- `config.inputCompression?: boolean` (既定 false、`autorunMode` と同様に再起動後も維持)。
- トグルコマンド (4箇所チェックリスト: repl実装 / completer / displayHelp / README)。

## 変更ファイル (第1段)
- `src/agent/compress-text.ts` (新規): `compressText()` ユーティリティ + サイズガード
- `src/agent/system-prompt.ts`: `buildSystemPrompt` に圧縮済み project/memory override 引数を追加
- `src/agent/agent-loop.ts`: 起動時/モデル切替時の圧縮 pre-step + キャッシュ、buildSystemPrompt 呼出更新
- `src/config/types.ts`: `inputCompression` フラグ
- `src/cli/repl.ts` / `completer.ts` / `renderer.ts` / `README.md`: トグルコマンド
- `src/cli/context-breakdown.ts`: 圧縮状態と原文の可視化

## 検証
- ユニット: サイズガード (縮まなければ原文) / 閾値未満は圧縮しない / 原文保持。
- `npx vitest run` 全グリーン。
- 三者レビュー (設計者→開発者→評価者) を新規サブエージェントで、採否はメイン判断。
- 実機 (vLLM) 確認はエンドポイント稼働時に行う (圧縮呼び出しは LLM 必須のため)。
