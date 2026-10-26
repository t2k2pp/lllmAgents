# サーバに合わせて動く (枠・スロット・モデルの自動の把握と、 脇の呼び出しの振り分け) 設計書

> **ステータス**: design (2026-10-26 設計。 未実装)
> **前提**: [context-reduction-redesign.md](context-reduction-redesign.md) (予約 R・規則 1/2・段階 3 の要約・先読み・計測) と
> [prompt-prefix-stability.md](prompt-prefix-stability.md) (送った並びは書き換えない)。
> **引き継ぐ計画**: [todo-local-llm-speed.md](todo-local-llm-speed.md) の T2 (脇の呼び出しの振り分け)・T3 (サーバの構成の把握)・T6 (2 スロットでの起動)。
> **方針の合意**: 2026-10-26 利用者と合意 (§3 の 1〜4)。

---

## 1. 背景と実測

### 1.1 利用者のサーバ (2026-10-26 に `GET /props` と `GET /slots` で確かめた)

| 項目 | 値 | どこから |
|---|---|---|
| サーバ | llama.cpp `llama-server`、 `build_info: b302-250b61446` | `/props` |
| モデル | `/home/osia/llama.cpp/models/Qwen3.8-27B/Qwen3.8-27B-Q8_0.gguf` (`model_alias` も同じ文字列。 `model_ftype: Q8_0`) | `/props` |
| スロット数 | `total_slots: 2` | `/props` |
| 1 スロットあたりの枠 | `default_generation_settings.n_ctx: 262144` | `/props` |
| 各スロット | `[{id:0, n_ctx:262144, is_processing:false}, {id:1, n_ctx:262144, is_processing:true, n_prompt_tokens:63242, n_prompt_tokens_cache:60239, …}]` | `/slots` |
| 画像 | `modalities: {vision:true, video:true, audio:false}` | `/props` |
| 見えないもの | `--cache-ram` の大きさ・`--kv-unified` の有無・`--ctx-checkpoints` の数・起動時刻 | `/props` の欄に無い (§6.4) |

- 利用者の設定 `mainLLM.contextWindow` は 1,048,576 のままで、 サーバの 1 スロットあたりの枠 262,144 の 4 倍になっていた。
  いまの起動の決め方 (§2.1) では設定の値がそのまま使われ、 予約 R・規則 1/2 (context-reduction-redesign.md §4) は 1M を前提に動く。
  実際には 262,144 を超えた時点でサーバがエラーを返す。 つまり **整理が間に合わず、 サーバのエラーで止まる** ずれが黙って起きうる。
- `/slots` で、 使っていないスロット (id 0) は `id` / `n_ctx` / `speculative` / `is_processing` だけを返し、
  処理中のスロットはプロンプトの数 (`n_prompt_tokens` / `n_prompt_tokens_processed` / `n_prompt_tokens_cache`) と `params` も返した。

### 1.1.1 利用者のサーバの起動のしかた (2026-10-26 利用者から `start.sh` を受け取って読んだ)

利用者は起動のたびに対話式のスクリプト (`start.sh`。 利用者の非公開リポジトリ) で引数を選ぶ。 **起動の引数は固定ではないので、
本書は特定の値を前提にしない** (見えるものは `/props` から読み、 見えないものは計測の結果で判断する。 §11 U6)。 読んで分かったこと:

- 選ぶもの: モデル (番号ごとに既定のポートが違う。 例: Qwen3.8-27B は 9190、 Muse-Glimmer-30B は 9084)・全体の枠 `-c` (32K〜1M)・
  スロット数 `--parallel` (1 / 2 / 4 / 8 / 16)・`--cache-ram` (既定 8GB。 0 で無効。 GPU の VRAM に置く独自版もある)・思考の強さ
  (`--reasoning-effort` / `--reasoning-budget`)・サーバ側の出力上限 `-n` (既定は無制限 -1)。
- `--kv-unified` と `--ctx-checkpoints` は渡していない (llama.cpp の既定のまま)。 `--parallel` を明示しているので、 1 スロットあたりの枠は
  `-c ÷ --parallel` で、 `/props` の `n_ctx` と一致する (2026-10-26 の実機は `-c 524288 --parallel 2` と推定される)。
- サーバ側の出力上限の既定が無制限なので、 アプリが本体呼び出しに渡す出力上限 O (context-reduction-redesign.md §4.2) が生成の暴走の
  唯一の歯止めになっている。
- 0 番のモデルは llama.cpp ではない別のサーバ (`serve llm -j <スロット数>`) で動く。 `/props` を返さないことがありうるので、 返さないときの扱い
  (§5 の「読めなかったとき」) がこの構成で実際に効く。
- `--cache-ram` に退避した状態から戻せるなら、 スロットが 1 つでもサブエージェントの後に本体のキャッシュが残りうる。 API では見えないので、
  サブエージェントの直後の本体呼び出しの `tokensCached` で判断する (§7)。

### 1.2 同じスロットへの脇の呼び出しの費用

- 混成モデル (線形注意 + 通常注意) は途中の位置に巻き戻せないので、 本体の KV キャッシュが一度追い出されると、
  次の本体呼び出しは全部の読み直しになる (prompt-prefix-stability.md §2.2)。 速さは約 130 トークン/秒 (10 万で約 13 分。
  context-reduction-redesign.md §1.2)。
- サブエージェント (`task` ツール。 メインと同じモデル) は別の文脈で何度も呼ぶので、 同じスロットなら戻った後の本体呼び出しが確実に全部の読み直しになる。
  意図の分類・進み具合の判定などの短い脇の呼び出しも、 同じスロットに入れば同じことが起きる (未測定。 context-reduction-redesign.md §14.3 B4)。
- 道具の一覧 (tools) はプロンプトの前方の一部なので、 会話の途中で増減するとキャッシュが全部外れる (prompt-prefix-stability.md §2.3)。

---

## 2. 現状 (2026-10-26 の main。 ファイルと行)

### 2.1 枠の決め方

| 箇所 | 内容 |
|---|---|
| `src/index.ts:500-535` | 起動時の contextWindow = 「明示設定 (`config.mainLLM.contextWindow`) > provider の `getModelInfo().contextLength` > モデル名からの推定 (`inferContextLength`)」。 設定に値があると provider に問い合わせない |
| `src/providers/llamacpp.ts:33-60` | `/props` を読み、 `default_generation_settings.n_ctx` を `contextLength` にする (`listModels` / `getModelInfo`)。 `/props` は `propsCache` でプロセス内に 1 回だけ読む (コメント「起動中サーバごとに固定」)。 `total_slots` は型にあるが使っていない |
| `src/agent/agent-loop.ts:503,526` | 生成時に `resolveCapability(model, contextWindow)` と起動時検査 (`assertContextWindowFits`。 context-reduction-redesign.md §6.3) |
| `src/agent/agent-loop.ts:4020-4074` | `setContextWindow` / `setModel` / `setProvider` が段階 (ティア) を再判定し、 起動時検査に通らなければ何も変えずに例外 |
| `src/agent/agent-loop.ts:794-850` | `run()` の始め: 入力の検査 (`checkUserInput`。 W を使う) → 新しい依頼の区切りの判定 (`judgeNewRequestBoundary`) |

