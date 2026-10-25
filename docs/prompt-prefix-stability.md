# プロンプト前方一致の安定化 (追記型の状態通知) 設計書

> 対象: ローカル LLM (llama.cpp / vLLM) の **KV キャッシュ再利用**、 クラウドの自動/明示プロンプトキャッシュ。
> 位置づけ: `docs/prompt-cache-cost-reduction.md` §3.1 (安定プレフィクス化) の **やり直し**。
> 作成日: 2026-10-25 / ステータス: 実装済 (実機での効果確認は未実施)

---

## 1. 背景・観測

myppt 開発セッション (`~/.localllm/logs/sessions/2026-10-24T13-40-41_main.jsonl`) で、
1 回の LLM 呼び出しに 17〜44 分かかっていた。 入力は 13〜17 万トークンで、 毎回 2 件 (assistant + tool) が
末尾に増えるだけなのに、 llama-server の `/slots` は `n_prompt_tokens_cache: 0` (毎回 0 トークン目から再計算)。

| ターン | 入力トークン | 所要 |
|---|---|---|
| t2 | 131,454 | 17.3 分 |
| t10 | 138,168 | 41.1 分 (出力 16k) |
| t20 | 168,631 | 30.9 分 |

## 2. 原因

### 2.1 主因: 毎ターン変わる部分を履歴より前に置いていた
`composeQuasiSystemPrompt` は system を `{ stable, dynamic }` に分け、 `getMessages()` は
`[system(stable), system(dynamic), ...履歴]` を返していた。 dynamic = **秒単位の現在日時** + Goal 節 + ToDo 節。

- `prompt-cache-cost-reduction.md` は「日時を system 本体から外し、 キャッシュ境界より後ろへ」 としたが、
  移した先は **履歴より前** だった。 前方一致は「ツール定義 + 固定 system」 で途切れ、 その後ろの履歴全部が毎回再計算になる。
- Qwen 系テンプレートは先頭に連続する system を 1 つに結合し、 **ツール定義 → system 本文** の順に描画する。
  dynamic は system ブロックの末尾、 履歴の直前に入る。
- Anthropic でも同じ。 system は messages より前に描画されるため、 dynamic が変わると
  「最後のメッセージに付けた履歴 breakpoint」 も毎回ずれていた (tools + system[0] しか読めていなかった)。

### 2.2 llama.cpp + ハイブリッドモデルで「0」 になる理由
Qwen3.5 以降は線形注意 (再帰状態) と通常の注意を混ぜた構成。 再帰状態は任意位置へ巻き戻せないため、
llama.cpp は **保存済みチェックポイントの位置** にしか戻れない。 チェックポイントは前回プロンプトの末尾付近にしか無いので、
途中 (system の末尾) で食い違うと、 戻れる位置が無く 0 から全部を再計算する。
通常の Transformer なら「system までは再利用」 になるが、 それでも履歴分は毎回再計算になる。

### 2.3 その他 (今回は対象外。 発生頻度が低い)
| 事象 | 頻度 | 扱い |
|---|---|---|
| 忘却 (tool 結果のトゥームストーン化) / 圧縮 | 文脈が溢れた時だけ | 文脈を減らすこと自体が目的。 キャッシュが一度外れるのは許容 |
| span 境界での揮発メッセージ除去・思考の破棄 | ユーザー依頼 1 件につき 1 回 | 許容。 必要なら別途 |
| ツール定義の変化 | 774 リクエスト中 3 回 | 許容 |
| 前回生成した思考 (`<think>`) を送り返さない | 毎回 | 食い違いは **前回プロンプトの末尾** なので、 llama.cpp の末尾チェックポイントで戻れる。 対応不要 |

## 3. 設計: 状態通知を「追記」 にする

原則: **一度送ったメッセージは書き換えない。 変わる情報は末尾に足す。**
(Claude Code が system-reminder を新しいメッセージに添付するのと同じ考え方)

### 3.1 getMessages() は固定部分だけを返す
`getMessages()` = `[system(stable), ...履歴]`。 composer の dynamic は `getMessages()` に入れない。

