# コンテキスト削減（忘却・圧縮）における思考モデル対応および空応答ハンドリング設計書

> **ステータス**: 2026-09-23 設計
> **対象**: `src/agent/forgetting.ts`, `src/agent/hierarchical-compressor.ts`, `src/providers/openai-compat.ts`
> **関連**: `docs/context-forgetting.md`, `docs/context-strategy.md`

---

## 1. 背景と課題

### 1.1 発生した障害
`sandbox/run.sh` にてエージェント実行中、コンテキスト削減（`contextReduction: "forget"`）および手動 `/compact` 実行時に以下のエラーが発生した。
1. `[ERROR] Context reduction failed: Error: contextReduction=forget を適用できませんでした: 忘却プランを作れませんでした (JSON パース失敗 / 選択 0 件 / 対象なし)。`
2. `Error: Layer 1 context summarization failed; history was not replaced with a lossy substitute: Error: Error: Context summarizer returned no JSON object; history was not replaced. (finishReason=stop, outputChars=0, maxTokens=1000).`

### 1.2 根本原因の分析（実機検証済み）
- **思考モデルにおける `max_tokens` の枯渇**:
  使用モデル（`Qwen3.8-Flash-Next` 等の推論・思考モデル）は、回答を生成する前に `reasoning_content`（思考トークン）を生成する。
  `llama.cpp` 等の推論エンジンでは、`max_tokens` は「思考トークン＋回答トークン」の合算枠に適用される。
  しかし、`FORGET_MAX_TOKENS = 600`、`COMPRESSOR_LAYER1_MAX_TOKENS = 1000` という非思考モデル前提の極小枠が指定されていたため、思考のみで枠を使い果たし、本文（`content` / JSON）が 1 文字も出力されないまま `finish_reason: "length"` で打ち切られていた（`outputChars=0`）。
- **思考モデルの推敲ループ**:
  厳格な優先度ルールや会話履歴を与えられると、思考モデルは思考ブロック内で下書きを推敲し、長大な思考トークンを消費する。
- **プロバイダー層における `finishReason` の上書き欠陥**:
  `src/providers/openai-compat.ts` のストリーミング処理において、チャンクで `choice.finish_reason = "length"` を受信しても、ストリーム末尾の `data: [DONE]` 処理で無条件に `yield { type: "done", finishReason: "stop" }` を発行していた。このため `collectResponse` が後勝ちで `"stop"` で上書きし、「トークン数上限到達で打ち切られた」事実が隠蔽され、「正常終了なのに空文字を返した」ように誤認させていた。
- **応答サイズ 0 に対する不要・不適切なパース処理**:
  応答文字数が 0 の場合にも JSON パース関数を呼び出しており、「JSONパース失敗」や「returned no JSON object」という見当違いなエラー表示となっていた。

---

## 2. 設計方針（フォールバックの排除）

フォールバック（途切れたら枠を広げてリトライする対症療法や、粗悪な代替処理）を行わず、最初から健全に動作する設計とする。

### 方針 A: 応答サイズ 0 の早期判定ガード
- `collectResponse` の結果テキストが空（`response.content.trim().length === 0`）の場合は、JSON パース関数を呼び出さず、直ちに「空応答（0文字）」として明確なエラー／警告を報告する。
- エラーメッセージには `finishReason`、`usage`（prompt/completion トークン数）を必ず含め、何が起きたのかを正確に可視化する。

### 方針 B: 内部定型タスクにおける思考制御とバジェットの適正化
- **タスクの役割の明確化**:
  忘却プラン作成やブロック要約は、自由推論を競う場ではなく「定型的な分類・構造化出力」タスクである。
- **思考の最小化ディレクティブ**:
  プロンプトおよびシステムメッセージにおいて、「内部思考（thinking）は最小限にとどめ、直ちに指定された JSON 形式のみを出力する」制約を明確に付与する。
- **一貫した適正バジェット**:
  「思考を抑制する」方針と整合させ、無闇に長大な思考を許容するのではなく、「最小限の思考（100〜300t）＋ 完全な JSON 出力（300〜800t）」が確実に 1 回で完結する適正バジェット（忘却: 1,500t、要約 Layer 1: 2,000t、Layer 2: 2,500t）を設定する。

### 方針 C: プロバイダー層（`openai-compat.ts`）の `finishReason` 保持修正
- チャンク処理中に受信した `choice.finish_reason` を `lastFinishReason` として追跡保持する。
- `data: [DONE]` 到達時には、既に `choice.finish_reason` が届いていればその値（`length` 等）を使用し、未受信の場合のみ `"stop"` を既定値とする。

---

## 3. 変更対象ファイル

1. `src/providers/openai-compat.ts`
   - `lastFinishReason` の追跡保持と `[DONE]` 処理の適正化
2. `src/agent/forgetting.ts`
   - `FORGET_MAX_TOKENS` の適正化（600 → 1,500）
   - `buildForgetPrompt` および `ForgettingEngine.plan` への思考最小化ディレクティブ追加
   - 応答サイズ 0 の早期検知ガード（空応答時に JSON パースを呼ばない）
3. `src/agent/hierarchical-compressor.ts`
   - `COMPRESSOR_LAYER1_MAX_TOKENS`（1,000 → 2,000）、`COMPRESSOR_LAYER2_MAX_TOKENS`（1,500 → 2,500）の適正化
   - 要約プロンプトへの思考最小化ディレクティブ追加
   - 応答サイズ 0 の早期検知ガード
4. テストファイル
   - `tests/providers/openai-compat.test.ts`
   - `tests/agent/forgetting.test.ts`
   - `tests/agent/hierarchical-compressor.test.ts`