### 2.2 段階 (T1/T2/T3) の判定

`src/agent/capability-tier.ts:348` `resolveCapability(modelId, ctxWindow, override)`。 モデル名の完全一致 → パターン → 名前のパラメータ数 (`inferTierFromName`、
`:506`) → 明示の `modelCapabilities.<id>.tier`。 入力のモデル名は `config.mainLLM.model` (サーバの実際のモデルではない)。 **判定の仕方は今回変えない** (§3 非目標)。

### 2.3 脇の呼び出しとサブエージェントの送り先

| 呼び出し | 目的タグ (`side-call.ts`) | 送り先 |
|---|---|---|
| 段階 3 の要約 (`reduction-summary.ts:396`) | summarize | 本体と同じ provider (キャッシュ済みの並びの末尾に指示を足す。 context-reduction-redesign.md §5.6) |
| 先読み (`prewarm.ts:175`) | prewarm | 本体と同じ provider (次の本体呼び出しと同じ並び) |
| 意図の分類・完了の分類 (`intent-classifier.ts:165,206`) | intent / completion | 本体と同じ (`agent-loop.ts:568`) |
| 進み具合の判定 (`progress-judge.ts:143`) | progress | 本体と同じ |
| Goal 昇格 (`goal-promotion.ts:95`) | goal-promotion | 本体と同じ |
| 引き継ぎメモ (`handoff.ts:176`) | handoff | 本体と同じ |
| 指示・メモの圧縮 (`compress-text.ts:67`) | compress-instructions | 本体と同じ (起動時) |
| サブエージェント (`sub-agent.ts:375,385`) | subagent | 明示の modelRef が無ければ本体と同じ provider (`sub-agent.ts:736` `resolveModelFor`) |
| セカンド LLM (`second-llm-manager.ts`) | second-llm | 別の provider (別サーバ) |
| 画像の解析 (`tools/definitions/vision.ts:28`) | vision | vision 用の provider |

- 道具の登録: `task` 一式は無条件に登録 (`index.ts:395-400`)。 `second_llm_agent` はセカンド LLM が使えるときだけ登録 (`index.ts:617-620`)。
  会話中の絞り込みは `getFilteredToolDefs` (`agent-loop.ts:2448`。 plan mode とチャネルだけ)。
- 送る本文: `openai-compat.ts:160-180` が `max_tokens` / `chat_template_kwargs` / `tools` を足す。 スロットを指す欄 (`id_slot`) は送っていない。
- 計測: `side_call` (目的・tokensIn・tokensCached・所要時間)、 `cache_miss` (前回の本体呼び出しとの間に起きたこと) が
  セッションログに出る (context-reduction-redesign.md §10)。 `response` の記録は所要時間 (`durationMs`) を持つが、 読み込みだけの時間は持たない。
  llama.cpp の `timings` は `cache_n` だけ読んでいる (`openai-compat.ts:63,252`)。

---

## 3. 目標と非目標

### 目標

1. **接続先 (host・port) だけでサーバに合わせる** (llama.cpp): 枠・スロット数・モデルをサーバから読み、 段階の判定もやり直す。
   サーバがモデルや設定を替えて起動し直したら気付いて合わせ、 画面に 1 行出す。
2. **llama.cpp ではサーバの値を正とする** (同じことのやり方を 1 つにする)。 設定の contextWindow は「サーバより小さくしたいとき」 だけ効く。
   サーバより大きい値は黙って使わず、 サーバの値に合わせたことを表示する。
3. **脇の呼び出し・サブエージェントがメインの KV キャッシュを追い出さない**: スロットが 2 以上なら別のスロットへ (`id_slot`)。
   スロットが 1 ならセカンド LLM へ、 無ければサブエージェントの道具を出さない。 判定の目安は「全部読み直すと何分かかるか」。
4. **道具の一覧は起動時とモデル切替 (= サーバの入れ替わりを含む) のときだけ変える**。 会話の途中では変えない。
5. `/context` と起動時の表示に、 サーバから読んだ値 (枠・スロット数・モデル) と、 判定した段階とその理由を出す。

### 非目標

- 名前による賢さ (段階) の判定の仕方を変えること (利用者は将来変えたい。 今回は入力のモデル名の出どころだけ扱う。 §5.4)。
- サーバの設定を変えること (`-c` / `--parallel` などは利用者が決める。 dev-workflow スキルの規約)。
- クラウドの provider の動き (今のまま)。
- vLLM / Ollama / LM Studio の自動の把握の実装 (調べた結果だけ §8 に書く。 実装は後のタスク)。
- スロットの保存・復元 (`/slots/{id}?action=save|restore`。 `--slot-save-path` が要る。 todo-local-llm-speed.md T3 の候補のまま)。

---

## 4. 用語と記号

| 記号・語 | 意味 |
|---|---|
| サーバの枠 W_s | `/props` の `default_generation_settings.n_ctx` (1 スロットあたり。 §6.1) |
| 設定の枠 W_c | `mainLLM.contextWindow` (無ければ未設定) |
| 使う枠 W | 本体が使う contextWindow (context-reduction-redesign.md の W) |
| スロット数 N | `/props` の `total_slots` |
| サーバの素性 | `{ model_path, model_alias, build_info, total_slots, n_ctx }` の組。 変わったら「サーバが入れ替わった」 とみなす |
| 読み込みの速さ v | プロンプトの読み込みのトークン/秒 (§7.2 の実測) |
| 読み直し時間 | 全部の読み直しにかかる見込み = トークン数 ÷ v |
| 避ける境目 | 読み直し時間がこれを超えるなら追い出しを避ける。 既定 3 分 (§5.6。 未決 U3) |
| 本体のスロット / 脇のスロット | 本体の呼び出しに使うスロット (0) / それ以外 (1 以上) |

---

## 5. 設計

### 5.1 いつ読むか

