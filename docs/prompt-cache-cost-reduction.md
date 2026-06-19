# プロンプトキャッシュによるコスト削減 設計書

> 対象: クラウドLLM利用時の **入力トークン課金の削減**。
> 制約: **品質・速度を変えない**(送るバイト列・出力は同一、TTFTはむしろ短縮)。
> 位置づけ: `docs/response-latency-improvement.md` の Lever B(プロンプトキャッシュ)/Lever C(安定プレフィクス) の実装。
> 作成日: 2026-06-18 / ステータス: 実装済

---

## 1. 背景・課題

エージェントループは毎ターン **system + tools + 会話履歴の全量** を再送する。クラウドAPIでは
これがそのまま入力課金になり、長いセッションほどコストが累積する(実測で 1 セッション数十M トークン)。

プロンプトキャッシュを使えば、繰り返し送る前方部分(プレフィクス)を **読込 0.1×** で課金できる。
送る内容も出力も変わらないため **品質不変**、キャッシュヒットで prefill が省け **TTFT はむしろ短縮**。
コスト削減・品質不変・速度不変の3条件を同時に満たす。

### これは Claude 限定ではない(効果は2層)
- **第1層 = 安定プレフィクス化(全プロバイダ共通)**: GPT系(Azure GPT/OpenAI)・Gemini はキャッシュが
  **自動**(マーカー不要)。だが従来は system 先頭付近の現在日時(秒変化)で前方一致が毎ターン壊れ、
  自動キャッシュが効いていなかった。プレフィクスを安定化すれば **GPT系もコード追加なしで割引が復活**。
  ローカル(vLLM/llama.cpp)も KV 前方一致が戻り prefill 再計算が減る(速度)。
- **第2層 = `cache_control` の明示挿入(Anthropic 固有)**: Claude だけ手動マーカーを要求する仕様のため。
  GPT/Gemini は自動なので不要 ＝ Claude 優遇ではなく各社仕様差の吸収。

---

## 2. 一次情報(Anthropic プロンプトキャッシュ)

- `cache_control: {type:"ephemeral"}` は **GA(betaヘッダ不要)**。`ttl:"1h"` で1時間TTLも可。
- レンダリング順は **tools → system → messages**。最後の system ブロックの breakpoint で tools+system がキャッシュされる。
- breakpoint は **最大4個**。任意の content ブロック(system text / message text / tool_result 等)に付与可。
- 最小キャッシュ長: **Opus系/Haiku 4.5 = 4096 tok / Sonnet 4.6 = 2048 tok**。未満は無音で非キャッシュ(無害)。
- 料金: 読込 **0.1×** / 書込 **1.25×(5分TTL)・2×(1時間TTL)**。エージェントは毎ターン読むので確実に黒。
- usage: `cache_read_input_tokens` / `cache_creation_input_tokens`、`input_tokens` は **非キャッシュ残のみ**。
- サイレント無効化の筆頭 = system 内の `datetime.now()`(まさに従来の `system-prompt.ts` の現在日時)。
- 20ブロック lookback: 1ターンに tool_use/result が多数積もると次ターンの breakpoint が前回キャッシュを見失う(将来の追加最適化点)。

---

## 3. 設計

### 3.1 安定プレフィクス化(全プロバイダ)
system プロンプトを **stable(キャッシュ対象)** と **dynamic(毎ターン変化)** に分離する。

- `system-prompt.ts`: Environment 節から **現在日時を除去**(session 内で安定な値のみ base に残す)。
- `agent-loop.ts` `composeQuasiSystemPrompt`: 戻り値を `{ stable, dynamic }` に変更。
  - stable = base(identity / rules / skills / project / memory)
  - dynamic = 現在日時 + goal section + todo section
- `message-history.ts` `getMessages()`: composer の `{stable, dynamic}` を **2つの role:"system" メッセージ**として返す
  (stable が先頭)。dynamic が空なら従来どおり1メッセージ。文字列を返す旧 composer も後方互換で受理(全量 stable 扱い)。

OpenAI 系プロバイダは複数 system を連結するだけなので順序・内容は不変(挙動不変)。

### 3.2 Anthropic への cache_control 付与
`azure-anthropic.ts buildRequestBody`(`anthropic.ts` も継承):
- `system` を **text ブロック配列**にし、`system[0]`(安定 base)に `cache_control` → tools+system[0] をキャッシュ。
- **ローリング履歴 breakpoint**: 変換後 messages の **最後のメッセージの最終ブロック**に `cache_control`
  → 履歴プレフィクスが毎ターン読込、新規分のみ書込。
