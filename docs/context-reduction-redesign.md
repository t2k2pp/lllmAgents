# コンテキスト整理の作り直し 設計書

> **ステータス**: design (2026-10-25 設計 / 実装中。 §13 のタスク 1・3〜8 済み)
> **置き換える設計**: `docs/context-forgetting.md` (忘却) / `docs/context-strategy.md` (区切りでの使い分け)。
> 実装が済んだら両書の先頭に「現行は本書」 の注記を入れる (§12)。
> **前提**: `docs/prompt-prefix-stability.md` (一度送ったメッセージは書き換えない) が実装済みであること。

---

## 1. 背景と実測

### 1.1 いまの動作環境

- llama.cpp サーバ、 Qwen3.x の混成モデル (線形注意 + 通常注意)、 スロット 1 つ。
- 前方一致の修正 (`prompt-prefix-stability.md`) 以降、 1 回の呼び出しで KV キャッシュの約 99% を再利用できている。
  1 回の呼び出しは 20 秒〜5 分で、 ほぼ出力の生成時間 (約 5〜7 トークン/秒)。 新しく読み込むプロンプトは 1 回 0.5k〜2.6k トークン。
- 一度送った履歴を書き換えると (忘却・圧縮・揮発メッセージの除去・思考の破棄)、 残した履歴の **全体** を読み直す。
  速さは約 130 トークン/秒で、 12〜16 万トークンなら 15〜20 分かかる。 混成モデルは途中の位置に巻き戻せないため
  (`prompt-prefix-stability.md` §2.2)、 書き換え 1 回ごとのこの費用は避けられない。

したがって目標は **書き換えを「まれに・やる価値のある量だけ・作業の途中では原則やらない」** にすること。

### 1.2 読み直し時間の目安 (130 トークン/秒で計算)

| 残した履歴 | 読み直し時間 |
|---|---|
| 10 万 | 約 13 分 |
| 20 万 | 約 26 分 |
| 40 万 | 約 51 分 |
| 90 万 | 約 1 時間 55 分 |

長い履歴ほど 1 トークンあたりの読み込みも遅くなるはずで、 20 万を超える領域の実測は無い (要確認)。

### 1.3 過去ログとの比較

- contextWindow が約 256K だった頃のログでは、 整理は呼び出し 25〜35 回に 1 回起き、 17〜20 万を 11〜13 万に減らしていた。
  1 回の呼び出しで増える量は平均 約 2.3k トークン ((19万 − 12万) ÷ 30)。
- 現在の contextWindow は 1,048,576 (約 1M)。 割合で決める仕組み (40/60/75% の帯、 ティアの閾値 0.5〜0.7) は
  40〜60 万で発火することになり、 そのときの読み直しは 1 時間を超える。
  **割合で決める方式は、 小さい枠でも大きい枠でもうまくいかない**。 小さい枠では余白が足りず、 大きい枠では 1 回が重すぎる。

### 1.4 同じサーバへの脇の呼び出し

忘却の選択、 要約、 意図の分類 (`agent-loop.ts:542` で本体と同じ provider)、 進み具合の判定、 Goal 昇格、 引き継ぎメモは、
いずれも本体と同じサーバ・同じスロットに送られる。 スロットが 1 つなので、 これらが本体の KV キャッシュを追い出している
可能性がある (未測定。 §10 で測る)。

---

## 2. 現状の実装と問題点

| 箇所 | 内容 | 問題 |
|---|---|---|
| `context-manager.ts:90` / `capability-tier.ts:111,128,143` | 発火閾値 = contextWindow × 0.7 / 0.6 / 0.5 | 割合なので 1M では 50〜70 万で発火 (§1.3) |
| `context-manager.ts:153-161` | 使用量 = `estimateMessageTokens(getMessages())` | ツール定義を数えていない (`token-counter.ts:26-38`)。 サーバが返す実数 (`agent-loop.ts:1345` の `lastPromptTokens`) を使っていない |
| `context-manager.ts:179-184` | 目標 = 閾値の 15 ポイント下 | 割合。 次の整理までの距離が作業量と無関係 |
| `context-manager.ts:297-372` | `reduce()` が compress / forget / hybrid の 3 方式 | 同じ目的に 3 つのやり方。 hybrid は忘却 (書き換え 1 回) の後に圧縮 (もう 1 回) で、 1 回の整理で 2 回書き換える |
| `forgetting.ts:28,736-` | 何を忘れるかを LLM に選ばせる | 脇の呼び出し (キャッシュを追い出す恐れ)、 JSON 失敗、 思考で上限を使い切る等の失敗経路が多い (`context-forgetting.md` §4.5) |
| `hierarchical-compressor.ts:25,151-163` | 10 件ずつ要約して 4〜5 回呼ぶ | 要約の入力は毎回新しいプロンプトなので全部読み込み直し。 要約の要約で劣化 |
| `context-strategy.ts:77,89-96` | 使用率の帯 × 区切りの強さの決定表 | 割合。 弱い区切り (応答完了・ToDo 1 つ完了) でも整理する |
| `agent-loop.ts:1031-1053` | 反復の先頭で区切り整理 → 閾値超過なら `reduce()` | 作業の途中で走る。 区切り整理と閾値整理が別々に書き換えるので 1 反復で 2 回書き換えうる |
| `agent-loop.ts:2726-2750` | 応答のたびに `purgeEphemeral()` と `clearAllThinking()` | 依頼 1 件ごとに書き換え 1 回 = 毎回 15〜20 分の読み直し |
| `message-history.ts:140-149` | 思考は assistant 本文の先頭に埋め込んで送る | 依頼の途中では思考が履歴に積もる (これ自体は意図どおり。 消す時期の問題) |
| `agent-loop.ts:1095-1100` | 本体の呼び出しに出力上限を渡していない | 1 回で増える量に上限が無く、 「次の呼び出しが必ず入る」 を保証できない (タスク 4 で解消) |
| `agent-loop.ts:209-224,3124,3266` | ツール結果を入れるときに頭と尻尾を残して切る (T1=20KB / T2=12KB / T3=6KB) | 1 件ごとの上限はあるが、 1 回の応答で複数ツールを呼んだときの合計に上限が無い (タスク 4 で解消。 1 件の上限もトークン数にした) |

---

## 3. 目標と非目標

### 目標

1. **次の本体呼び出しは必ず枠に入る** ことを作りで保証する。 入らなかったときの逃げ道は作らない。
2. 書き換えは **1 回の整理につき 1 回だけ**。 応答のたびの書き換えをやめる。
3. 整理は必要なときだけ、 必要な量より多めに。 作業の途中の整理は「次が入らない」 ときに限る。
4. 整理のやり方を 1 つにする (決まった順の段階。 LLM に選ばせない)。
5. 整理の前後で何が起きたかを記録し、 キャッシュが外れた原因を後から特定できるようにする。

### 非目標

- 実効的な枠を別の設定で持つこと (使う量を減らしたい人は contextWindow を下げる。 新しい予算設定は作らない)。
- 脇の呼び出し・サブエージェント (`task` ツールでメインのモデル自身に委任) を別のサーバ/スロットへ回すこと。
  これは [todo-local-llm-speed.md](todo-local-llm-speed.md) の T2/T3 で扱う (本書は §10 の計測で影響を見えるようにするまで)。
  本書の段階 3 の要約はキャッシュ済みの並びの末尾に指示を足して呼ぶので、 キャッシュを追い出さない。
- `/handoff` (引き継ぎメモでリセット) と `/clear` の作り直し。 手動の機能としてそのまま残す。
- モデルに残量を伝えること (§8)。

---

## 4. 予測と発火

### 4.1 記号

| 記号 | 意味 | 求め方 |
|---|---|---|
| W | contextWindow | 設定 (唯一のつまみ) |
| P | 次に送るプロンプトの大きさ | 直前の本体呼び出しの実数 (`usage.promptTokens`) + その出力の実数 + その後に足したもの (ツール結果・状態通知) の推定。 実数が無いとき (起動直後・整理直後・usage を返さない provider) は `estimateMessageTokens` + ツール定義の推定 |
| O | 1 回の出力の上限 | 本体呼び出しに `maxTokens` として **新たに渡す** (表 4.2) |
| T | 1 回の応答で足されるツール結果の合計の上限 | 入れるときに強制する (§4.3) |
| M | 推定の誤差の余白 | 固定値 (表 4.2) |
| S | 整理そのものに要る余白 | 段階 3 の要約呼び出し (指示 + 要約の出力) と、 整理後に足す状態通知 |
| R | 予約 = O + T + M + S | |
| G | 次の「ひと仕事」 で増える量 | 直近 3 件の依頼で実際に増えた量の最大 (§4.5) |

### 4.2 ティアごとの値 (案。 要確認)

| | O | T | M | S | R | 1 件の上限 |
|---|---|---|---|---|---|---|
| T1 | 32,768 | 24,576 | 8,192 | 6,144 | **71,680** | 8,192 |
| T2 | 32,768 | 24,576 | 4,096 | 6,144 | **67,584** | 5,120 |
| T3 | 4,096 | 8,192 | 2,048 | 3,072 | **17,408** | 2,048 |

「1 件の上限」 はツール結果 1 件を履歴に入れるときの上限 (切り詰めの注記を含む。 R には入らない。 §4.3、 §6.3 で使う)。
2026-10-25 利用者と決定: 文字数 (T1=20KB / T2=12KB / T3=6KB) からトークン数に決め直した。

O の役割は 2 つ (2026-10-25 利用者と確認): (1) 生成の暴走 (同じ文を繰り返し続けるループ。 ローカルモデルで起きやすい) の歯止め。
今は上限を渡していないので、 サーバは残りの枠全部まで生成を続ける (1M の枠で 5〜7 トークン/秒なら止まるまで何日もかかりうる)。
(2) 予約 R の計算 (小さい枠で「次の呼び出しが必ず入る」 を保証する)。 (1) は枠の大きさに関係なく効く。
O は観測された最大出力 (16,552、 2026-10-24 myppt の t10。 現在の Qwen3.8-27B は T2) の 2 倍。
T2 も T1 と同じ O・T にする (2026-10-25。 当初案の T2 O=16,384 ではこの実例が切れる。 枠が大きければ予約の大きさはほぼ問題にならない)。 上限に達したときは既存の
「続きを出力」 処理 (`agent-loop.ts:1523`) が次の呼び出しとして続けるので、 その呼び出しの前にも同じ判定が走る。
いずれもティアの既定値 (`TIER_DEFAULTS`) に置き、 利用者向けの設定にはしない。

実装 (タスク 3、 2026-10-25): O / T / M / S / K は `capability-tier.ts` の `TIER_CONTEXT_BUDGETS` に置いた。
`TIER_DEFAULTS` (= `CapabilityProfile`) は config の `modelCapabilities` で上書きできるので、 上書きできないよう別の定数にした。
予算の計算は `src/agent/context-budget.ts`:
- `computeContextBudget(W, tier)` → R を含む予算。 `measurePromptSize({ lastMainCall, addedSinceLastCall, messages, tools })` → P と
  `basis: "usage" | "estimate"`。 `lastMainCall.promptTokens` は入力の全体 (AgentLoop の `previousMainPromptTokens` と同じ値)。
  推定のときのツール定義は `estimateToolDefinitionTokens()` (`token-counter.ts`)。
- 規則は `exceedsForcedLimit(P, budget)` (規則 1) と `exceedsBoundaryLimit(P, budget, G)` (規則 2)。
  目標と最低量は `computeReductionGoal(budget, G)` → `{ targetPromptTokens, minimumReductionTokens }`。
