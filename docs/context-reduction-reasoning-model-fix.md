# コンテキスト削減（忘却・圧縮）における思考モデル対応および空応答ハンドリング設計書

> **ステータス**: 2026-09-23 設計 / 2026-10-15 §4〜§5 改訂 (思考オフを内部呼び出し全体へ適用)
> **対象**: `src/agent/forgetting.ts`, `src/agent/hierarchical-compressor.ts`, `src/providers/openai-compat.ts`,
> `src/agent/{intent-classifier,progress-judge,goal-promotion,compress-text,handoff}.ts`
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

---

## 4. 2026-10-15 改訂: 方針 B の見直し (思考を「頼んで短くする」 → 「オフにする」)

方針 B の「思考は最小限に」 という指示は、 思考モデルが守らなかった。 忘却選択では 84 セグメントの一覧を
1 件ずつ検討し、 1,500t の上限を思考だけで使い切って本文 0 字のまま 2 回失敗した (acecomb セッションで作業停止)。
上限を広げても一覧が長くなれば再び使い切るため、 **思考そのものを止める**手段を用意した。

- `ChatParams.disableThinking?: boolean` を追加 (`src/providers/base-provider.ts`)
- `openai-compat.ts` は `llamacpp` / `vllm` のときだけ `chat_template_kwargs: {enable_thinking: false}` を送る。
  未知フィールドで 400 を返し得る商用 API には送らない (対応外 provider では従来どおり)
- 忘却選択の扱いは `docs/context-forgetting.md` §4.2 / §4.5

## 5. 内部呼び出しごとの判断 (実測)

**計測条件**: Qwen3.8 Flash Next / llama.cpp (`http://192.168.1.201:9087`)。 入力は acecomb セッション
(`~/.localllm/sessions/mv82bvpa-gkgv.json`, 170 メッセージ / 84 セグメント) と、 その作業フォルダの `HANDOVER.md`。
各関数を実コードのまま、 provider だけ包んで `disableThinking` を切り替えて呼んだ。 1 条件 1 回の計測である。

| 呼び出し | 上限 | 思考あり | 思考オフ | 判断 |
|----------|-----:|----------|----------|------|
| 忘却選択 (`forgetting.ts`) | 1,500 | `length`・本文 0 字 → **失敗** | 7.6 秒・有効 JSON | **オフ** |
| 意図分類 (`intent-classifier.ts` classifyIntent) | 50 | `length`・本文 0 字 → **毎回失敗** | 0.3 秒・正答 | **オフ** |
| 完了分類 (同 classifyCompletion) | 50 | `length`・本文 0 字 → **毎回失敗** | 0.3 秒・正答 | **オフ** |
| 進捗判定 (`progress-judge.ts`) | 200 | `length`・本文 0 字 → **失敗** | 1.5 秒・妥当な verdict | **オフ** |
| 完了条件抽出 (`goal-promotion.ts`) | 800 | 8.2 秒・成功 (314t) | 2.0 秒・同等の質 | **オフ** (下記の形式差に対応) |
| テキスト圧縮 (`compress-text.ts`) | 2,000 | `length` で**途中切れなのに採用されていた** | 32.9 秒・`stop` で完結 | **オフ** + 切れ検出 |
| 要約 Layer 1 (`hierarchical-compressor.ts`) | 2,000 | 10.8 秒・成功 (401t) | 4.6 秒・同等 (パスと事実が多い) | **オフ** |
| 要約 Layer 2 (同) | 2,500 | 計 47.1 秒・成功 | 計 27.7 秒・同等 | **オフ** |
| 引き継ぎメモ (`handoff.ts`) | 1,200 | `length` → **失敗** | `length` → **失敗** (本文だけで 1,272t) | **思考あり** + 上限 8,000 |

### 5.1 思考を残したもの: 引き継ぎメモ

上限 4,000 で両方を生成して比べた。 どちらも検証は通ったが、 思考ありの方が明確に良かった。

- 思考あり (2,390t, 53 秒): 「直前の作業 (campaign テストの注入修正の直後に中断)」 を拾い、 次にやることの先頭に
  再実行を置いた。 ロック円錐 ±18° / 旋回率 8.9°/s などの具体値も制約に残した
- 思考なし (1,272t, 29 秒): 直前の作業が抜け、 次にやることが一般論になった。 履歴に無い方針
  (「ES Modules または IIFE」) が混ざった

引き継ぎメモは clear 後の唯一の拠り所なので質を優先する。 `HANDOFF_MAX_TOKENS` は 1,200 → 8,000 とした。
これはメモの長さを決める値ではなく (長さはテンプレートで決まる)、 暴走を止める絶対上限である。
1,200 は思考なしでも本文だけで超えていた。

### 5.2 思考オフに伴う出力形式の差: 完了条件抽出

思考オフでは `{"criteria": [...]}` ではなく素の配列 `[...]` を返した (3 回とも)。 プロンプト中の
「JSON 配列形式で抽出」 に従った結果で、 中身の質は思考ありと同等。 `parseCriteriaResponse()` で両方を受ける。

### 5.3 失敗理由に finishReason を出す

「思考で上限を使い切った」 のか「本文が崩れた」 のかで打ち手が違うため、 失敗理由に必ず finishReason を含める。

| 呼び出し | 対応 |
|----------|------|
| 意図分類 / 完了分類 | `finishReason / outputChars / maxTokens` を例外文に追加 |
| 進捗判定 | 本文が空なら JSON パースを呼ばず、 finishReason 付きで失敗 |
| 完了条件抽出 | ベストエフォート (失敗時は提案しないだけ) なので debug ログに finishReason を残す |
| テキスト圧縮 | 空応答に finishReason を追加。 **`finishReason=length` は原文より短くても採用せず失敗**にした。 途中で切れた圧縮結果を採用すると、 後半の指示・制約が黙って消えるため |
| 引き継ぎメモ / 要約 Layer 1・2 / 忘却 | もともと finishReason を出している |

### 5.4 限界

- 計測は 1 セッション・1 条件 1 回。 要約の質の比較は目視による
- 思考オフは `llamacpp` / `vllm` でだけ効く。 他の provider で同じ症状が出たら、 §5.3 の理由表示で分かる