| 時 | 読むもの | 何をするか |
|---|---|---|
| 起動時 (`index.ts` の contextWindow を決める所) | `GET /props` | 素性を控え、 W・段階・振り分けを決める (§5.2〜5.5)。 起動の表示に 1 行 (§5.7) |
| 依頼の区切り (`run()` の最初。 `checkUserInput` の前) | `GET /props` | 前の素性と比べる。 同じなら何もしない。 変わっていたら §5.3 |
| `/model host` / `/model port` / `/model provider` / `/model <名前>` (provider の作り直し) | `GET /props` | 新しい接続先として起動時と同じ扱い |
| `/context` | `GET /props` と `GET /slots` | 表示だけ (§5.7)。 素性が変わっていたら表示に出し、 合わせるのは次の依頼の区切り |

- **`/props` は軽い**: サーバのソースでは `/props` の応答は起動時に決まる値 (`params.n_parallel`・`meta.slot_n_ctx` など) を返すだけ
  ([server-context.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp))。
  生成のキューを通るかは実装時に確かめる (通るなら処理中に少し待つことがある)。 待ち時間は 5 秒で打ち切る (今の `httpGet(..., 5000)` と同じ)。
- **`/slots` は依頼の区切りでは読まない**: ソースでは `/slots` は生成のキューに載る処理 (`SERVER_TASK_TYPE_SLOT_GET`) で、
  `--no-slots` で無効にできる ([server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md))。
  使うのは `/context` の表示と、 振り分けの確かめ (§5.5.3) だけ。
- **依頼の途中では読まない**: 依頼の途中で W や段階が変わると、 予約 R・ツール結果の上限が途中で変わる。 区切りでだけ合わせる。
- `LlamaCppProvider.propsCache` (プロセス内に 1 回) はやめ、 「最後に読んだ素性」 として持つ (読み直す口 `refreshServerInfo()` を足す)。

### 5.2 枠の決め方 (llama.cpp)

```
W = W_c があり W_c < W_s なら W_c、 それ以外は W_s
```

- **W_c > W_s** (今の利用者): W_s を使い、 黄色の 1 行を出す。
  `サーバ (192.168.1.201:9190) の 1 スロットあたりの枠は 262,144 トークンです。 設定の contextWindow 1,048,576 はサーバより大きいので、 262,144 で動きます。`
  設定ファイルは書き換えない (利用者の値を勝手に消さない)。 1 行は起動時に 1 回と、 値が変わったときに出す。 記録は §7.1 の `server_info`。
- **W_c < W_s**: W_c を使う (利用者が小さくしたい場合)。 起動の表示に `枠 131,072 (設定。 サーバは 262,144)` と出す。
- **W_c が無い / W_c = W_s**: W_s。
- **`/props` が読めない** (§5.8): 今の決め方 (設定 > `getModelInfo` > 名前からの推定) に戻し、 黄色の 1 行で読めなかったことを出す。
- 起動時検査 (`assertContextWindowFits`) は W で行う。 通らなければ今と同じく起動を止める (サーバの枠が小さすぎるという文に、 サーバの値であることを添える)。
- `index.ts` の「明示設定 > provider」 の順は llama.cpp では「サーバ > 設定 (小さいときだけ)」 に変わる。 他の provider は今のまま。
  決め方を 1 か所 (新しい `resolveMainContextWindow()`) にまとめ、 起動時・依頼の区切り・provider の作り直しが同じ関数を使う。

### 5.3 ずれの扱い (依頼の区切りで素性が変わっていたとき)

| 変わったもの | 意味 | 何をするか |
|---|---|---|
| `model_path` / `model_alias` | モデルを替えて起動し直した | **モデル切替** として扱う: 段階を判定し直し、 W を決め直し、 振り分けと道具の一覧を決め直す (§5.6)。 KV キャッシュはサーバの起動し直しで既に無いので、 道具の一覧を変えても失うものは無い |
| `total_slots` | `--parallel` を替えて起動し直した | 振り分けと道具の一覧を決め直す。 W も決め直す (`--parallel` で 1 スロットあたりの枠が変わる) |
| `n_ctx` だけ | `-c` を替えて起動し直した | W を決め直す。 振り分けの判定 (読み直し時間) もやり直す |
| `build_info` だけ | サーバを更新して起動し直した | 合わせるものは無い。 1 行 (dim) と記録だけ。 `id_slot` の確かめ (§5.5.3) をやり直す |
| どれも同じ | — | 何もしない (表示もしない) |

- 画面に 1 行 (黄色): `サーバが入れ替わっていました (モデル Qwen3.8-27B-Q8_0 → …、 枠 262,144 → 131,072、 スロット 2 → 1)。 合わせました: 段階 T2 (…)、 サブエージェント: 出しません (理由)。`
  変わった欄だけを並べる。 同じ内容を `harness_notice` (info) と `server_info` の記録 (§7.1) にも出す。
- **W が小さくなり、 いまの P が入らなくなったとき**: 区切りの直後の本体呼び出しの前に規則 1 (context-reduction-redesign.md §4.4) が整理する。
  W を変えること自体は書き換えではない (前方一致は崩れない。 サーバの起動し直しでキャッシュは無い)。
- **起動時検査に通らない W になったとき** (サーバの枠が小さすぎる): 何も変えずに (前の W・段階のまま) 赤字の 1 行で知らせ、 依頼を受け付けずに終える
  (outcome error)。 前の W のまま送るとサーバのエラーになるので、 黙って続けない。 直し方 (サーバを大きい枠で起動し直す) を添える。
- **素性が変わったのに履歴が残っている**: 履歴はそのまま (書き換えない)。 キャッシュは無いので次の本体呼び出しは全部の読み直しになる。
  これは `cache_miss` の原因として `server_restart` を足して記録する (§7.1)。
- 段階が変わる (例: T2 → T3) と O / T / M / S / K と 1 件の上限 (context-reduction-redesign.md §4.2) も変わる。 既に履歴にあるツール結果は切り直さない
  (書き換えになるため)。 次の整理で新しい段階の値が使われる。

### 5.4 段階の判定の入力 (モデル名の出どころ)

- 判定の関数 `resolveCapability` はそのまま使う。 入力のモデル名を、 llama.cpp では **サーバの `model_alias` (無ければ `model_path`)** にする。
  今の利用者では `/home/osia/.../Qwen3.8-27B-Q8_0.gguf` で、 パス付きの名前の候補 (`extractModelCandidates`) から今と同じく T2 になる見込み (実装時に試験で固定)。
- `config.mainLLM.model` とサーバのモデル名が違うときは、 起動の表示にどちらも出す (`モデル: Qwen3.8-27B-Q8_0.gguf (サーバ)。 設定の model は "qwen3.8-27b"`)。
  送る `model` 欄は今のまま `config.mainLLM.model` (llama.cpp は 1 モデルのときこの欄を使わない。 ルーターの形で起動したサーバは §8 の未確認)。