- 発火への組み込みはタスク 7 (規則 1) とタスク 8 (規則 2)。 旧経路 (割合の閾値) はタスク 8 で削除した。

### 4.3 1 回で増える量を有限にする

- 出力: O を超えない (サーバが止める)。
- ツール結果: 1 件の切り詰め (既存) に加え、 **同じ応答の結果の合計** が T を超えそうなら、 後の結果ほど強く切る
  (残りの枠で頭と尻尾を残す。 最低 1KB)。 `file_write` / `file_edit` も合計には数える (切り詰めはしない)。
- 利用者の入力: 送信時に「入力 + 固定部分 (system・ツール定義) + 最小限の保護部分 + R > W」 なら受け付けず、
  ファイルにして渡すよう案内する (入力の検査であって、 整理の逃げ道ではない)。

これで P は 1 回の本体呼び出しにつき最大 O + T しか増えない。

実装 (タスク 4、 2026-10-25):
- **出力**: 本体呼び出し (`agent-loop.ts` の chat / chatWithTools) に `maxTokens: TIER_CONTEXT_BUDGETS[tier].outputTokenLimit` を渡す。
  provider ごとの欄: OpenAI 互換 (vllm / llamacpp / lmstudio / ollama / gemini / vertex-ai / azure-foundry / azure-claude / azure-openai) = `max_tokens`、
  ただし azure-openai の推論モデル (GPT-5 / o 系。 `isOpenAIReasoningModel`) は `max_completion_tokens` (max_tokens を受け付けないため)。
  anthropic / azure-anthropic = `max_tokens`、 azure-gpt (Responses API) = `max_output_tokens`、
  claude-cli / claude-agent-sdk = 子プロセスの環境変数 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (`providers/utils/claude-code-env.ts`。 リクエストに直接渡す口が無い)。
  脇の呼び出しは従来どおり呼び出し側が決める。 O で切れたら `finish_reason="length"` になり、 既存の「続きを出力」 の処理が続ける
  (本文が空なら既存の空応答の扱い)。
- **ツール結果**: `src/agent/tool-result-limit.ts` の `ToolResultBatch`。 1 回の応答 (1 回の本体呼び出しが返したツール呼び出しの組。
  台本外の file_write を代わりに実行する経路も 1 組) ごとに 1 つ作り、 結果を履歴に入れる直前に `fit()` を通す
  (`AgentLoop.addLimitedToolResult`)。 数える順は履歴に入れる順 (並列実行でも settled の順 = 呼び出しの順) なので決定的。
  - 許す量 = min(1 件の上限, max(256, T − それまでの合計))。 最低量は 256 トークン (ASCII で約 930 字、 全角で約 230 字。 「1KB 相当」 をトークンで決めた)。
  - 切り方は頭 2/3・尻尾 1/3 を残し、 中央に英語の注記 (何文字のうち何文字を切ったか、 元の推定トークン数、 1 件の上限か合計の上限か、
    残りの読み方) を入れる。 注記を含めて許す量以下に収める。 合計の上限で切ったときは利用者にも 1 行表示する。
  - file_write / file_edit は切らずに合計に数える。 そのため厳密には 1 回の応答の合計は「T + 最低量 × 件数 + 書き込み系の結果」 まで
    増えうる (書き込み系の結果は短く、 最低量の分は余白 M で吸収する見込み。 実測で見直す)。
- **利用者の入力**: `checkUserInputFits` / `formatUserInputTooLarge` (`context-budget.ts`)。 「最小限の保護部分」 は起動時検査と同じ
  (直近 K 回のツール結果 + 会話の最小限 16,384)。 よって受け付ける最大は `W − 起動時検査の必要量`
  (例: T1・200K 枠・固定部分 11k なら 51,784 トークン)。 `AgentLoop.run()` の最初 (履歴に入れる前、 ToDo の区切りなど依頼の準備の前) に確かめ、
  入らなければ赤字と `harness_notice` (error) で「ファイルに保存して絶対パスで読ませる」 よう案内し、 outcome を error にして終える。
  数えるのはテキスト部分だけ (画像の大きさはサーバの数え方によるので推定しない)。 再開 (durableResume) では確かめない (入力は履歴に入っている)。

### 4.4 発火の 2 つの規則

**規則 1 (強制)**: 本体呼び出しの直前に `P + R > W` なら、 その呼び出しの前に整理する。

前回の呼び出しの前には `P_前 + R ≤ W` だったので、 今の P は `W − M − S` 以下。
よって段階 3 の要約呼び出し (S の中に収まる) も枠に入る。 「入らない」 は作りの上で起きない。

**規則 2 (区切りでの先回り)**: 強い区切りでだけ、 `P + R + G > W` なら整理する。

| 区切り | 強さ | 判定 |
|---|---|---|
| 依頼の終わり: 応答が正常に終わり、 未完了 (pending / in_progress) の ToDo が無く、 Goal も動いていない | 強 | 応答完了の直後 (利用者が次を打つ前) に判定する |
| ToDo が全部完了した | 強 | ToDo 更新の直後に記録し、 次の本体呼び出しの直前に判定 |
| Goal を達成した | 強 | 評価結果の直後に記録し、 同上 |
| 新しい依頼が届いた | 強 | 依頼の終わりで判定済みならしない (中断・再開で判定されていないときだけ) |
| 応答完了 (ToDo が残っている) / ToDo 1 つ完了 / 話題の切り替わり / git commit | 弱 | **整理しない** |

「新しい依頼が届いた」 を、 前の依頼の応答が終わった時点で先に判定するのは、 読み直しを利用者の手が空いている間に
済ませるため (§9)。 git commit は「区切りごとにコミット」 の運用で作業の途中にも頻繁に起きるので弱に入れる (要確認)。

使用率の帯 (`USAGE_BANDS`)、 ティアの閾値 (`compressionThreshold`)、 最短間隔 (3 ターン) はすべて廃止する。
間隔は §4.6 の目標の置き方で自然に空く。

実装 (タスク 8、 2026-10-25): 発火の種類は `boundary:request-end` / `boundary:todos-complete` / `boundary:goal-achieved` /
`boundary:new-request` (`BoundaryKind`。 `reduction-event.ts`)。 判定は `AgentLoop.judgeBoundary(種類)` の 1 つで、
P (`measureNextPrompt`) と G (`RequestGrowthTracker.resolve`) で `exceedsBoundaryLimit` を見て、 超えたら `runReductionEvent("boundary:<種類>")`。
- **依頼の終わり**: `run()` の finally で `task_complete` を出した後 (応答を先に届ける) に `finishRequest()`。
  終わり方が `completed` (response_complete / 最終の文章 / 自己点検の上限) で、 未完了 (pending / in_progress) の ToDo が無く、
  Goal Seek でなければ判定する。 判定の間は `isProcessing` を true のままにする (チャネルの直列化を崩さない)。
  判定や整理が例外を投げたら赤字と `harness_notice` (error) で知らせる (作りの上では投げない)。
- **ToDo の全部完了**: ToDo の遷移フック (`onTodoChange`) で、 全部 completed になった瞬間に `pendingBoundary = "todos-complete"` を記録。
  **Goal の達成**: response_complete で Goal Seek の全項目が完了して抜けたときに `pendingBoundary = "goal-achieved"`。
  どちらも本体呼び出しの再試行ループの中、 規則 1 (`enforceForcedLimit`) の直前に `judgePendingBoundary()` で判定して捨てる。
  そのまま依頼が終われば、 依頼の終わりの判定に含める (記録を捨てて 1 回だけ判定する)。 判定の後に Esc で中断されていたら本体を呼ばずに止める。
- **新しい依頼**: `run()` の始め (入力の検査の後、 発言を履歴に入れる前。 再開 `durableResume` では行わない) に `judgeNewRequestBoundary()`。
  前の依頼が正常に終わった (`requestEndSettled`) ならしない。 済んでいないのは、 前の依頼が中断・エラー・ループ停止で終わったとき、
  セッションを再開したとき (`restoreSession`)、 会話を載せ替えたとき (`importConversation`)、 起動直後。
  決めたこと: ToDo が残ったままの応答完了 (弱い区切り) も「正常に終わった」 に数え、 次の新しい依頼で改めて判定しない
  (§4.4 の表の「依頼の終わりで判定済み」 を「前の依頼が正常に終わった」 と読んだ。 ToDo が残る依頼の続きの発言で整理しないため)。
- **弱い区切り**: ToDo 1 つの完了・話題の切り替わり・git commit・plan mode を抜けた・複雑な依頼・多段の ToDo の作成の検出
  (旧 `queueBreak` の B2/B4/B5/B6/P1/P2/P3) は整理に使わなくなったので、 検出ごと削除した。
- 規則 2 は先回りなので、 整理に失敗しても作業は止めない (失敗は整理イベントが画面と記録に出す。 入らなければ次の規則 1 が判定する)。
- 試験: `tests/agent/reduction-boundary.test.ts` (依頼の終わり・ToDo の全部完了・Goal の達成・新しい依頼 (再開後)・弱い区切り・
  Goal が動いている間・P + R + G ≤ W のときに整理しないこと)、 `tests/agent/prompt-prefix-invariant.test.ts` (規則 1 と規則 2 が起きる
  4 件の依頼で、 キャッシュが外れる送信が整理イベントの直後だけであること、 余裕のある枠では依頼の境目で 1 度も外れないこと)。

### 4.5 ひと仕事の増分 G の測り方

- 1 件の依頼 (利用者の発話から依頼の終わりまで) の増分 = 最後の本体呼び出しの実数 P + その出力 − 最初の本体呼び出しの実数 P。
  途中で整理が入った依頼は、 整理で減らした量を足し戻して数える。
- G = 直近 3 件の最大。 3 件そろうまでは既定 80,000 (≈ 2.3k × 35 回。 要確認)。
- G は `(W − R) ÷ 2` で頭打ちにする (1 件の巨大な依頼のせいで、 区切りのたびに全部を要約する状態を避ける)。
- 記録はセッションに保存し、 再開後も使う。

実装 (タスク 3、 2026-10-25): `RequestGrowthTracker` (`context-budget.ts`)。 依頼の始まりで `beginRequest()`、
本体呼び出しの応答ごとに `noteMainCall(入力の全体, 出力)`、 依頼の途中の整理で `noteReduction(減らした量)`、
依頼の終わりで `endRequest()`。 G は `resolve(budget)` (= `resolveRequestGrowth(recent, budget)`) で、 既定値か直近 3 件の最大かと、
頭打ちしたかを返す (頭打ちは既定値にもかかる)。 呼ぶ箇所の組み込みはタスク 8。
- 本体呼び出しの実数が 1 件も無い依頼は記録しない (増分を作らない)。 終わる前に次の依頼が始まったら (中断など)、 そこまでを 1 件として記録する。
- 保存先は `SessionData.requestGrowth` (`{ version: 1, recent, current }`。 依頼の途中で保存したときは途中の分も持つ)。
  `toSnapshot()` で保存し、 `RequestGrowthTracker.restore(raw)` で戻す。 欄の無い古いセッションは空の記録から始め、
  形が壊れていれば `{ ok: false, error }` を返す (黙って空にしない)。 `forkSession` は履歴と一緒に引き継ぐ。
  AgentLoop の保存・再開への組み込みもタスク 8。