### 3.2 状態通知の添付 (`MessageHistory.attachDynamicContext`)
AgentLoop / SubAgent は **LLM 呼び出しの直前** に composer の dynamic を渡す。 MessageHistory は次の条件で、
**末尾のまだ送っていないメッセージ** (tool 結果 または user) に通知を添付する。

添付する条件 (いずれか):
1. 前回の通知と内容 (日時を除く Goal 節 + ToDo 節) が違う
2. 前回通知を添付したメッセージが履歴から消えた (忘却・圧縮・揮発除去・巻き戻し)。 状態を見失わせないため出し直す
3. 末尾が user メッセージ (新しい依頼の始まり)。 現在日時をここで更新する

添付しない場合:
- 末尾が送信済み (接続リトライ等で同じ履歴を再送する時) → 何もしない
- 末尾が assistant → 添付できないので見送り、 次の呼び出しで再判定 (未添付扱いのまま)

添付したら、 その時点の全メッセージを「送信済み」 にする (WeakSet)。 以後そのメッセージは書き換えない。

### 3.3 保存と描画
- 通知は `Message.contextNote` (内部専用フィールド、 `thinking` と同じ扱い) に保存する。
  session 保存に乗るので、 復元後も同じ描画になる。
- `getMessages()` が描画時に本文の後ろへ次の形で連結する。 provider には `contextNote` フィールドを渡さない。

```
<harness-context>
The harness attached the current state below. It is not part of the tool output or the user's message.

# Current datetime
2026/10/25 10:14:22

# 現在の ToDo (戦略)
...
</harness-context>
```
- 本文が ContentPart[] (画像付き user) の時は text パートを 1 つ足す。
- ユーザー発言の中身で判定する処理 (委任意図の検出など) は `getRawMessages()` を使い、 通知を読まない。

### 3.4 効果の見込み
1 回の呼び出しで再計算するのは「前回の生成分 + 新しい tool 結果 (+ 通知)」 だけになる。
myppt の例なら 13 万トークンの prefill (約 17 分) → 数千トークン (数十秒) の見込み。

## 4. 可視化 (キャッシュ破壊を見えるようにする)

### 4.1 ログの差分記録を「最初に食い違った位置」 基準にする
旧 `llm-logger` は件数だけで差分を取っていたため、 既存メッセージの書き換え (= キャッシュ破壊) がログに残らず、
ログからの再現も不正確だった。 各メッセージの JSON を前回と比べ、 **最初に食い違った位置** を `messageOffset` にする。
`messageOffset < 前回の messageTotal` なら途中が書き換わった (キャッシュが外れた) ことが分かる。

### 4.2 キャッシュヒット数を response ログに残す
`tokensCached` を記録する。 取得元は `usage.prompt_tokens_details.cached_tokens`、
無ければ llama.cpp の最終チャンクの `timings.cache_n`。

## 5. 変更ファイル
| ファイル | 変更 |
|---|---|
| `src/providers/base-provider.ts` | `Message.contextNote` 追加 |
| `src/agent/message-history.ts` | `getMessages()` から dynamic を外す / `attachDynamicContext()` / 描画で通知を連結 |
| `src/agent/agent-loop.ts` | 呼び出し直前に `attachDynamicContext(composeDynamicContext())` / 委任意図検出を raw に |
| `src/agent/sub-agent.ts` | (composer 未使用のため変更なし) |
| `src/agent/llm-logger.ts` | 差分の基準を「最初に食い違った位置」 に / `tokensCached` |
| `src/providers/openai-compat.ts` | `timings.cache_n` を cachedTokens の代替に |

## 6. 未確認・今後
- 実機 (llama-server, Qwen3.8-27B) での `n_prompt_tokens_cache` の改善は未確認。 次回セッションのログの `tokensCached` で確認する。
- 忘却トゥームストーンは openai-compat の system 統合で先頭へ寄る。 忘却時は元々キャッシュが外れるので今回は対象外。