- `modelCapabilities.<id>` の上書きは、 サーバのモデル名と設定の model の両方で探す (どちらに書いた人も今のまま効く)。 両方にあれば **未決 U4**。
- 判定の理由 (`capability.reason`) に入力の出どころ (`server` / `config`) を添える。

### 5.5 脇の呼び出し・サブエージェントの振り分け

#### 5.5.1 規則 (llama.cpp)

| 呼び出し | N ≥ 2 | N = 1、 セカンド LLM あり | N = 1、 セカンド LLM なし |
|---|---|---|---|
| 本体 | スロット 0 に固定 (`id_slot: 0`) | 今のまま (`id_slot` を送らない) | 今のまま |
| summarize (段階 3) | **本体と同じスロット 0** (キャッシュ済みの並びの末尾に足すので、 同じスロットでないと意味が無い) | 本体と同じ | 本体と同じ |
| prewarm (先読み) | **本体と同じスロット 0** (先読みした中身を次の本体呼び出しが使う) | 本体と同じ | 本体と同じ |
| subagent (`task`) | 脇のスロット (1 以上。 §5.5.2) | セカンド LLM へ (§5.5.4) | **道具を出さない** (§5.6) |
| intent / completion / progress / goal-promotion | 脇のスロット | 読み直し時間が境目を超えるならセカンド LLM、 超えなければ今のまま (§5.5.5) | 今のまま (計測を続ける。 **未決 U2**) |
| handoff | 脇のスロット | 今のまま (引き継ぎメモの後は履歴を消すので、 キャッシュを守っても使わない) | 今のまま |
| compress-instructions | 脇のスロット | 今のまま (起動時。 本体のキャッシュがまだ無い) | 今のまま |
| second-llm / vision | 別の provider (今のまま) | 同 | 同 |

- 本体をスロット 0 に固定する理由: `id_slot` を送らないと、 サーバは「プロンプトの先頭の一致の割合」 が閾値 (`--slot-prompt-similarity`、 既定 0.10) を超えるスロットを選び、
  無ければ空きか最後に使われたのが最も古いスロットを選ぶ ([server-context.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp) の `get_available_slot`、
  [README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) の `-sps`)。 次の 2 つの理由で、 何もしなくても分かれるとは限らない (todo-local-llm-speed.md T6 の見込みの見直し):
  - サブエージェントの並びは、 先頭がメインと同じ道具の定義 (Qwen 系のテンプレートは道具の定義を system の先頭に描く) なので、
    一致の割合が閾値を超えて **メインのスロットに入りうる** (見込み。 実機で確かめる。 §5.5.3)。
  - 利用者が打っている間 (本体が待っている間) はメインのスロットが「最後に使われたのが古い」 側になり、 一致しない短い呼び出しがそこに入りうる。
- 固定したスロットが処理中なら、 サーバは別のスロットに回さず、 空くまで待たせる (ソースのコメント「a busy slot is returned untouched, the caller defers the task」)。
  よって脇のスロットが塞がっているとき、 脇の呼び出しは待つ (本体のスロットには入らない)。 本体はスロット 0 を自分しか使わないので待たない
  (ほかの利用者・別の測定が同じサーバを使う場合は §5.9)。
- N = 1 では `id_slot` を送らない (0 しか無いので意味が無い)。
- 先読みと本体が別のスロットに入る可能性 (2026-10-26 実機確認で検討): スロットが 2 つのサーバで、 再開の先読みの後の本体呼び出しが全部の読み直しになった。
  この件の原因は並びのずれ (先読みの後に道具を足していた。 context-reduction-redesign.md §9.4) だったが、 `id_slot` を送らない今は、
  先読みと本体が別のスロットに入ることもありうる (先頭の一致の割合で選ぶので、 並びが同じなら同じスロットに入る見込みは高い)。
  見分け方は `cache_miss` の `divergence` (context-reduction-redesign.md §10.2): 直前の送信 (先読み) と並びが変わっていない (`firstDifferentMessage` が null、
  道具・設定も同じ) のに外れたなら、 スロットの違いかサーバ側の追い出しを疑う。 本体・先読みをスロット 0 に固定すれば (上の表) この可能性は消える。

#### 5.5.2 脇のスロットの選び方 (N ≥ 2)

- 脇のスロットは 1〜N−1。 サブエージェントは 1 件ごとに、 そのサブエージェントの寿命のあいだ同じスロットを使う (自分の文脈のキャッシュを使うため)。
  並べて動くサブエージェントが N−1 を超えたら、 超えた分は同じスロットを分け合う (互いに追い出すが、 本体のスロットは守られる)。
  割り当ては「いま使っているサブエージェントが最も少ないスロット」。
- 短い脇の呼び出し (intent など) はスロット N−1 に固定 (サブエージェントはスロット 1 から割り当てるので、 N ≥ 3 なら分かれる)。
- 送り方: `ChatParams` に llama.cpp 用の欄 `slotId?: number` を足し、 `LlamaCppProvider` だけが本文に `id_slot` を載せる (他の provider は無視)。
  チャットの入口 `/v1/chat/completions` では、 本文の知らない欄は llama.cpp 用の引数としてそのまま渡る
  ([server-common.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-common.cpp) の `oaicompat_chat_params_parse`:
  「Copy remaining properties to llama_params. This allows user to use llama.cpp-specific params like "mirostat", ... via OAI endpoint」)。
  その後 `handle_completions_impl` が `task.id_slot = json_value(data, "id_slot", -1)` で読む (`post_chat_completions` も同じ関数を通る)。
  **2026-10 の master のソースでは効く**。 利用者の版 (`b302-250b61446`) で効くかは §5.5.3 で確かめる。
- 割り当てを決めるのは `AgentLoop` が持つ 1 つの「振り分け」 (`SlotRouter`。 新規 `src/agent/slot-router.ts`)。 `sideCall()` の入口で目的からスロットを決め、
  `request.params.slotId` を埋める (呼び出し元は目的を渡すだけ。 送り先の決め方を 1 か所にする)。 本体呼び出しは `buildMainCallRequest` で 0 を埋める。

#### 5.5.3 `id_slot` が効くことの確かめ (版ごと)

自動の確かめ (実装する):
1. 起動時 (と `build_info` が変わったとき) は「未確認」 として始める。 未確認のあいだも `id_slot` は送る (効かなくても害は無い。 今と同じ振り分けになるだけ)。
2. 最初の脇の呼び出し (スロット k を指定) が終わったら、 `GET /slots` を 1 回読み、 スロット k の `n_prompt_tokens` がその呼び出しの `tokensIn` と一致するか、
   または スロット k の `id_task` が前回の読みから変わったかを見る。 一致すれば「効く」、 本体のスロット 0 の方が変わっていたら「効かない」。