- 組み込み (タスク 8、 2026-10-25): `beginRequest` は `run()` の始め (新しい依頼の判定の後。 再開 `durableResume` では呼ばない =
  一時停止をはさんでも同じ依頼として測る)、 `noteMainCall` は本体呼び出しの応答の usage を受けたとき (入力の全体 = cache_miss と同じ値、 出力)、
  `endRequest` は `run()` の終わり方が決まったとき (`incomplete` = 一時停止以外。 中断・エラーもそこまでを 1 件にする)。
  `saveCurrentSession` が `toSnapshot()` を `SessionData.requestGrowth` に書き、 `restoreSession` が `restore()` で戻す。
  壊れていたら黄色の 1 行とログの警告で知らせて空の記録から始める。 チャネルの会話の載せ替え (`ConversationState`) は会話ごとに記録を持つ。

### 4.6 1 回の整理の目標と最低量

- **目標**: 整理後の P が `W − R − G` 以下 (= 少なくともひと仕事ぶんの余白を空ける)。 段階は目標に達したところで止める。
- **最低量**: 1 回の整理で少なくとも `F = max(32,768, G ÷ 2)` を減らす。 目標に達していても F に届くまでは段階を進める。
  (Anthropic の `clear_at_least` と同じ考え方。 キャッシュを失う以上、 割に合う量を空ける)

### 4.7 具体的な数字 (T1、 G = 80,000、 R = 71,680)

| | W = 262,144 (256K) | W = 1,048,576 (1M) | 参考: W = 393,216 (384K) |
|---|---|---|---|
| 規則 1 の発火点 (W − R) | 190,464 | 976,896 | 321,536 |
| 規則 2 の発火点 (W − R − G) | 110,464 | 896,896 | 241,536 |
| 整理後の目標 | ≤ 110,464 | ≤ 896,896 | ≤ 241,536 |
| 整理後の読み直し | 約 14 分 | **約 1 時間 55 分以上** | 約 31 分 |
| 次の整理まで | 約 80k 増 (≈ 35 回) | 約 80k 増 | 約 80k 増 |

256K では過去ログ (17〜20 万 → 11〜13 万) とほぼ同じ動きになる。 1M では整理が非常にまれになる。

**contextWindow は下げない (2026-10-25 利用者と決定)**。 上の「整理後の目標」 は上限であって、 実際に残る量ではない。
段階 0〜2 を毎回最後まで行う (§5) ので、 古いツール結果はほぼ全部消え、 残るのは会話の本文・利用者の発言・直近 K 回の
ツール結果・要約になる。 実際の読み直しは目標値から計算した時間よりずっと短い (整理イベントの記録 §10.1 で実測する)。
枠を大きく使う間に注意する点 (いずれも §10 で測る):
- キャッシュが外れたとき (補助の呼び出し・サブエージェント・再開・サーバの再起動) の読み直しは、 その時点の履歴の長さに比例する
- 履歴が長いほど 1 回の生成が遅くなる
- 長い文脈での応答の質

---

## 5. 整理の段階

整理は 1 回の「整理イベント」 の中で、 決まった順に段階を進める。 各段階は **履歴の写し** に対して行う。

- **段階 0〜2 (決まった規則) は毎回最後まで行う** (2026-10-25 利用者と決定)。 キャッシュの費用は 1 回の書き換えで同じなので、
  残す量を減らすほど読み直しが短くなり、 余白が広がって次の整理も遠のく。 目標の手前で止めると小出しの整理を繰り返すことになる。
- **段階 3 (要約) だけは**、 段階 0〜2 の後も目標と最低量 (§4.6) を満たさないときに行い、 満たす最小の範囲を要約する。

### 5.1 保護するもの (全段階共通)

- system (固定部分)、 圧縮要約・忘却の記録の system ノート
- **利用者の発言すべて (原文のまま。 どの段階でも要約・切り詰めをしない。 2026-10-25 利用者と決定)**。
  ハーネスが入れた促し (揮発メッセージ) は利用者の言葉ではないので保護しない (§5.2 で除く)
- 直近 K 回のツール呼び出し (K: T1=6 / T2=5 / T3=3。 `keepRecentMessages` を置き換えるティア既定値 `keepRecentToolUses`)
- 結果に利用者の言葉や状態を持つツール: `ask_user`、 `todo_append` / `todo_mark` などの ToDo ツール、
  `exit_plan_mode`、 `response_complete`。 タスク 5 で `todo_delete` と `enter_plan_mode` を足して確定
  (`PROTECTED_TOOL_NAMES` = ask_user / todo_append / todo_mark / todo_delete / enter_plan_mode / exit_plan_mode / response_complete。
  名前は `src/tools/definitions/` で確かめた。 §5.7)
- ツール呼び出しと結果の対 (片方だけ消さない。 `context-forgetting.md` §2.1)

### 5.2 前処理: 書き換えの借りを返す

応答のたびに行っていた書き換えを、 整理イベントまで延ばす (§6.2)。 イベントでは最初にまとめて行う:

- 終わった依頼の揮発メッセージを除く (`purgeEphemeral` 相当)
- 終わった依頼の思考を消す (`clearAllThinking` 相当。 今の依頼の思考は段階 2 で扱う)

どちらもイベントの書き換えに含まれるので追加の読み直しは無い。

### 5.3 段階 0: 意味を変えない除去 (古い順・決まった規則)

| 規則 | 対象 (古い方) | 条件 | 変換 |
|---|---|---|---|
| 0-a 読み直し | `file_read` の結果 | 後に同じファイル (絶対パス、 Windows では大小文字を区別しない) を、 同じか広い範囲 (offset / limit) で **成功して** 読んでいる。 または後に同じファイルへ `file_write` が成功している | 結果の本文を `[忘却済み] … 後で読み直したため省略` に差し替え。 呼び出しは残す |
| 0-b 同じ結果 | 任意のツールの結果 | 後に同じツール名・同じ引数 (JSON を正規化して比較)・**全く同じ結果** がある | 同上 (`… 後で同じ結果を得たため省略`) |
| 0-c 失敗のあとの成功 | 結果が `Error: ` で始まる呼び出し | 後に同じツール・同じ対象 (`file_edit` / `file_write` はパス、 `bash` はコマンド文字列) が成功している | 結果を先頭 300 字 + 省略注記に縮める (何で失敗したかは残す) |
| 0-d 上書きされた書き込み | `file_write` の呼び出し | 後に同じファイルへの `file_write` が成功している | 呼び出しと結果の対を外し、 1 行の記録を忘却の記録へ移す (既存 `thinSlice` の本文ありの扱い) |

慎重側に倒す規則:
- `file_edit` だけでは前の `file_read` を古いとみなさない (編集の土台として要る。 要確認)。
- 成功・失敗は結果本文の先頭 `Error: ` で判定する (`agent-loop.ts:3086`)。 判定できないものは触らない。
- 最新の 1 回分のツール呼び出しは古い側として扱わない。

### 5.4 段階 1: 古いツール結果を消す (決まった規則)

いまの `thin` の動きをそのまま使う (`forgetting.ts:464` `thinSlice`)。

- 古い順に、 保護 (§5.1) されていないツール呼び出しの **結果の本文だけ** を `[忘却済み] <ツール> <対象> の結果 (約 N トークン) は…` に差し替える。
  呼び出しは残す (「このファイルを読んだ」 という行動の記録を消すと読み直しの繰り返しを招く)。
- 引数に本文を持つ呼び出し (`file_path` / `path` / `url` 以外の文字列引数が 200 字超。 `forgetting.ts:447`) は、
  対ごと外して 1 行の記録を忘却の記録へ移す。 **引数を切り詰めて呼び出しの形のまま残してはいけない**
  (モデルが真似して壊れた呼び出しを出す。 `context-forgetting.md` §3.1 の 2026-10-18〜19 の実害)。
- 旧方式で切り詰め済みの引数 (`[忘却済み]` を含む) も本文ありとして記録へ移す。
- 差し替え済みの結果は再変換しない。 減る量が 0 のものは選ばない。
- 旧 `forget-thinking` との違い: 読み取り系に限らず、 書き込み・実行系の結果本文も対象にする (呼び出しは残るので
  「何をしたか」 は残る)。

### 5.5 段階 2: 古い思考を消す (決まった規則)

- 今の依頼の assistant メッセージの思考を古い順に消す。 直近 3 件の思考は残す
  (依頼の中では思考を活かす、 という `ephemeral-context-design.md` §1.2 の考えを守る)。

### 5.6 段階 3: 要約 (LLM。 まだ目標に届かないときだけ)