- OFF 時(`features.promptCache.enabled=false`)は従来どおり system を文字列で送り無印。

### 3.3 GPT系/vLLM のキャッシュ可視化
`openai-compat.ts`: ストリーム usage の `prompt_tokens_details.cached_tokens` を読み `ChatChunk.usage.cachedTokens` に載せる。
(azure-gpt は既に取得済。pricing-table の GPT は `cachedInputPerMToken` 設定済のため計算で自動割引。)

### 3.4 コスト計算のプロバイダ別セマンティクス
OpenAI は `prompt_tokens` が cached を **内包**、Anthropic は `input_tokens` が cached を **含まない**。
`TokenUsage.cacheCreationTokens` の有無で判別する:
- 定義あり = Anthropic → `calculateForModelWithCacheBreakdown`(非キャッシュ残×1 + 読込×0.1 + 書込×1.25 + 出力)
- 定義なし = OpenAI → 既存 `calculateForModelWithCache`(cached を控除)

### 3.5 料金表の整合(`pricing-table.ts`)
Claude キーをドット表記→**実ID(ハイフン)**に統一(従来は前方一致せずコスト0表示のバグ)。
`claude-opus-4-8` 追加、各 Claude に `cachedInputPerMToken = 入力×0.1` を設定。

### 3.6 設定(`config/types.ts`)
`features.promptCache?: { enabled?: boolean; ttl?: "5m"|"1h" }`。既定 ON / 5分TTL。
`cache_control` を出すのは anthropic/azure-anthropic のみ。他プロバイダのリクエストには混入しない。

### キャッシュ配置図(Anthropic)
```
[tools] [system[0]=stable ★cache_control] | [system[1]=dynamic(日時/goal/todo)]
[...履歴...] [最終メッセージ最終ブロック ★cache_control]
  ★ より前 = キャッシュ前方一致(読込0.1×)、★ 直後の新規分のみ書込1.25×
```

---

## 4. 自動的に効く対象(追加実装ゼロ)
サブエージェント(`sub-agent`)/セカンドLLM/Evaluator/intent-classifier/progress-judge は
いずれも同じプロバイダ `buildRequestBody` を通るため、本実装だけで各自の繰返し呼出にキャッシュが効く。

## 5. 想定削減と計測
- 削減: 定常ターンは入力の大半がキャッシュ読込になり **入力課金が概ね 1/10 に**(履歴が大きいほど効果大)。
- 計測: `/cost` のキャッシュ読込トークンと推定コスト。2ターン連続で `cache_read_input_tokens > 0` を確認。
- 損益: 書込1.25×だが2リクエスト目で黒。エージェントは毎ターン読むため確実にプラス。

## 6. スコープ外(今回見送り)
- 内部補助LLMの安価モデルへのルーティング: 判定品質が僅かに変わり得るため「品質不変」条件に抵触。候補として保留。
- 20ブロック lookback 対策の中間 breakpoint 追加: 効果計測後の追加最適化とする。

## 7. 変更ファイル
| ファイル | 変更 |
|---|---|
| `src/agent/system-prompt.ts` | 現在日時を base から除去 |
| `src/agent/agent-loop.ts` | composeQuasiSystemPrompt を {stable,dynamic} 化 / コスト計算のキャッシュ対応 |
| `src/agent/message-history.ts` | system を stable/dynamic の2メッセージで返す |
| `src/providers/azure-anthropic.ts` | cache_control(system+rolling) / SSE で cacheトークン取得 |
| `src/providers/anthropic.ts` | promptCache を super へ伝播 |
| `src/providers/openai-compat.ts` | prompt_tokens_details.cached_tokens 取得 |
| `src/providers/provider-factory.ts` | config から promptCache を解決し注入 |
| `src/providers/base-provider.ts` | TokenUsage に cacheCreationTokens 追加 |
| `src/cost/cost-calculator.ts` | Anthropic セマンティクスの内訳計算を追加 |
| `src/cost/pricing-table.ts` | Claude キー統一 / cache単価 / opus-4-8 |
| `src/config/types.ts` | features.promptCache |
| `tests/cost/*` `tests/agent/message-history.test.ts` `tests/providers/azure-anthropic-cache.test.ts` | 単体テスト |