3. 「効かない」 なら、 黄色の 1 行 (`このサーバの版 (b302-…) ではチャットの入口でスロットの指定 (id_slot) が効きません。 脇の呼び出しは本体と同じスロットに入りえます`)
   と `server_info` の記録を出し、 振り分けの判定を N = 1 と同じ扱いにする。 **ただし道具の一覧はその会話では変えない** (§5.6。 次の起動から反映)。
   結果は §7.3 の控えに版ごとに残す (次の起動では確かめ済みとして扱う)。
4. `/slots` が読めない (`--no-slots`) ときは「確かめられない」 として 1 行 (dim) と記録を出し、 効くものとして扱う (ソースでは効くため)。

手で確かめる手順 (利用者が別の測定をしていないときに行う。 設計書のための記録):
1. `curl -s http://<host>:<port>/slots` で、 2 つのスロットが `is_processing: false` であることと、 各スロットの `id_task` (無ければ未使用) を控える。
2. `curl -s http://<host>:<port>/v1/chat/completions -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"slot test"}],"max_tokens":1,"id_slot":1}'`
3. もう一度 `/slots` を読み、 スロット 1 の `id_task` が変わり (または `n_prompt_tokens` が小さい値になり)、 スロット 0 が変わっていなければ効いている。
   `"id_slot":0` でも同じことを確かめる。 あわせて、 スロット 1 が処理中のときに `"id_slot":1` を送ると待たされる (スロット 0 に入らない) ことも確かめる。

#### 5.5.4 スロットが 1 つでセカンド LLM があるとき

- サブエージェントの既定の送り先をセカンド LLM (別サーバ) にする。 今の仕組み (`resolveModelFor` の modelRef → model-registry の `second` スロット) をそのまま使い、
  「明示の modelRef が無いときの既定」 を `main` から `second` に変える (新しい送り先の仕組みは作らない)。 明示の modelRef は今のまま優先。
- セカンド LLM が本体と同じサーバ・同じスロットを指している (host・port が同じ) ときは、 セカンド LLM は無いものとみなす (別サーバでないと意味が無い)。
- セカンド LLM のモデルは本体より小さいことが多い。 サブエージェントの質が変わることを起動の表示に出す (`サブエージェント: セカンド LLM (… ) で動かします (本体のスロットが 1 つのため)`)。

#### 5.5.5 判定の目安: 読み直し時間

固定のトークン数 (例: 128K) ではなく、 **全部読み直すと何分かかるか** で決める。

```
読み直し時間 = 対象のトークン数 ÷ v
避ける (追い出しを許さない) = 読み直し時間 > 境目 (既定 3 分)
```

- 道具の一覧 (サブエージェント) の判定は起動時とモデル切替時だけなので、 その会話で起こりうる最大で判定する: 対象 = 規則 1 の発火点 `W − R`
  (context-reduction-redesign.md §4.4。 それより大きい履歴は整理で減らされる)。
  例: 利用者 (T2、 W = 262,144、 R = 67,584) → 194,560 トークン ÷ 130 = 約 25 分 > 3 分 → スロットが 1 つでセカンド LLM が無ければサブエージェントを出さない。
  境目 3 分・130 トークン/秒では、 `W − R` が 23,400 以下 (T3 の 32K 枠など) なら出す。
- 短い脇の呼び出し (intent など) は呼ぶたびに判定できる (道具の一覧と関係ない): 対象 = いまの P (`measureNextPrompt`)。
  依頼の始めの数回 (P が小さい) は本体と同じでも害が小さい。
- v は §7.2 の実測。 実測が無いうちの既定は **130 トークン/秒** (利用者の実測。 他の環境では合わない。 **未決 U3**)。
  実測が増えたら直近の中央値を使う。

### 5.6 道具の一覧を変える時

- 決めるのは **起動時** と **モデル切替時** (`setModel` / `setProvider` と、 §5.3 のサーバの入れ替わり) だけ。
  サーバの入れ替わりではキャッシュが既に無いので、 そこで変えても失うものは無い。 `/model <名前>` で同じサーバのままモデル名だけ変えたときも
  決め直すが、 結果が同じなら一覧は変わらない。
- 変える対象は `task` 一式 (`task` / `task_output` / `task_list` / `task_send` / `task_cancel` / `task_diff`)。 `task` だけを外すと残りは使い道が無いので一緒に外す
  (**未決 U5**: 実行中のサブエージェントが残っている場合の `task_output` など)。
- 作り: `ToolRegistry` から消すのではなく、 `getFilteredToolDefs` (`agent-loop.ts:2448`) の最後に「サーバの構成で出さない道具」 の集合を当てる。
  集合は起動時・モデル切替時にだけ更新し、 依頼の区切りの読み直し (素性が同じ) では触らない。 plan mode・チャネルの絞り込みは今のまま。
- 出さないときは、 起動の表示と `/context` に理由を 1 行 (`サブエージェント (task): 出していません。 スロットが 1 つでセカンド LLM が無く、
  サブエージェントの後の読み直しが最大 約 25 分 (194,560 トークン ÷ 130 トークン/秒) かかるため。 llama-server を --parallel 2 で起動すると使えます`)。
  モデルには理由を伝えない (道具が無いだけ。 システムプロンプトで `task` に触れている箇所があれば、 一覧と食い違わないよう確かめる。 実装タスク 6)。
- 会話の途中で「スロットが足りなくなった」 (例: 自動の確かめで `id_slot` が効かないと分かった) ときも、 一覧はその会話では変えない。
  1 行で知らせ、 次の起動で反映する。

### 5.7 表示

起動時 (今の `Resumed session` などの並びの近く。 1〜3 行):
```
  サーバ: llama.cpp b302-250b61446 (192.168.1.201:9190) / モデル Qwen3.8-27B-Q8_0.gguf / 1 スロット 262,144 トークン × 2 スロット
  枠: 262,144 (サーバ。 設定の 1,048,576 はサーバより大きいので使いません)   段階: T2 (pattern match: … 。 名前はサーバから)
  振り分け: 本体 = スロット 0、 サブエージェント・脇の呼び出し = スロット 1 (id_slot は未確認)
```
- `/context` の「コンテキストの整理」 欄 (`reduction-view.ts` の `formatReductionStatus`) の前に「サーバ」 欄を足す: 上の 3 行に加えて、
  最後に読んだ時刻、 `/slots` の各スロットの `is_processing` と `n_prompt_tokens` / `n_prompt_tokens_cache` (返したときだけ)、 読み込みの速さ v (実測の件数と値・既定値か)、
  出していない道具とその理由、 `id_slot` の確かめの結果。 チャネルの `/context` (`channel-commands.ts`) も同じ欄を返す。