**要約の範囲**: 履歴の先頭 (既存の要約があればその次) から、 保護部分の手前までのうち、 目標と最低量を満たす最小の範囲。
境界はツールの対を分けない位置に寄せる (`message-history.ts:365` `replaceOlderMessages` と同じ扱い)。
範囲の中の **利用者の発言は要約せず、 元の位置に原文のまま残す**。 要約するのは利用者の発言の間にあるモデルの発言とツール結果で、
利用者の発言ごとの区間を 1 つの要約に置き換える (要約は system ノートではなく、 区間の位置に置く。
置き方は **assistant メッセージ** に決めた (タスク 6。 理由と形は §5.8)。

**要約の呼び出し方 (キャッシュを使う)**: 段階 0〜2 は写しに適用しただけなので、 サーバのキャッシュにあるのは
まだ書き換え前の履歴である。 そこで要約は **書き換え前の現在の履歴 (同じ system・同じツール定義。 前回の本体呼び出しの並び +
その後に足した出力とツール結果) の末尾に、 要約の指示を 1 件足した呼び出し** として送る。 前方一致でキャッシュがそのまま使われ、
費用は新しい末尾 (T 以下) の読み込みと出力 (約 2〜4k トークン、 5〜10 分) だけになる。 指示には「`<境界の目印>` より前を要約せよ。 ツールは呼ぶな」 と書く。
**思考はオフにしない** (確認済み): 実機のチャットテンプレートは、 思考オン (既定) のときだけ system ブロックの **先頭** に
`Reasoning effort is set to xhigh. …` を入れ、 `enable_thinking: false` ではこれを入れない。 オフにすると前方が変わり、
全体の読み直しになる。 要約の呼び出しは本体と同じ思考設定のまま送り、 長さは出力上限で抑える。
`context-reduction-reasoning-model-fix.md` の「思考オフで呼ぶ」 知見は、 キャッシュを使わない脇の呼び出しにだけ当てはまる。
ツール呼び出しが返ったら 1 回だけ指示を強めて再送し、 だめなら失敗として報告する (別の手段には切り替えない)。

**要約の型** (Claude Code の要約の型に合わせる。 見出しは英語、 中身は会話の言語):

1. 依頼と意図 (Primary request and intent)
2. 主な技術上の概念 (Key technical concepts)
3. ファイルとコードの箇所 (パス・関数名・行番号を丸めない)
4. エラーと直し方
5. 問題解決の経過
6. 残っている作業
7. いまの作業 (要約の直前に何をしていたか)
8. 次の一歩 (いまの作業に直結するものだけ)

Claude Code の型にある「利用者の発言の一覧」 は入れない。 利用者の発言は原文のまま履歴に残るため (§5.1)。

**状態の渡し直し**: 要約の後、 既存の状態通知 (`attachDynamicContext`) で ToDo・Goal に加えて
「最近触ったファイル (パス一覧)」 と「いまの作業 (要約の 8)」 を 1 回だけ添える。
前回の通知を付けたメッセージが消えたときに出し直す既存の規則 (`prompt-prefix-stability.md` §3.2 の 2) にそのまま乗る。

### 5.7 実装 (タスク 5、 2026-10-25)

`applyReductionStages(input)` (`src/agent/reduction-stages.ts`) が前処理と段階 0〜2 を写しに最後まで当てはめる純粋な関数。
入力の配列もメッセージも書き換えず、 変えないメッセージは同じ参照のまま返す。 履歴の差し替え・忘却の記録の挿入はしない (タスク 7)。

- 入力: `messages` (getRawMessages() の形。 固定の system は含まない。 揮発は各メッセージの `ephemeral` の印で判定する。 タスク 7 で `isEphemeral(m)` の引数から移した)、
  `currentRequestStart` (今の依頼の始まりの添字。 依頼の終わりで整理するときは `messages.length`)、 `keepRecentToolUses` (K)、
  `promptTokens` (整理前の P)、 `goal` (`computeReductionGoal` の結果)、 `caseInsensitivePaths` (省略時は Windows なら true)。
- 出力: `messages` (対の検証済み)、 `freedTokens` {preprocess, stage0, stage1, stage2, total}、 `repaid` {ephemeral, thinking}、
  `clearedCurrentThinking`、 `forgotten` (規則・ツール名・呼び出し id・説明・減った量)、 `recordLines` (忘却の記録に入れる行)、
  `firstForgottenIndex` (最初に消した応答の組の先頭の位置。 ここに記録を置いても対の間に挟まらない)、
  `promptTokensAfter` (= P − total)、 `needsSummary` と `shortfall` {toTarget, toMinimum} (段階 3 が要るか)。
- 減った量は送る形 (`toSentMessage`。 思考の inline 化・状態通知を含む) の `estimateMessageTokens` の差。
  `toSentMessage` と対の検証 `findToolPairingError` は `message-history.ts` から切り出し、 `getMessages()` / `replaceMessages()` と共用する。
- 段階 1 の変換 (`transformToolBatch`・本文ありの判定・`[忘却済み]` の文面) は reduction-stages.ts に移し、 旧 `forgetting.ts` の
  `thinSlice` もこれを使う (タスク 8 で旧経路を消してもこちらが残る)。
- 決めたこと:
  - 保護 (§5.1) は呼び出し 1 件ごと。 直近 K 回は呼び出しの件数で数え、 最新の応答の組は K が 0 でも保護する。 結果の無い呼び出しも触らない。
  - 段階 0 の成功・失敗は結果の先頭 `Error: ` で判定。 本文が文字列でないもの・既に `[忘却済み]` にしたものは判定せず、 手本 (後の成功) にもしない。
  - 規則は 1 つの呼び出しに 0-d → 0-a → 0-b → 0-c の順で 1 つだけ。 引数に本文を持つ呼び出しは 0-d 以外の対象にしない (段階 1 が対ごと外すため)。
  - 0-a の範囲は file_read の既定 (offset 1・limit 2000) で補って比べる。 offset / limit が数でなければ判定しない。
    パスは Windows では `\` と `/`・大小文字を区別しない (それ以上の正規化はしない。 違って見えるものは別物として残す)。
  - 0-c の「同じ対象」: file_edit / file_write / file_read はパス、 bash はコマンド、 ほかのツールは引数の全体。
    短縮した結果 (途中の行が `[忘却済み] ` で始まる) は段階 1 でも消さない (何で失敗したかを残す)。
  - 段階 0・1 は減る量が 0 以下になる変換を選ばない。
  - 忘却の記録の行は、 結果の本文を消したものを規則ごとにツール名と件数で、 対ごと外したもの (0-d・段階 1) を 1 件 1 行
    (10 件まで。 残りは件数)、 段階 2 の思考を件数で出す。 前処理 (揮発メッセージ・終わった依頼の思考) は行にせず `repaid` の件数で返す
    (応答のたびに黙って消していたハーネスの一時的なものなので。 件数は整理イベントの記録 §10.1 に出す)。
- 結果に `originalIndices` (写しの各メッセージが元の履歴の何番目から来たか) を足した (タスク 6。 段階 3 が写しで決めた範囲を
  サーバに送る元の履歴の位置に対応させるため)。

### 5.8 実装 (タスク 6、 2026-10-25)

`src/agent/reduction-summary.ts`。 1・3・4 は写しに対する純粋な関数、 2 だけが LLM を呼ぶ。 履歴の差し替え・発火はしない (タスク 7・8)。

1. **範囲** `selectSummaryRange({ messages, originalIndices, originalLength, keepRecentToolUses, shortfall })` (揮発は `m.ephemeral` で判定)
   (`messages` / `originalIndices` / `shortfall` は `applyReductionStages` の結果) → `{ ok: true, range }` か
   `{ ok: false, reason: "not-needed" | "nothing-to-summarize" }`。
   - 範囲の中で原文のまま残すもの: 揮発でない利用者の発言、 system ノート、 保護するツール (§5.1) を含む応答の組。
     それ以外 (モデルの発言・ツールの組・ハーネスの促し) の連続が 1 つの「区間」 で、 区間ごとに要約 1 件に置き換える。
   - 先頭は履歴の先頭、 既存の要約 (`<summary-of-earlier-turns>` で始まる assistant) があればその次。 終わりの上限は直近 K 回の
     ツール呼び出しと最新の応答の組の手前 (ツール呼び出しが無ければ最後のモデルの発言の手前)。
   - 終わりはツールの対を分けない位置で、 区間のメッセージで終わる位置だけを候補にし、 見込みの減る量
     (区間の大きさ − 区間ごと 256 トークン + 包み − 全体の要約 3,072 トークン) が `max(目標まで, 最低量まで)` に届く最小の位置を選ぶ。
     最後の区間は利用者の発言の途中 (依頼の途中) で切れてよい。
   - 上限まで広げても届かなければ、 上限までの範囲を `meetsShortfall: false` で返す (減る分は減る。 足りたかの判断は呼び出し側。
     規則 1 なら当てはめ後の P + R ≤ W を確かめる)。 見込みが 0 以下なら `nothing-to-summarize`。
   - 範囲・区間は写しの添字 (`start` / `end`) と元の履歴の添字 (`originalStart` / `originalEnd`) の両方で持つ。
     元の範囲は段階 0〜2 が消したメッセージ (終わった依頼の促し・対ごと外した呼び出し) も含む (モデルはそれも見ているので要約に含めてよい)。
2. **呼び出し** `requestSummary({ provider, request, history, range, promptTokens, budget })` → `SummaryCallResult`。
   - `request` は次の本体呼び出しで送るはずのもの (`{ method: "chat" | "chatWithTools", params }`。 model・tools・サンプリング・
     思考の設定・signal は本体と同じ、 `messages = getMessages()`)。 `history` は `getRawMessages()`。 並びと履歴の対応が崩れていれば例外。
   - `params.messages` の末尾に指示 (user、 `<context-summary-request>`) を 1 件足し、 `maxTokens` だけ差し替えて `sideCall("summarize")` で送る。
     `disableThinking` は足さない。 出力上限は `min(O, W − P − 指示 − M)`。 規則 1 の発火時 (P ≤ W − M − S) でも S − 指示 以上が残る。
     1,024 未満なら呼ばずに `no-room`。
   - **境界の目印**: 並びの途中に印は入れられない (前方が変わる) ので、 指示の中で元の履歴のメッセージを言葉で指す
     (`describeMessageAnchor`): 利用者の発言は通し番号と書き出し 80 字 (`user message #3 (it begins: "…")`)、 ツール呼び出しは
     `your tool call file_read /path`、 結果は `the tool result of your call …`、 モデルの発言は書き出し。 ツール呼び出しの id は
     チャットテンプレートに描画されないので使わない。 範囲の始まりと終わり (含む)、 範囲の後ろの最初のメッセージ (要約しない)、
     区間ごとの始まりと終わりを書く。
   - ツール呼び出しが返った・型が揃わないときは、 同じ並び + 問題を先頭に書いた強めの指示で **1 回だけ** 送り直す。
     2 回目もだめなら `{ ok: false, reason: "tool-call" | "format" }` (理由は 2 回目の問題)。 `finishReason=length` は送り直さず `length`
     (同じ上限では同じ結果になる)。 provider のエラー・中断は例外のまま投げる。 思考オフ・別の要約器への切り替えはしない。
3. **出力の形と検査** `parseSummaryOutput(text, 区間の数)`。 出力は
   `<segment n="1">…</segment> … <segment n="N">…</segment>` (区間ごとの短い要約) + `<summary>` (8 見出し `## Primary request and intent` 〜
   `## Next step`) `</summary>`。 区間が 1〜N の順に 1 つずつ、 `<summary>` が 1 つ、 8 見出しが順に 1 回ずつ・中身が空でないこと
   (無いときは "None" と書かせる) を確かめ、 揃わなければ問題の一覧を返す (黙って受け入れない)。 8 見出し以外の見出し行 (ファイル名の
   小見出し等) は中身として扱う。 タグの外の文 (前置き) は捨てて文字数 `extraTextChars` を返す (記録に出す用)。 先頭の `<think>…</think>` は除く。
   - **形を「区間ごとの短い要約 + 全体 1 つの 8 見出し」 にした理由**: 区間ごとに 8 見出しを繰り返すと、 古い区間の Pending tasks /
     Current work / Next step は既に古く、 新しい状態と食い違って誤解を招く。 出力も区間の数だけ長くなる (5〜7 トークン/秒で数分ずつ増える)。
     利用者の発言は原文で残るので、 区間ごとには「その発言に対して何をしたか」 が分かれば足りる。 全体の要約は時系列の正しい位置
     (境界の直前、 = 残る最近の部分のすぐ前) に 1 つ置き、 いまの状態をそこで示す。
4. **当てはめ** `applySummaryToCopy(写し, range, summary)` → `{ messages, freedTokens, newIndexOf, summaryIndices }`。
   区間を 1 件の assistant メッセージに置き換え、 最後の区間のメッセージにだけ全体の要約 (`# Summary of the conversation so far` + 8 見出し) を付ける。
   残すメッセージは同じ参照のまま。 `freedTokens` は当てはめ後の実際の推定 (範囲を決めたときの見込みではない)。 `newIndexOf` は
   元の写しの添字 → 当てはめ後の添字 (要約したものは要約の位置) で、 忘却の記録 (`firstForgottenIndex`) を置き直すのに使う。 対の検証を通らなければ例外。
   - **置き方を assistant にした理由**: 履歴途中の system は Qwen 系のテンプレートが `System message must be at the beginning` で拒み、
     openai-compat はそれを先頭の system に寄せる (= 先頭が変わり、 要約が時系列の位置から外れる)。 user にすると利用者の言葉に見え、
     「利用者の発言は原文のまま」 (§5.1) と食い違う。 要約は「モデルがしたこと」 の記録なので assistant が意味として合う。
     範囲が依頼の途中で切れると要約の assistant の直後に assistant (ツール呼び出し) が続くが、 Qwen のテンプレート・OpenAI 互換・Anthropic 変換
     (`azure-anthropic.ts` は同じ役割の連続をそのまま送る) で問題ない。
   - **真似の対策**: 本文は `<summary-of-earlier-turns>` で囲み、 先頭に「ハーネスが置いた記録で返答の手本ではない。 この形で答えるな」
     (英語) と必ず書く。 8 見出しは最後の 1 件だけで、 他は短い文章なので、 返答の型として目立たない。
5. **状態の渡し直し** `buildStateHandover(history, range, summary)` → 文面 (`# After context reduction` / 要約した部分で触ったファイル
   (引数 `file_path`、 新しい順・重複なし・20 件まで、 超えた分は件数) / 要約の Current work)。 `MessageHistory.queueStateHandover(文面)` で預けると、
   次の `attachDynamicContext` が状態通知 (日時・ToDo・Goal) の後ろに **1 回だけ** 添える。 預かりがあることは添付の条件 (§3.2 の 4 番目) になり、
   状態が前回と同じでも添える。 末尾が assistant・送信済みなら待たせたまま次で添える。 変化の判定 (key) には含めない。 `clear()` で捨てる。
   預かりは `SessionData.pendingStateHandover` に保存する (タスク 8 で決定。 依頼の終わり・`/compact` の整理の後は、 次の本体呼び出しの前に
   保存・終了・再開をはさみうるため。 添えたら預かりが消え、 次の保存で欄も消える)。 再開で `queueStateHandover` に戻す。 文字列でなければ警告して使わない。

タスク 7 への申し送り: 要約の呼び出しの `request` は本体呼び出しと同じ組み立て (同じ関数) から作ること (思考・サンプリングの差で前方が変わる)。
要約を呼ぶ前に `attachDynamicContext()` を呼ばないこと (末尾が送信済みになり、 当てはめ後の写しにも通知が残る。 通知は差し替えの後の本体呼び出しで付ける)。

---

## 6. 1 回の書き換えにまとめる仕組み

### 6.1 整理イベントの流れ

```
1. 発火 (規則 1 / 規則 2 / 手動)
2. 写しに前処理 (借りの返済) → 段階 0 → 1 → 2 を順に適用。 満たしたら止める
3. まだ届かなければ段階 3: キャッシュ済みの並び + 指示で要約を得る (書き換え前に呼ぶ)
4. 写しに要約を当てはめ、 忘却の記録を 1 件にまとめて入れる (既存 insertTombstone の追記統合)
5. ツールの対を検証して、 MessageHistory.replaceMessages() で 1 回だけ差し替える
   (書き換え理由は "reduction:<イベント ID>" の 1 件)
6. 記録 (§10) → 依頼の境目なら予熱 (§9)
```

途中で失敗したら写しを捨てるだけで、 履歴は元のまま。 失敗はそのまま利用者に報告する。
規則 1 の発火で失敗した場合は本体呼び出しを出さずに止める (入らない呼び出しは送らない)。

**段階 3 の要約に失敗したときの扱いは設定で選ぶ** (2026-10-25 利用者の決定。 設定は §11.3 の `context.summaryFailure`):
- `continue` (既定): 要約の失敗 (型が揃わない・ツールを呼んだ・出力上限・provider のエラー) を、 利用者に見える 1 行 (黄色の警告と
  `harness_notice` (warn)) と `reduction_event` の記録 (`summary.status` / `summary.failureDetail` / `continuedWithoutSummary: true`) に
  必ず出したうえで、 段階 0〜2 の写しだけで履歴を差し替える。 ただし規則 1 の発火で、 段階 0〜2 だけでは次の本体呼び出しが入らない
  (整理後の P + R > W のまま) ときは止める (`still-too-large`。 失敗の文に要約の失敗の中身も添える。 入らない呼び出しは送らない)。
  段階 0〜2 で減るものが無ければ `nothing-to-reduce` (同じく要約の失敗を添える)。
- `stop`: イベント全体を失敗にする (写しを捨て、 履歴は元のまま。 規則 1 なら本体を呼ばずに止める)。 タスク 7 の動き。
- 手動の `/compact` と規則 2 も同じ設定に従う。
- Esc で要約の呼び出しが切れたとき (中断の signal が立っている) は、 設定にかかわらず失敗にする (利用者が止めた処理を続けない)。
- これは利用者が選べる見える形の扱いで、 黙った代替ではない (失敗は必ず出す。 要約を別の手段に切り替えることもしない)。

### 6.2 応答のたびの書き換えをやめる

- `purgeEphemeralAtSpanEnd` (`agent-loop.ts:2726`) は、 表示済み応答の保全 (`promoteDisplayedEphemeral`) と
  終わり方の記録だけを行い、 `purgeEphemeral()` と `clearAllThinking()` を呼ばない。 代わりに「借り」 として記録する。
- 揮発の印は今は WeakSet でメモリにしか無い。 借りを持ったままセッションを保存・再開しても失わないよう、
  `contextNote` と同じ内部専用の欄 (`Message.ephemeral`) に移し、 provider へ送る前に外す。
- 揮発メッセージが次の依頼にも見えたままになる (前の依頼の点検の催促などが残る)。 §14 の未決事項。

### 6.3 最小限の保護部分が枠に入ることの起動時検査

段階 0〜3 を最後まで行っても残るのは、 system・ツール定義・今の依頼の発話・直近 K 回のツール結果 (各 1 件の上限まで)・
要約・状態通知。 起動時 (とモデル切替時) に `固定部分 + K × 1 件の上限 + 16,384 + R ≤ W` を確かめ、
満たさなければ「contextWindow が小さすぎる」 と理由と必要量を示して止める。 これで「整理しても入らない」 も起きない。

実装 (タスク 3、 2026-10-25): `checkContextWindowFits()` と `formatContextWindowTooSmall()` (`context-budget.ts`)。
- 固定部分 = いまの system + 登録済みのツール定義の全部 (絞り込み前) の推定。
- 1 件の上限 = `TIER_CONTEXT_BUDGETS[tier].toolResultLimitTokens` (§4.2 の表) をそのまま使う。 タスク 4 で切り詰めを同じトークン数・
  同じ数え方 (`estimateTokens`) にしたので、 見積もりと実際の切り方が一致し、 最悪値に直さなくても保証は保たれる
  (タスク 3 の時点では文字数で切っていたので全角の最悪値 1 文字 1.1 トークンで直していた。 2026-10-25 利用者の決定で廃止)。
- 呼ぶ箇所: `AgentLoop` の生成時 (= 起動時。 失敗は起動の致命的エラー)、 `setContextWindow` / `setModel` / `setProvider`
  (反映する前に確かめ、 入らなければ何も変えずに例外)。 `setProvider` は endpoint の `contextWindow` も一緒に反映するようにし、
  REPL の `applyMainLLMEndpoint` が別に呼んでいた `setContextWindow` をやめた (新しいモデルと新しい枠の組で 1 回だけ確かめるため)。
  REPL の `/model context` / `/model <名前>` / `/model list` は失敗を赤字で示し、 設定を保存しない。 `applyMainLLMEndpoint` は既存の
  「反映できなかった」 表示 (`reportApplyFailure`) に出す。
- 実際の必要量 (固定部分 約 11k のとき。 `context-budget.test.ts` で数字を固定):
  T1 = 11,000 + 6 × 8,192 + 16,384 + 71,680 = **148,216** (200K 枠で起動できる)、
  T2 = 11,000 + 5 × 5,120 + 16,384 + 67,584 = **120,568** (128K 枠で起動できる。 固定部分が約 18k までなら 128,000 に入る)、
  T3 = 11,000 + 3 × 2,048 + 16,384 + 17,408 = **50,936** (64K 枠で起動できる)。 目安の値のままで 3 つとも入ったので調整はしていない。
  (タスク 3 の最悪値の換算では T1 約 236k、 T2 約 164k、 T3 約 66k で、 200K / 128K / 64K 枠が起動できなかった。)
  既存テストの 8,192 / 32,768 の枠は 128,000 / 262,144 に上げたまま (検査に合っているので戻していない)。

### 6.4 実装 (タスク 7、 2026-10-25)

**整理イベント** `runReductionEvent(input)` (`src/agent/reduction-event.ts`) が §6.1 の 1〜5 を行う。 AgentLoop からは
`AgentLoop.runReductionEvent(trigger, size?)` (public。 タスク 8 の規則 2・タスク 10 の `/compact` もこれを呼ぶ) を通す。

- 入力: `id`、 `trigger` (`"forced" | "boundary:<種類>" | "manual"`)、 `history`、 `provider` (本体と同じ)、 `budget`、 `keepRecentToolUses` (K)、
  `promptSize` (整理前の P)、 `growthTokens` (G)、 `currentRequestStart`、 `buildMainCallRequest` (本体呼び出しと同じ組み立て関数)、
  `cacheMissCauses`、 `growth` (RequestGrowthTracker)。
- 出力: `{ ok: true, record }` か `{ ok: false, reason, detail, record }`。 reason は `stages-error` / `summary-failed` / `summary-error` /
  `nothing-to-reduce` / `still-too-large` / `apply-error`。 記録 `record` は §10.1 の欄 (下) で、 成功・失敗のどちらも返す。
  `formatReductionEventLine(result)` が利用者向けの 1 行。
- 成功したときだけ `replaceMessages(写し, "reduction:<id>")` を 1 回呼び、 続けて `cacheMissCauses.noteReductionEvent(id)`、
  `growth.noteReduction(減った量)`、 要約があれば `queueStateHandover()`。 失敗したら写しを捨てるだけで、 履歴・書き換え理由・
  書き換えの回数 (`getRevision()`)・渡し直しの預かりは元のまま。
- AgentLoop 側 (`runReductionEvent`): ID は `r-<通し番号>-<時刻の 36 進>` (プロセスをまたいで同じセッションのログに書いても重ならない)。
  `reduction_event` をセッションログに書き、 成功は 1 行 (✔) と `harness_notice` (info)、 失敗は赤の 1 行と `harness_notice` (error)。
  ただし規則 1 以外で `nothing-to-reduce` のときは情報 (ℹ) にする (書き換えないだけで害はない)。 要約の呼び出しも Esc で切れるよう
  本体と同じ `llmAbortController` を使う。 成功したらチャットログのパートを分ける (`onCompressed`)。

決めたこと:
- ~~**要約に失敗したら、 イベント全体を失敗にする**~~ → タスク 8 で利用者の決定により設定 `context.summaryFailure` で選ぶ形にした
  (既定 `continue`。 §6.1)。 タスク 7 の動きは `stop`。 要約の範囲が取れない (`nothing-to-summarize`。 要約しても減らない) のは失敗ではなく、
  段階 0〜2 の分だけで進める (設定に関係しない)。 規則 1 の発火なら、 そのあと「整理後の P + R ≤ W」 を確かめ、 満たさなければ `still-too-large` で失敗。
- 差し替え前後の送る形の推定の差 (`freedTokens.total`。 忘却の記録の分を差し引く) が 0 以下なら `nothing-to-reduce` で書き換えない。
- 忘却の記録の本文は `[忘却の記録] 整理 <id>: 古いツール結果などを履歴から削除しました。` + 段階 0〜2 の行 (§5.7) + 読み直しの案内。
  行が無い (前処理・要約だけ) ときは記録を入れない (要約は自分の目印 `<summary-of-earlier-turns>` を持つ)。 置く位置は
  `firstForgottenIndex` を要約の当てはめ (`newIndexOf`) で置き直した位置。 既存の記録があれば追記して 1 件にする。
  `TOMBSTONE_MARKER` / `insertTombstone` は `reduction-stages.ts` に移し、 旧 `forgetting.ts` もそれを使う。
- `currentRequestStart` (前処理の境目) は、 `run()` の始めに控える「依頼を始めた利用者の発言」 (再開 `durableResume` では履歴の最後の
  揮発でない利用者の発言) の位置。 依頼の外 (待ち受け中) なら全部が終わった依頼 (`length`)。 控えた発言が履歴に無い (旧方式の圧縮で
  要約に入った) ときは 0 (残っている全部を今の依頼とみなし、 返済しない側に倒す)。
- 記録 (§10.1) の欄: `id` / `trigger` / `ok` / `failureReason` / `failureDetail` / `promptTokensBefore` / `promptBasis` (usage | estimate) /
  `targetPromptTokens` / `minimumReductionTokens` / `growthTokens` / `reachedStage` (2 | 3。 段階 0〜2 の前に失敗したら null) /
  `freedTokens` {preprocess, stage0, stage1, stage2, stage3, total} / `repaid` {ephemeral, thinking} / `forgottenCalls` / `clearedCurrentThinking` /
  `promptTokensAfter` (推定) / `summary` {status: not-needed | nothing-to-summarize | done | failed | error, failureReason, failureDetail (タスク 8), segments, attempts,
  maxTokens, tokensIn, tokensCached, tokensOut (全試行の合計), durationMs, extraTextChars} / `summaryFailurePolicy` (continue | stop。 タスク 8) /
  `continuedWithoutSummary` (タスク 8) / `prewarm` (タスク 9 用。 今は常に null) / `durationMs`。

**規則 1 の組み込み** (`AgentLoop.enforceForcedLimit`): 本体呼び出しの再試行ループの中で、 一時停止の確認の後、 状態通知の添付
(`attachDynamicContext`) の前に P を測り、 `exceedsForcedLimit` なら `runReductionEvent("forced", P)`。 失敗したら本体を呼ばずに止める:
履歴に「この応答はコンテキストの整理に失敗したため送れませんでした」 の印 (`appendAbortMarker`) を足し、 終わり方 `context_reduction_failed`
(outcome error)。 Esc で要約が切れたときは従来の中断 (`user_abort`)。 接続の再試行で送り直すときも同じ判定を通る (整理済みなら入る)。
- **P の求め方** (`AgentLoop.measureNextPrompt`): 本体呼び出しの応答に usage があれば、 入力の全体 (Anthropic 系はキャッシュ分を足す)・出力・
  送った時点の履歴の件数と書き換えの回数 (`MessageHistory.getRevision()`。 書き換え理由を申告するたびに増える) を `lastMainCall` に残す。
  次の測定で、 同じ履歴オブジェクト・同じ書き換えの回数なら、 実数 + 送った後に足したもの (送った直後の assistant はその呼び出しの出力なので除く)
  の送る形の推定。 間に書き換え・履歴の載せ替え (`restoreSession` / `importConversation`) があった、 usage が無かったときは全体の推定。
  これから添付する状態通知は数えない (小さいので余白 M で吸収する)。
- 本体呼び出しの送り方は `buildMainCallRequest(toolDefs, signal)` の 1 つにまとめ、 本体呼び出しと要約の呼び出しが同じものを使う。
- `RequestGrowthTracker` は AgentLoop に 1 つ持つ。 依頼の始まり・本体呼び出し・依頼の終わり・セッションへの保存の組み込みはタスク 8 (§4.5)。

**外した旧経路の呼び出し** (本体はタスク 8 で削除済み。 §6.5): 反復の先頭の `runContextStrategy(true)` (区切りでの整理) と
`contextManager.shouldReduce() → reduce()` (割合の閾値での整理)、 依頼の終わり (`run()` の finally) の `runSpanEndStrategy()`。
使われなくなった AgentLoop の `runContextStrategy` / `runSpanEndStrategy` / `confirmClear` / `reportStrategyOutcome` / `printHandoffNote` /
`lastSpanEndReason` / `lastCompletionType` は消した (tsc の未使用の検査に掛かるため)。 区切りの検出 (`queueBreak` と ToDo・git commit・
話題の切り替わりの検出) は規則 2 の作り直しまで残し、 待ち行列は依頼の始まりで捨てる。 `ContextManager.shouldReduce` / `reduce` /
`applyStrategy`、 `ContextStrategy`、 `ForgettingEngine`、 `HierarchicalCompressor` は手動コマンド (`/compact` / `/forget` / `/handoff` /
`/context strategy`) からだけ使われている (タスク 8・10 で消す・作り直す)。

**借りの延期** (§6.2): `purgeEphemeralAtSpanEnd` は `recordSpanEnd(reason)` に名前を変え、 終わり方 (task_complete の outcome) の記録だけにした。
借りは履歴そのもの (揮発の印と思考) に残るので別に控えない。 応答の終わりで履歴を書き換えていた経路は、 これと `runSpanEndStrategy` の 2 つで、
どちらも無くなった (grep で確認。 残る書き換えは手動コマンド・システムプロンプトの更新・`/clear`)。
- **表示済みの応答**: 以前は揮発の印を付けておき、 応答の終わりに `promoteDisplayedEphemeral()` で外していた。 応答の終わりの片付けが無くなったので、
  `addAssistantMessage(..., { ephemeral: true, displayed: true })` は最初から印を付けない (同じ結果。 保存・再開で「表示済み」 の控えを持たなくてよい)。
  `promoteDisplayedEphemeral` と表示済みの WeakSet は消した。
- **揮発の印** は WeakSet から `Message.ephemeral` (内部専用の欄) に移した。 `toSentMessage()` が送る前に外す (`getMessages()` と送る形の推定)。
  `MessageHistory.purgeEphemeral()` / `isEphemeral()` と WeakSet は消した。 段階 0〜3 の入力の `isEphemeral` も無くし、 `m.ephemeral` を見る。
- **保存・再開**: 印は Message の欄なのでセッションの JSON に乗る。 `restoreSession` は揮発の印と思考 (`thinking`) を戻すようにした
  (以前は思考を捨てていた。 思考も次の整理イベントで返す借りなので戻す)。 状態通知 (`contextNote`) は以前どおり戻さない (再開後の最初の送信で出し直す)。
- `MessageHistory.replaceMessages(next, reason = "replace")` は書き換え理由を受け取る (整理イベントは `reduction:<id>`、 旧経路の忘却は既定の `replace`)。
  `clearAllThinking()` は旧経路の忘却 (`forgetThinking`) だけが使う。
- 要約の後の渡し直しの預かりは、 タスク 8 でセッションに保存するようにした (§5.8 の 5)。

試験: `tests/agent/reduction-event.test.ts` (要約なし・あり、 失敗で履歴が元のまま、 書き換え理由、 記録の欄、 忘却の記録の追記、 前処理の返済、
G への足し戻し、 揮発の印の保存・復元と送る形から外れること、 規則 1 の失敗で本体を呼ばないこと)、 `tests/agent/prompt-prefix-invariant.test.ts`
(台本 provider で 4 件の依頼を回し、 起動時検査の最小 + 2,000 の W で規則 1 を起こす。 要約なし・ありの 2 通りで、 直前の送信を先頭に含まない送信が
整理イベントの直後の送信とちょうど一致し、 揮発メッセージと思考が残る依頼の境目では外れない)。

### 6.5 旧経路の削除 (タスク 8、 2026-10-25)

削除したもの:
- ファイル: `src/agent/context-strategy.ts` (区切りの決定表 `USAGE_BANDS` / `decideAction` / ガード / `ContextStrategy`)、
  `src/agent/forgetting.ts` (`ForgettingEngine` = LLM に忘却を選ばせる経路、 `forgetThinking`、 `buildSegments` 等)、
  `src/agent/hierarchical-compressor.ts`、 `src/agent/context-manager.ts` (`reduce()` の compress / forget / hybrid、 `applyStrategy`、
  割合の閾値 `shouldReduce` / `shouldCompress`、 区切りでの自動リセット (自動の clear))、 `src/cli/commands/forget.ts` (`/forget` 一式)。
  試験の `context-strategy.test.ts` / `forgetting.test.ts` / `context-manager-failure-policy.test.ts` / `hierarchical-compressor-failure.test.ts`。
- `MessageHistory.clearAllThinking()` と `replaceOlderMessages()` (使う所が無くなった)。 `CapabilityProfile` / `CapabilityOverride` の
  `compressionThreshold` と `keepRecentMessages`。 脇の呼び出しの目的 `forget-select`。 `/context strategy` (REPL と補完)。
  AgentLoop の `forceCompress` / `forceForget` / `forgetDryRun` / `setReductionMode` / `getReductionMode` / `getLastForgetResult` /
  `getStrategyMode` / `setStrategyMode` / `getStrategyDecisions` / `getContextUsageRatio`。 `/context` の「自動縮約の手段」 の行。
- 設定の型 `ReductionMode` / `ForgettingConfig` / `ContextStrategyMode` / `ContextStrategyConfig` と、 既定値の `context.reduction` / `context.strategy`。
  旧キーを読むコードは無い (キーの削除・移行はタスク 11)。 config のスキーマ検証 (`sanitizeParsedConfig`) は未知のキーを残したまま
  警告しない作り (`z.object` の既定) なので、 タスク 11 までの間、 旧キーは黙って読まれないだけになる (警告は出ない。 試験で固定)。
  `modelCapabilities.<id>.compressionThreshold` / `keepRecentMessages` も読まないが、 上書きの取り込み (`applyOverride`) は欄を丸ごと
  広げるので、 プロファイルの中に使われない欄として残る (どこも読まない)。
- 共通の部分は新側に残した: `transformToolBatch` / `[忘却済み]` の文面 / `TOMBSTONE_MARKER` / `insertTombstone` (`reduction-stages.ts`。 タスク 5・7 で移動済み)。
  `insertTombstone` と `replaceMessages` の対の検証の試験は `reduction-stages.test.ts` / `message-history.test.ts` に移した。

手動コマンドの付け替え (タスク 10 の前倒し・最小限): `/compact` は `AgentLoop.runReductionEvent("manual")` を呼ぶ (結果は整理イベントの 1 行)。
`/handoff` は `runHandoff` (`handoff.ts`) を直接呼ぶ (`AgentLoop.runHandoffNow` の戻り値は `HandoffResult`。 使用率の表示はやめた)。

Goal 昇格の提案 (`maybePromoteToGoal`。 REPL / Slack / Discord が `run()` の前に呼ぶ脇の呼び出し) は、 最初に `AgentLoop.checkUserInput`
(`run()` の最初の入力の検査と同じ関数) を呼び、 入らない入力なら提案しない (脇の呼び出しを送らない)。 断りの表示は `run()` が行う。

検証の grep (2026-10-25):
`grep -rnE "ContextStrategy|context-strategy\.js|USAGE_BANDS|decideAction|ForgettingEngine|forgetting\.js|forget-select|HierarchicalCompressor|hierarchical-compressor|ContextManager|context-manager\.js|shouldReduce|shouldCompress|applyStrategy|compressionThreshold|keepRecentMessages|clearAllThinking|replaceOlderMessages|queueBreak|forceCompress|forceForget|forgetDryRun|setReductionMode|ReductionMode|ForgettingConfig|ContextStrategyMode|strategy\.mode|context\.reduction|maybeDetectCommitBreak|detectTopicSwitch" src tests`
→ 3 件だけ (`capability-tier.ts` のコメント「旧 keepRecentMessages を置き換えた」、 `config-schema.test.ts` の旧キーが警告されないことの試験データ 2 件)。

---

## 7. 手動コマンド

| コマンド | 新しい動き |
|---|---|
| `/compact` | **手動の整理はこの 1 つだけ** (2026-10-25 利用者と決定)。 整理イベントを今すぐ行い、 段階 0〜3 を最後まで進める。 終わったら予熱する。 タスク 8 で `runReductionEvent("manual")` に付け替え済み (表示・予熱はタスク 9・10) |
| `/context` | 内訳表示に加えて、 P (実数か推定か)、 R の内訳、 規則 1・2 の発火点、 G と直近 3 件、 直近の整理イベント、 今 `/compact` した場合の段階ごとの減る量の見込みを表示 |
| `/forget` | **削除** (LLM に選ばせる忘却が無くなるため。 決まった段階は `/compact` に含まれる)。 タスク 8 で削除済み |
| `/forget mode` / `/forget status` / `/forget dry` | 削除 |
| `/context strategy` | 削除 (区切りの決定表が無くなるため)。 タスク 8 で削除済み |
| `/handoff` / `/clear` | 変更なし (手動のリセット。 整理とは別の機能) |

自動の `clear` (区切りで引き継ぎメモを作ってリセット) も廃止する。 リセットは利用者が `/handoff` で決める (タスク 8 で削除済み)。

---

## 8. モデルに残量を伝えない理由

- 訓練されていないローカルモデルに残量を見せると、 「急いで終わらせる」「考えを浅くする」「途中で完了を宣言する」
  といった振る舞い (残量への不安) を招く恐れがある。 得をする場面が思い当たらない。
- 残量の管理はハーネスが黙って行う。 整理の後の続きやすさは、 要約の型 (§5.6) と状態の渡し直しで支える。
- 現状も system プロンプト・ツールの案内・状態通知に残量は書いていない (`system-prompt.ts` / `tool-guides.ts` を確認済み)。
  新しく足さないことを決まりとして本書に残す。 `/context` の表示は利用者向けだけ。

---

## 9. 予熱

### 9.1 いつ送るか

- 依頼の境目 (規則 2 の「依頼の終わり」) で整理したとき
- `/compact` の後
- セッションを再開したとき (再開直後はキャッシュが無い)

規則 1 (作業の途中) の整理では送らない (すぐ本体を呼ぶので意味がない)。

### 9.2 送り方

- 次の本体呼び出しと **同じ並び** (`getMessages()` と同じツール定義・同じサンプリング以外の設定) を、
  出力上限 1 (`max_tokens: 1`) で送る。 結果は捨てる。 次の本体呼び出しはこの並びの末尾に発話と状態通知を足すだけなので、
  前方一致する。
- llama.cpp の `/completion` の `n_predict: 0` は読み込みだけで返すとされるが、 チャットのテンプレートを通らないので
  並びが一致する保証がない。 OpenAI 互換の `/v1/chat/completions` + `max_tokens: 1` を使う。
- 出力した 1 トークンの分だけ次の呼び出しとずれる。 混成モデルではプロンプト末尾近くの保存点に戻れれば再利用できる。
  実測 (2026-10-25、 前方一致の修正後の 11 回) では、 再利用数が毎回ちょうど「前回の入力 − 4」 だった。
  末尾の生成開始部分 (`<|im_start|>assistant\n<think>\n`) の手前の保存点に戻れているということで、
  予熱の並びの末尾に次の依頼を足す形でも同じく効く見込みが高い。 最終確認は次の本体呼び出しの `tokensCached` で行う。
- 予熱中に利用者が送信したら、 本体呼び出しは予熱の終了を待ってから送る (切断するとそれまでの読み込みが無駄になる恐れ)。
  Esc での中断は予熱も切る。
- スロットが 1 つなので、 予熱中に脇の呼び出しを送らない (送ると予熱した中身を追い出す)。

---

## 10. 計測

### 10.1 整理イベントの記録 (`reduction_event`)

セッションログ (`~/.localllm/logs/sessions/<sid>_main.jsonl`) に 1 件:
`id`、 発火 (`forced` / `boundary:<種類>` / `manual`)、 整理前の P (実数か推定か)、 目標、 最低量、
到達した段階、 段階ごとの減った量 (前処理・0・1・2・3)、 返した借り (揮発 N 件・思考 N 件)、 整理後の P (推定)、
段階 3 の要約呼び出しの `tokensIn` / `tokensCached` / `tokensOut` / 所要時間、 予熱の有無と所要時間。
実装の欄の名前と形は §6.4 (タスク 7)。

### 10.2 キャッシュが外れた原因の特定 (`cache_miss`)

本体呼び出しの応答で `tokensCached` が「前回の本体呼び出しの P − 4,096」 を下回ったら記録する。
原因の欄には、 前回の本体呼び出しからの間に起きたことを入れる:
整理イベントの id、 `prefix_break` の理由 (`message-history.ts` の書き換え理由)、 脇の呼び出しの目的の一覧。
何も無ければ `unknown`。 整理イベントの直後の外れは想定どおりなので `expected: true` を付ける。

実装 (タスク 1、 2026-10-25):
- 判定と原因の特定は純粋な関数 `diagnoseCacheMiss()` (`src/agent/cache-miss.ts`)。 P は前回の本体呼び出しの入力の全体
  (Anthropic 系はキャッシュ分を足した値)。 前回の usage が無い・今回 `cachedTokens` が無いときは判定しない。
- 「間に起きたこと」 は AgentLoop が持つ `CacheMissCauseCollector` にためる。 本体の送信のたびに
  `take(history.takeRewriteReasons())` で取り出し (接続の再試行で送り直したときは合わせる)、 その応答で判定する。
- **整理イベントの id を渡す口**: 整理イベント (タスク 7) は `MessageHistory.replaceMessages()` の直後に
  `this.cacheMissCauses.noteReductionEvent(<イベント id>)` を呼ぶ。 これで次の本体呼び出しの外れが `expected: true` になる。
- ログの形 (`<sid>_main.jsonl`):
  `{"type":"cache_miss","turn":12,"previousPromptTokens":150000,"promptTokens":151200,"tokensCached":0,"causes":["reduction:r-3","prefix_break:reduction:r-3","side_call:intent"],"expected":true}`。
  `causes` は `reduction:<id>` / `prefix_break:<書き換え理由>` / `side_call:<目的>` の並び (同じものは 1 つ)、 何も無ければ `["unknown"]`。

### 10.3 脇の呼び出しの目的タグ (`side_call`)

脇の呼び出しはすべて 1 つの入口 (目的タグを必須にした関数) を通し、 目的・`tokensIn`・`tokensCached`・所要時間を記録する。
目的: `summarize` / `intent` / `completion` / `progress` / `goal-promotion` / `handoff` / `prewarm` / `subagent`
(サブエージェントは別の文脈で何度も呼ぶため、 スロットが 1 つなら戻った後のメイン呼び出しが全部の読み直しになる。 影響が最も大きい見込み)。

実装 (タスク 1、 2026-10-25):
- 入口は `sideCall(目的, provider, { method: "chat" | "chatWithTools" | "chatWithVision", params })` (`src/agent/side-call.ts`)。
  provider の応答をそのまま流し、 終わったとき (正常・失敗・途中で読むのをやめた) に 1 件だけ記録する。
  本体の会話ループ (`agent-loop.ts` の本体呼び出し) 以外で provider の chat 系を直接呼ばない。
- 記録先は AgentLoop が生成時に `setSideCallSink()` で登録し、 メインのセッションログに書く (サブエージェント・セカンド LLM の分も)。
  ログの形: `{"type":"side_call","turn":12,"purpose":"intent","model":"…","providerType":"llamacpp","tokensIn":812,"tokensOut":9,"tokensCached":0,"durationMs":1530,"finishReason":"stop"}`
  (失敗・中断なら `error`)。 `turn` は直前の本体呼び出しの番号。
- 目的は上の 8 つに、 実在する呼び出し元に合わせて次の 4 つを足した:
  `compress-instructions` (プロジェクト指示・メモの圧縮 `compress-text.ts`)、 ~~`forget-select` (忘却の LLM 選択 `forgetting.ts`)~~ (タスク 8 で削除済み)、
  `second-llm` (セカンド LLM の相談・委任・評価 `second-llm-manager.ts`)、 `vision` (画像解析 `vision.ts`)。
  呼び出し元と目的: `intent-classifier.ts` (intent / completion)、 `progress-judge.ts` (progress)、 `goal-promotion.ts` (goal-promotion)、
  `handoff.ts` (handoff)、 `reduction-summary.ts` (summarize。 旧 `hierarchical-compressor.ts` はタスク 8 で削除済み)、 `sub-agent.ts` (subagent)。
  `prewarm` はタスク 9 で使う。

本節の計測は [todo-local-llm-speed.md](todo-local-llm-speed.md) の T1 を兼ねる。 同書の T4 (依頼の区切りでの書き換え) は本書 §6.2 で扱う。

脇の呼び出しがキャッシュを追い出すと分かった場合の後続候補 (今回は作らない):
- 脇の呼び出しを 2 台目の LLM (既存の named slot) へ回す
- サーバのスロットを 2 つにし、 `id_slot` で本体と脇を分ける
- llama.cpp のホスト側プロンプトキャッシュ (RAM に状態を退避・復元する機能。 版により有無が違う。 要確認) を使う

---

## 11. 設定の変更

### 11.1 削除するキー

| キー | 理由 |
|---|---|
| `context.reduction` (compress / forget / hybrid) | やり方は段階の 1 つだけ |
| `context.forgetting.keepRecentSegments` / `targetMarginRatio` / `sufficiencyRatio` / `minIntervalTurns` | LLM に選ばせる忘却・割合の目標・最短間隔の廃止 |
| `context.strategy.mode` / `minIntervalTurns` | 区切りの決定表の廃止 (強い区切りの規則は固定) |
| `modelCapabilities.<id>.compressionThreshold` | 割合の閾値の廃止 |
| `modelCapabilities.<id>.keepRecentMessages` | `keepRecentToolUses` (ティア既定値) に置き換え |

### 11.2 既存の設定の 1 回だけの扱い

権限ルールへの移行 (`config-manager.ts:51`、 `permission-migration.ts`) と同じやり方にする。

- 起動時に上のキーがあれば、 書き換え前の設定をバックアップしてから削除して保存する。 2 回目以降はキーが無いので何もしない。
- 1 回だけ告知する: 「コンテキスト整理の方式を 1 つにしたため、 次の設定を削除しました: …。
  整理を早めたい場合は contextWindow を小さくしてください」。
- 値の読み替えはしない (対応する設定が無い)。 `compressionThreshold` を下げていた人には上の告知が答えになる。
- スキーマ検証 (`sanitizeParsedConfig`) が未知のキーとして警告する前に処理する。
  (タスク 8 で確認: 今の検証は未知のキーを警告せずに残すので、 旧キーはタスク 11 まで黙って読まれないだけになる。 §6.5)

### 11.3 足すキー

| キー | 値 | 既定 | 意味 |
|---|---|---|---|
| `context.summaryFailure` | `"continue"` \| `"stop"` | `"continue"` | 段階 3 の要約に失敗したときの扱い (§6.1。 2026-10-25 利用者の決定)。 規則 1・規則 2・`/compact` の全部に効く |

実装 (タスク 8): 型 `SummaryFailurePolicy` と既定値 `DEFAULT_SUMMARY_FAILURE_POLICY` (`config/types.ts`。 `getDefaultConfig` と読み出しの両方がこれを使う)。
スキーマ (`config-schema.ts`) は `context.summaryFailure` を `continue` / `stop` に限り、 それ以外は既存の仕組みどおり警告して取り除く (= 既定値)。
AgentLoop は整理イベントのたびに `loadConfig()` から読む (変更は次の整理から効く)。 変更するコマンドは作らない (config.json を直接書く)。 文書 (`config-reference.md`) への記載はタスク 12。

---

## 12. 既存設計書との関係

| 文書 | 扱い |
|---|---|
| `docs/context-forgetting.md` | 実装後は記録扱い。 先頭に「現行は context-reduction-redesign.md」 の注記。 §3.1 (呼び出しを残す・本文ありの扱い・切り詰めて残さない) と §4.4 (忘却の記録) は本書の段階 0・1 が引き継ぐ |
| `docs/context-strategy.md` | 実装後は記録扱い。 先頭に同じ注記。 区切りの検出 (§3) のうち強い区切りだけを本書 §4.4 が引き継ぐ |
| `docs/context-intelligence.md` | 圧縮 (B 節) は記録扱い。 意図の分類 (A 節) は変わらない |
| `docs/ephemeral-context-design.md` | 揮発の印の考えは残る。 除く時期を「応答のたび」 から「整理イベント」 に変える旨を追記 |
| `docs/prompt-prefix-stability.md` | 前提として残る。 §2.3 の「span 境界の除去は依頼 1 件につき 1 回なので許容」 を本書で改めた旨を追記 |
| `docs/context-reduction-reasoning-model-fix.md` | 思考オフで呼ぶ知見は段階 3 が引き継ぐ |
| `docs/README.md` | 本書を `design` で登録。 実装後に `implemented` に変え、 上の 2 書を `superseded` にする |

---

## 13. 実装タスク分割

各タスクの完了時に `npm run lint` / `npm run test:coverage` を通し、 区切りごとに main へ push する。

| # | タスク | 受け入れ条件 | テスト |
|---|---|---|---|
| 1 | 計測の土台: 脇の呼び出しの入口と目的タグ、 `side_call` / `cache_miss` の記録 | 既存の脇の呼び出しが全部入口を通る。 ログに目的が出る | 原因の特定 (整理・書き換え理由・脇の呼び出し・不明) の単体テスト |
| 2 | 実機で脇の呼び出しの影響を測る (llama.cpp) | 意図の分類などの直後の本体呼び出しの `tokensCached` を記録した表 | 手動 (結果を本書 §10.3 に追記) |
| 3 | 予算の計算 (新モジュール): P の求め方、 R、 規則 1・2、 G の測定と保存、 起動時検査 | 256K / 1M の例 (§4.7) の数字を再現 | 数値の単体テスト。 実数が無いときの推定。 G の頭打ち |
| 4 | 1 回で増える量の上限: 本体呼び出しに O を渡す、 ツール結果の合計 T、 利用者入力の検査 | 1 回の応答で T を超えない。 O が送られている | 複数ツールの合計切り詰め。 provider に `max_tokens` が載る |
| 5 | 段階 0〜2 と前処理 (写しに適用し、 減る量を返す純粋な関数) | 規則ごとに対象・非対象が設計どおり。 保護部分に触れない | 0-a〜0-d、 段階 1 の本文ありの扱い、 段階 2 の直近 3 件、 停止条件、 ツールの対の検証 |
| 6 | 段階 3: キャッシュ済みの並び + 指示での要約、 要約の型、 状態の渡し直し | 要約の呼び出しが前回の本体呼び出しをそのまま先頭に含む | 台本 provider で前方一致を検証。 型の 8 見出し。 利用者の発言が原文のまま残ること。 ツール呼び出しが返ったときの再送 |
| 7 | 1 回の書き換え: イベントの流れ、 借りの延期、 `Message.ephemeral` の保存 | 応答の終わりで履歴が書き換わらない | **前方一致テストの拡張**: 台本 provider で AgentLoop を複数の依頼にわたって回し、 小さい W で規則 1 を起こす。 「直前の送信を先頭に含まない送信」 がイベントごとにちょうど 1 回で、 揮発メッセージ・思考がある依頼の境目では 0 回 |
| 8 | AgentLoop への組み込み: 規則 1 を本体呼び出しの直前に、 規則 2 を依頼の終わり・ToDo 全完了・Goal 達成に。 `ContextStrategy` の自動経路、 `ForgettingEngine` の LLM 経路、 `reduce()` の 3 方式、 `HierarchicalCompressor` を削除 | 旧経路が残っていない (grep で確認) | 既存の `context-strategy.test.ts` / `forgetting.test.ts` / `context-manager-failure-policy.test.ts` を新仕様に置き換え (**済み**: `reduction-boundary.test.ts` ほか。 §4.4 / §6.5) |
| 9 | 予熱 | 依頼の境目の整理・`/compact`・再開の後に 1 回送る。 予熱中の送信は終了を待つ | 台本 provider で予熱の並びが次の本体呼び出しの先頭と一致 |
| 10 | コマンド: `/compact` / `/context` の表示 (見込みを含む)、 `/forget` 一式と `/context strategy` の削除 | 補完・help から消える (レジストリ方式) | コマンドの単体テスト |
| 11 | 設定: キー削除と 1 回だけの扱い、 告知、 バックアップ | 2 回目の起動で何もしない | 移行の単体テスト (`permission-migration` のテストに倣う) |
| 12 | 文書: README、 `config-reference.md`、 `external_design.md` / `internal_design.md`、 §12 の注記、 索引の Status | 設計書と実装が一致 | — |
| 13 | 実機確認: 予熱後の `tokensCached`、 20 万超の読み込み速度、 整理イベントの記録 | 結果を本書に追記 | 手動 (TTY) |

---

## 14. リスクと未決事項

### 14.1 リスク

| リスク | 対策 |
|---|---|
| 1M の枠では 1 回の整理の読み直しが 2 時間近い | 利用者に contextWindow を下げることを勧める (§4.7)。 計測で実際の時間を出す |
| 出力上限 O で長い思考が途中で切れる | 既存の「続きを出力」 で続ける。 思考だけで切れて本文が空の場合は既存の空応答の扱い。 頻度を計測する |
| 揮発メッセージ・古い思考が次の依頼にも見える | 整理イベントで必ず除く。 実害 (前の催促に引きずられる) が出たら §14.2 の 3 を再検討 |
| 段階 0 の規則の誤判定で必要な結果を消す | 条件を慎重側に倒し、 呼び出しは残す (読み直せば取れる)。 消したものは忘却の記録に必ず書く |
| 要約の呼び出しでモデルがツールを呼ぶ | 1 回だけ再送し、 だめなら失敗を報告。 規則 1 の発火中なら本体を呼ばずに止める |
| 予熱の 1 トークン分のずれでキャッシュが使えない | 実測から効く見込みが高い (§9.2)。 実機で確かめ、 使えなければ予熱を外す (別のやり方を足さない) |
| 推定 (文字数ベース) が実際より小さい | 実数を優先して使う。 余白 M を置く。 `cache_miss` と同じく推定と実数の差を記録する |

### 14.2 決定事項 (2026-10-25 利用者と確認)

| # | 事項 | 決定 |
|---|---|---|
| 1 | contextWindow 1M の扱い | 下げない (§4.7) |
| 2 | 段階 0〜2 | 毎回最後まで行う。 要約だけ目標に届かないとき (§5) |
| 3 | 揮発メッセージが依頼をまたいで残る | 許容。 整理イベントで除く (§6.2) |
| 4 | 手動コマンド | `/compact` の 1 つだけ (段階 0〜3 を最後まで)。 `/forget` 一式と `/compact dry` は無し。 見込みは `/context` に表示 (§7) |
| 5 | 区切りでの自動リセット (引き継ぎメモを作って履歴を全部消す) | 廃止。 手動の `/handoff` だけ残す (§7) |
| 6 | 出力上限 O・ツール結果の合計上限 T | T1・T2 とも O=32,768 / T=24,576 (§4.2) |
| 7 | 利用者の発言 | どの段階でも原文のまま残し、 要約しない (§5.1, §5.6) |
| 8 | 補助呼び出し・サブエージェントによるキャッシュの追い出し | 本書では計測まで。 振り分けは todo-local-llm-speed.md T2/T3 (§3 非目標) |
| 9 | 段階 3 の要約に失敗したとき | 設定 `context.summaryFailure` で選ぶ。 既定 `continue` (失敗を画面と記録に出して段階 0〜2 だけで差し替え。 規則 1 で入らなければ止める)、 `stop` は履歴を変えずに失敗 (§6.1 / §11.3) |

### 14.3 残る未決事項 (実装中に決めて本書に追記する)

- G の既定値 (80,000)・直近 3 件の最大・`(W − R) ÷ 2` の頭打ち (§4.5)。 計測で見直す。
  (タスク 3 で決めたこと: 頭打ちは既定値にもかける。 実数の無い依頼は記録しない。 中断で終わった依頼もそこまでを記録する。 F の G ÷ 2 は切り捨て)
- 最低量 F = max(32,768, G ÷ 2) (§4.6)
- ~~起動時検査の 1 件の上限を全角の最悪値で数えると、 200K 枠の T1 などが起動できない (§6.3)~~
  → 解決 (2026-10-25 利用者の決定、 タスク 4): 1 件の切り詰めをトークン数基準 (T1=8,192 / T2=5,120 / T3=2,048) にし、
  起動時検査も同じ値をそのまま使う。 固定部分 11k で T1 は 200K、 T2 は 128K、 T3 は 64K の枠で起動できる。 全角の多い結果は以前より短く切られる (許容済み)
- ツール結果の合計の最低量 256 トークンと、 書き込み系を切らないことで T を少し超えうる分 (§4.3) が余白 M に収まるか。 計測で見直す
- 保護するツールの一覧と、 `file_edit` だけでは前の `file_read` を古いとみなさない規則 (§5.1, §5.3)
  (タスク 5 で決めたこと: 一覧は ask_user / todo_append / todo_mark / todo_delete / enter_plan_mode / exit_plan_mode / response_complete。
  file_edit の規則は案のまま実装。 実機で読み直しの繰り返しが出ないかを見る)
- 今の依頼の思考を何件残すか (案: 直近 3 件。 §5.5。 タスク 5 は 3 件で実装 `KEEP_RECENT_THINKING`)
- ~~要約を利用者の発言ごとの区間に置くときの置き方 (§5.6)~~
  → タスク 6 で決定: 区間の位置に assistant メッセージ (`<summary-of-earlier-turns>` で囲み、 返答の手本ではないと明記) として置く。
  出力は区間ごとの短い要約 + 全体 1 つの 8 見出し (最後の区間に付ける)。 理由は §5.8。 実機で真似 (返答に同じ囲みを書く) が出ないかを見る
- 段階 3 の要約の出力上限は `min(O, W − P − 指示 − M)` (§5.8)。 規則 1 の発火時は S − 指示 (T1・T2 で約 5k、 T3 で約 2k) しか残らず、
  思考オン (既定) では思考だけで使い切る恐れがある (`length` で失敗として返す)。 実機の要約の思考の長さを測り、 足りなければ S を見直す
- 範囲を決めるときの要約の大きさの見込み (区間ごと 256・全体 3,072 トークン)。 実際の大きさで見直す
- git commit を弱い区切りにすること (§4.4。 タスク 8 で検出ごと削除した。 強い区切りにするなら検出を作り直す)
- ToDo が残ったまま終わった依頼の次の発言で「新しい依頼」 の判定をしないこと (§4.4 の実装。 タスク 8 で決めた)