- 黙った欠損をしない: サーバの値と違う値を使っているとき (W_c < W_s、 W_c > W_s)、 読めなかったとき、 道具を出していないとき、 `id_slot` が効かないときは、
  必ず画面に 1 行と `server_info` の記録を出す。 同じ状態が続く間は依頼ごとには繰り返さない (変わったときと `/context` で出す)。

### 5.8 失敗の扱い

| 場面 | 扱い |
|---|---|
| 起動時に `/props` が読めない (接続できない・404・形が違う) | 今の決め方 (設定 > `getModelInfo` > 名前の推定) で起動し、 黄色の 1 行 `サーバの情報 (/props) を読めませんでした (…)。 設定の値で動きます` と記録。 スロット数は 1 とみなす (振り分けしない側に倒す)。 依頼の区切りで読めたら、 そこで §5.3 として合わせる |
| 依頼の区切りで読めない | 前の素性のまま続ける。 読めなくなった最初の 1 回だけ黄色の 1 行と記録 (読めない間は依頼ごとに繰り返さない。 記録は毎回)。 本体の呼び出しも失敗するはずなので、 そちらは今のエラー処理に任せる |
| `/props` の欄が欠けている (`total_slots` が無い等) | 欠けた欄は「分からない」 として扱う: 枠が無ければ今の決め方、 スロット数が無ければ 1。 何が欠けたかを記録と `/context` に出す |
| `/props` が 5 秒で返らない | 読めないと同じ。 依頼を 5 秒より長く待たせない |
| 他の provider (vllm / ollama / lmstudio / クラウド) | 今のまま (設定 > `getModelInfo` > 名前の推定。 振り分けしない。 `id_slot` を送らない)。 起動の表示の「サーバ」 行は出さない。 §8 で同じことができるものは後のタスク |
| セカンド LLM が落ちている (§5.5.4 の送り先) | 今のセカンド LLM のエラー処理のまま (本体のスロットに切り替えない。 黙った切り替えをしない) |

### 5.9 同じサーバを別の利用者・別の測定が使うとき

- 本体をスロット 0 に固定すると、 別の利用者がスロット 0 を使っている間、 本体は待たされる (サーバは指定のスロットが空くまで待たせる)。
  固定しない今のやり方なら空いている方に入る (ただし追い出される)。
- todo-local-llm-speed.md の方針「環境を知っているときだけ踏み込む」 に従い、 振り分け (`id_slot` を送ること) は llama.cpp のときの既定にするが、
  設定で止められるようにする: `localServer.slotRouting: "auto" | "off"` (既定 `auto`)。 **未決 U1** (既定をどちらにするか。 利用者のサーバは
  今まさに別の測定がスロット 1 を使っており、 共有の場面がある)。
- 待たされたことは見えるようにする: 本体呼び出しが送ってから最初の 1 文字まで長いとき、 `/slots` を読んで指定のスロットが他の処理中なら dim の 1 行
  (`スロット 0 が別の処理で使われているため待っています`)。 実装タスク 5 の受け入れ条件。

---

## 6. 調べた事実 (根拠)

### 6.1 `/props`

- `total_slots` = `params.n_parallel` (`--parallel` / `-np`)。 `default_generation_settings.n_ctx` = `meta.slot_n_ctx` = 1 スロットあたりの枠
  (`llama_n_ctx_seq`・`--kv-unified-per-slot`・学習時の枠の小さい方)。 ほかに `model_path`・`model_alias`・`build_info`・`modalities`・`is_sleeping`・`endpoint_slots`・`endpoint_metrics`。
  出典: [server-context.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp) (`/props` の組み立て)、
  [server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) (GET /props)。 実機でも同じ欄を確かめた (§1.1)。
- `is_sleeping` (アイドル時のスリープ) が true のときは、 モデルが下ろされていてキャッシュも無い見込み。 素性の比較には入れず、 `/context` に出す。

### 6.2 `/slots`

- 既定で有効、 `--no-slots` で無効。 各スロットの `id`・`n_ctx`・`is_processing`・(処理中・処理後) `id_task`・`n_prompt_tokens`・`n_prompt_tokens_processed`・`n_prompt_tokens_cache`・`params`・`next_token`。
  実機では使っていないスロットはプロンプトの数を返さなかった (§1.1)。 生成のキューを通る処理 (`SERVER_TASK_TYPE_SLOT_GET`)。
  出典: 同 README (GET /slots、 `--slots, --no-slots`)、 server-context.cpp。

### 6.3 `id_slot`

- `/completion`: 「Assign the completion task to an specific slot. If is -1 the task will be assigned to a Idle slot」 (既定 -1)。 README。
- チャットの入口 `/v1/chat/completions`: README には書かれていない。 ソースでは §5.5.2 のとおり知らない欄がそのまま渡り、
  `post_chat_completions` → `handle_completions_impl` の `task.id_slot = json_value(data, "id_slot", -1)` で効く (2026-10 の master)。
  同じ関数を `/v1/completions`・Responses・Anthropic の入口も通る。
- 指定したスロットが処理中なら待たせる (別のスロットに回さない)。 `id_slot` はスロット数で割った余りに丸められる (`id_slot % slots.size()`)。
- 版による違い: 古い版の扱いはここでは確かめていない。 利用者の版 `b302-250b61446` は番号の形が本家の `b<番号>` と桁が違う (自前のビルドの可能性)。 §5.5.3 で確かめる。

### 6.4 キャッシュの大きさは API から見えるか

- `--cache-ram` / `-cram`: 「set the maximum cache size in MiB」 (README の既定は 8192。 -1 は上限なし、 0 は無効)。 使っていないスロットのプロンプトを
  ホストのメモリに退避する `--cache-idle-slots` (既定で有効。 `--cache-ram` が要る) もある
  ([common/arg.cpp](https://github.com/ggml-org/llama.cpp/blob/master/common/arg.cpp)、 README)。
- **`/props` にも `/slots` にも、 キャッシュの大きさ・使用量・退避した数の欄は無い** (ソースの `/props` の欄と、 実機の `/props` の欄の一覧で確かめた)。
  ソースでは大きさはサーバのログ (`prompt cache is enabled, size limit: %d MiB`) に出るだけ。
- `/metrics` (Prometheus 形式) は `--metrics` で有効にしたときだけ (`endpoint_metrics`。 実機は false)。 中身は処理中のスロット数・待っている処理の数などで、
  キャッシュの大きさは載っていない (ソースの読み)。
- よって `--cache-ram` を前提にした判断 (退避から戻せるので追い出しても安い、 など) はアプリからはできない。 必要なら利用者の設定にする (todo-local-llm-speed.md T3 の案のまま。
  今回は作らない)。 混成モデルで退避から戻せるかも版による (todo-local-llm-speed.md T2-c)。
- `--kv-unified` (全スロットで 1 つの KV を分け合う。 `--parallel` が自動 (-1) のとき既定で有効) かどうかも `/props` からは見えない。
  分け合う形では、 スロットを分けても KV の容量を取り合う。 利用者の起動のしかたでは付けていない (§1.1.1)。 ただし起動の引数は固定ではないので前提にはしない (U6)。

---

## 7. 計測

### 7.1 記録 (セッションログ `<sid>_main.jsonl`)

- **`server_info`** (新規): 起動時・素性が変わったとき・読めなかったとき・`id_slot` を確かめたときに 1 件。
  `{"type":"server_info","trigger":"startup"|"request-boundary"|"provider-change","ok":true,"baseUrl":"…","modelPath":"…","modelAlias":"…","buildInfo":"…","totalSlots":2,"slotNCtx":262144,
  "contextWindow":{"used":262144,"configured":1048576,"source":"server"|"config"|"fallback"},"tier":"T2","tierReason":"…","changed":["model_path",…],
  "routing":{"mode":"slots"|"second-llm"|"none","mainSlot":0,"sideSlots":[1],"idSlotCheck":"unknown"|"works"|"not-working"|"unavailable"},
  "hiddenTools":["task",…],"hiddenReason":"…","error":"…"}`。
- **`side_call`** (既存) に `slotId` (送ったスロット。 送らなければ無し) を足す。 どの脇の呼び出しがどのスロットに行ったかが分かる。
- **`cache_miss`** (既存) の `causes` に `server_restart` (間にサーバの素性が変わった) を足す。 これでサーバの入れ替わりによる外れを `unknown` と区別できる。
- 確かめ方 (振り分けが効いているか): 脇の呼び出し (`side_call`、 `slotId` ≥ 1) の直後の本体呼び出しで `cache_miss` が出ないこと。
  `cache_miss` の `causes` に `side_call:subagent` 等が出ていれば振り分けが効いていない。 context-reduction-redesign.md §14.3 B4 (タスク 2) と同じ記録で見る。

### 7.2 読み込みの速さ v の実測

- llama.cpp のストリームの最後の `timings` (`prompt_n` = 新しく読んだトークン数、 `prompt_ms`) を読む (今は `cache_n` だけ読んでいる。 `openai-compat.ts:63`)。
  `response` の記録に `promptEvalTokens` / `promptEvalMs` を足す。
- v の見積もりに使うのは、 新しく読んだ量が多い呼び出し (例: `prompt_n` ≥ 20,000) だけ (少ない量では 1 トークンあたりの時間が安定しない)。
  20 万を超える領域で遅くなるか (context-reduction-redesign.md §14.3 B2) も同じ記録で見る。
- `timings` を返さない provider・版では、 読み込みだけの時間が分からないので v を更新しない (所要時間全体から推すと生成の時間が混ざる)。

### 7.3 控え (セッションをまたぐ)

- `~/.localllm/server-observations.json` (新規): サーバ (baseUrl + model_path) ごとに、 v の直近の実測 (最大 20 件) と、 版 (build_info) ごとの `id_slot` の確かめの結果。
  壊れていたら黄色の 1 行で知らせて空から始める (黙って空にしない)。 利用者の実データの場所なので、 試験は一時フォルダで行う。

---

## 8. ほかの provider で同じことができるか (調べた結果)

| provider | 枠を読めるか | スロット・並べての数 | キャッシュの追い出し | 振り分け |
|---|---|---|---|---|
| llama.cpp | `/props` の `n_ctx` (1 スロットあたり) | `/props` の `total_slots` | スロットごとに 1 つの並び。 別の並びが入ると追い出す (混成モデルは途中に戻れない) | `id_slot` (§6.3) |
| vLLM | `/v1/models` の `max_model_len` (ソースの知識。 実機は未確認) | 「スロット」 は無い。 同時に処理する数は `--max-num-seqs` (API からは見えない) | 前方のキャッシュはブロック単位で全部の要求が分け合い、 空きが足りないときに最後に使われたのが古いブロックから捨てる ([prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html))。 短い脇の呼び出しでは追い出されにくい | 不要 (分ける口も無い)。 使用率は `/metrics` の `vllm:kv_cache_usage_perc`、 前方のキャッシュの当たりは `vllm:prefix_cache_queries` / `vllm:prefix_cache_hits` ([metrics](https://docs.vllm.ai/en/latest/usage/metrics.html)) |
| Ollama | `/api/ps` の `context_length` (読み込み済みのモデルの枠。 [api/ps](https://docs.ollama.com/api/ps))、 `/api/show` は学習時の値 (今 `ollama.ts:93` が使う) | `OLLAMA_NUM_PARALLEL` は API から見えない | 並べての数ごとに枠を分ける。 指定の口は無い | できない |
| LM Studio | `/api/v0/models` の `max_context_length` (学習時の最大。 [REST v0](https://lmstudio.ai/docs/developer/rest/endpoints))。 読み込み時の枠の欄は文書で確かめられなかった | 文書に無い | 文書に無い | できない |

- vLLM の枠の自動の把握は llama.cpp と同じ形 (起動時と依頼の区切りに `/v1/models` を読み、 サーバの値を正とする) でできる見込み。 後のタスク (実装タスク 9)。
- Ollama は `/api/ps` で読み込み済みの枠を読めるが、 モデルが読み込まれていないと出ない (最初の呼び出しまで分からない)。 後で検討。

---

## 9. 前方一致との関係

- **`id_slot` は並びを変えない**: 本文の欄であって、 テンプレートで描かれるプロンプトには入らない。 本体はいつも同じスロット 0 なので、 前方一致の不変条件
  (`tests/agent/prompt-prefix-invariant.test.ts`) はそのまま成り立つ。 試験では本体の送信の `slotId` が全部 0 であることを足す。
- **道具の一覧**: 起動時とモデル切替時だけ変える (§5.6)。 依頼の区切りの読み直しで素性が同じなら一覧は変わらない。 素性が変わったときはサーバの起動し直しで
  キャッシュが無いので、 一覧を変えても追加の損は無い。 前方一致の試験に「依頼の区切りで `/props` を読んでも、 素性が同じなら tools が変わらない」 を足す。
- **W・段階の変更**: 送る並びそのものは変えない (既にあるツール結果は切り直さない。 §5.3)。 規則 1 の整理が要るなら、 それは整理イベント (申告済みの書き換え) になる。
- **先読み・要約は本体と同じスロット**: 先読み (context-reduction-redesign.md §9) と段階 3 の要約 (§5.6) は、 本体と同じスロット 0 に送らないと効かない。
  `SlotRouter` で目的 `prewarm` / `summarize` を本体のスロットに固定し、 試験で確かめる。
- **待ち合わせ** (`setSideCallGate`。 先読みの間は脇の呼び出しを待たせる): スロットが分かれているなら、 脇のスロットへの呼び出しは先読みを追い出さないので待たなくてよい。
  ただし同じサーバの計算を取り合う (先読みが遅くなる) ので、 今回は今のまま待たせる (**未決 U7**)。

---

## 10. 実装タスク分割

各タスクの完了時に `npm run lint` / `npm run test:coverage` / `npm run test:e2e` を通し、 区切りごとに main へ push する。

| # | タスク | 受け入れ条件 | テスト |
|---|---|---|---|
| 1 | サーバの素性を読む口: `LlamaCppProvider.refreshServerInfo()` (`/props`、 5 秒)、 `propsCache` をやめて「最後に読んだ素性」 にする。 `getSlots()` (`/slots`)。 欄が欠けたときの扱い | 読むたびにサーバへ問い合わせる。 欠けた欄・失敗を区別して返す | 偽の HTTP で: 正常・欄の欠け・404・時間切れ・形の違い |
| 2 | 枠の決め方を 1 つに: `resolveMainContextWindow()` (§5.2)。 起動時に使い、 W_c > W_s の 1 行・W_c < W_s の表示・読めないときの今の決め方 | 利用者の形 (W_c 1,048,576、 W_s 262,144) で W = 262,144 と黄色の 1 行。 他の provider は今と同じ値 | 各場合の単体テスト。 起動の表示 |
| 3 | 段階の判定の入力をサーバのモデル名に (§5.4)。 上書きの探し方。 理由に出どころ | 利用者のモデルのパスで今と同じ T2 | `resolveCapability` にサーバのパスを渡す試験 |
| 4 | 依頼の区切りでの読み直しとずれの扱い (§5.3): `run()` の最初で比べ、 変わったら W・段階・振り分け・道具の一覧を決め直す。 起動時検査に通らないときの止め方。 `cache_miss` の `server_restart` | 素性が同じなら何も変えない (送る並び・tools が同じ)。 変わったら 1 行と記録 | 台本 provider + 偽の `/props` で: 同じ・モデル・スロット数・枠・版が変わる。 前方一致の試験に「読み直しで tools が変わらない」 |
| 5 | 振り分け (§5.5): `SlotRouter`、 `ChatParams.slotId` → llama.cpp の本文の `id_slot`、 `sideCall()` での割り当て、 本体 = 0、 summarize / prewarm = 0。 サブエージェントのスロットの割り当て。 待たされたときの 1 行 | N ≥ 2 で本体の送信が全部 `id_slot: 0`、 subagent / intent が 1 以上、 summarize / prewarm が 0。 N = 1 では送らない。 他の provider の本文に `id_slot` が無い | 本文の組み立ての試験 (provider ごと)、 目的ごとのスロット、 並べたサブエージェントの割り当て |
| 6 | 道具の一覧 (§5.6): 出さない道具の集合を起動時・モデル切替時にだけ更新、 読み直し時間の判定 (§5.5.5)、 理由の表示。 システムプロンプト・ツールの案内が `task` に触れる箇所の確認 | N = 1・セカンド LLM なし・利用者の枠で `task` 一式が出ない。 会話の途中で変わらない | 一覧の試験、 境目の前後の値 |
| 7 | スロットが 1 つでセカンド LLM があるとき (§5.5.4): サブエージェントの既定の送り先、 同じサーバのセカンド LLM を無いものとみなす、 短い脇の呼び出しの読み直し時間の判定 | 明示の modelRef が無いサブエージェントがセカンド LLM の provider で動く | `resolveModelFor` の試験 |
| 8 | 計測と控え (§7): `server_info`、 `side_call.slotId`、 `timings` の `prompt_n` / `prompt_ms`、 v の見積もり、 `server-observations.json`、 `id_slot` の自動の確かめ (§5.5.3) | 記録の欄が設計どおり。 確かめで「効かない」 なら 1 行と N = 1 の扱い (一覧は変えない) | 記録の形の試験、 偽の `/slots` での確かめ (効く・効かない・読めない) |
| 9 | 表示 (§5.7): 起動時の 3 行、 `/context` の「サーバ」 欄 (チャネルも) | 利用者の形の表示が §5.7 の例と同じ内容 | `compact-context-commands.test.ts` に欄を足す |
| 10 | 実機確認 (llama.cpp。 利用者の測定が終わってから): §5.5.3 の手の確かめ、 振り分けの後の `cache_miss`、 v の実測、 `--kv-unified` の有無 | 結果を本書に追記 | 手動 |
| 11 | (後で) vLLM の枠の自動の把握 (§8) | — | — |

---

## 11. 未決事項 (利用者の判断が要る)

| # | 事項 | 案 |
|---|---|---|
| U1 | 振り分け (`id_slot`) の既定 | `auto` (llama.cpp なら振り分ける)。 共有のサーバで本体がスロット 0 の空きを待つのが困るなら `off` を既定にする (§5.9) |
| U2 | スロットが 1 つでセカンド LLM が無いときの短い脇の呼び出し (意図の分類・進み具合・Goal 昇格) | 今のまま送り、 計測 (タスク 2・B4) の結果で決める。 追い出しが確かなら、 読み直し時間が境目を超える間は名前の規則だけで分類する (LLM を呼ばない) 案 |
| U3 | 避ける境目 (既定 3 分) と、 実測が無いときの v (既定 130 トークン/秒) | 3 分・130。 境目は設定にするか (しないなら固定) |
| U4 | `modelCapabilities` がサーバのモデル名と設定の model の両方にあるとき | サーバのモデル名の方を使い、 起動の表示に両方あることを出す |
| U5 | `task` 一式を出さない会話で、 前の起動から残る背景のサブエージェントの扱い | `task_list` / `task_output` だけは残す案と、 一式を外す案 |
| U6 | 利用者のサーバの起動の引数 | **決定 (2026-10-26)**: 利用者は起動のたびに引数を選ぶので固定の値は持たない。 見えるもの (枠・スロット数・モデル) は `/props` から読み、 見えないもの (`--cache-ram`・`--kv-unified`) は計測 (§7) の結果で判断する。 起動のしかたは §1.1.1 |
| U7 | 先読みの間、 脇のスロットへの呼び出しも待たせるか | 今のまま待たせる (§9) |
| U8 | 設定の contextWindow がサーバより大きいとき、 設定ファイルの値を直すか | 直さない (表示だけ)。 直すなら 1 回だけの扱い (context-reduction-redesign.md §11.4 と同じやり方) にする |
