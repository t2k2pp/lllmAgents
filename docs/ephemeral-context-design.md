# Ephemeral Context — span スコープの揮発メッセージ設計

> **目的**: ハーネスが in-turn の方向修正・自己点検・空応答救済のために注入する補助メッセージを、 **ユーザー応答完了の瞬間に消費し終えた scratch space として破棄する**。 これにより過去 span のノイズが次 span の判断を引きずらず、 同時に LLM が思考した内容を span 内では十分活用できる仕組みにする。
>
> **位置づけ**: `docs/multi-tier-harness-roadmap.md` Phase B-C / Phase D-4 (短 ctx 最適化) と直交する横串の改善。 思想は「思考と試行錯誤を無駄にしない」。 設計の詳細は `docs/agent-loop-efficiency-review.md` で分析した P0-P3 自己点検メカニズムの上に乗る。
>
> **作成日**: 2026-05-10

---

## 1. 背景 — なぜこの設計が必要か

### 1.1 観測された実害

セッションログ `~/.localllm/logs/sessions/2026-05-09T12-59-26_main.jsonl` で以下を観測:

| turn | thinking | text | toolCalls | 結果 |
|---:|---:|---:|---:|---|
| 3 | **537字** (具体的な `<tool_call>` 含む) | 0 字 | 0 件 | empty 扱いで `（空のレスポンス）` 履歴化、 思考は捨てられた |
| 4 | 255字 (前 turn の再生成) | 0 字 | 1 件 | 同じ仕様を再導出。 todo 構造は失われた |

`addAssistantMessage(content, toolCalls?)` のシグネチャに **thinking を渡す経路がない** (`message-history.ts`)。 一方ハーネスが注入する nudge / self-check メッセージは永続化されていたため、 過去 span のノイズが次 span に残り続けていた。

これは「LLM が考えたことを活用する」 という設計原則と矛盾する。

### 1.2 設計者の哲学 (ユーザーから)

> 生成 AI が思考が必要と感じたことを無駄にしたくない。 それはきっと大事なポイントだと思います。 設計をする際に、 思想を残さず進めると行き詰まるのと同じです。 SoWhat、 WhySo を理解しながら実装を進める仕組みにつながると考えます。

→ **思考は SoWhat/WhySo の核**。 span 内では保全し、 ユーザー応答が出たら消費済みとして clean に切る。

---

## 2. 核心の設計原則

### 2.1 二分法

履歴に積むメッセージを 2 種類に分ける:

| 種別 | 例 | 寿命 |
|---|---|---|
| **永続 (default)** | user 実発話、 実 tool_call と tool_result、 最終 assistant 応答 | span 境界を越える |
| **揮発 (ephemeral)** | self-check nudge、 stuck-loop 介入、 「（空のレスポンス）」 placeholder、 「続きを出力してください」 等の継続合図、 plan-mode 警告、 P1-A/B 警告 | span 内でのみ生存。 境界で破棄 |

### 2.2 span の定義

「ユーザー発話 → 応答完了」 までの 1 単位を span と呼ぶ。 span 終了の契機は:

1. `response_complete` ツール呼出 (= 明示完了)
2. 最終 assistant テキスト応答 (= ツール未呼び出しでテキストのみ)
3. ガベージ応答 / 自己点検上限到達 / 空応答リトライ上限 / max_iterations
4. ユーザー abort
5. LLM 呼出失敗での abort

すべての span 終了で `purgeEphemeralAtSpanEnd(reason)` を呼ぶ。

### 2.3 不変条件 — tool ペアは絶対に切らない

OpenAI 互換 API の仕様上、 `assistant.tool_calls` を含むメッセージと対応する `role=tool` は必ずペアで存在する必要がある (片方を消すと 400)。

そのため:
- **揮発化対象**: assistant の純テキスト (tool_calls なし) と user 役の harness 注入のみ
- **揮発化禁止**: tool_calls を含む assistant、 role=tool、 system

`addAssistantMessage` は ephemeral=true でも tool_calls がある場合は警告を出して永続化する (実装で防御)。

---

## 3. 実装

### 3.1 型と保存方式 (`src/agent/message-history.ts`)

`Message` 型は変更しない (provider にリークさせないため)。 揮発フラグは `WeakSet<Message>` で外置き保存:

```ts
private messages: Message[] = [];
private ephemeralMessages = new WeakSet<Message>();

addUserMessage(content, opts?: { ephemeral?: boolean }): void {
  const msg: Message = { role: "user", content };
  this.messages.push(msg);
  if (opts?.ephemeral) this.ephemeralMessages.add(msg);
}

addAssistantMessage(content, toolCalls?, opts?: { ephemeral?: boolean }): void {
  const msg: Message = { role: "assistant", content };
  if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
  this.messages.push(msg);
  if (opts?.ephemeral) {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.warn("[message-history] ephemeral=true は tool_calls を含む assistant メッセージには適用できません。 永続化します。");
    } else {
      this.ephemeralMessages.add(msg);
    }
  }
}

purgeEphemeral(): number {
  const before = this.messages.length;
  this.messages = this.messages.filter((m) => !this.ephemeralMessages.has(m));
  return before - this.messages.length;
}
```

WeakSet の利点:
- メッセージ参照そのものをキーにするので index 管理が不要
- `Message` 型に余計なフィールドが載らないので `getMessages()` が provider にきれいなオブジェクトを返す
- メッセージが GC されると自動的にエントリも消える

### 3.2 揮発マーキング (`src/agent/agent-loop.ts`)

以下の harness 注入箇所すべてに `{ ephemeral: true }` を付与:

| 注入箇所 | 内容 | 理由 |
|---|---|---|
| max_tokens 到達時の継続合図 | "続きを出力してください…" | 部分応答→続きの内部リトライ。 完了後は不要 |
| 検証未実施 self-check | "以下のファイルの動作確認が未完了です…" | bash 検証を促すための span 内ガード |
| Evaluator 不合格 self-check | "Evaluator から以下の指摘…" | 修正促進。 修正後は中間ノイズ |
| ツール未呼び出し reprompt | "promise テキストだけでは作業継続と認識しません…" | 作業催促。 作業開始後は不要 |
| 大コードブロック検出 reprompt | "file_write を使ってください" | 同上 |
| 空応答リトライ placeholder + nudge | "（空のレスポンス）" / "[ハーネス通知]…" | 空応答救済。 完了後は不要 |
| stuck-loop 介入 (P0-A) | "直近 N 反復で同じエラー…" | 方向修正。 修正後は中間ノイズ |
| plan-mode コード書き込み警告 | "exit_plan_mode で承認を…" | プランモード保護 |
| P1-A bash 累積警告 | "bash 累積実行時間が…" (現在 OFF) | 観測警告 |
| P1-B plan/todo 過多警告 | "計画/Todo の更新が過多…" | 観測警告 |

### 3.3 span 境界での purge

`purgeEphemeralAtSpanEnd(reason)` を span 終了の各 return 直前に呼ぶ。 reason は telemetry 用:

| reason | 契機 |
|---|---|
| `response_complete` | 明示完了 |
| `final_text_response` | テキストのみで終了 |
| `garbage_response` | 解析不能応答 |
| `self_check_limit` | 自己点検上限到達 |
| `empty_response_giveup` | 空応答リトライ上限 |
| `max_iterations` | ループ上限 |
| `tool_abort` / `synthetic_write_abort` | ツール側 abort |
| `user_abort` | ユーザー中断 |
| `llm_error_abort` / `llm_call_unsuccessful` | LLM 呼出失敗 |

破棄件数が 1 以上なら console.dim でログ表示し、 ブラックボックス化を防ぐ。

---

## 4. 観測される効果

### 4.1 ctx 圧迫の削減

長尺 span で self-check が複数回発動した場合、 ハーネス nudge が 5-10 件積もる。 span 終了時にこれが消えるので:

- **T1 (200K ctx)**: 軽微だが累積で効く
- **T2 (32-128K ctx)**: 5-10% 程度の節約見込み
- **T3 (8-32K ctx)**: 短 ctx 救済として直撃。 Phase D-4 (aggressive context manager) と相乗効果

### 4.2 過去 span ノイズの遮断

stuck-loop 介入や空応答 nudge が永続化されていた現状:
- 「前回ハーネスに方向修正されたから慎重にやらないと」 のような過剰反応を次 span に持ち込む
- ユーザーから見て不要な harness 内部対話が context に残る

ephemeral 化で次 span は綺麗な状態から始まる。

### 4.3 思考 (thinking) 保全への布石 (Phase 2)

Phase 1 (本 commit) でインフラを入れたので、 Phase 2 で:
- empty-response 救済時に thinking 要約を ephemeral assistant として残す → 同 span 内で再活用、 完了後は破棄
- thinking 内 `<tool_call>` を normalizer で抽出 → 真の tool_call として実行

を自然に実装できる。

---

## 5. テスト

`tests/agent/message-history.test.ts` に 6 件追加 (合計 9 件 pass):

1. ephemeral=true のメッセージのみ purge され、 永続メッセージは残る
2. tool_call を含む assistant メッセージは ephemeral=true でも揮発化されない
3. 複数回 purge 呼んでも idempotent
4. purge 後に追加した ephemeral も次の purge で除去 (span 跨ぎ無し)
5. ephemeral メッセージは getMessages() で他と区別なく見える (in-turn 中は届く)
6. isEphemeral() で個別判定可能

---

## 6. 制約と非対象

### 6.1 やらないこと

- **provider への ephemeral フラグ送信**: しない。 provider は通常メッセージとして受け取る
- **強制 GC**: WeakSet の参照消失に任せる
- **永続化されたメッセージの後付け揮発化**: 不可。 add 時にしか印付けできない
- **history 圧縮 (`replaceOlderMessages`) との連携**: 直交。 圧縮は ctx 閾値到達時、 purge は span 境界。 両方が独立に動作する

### 6.2 既知の限界

- ~~thinking content そのものは現状捨てられたまま~~ (Phase 2 で対応済 §7.1)
- 既存 P0-A の stuck-loop 介入を ephemeral 化したが、 真に学習させたい場合は span を跨ぎたいケースもある (要観察)
- empty-response retry の placeholder が ephemeral になったため、 上限到達後の中断時にも purge される。 ただし最終的な「思考のみで終了」 のヒントはコンソール表示で残る
- 思考保全は empty-response 経路のみ (textContent / toolCalls がある正常応答の thinking は変わらず捨てる)。 これは妥当: 正常応答が出ているなら model 自身がツールコール / テキストとして必要事項を吐き出せたので、 thinking は scratch として役目を果たした

---

## 7. Phase 2 — 思考保全 (実装済 2026-05-10)

### 7.1 思考保全 (empty-response 救済) ✅

`agent-loop.ts` の empty-response retry 箇所を以下に変更:

```ts
const placeholder = thinkingContent.trim().length > 0
  ? `[前回の思考 ${thinkingContent.length}字 — 形式不一致で吐き出せず、 ハーネスが保全]\n${thinkingContent}`
  : "（空のレスポンス）";
this.history.addAssistantMessage(placeholder, undefined, { ephemeral: true });
```

→ 同 span 内で次の生成時にモデルが自分の前思考を読める。 完了後は ephemeral として破棄され、 次 span に漏れない。 nudge 文も「あなたの前回の思考は保全しました。 続きをそのまま実行に移してください」 と切り替え、 再思考の無駄を抑制。

**重要な設計判断 — 機械的な文字数カットはしない (2026-05-10 修正)**:

初版では `slice(0, 2000)` で先頭 2000 字に切り詰めていたが、 中途半端な切り取りは意味を壊しノイズになる。 「思考を無駄にしない」 という設計哲学とも矛盾する。 完全保全に倒す。

ctx 圧迫の懸念は以下の三層で抑えられているため、 文字数キャップは不要:

| 安全網 | 効果 |
|---|---|
| `MAX_EMPTY_RETRIES = 3` | span 内で thinking placeholder が積み増される回数を上限固定 (高々 3 件) |
| `ContextManager` の閾値圧縮 | `capability.compressionThreshold` (T1=0.7 / T2=0.6 / T3=0.5) を超えたら自動で要約に置換。 文字数カットと違い意味を保つ要約 |
| `purgeEphemeral` at span end | 応答完了時に必ず破棄。 span 境界を越えて持ち越されない |

異常系 (思考 50K 字超など) でも要約圧縮が意味を保ったまま縮める。 機械的なカットより常に上位互換。

### 7.2 thinking 内 tool_call 抽出 (Phase D-1 拡張) ✅

`normalizeToolCalls()` を `thinkingContent` にも適用 (T2/T3 限定):

```ts
if (
  toolCalls.length === 0 &&
  thinkingContent.trim().length > 0 &&
  (this.capability.tier === "T2" || this.capability.tier === "T3")
) {
  const normalized = normalizeToolCalls(thinkingContent);
  if (normalized.toolCalls.length > 0) {
    console.log(chalk.dim(`  [tool-format] thinking 内 ${normalized.format} 形式から ${normalized.toolCalls.length} 件の tool 呼び出しを抽出`));
    toolCalls.push(...normalized.toolCalls);
  }
}
```

これで観測された Qwen3 turn 3 のケース (思考内に `<tool_call><function=todo_write>...` が完成形で存在) が自動回収される。 抽出された tool_call は real tool execution に流れ、 結果と一緒に**永続**化される (tool ペア保護)。

T1 (Claude/GPT-5) は OpenAI 互換 function calling が確実なのでスキップ (誤検知回避)。 既存の textContent 向け normalizer と同じ tier ガード。

### 7.3 telemetry (将来)

`purgeEphemeralAtSpanEnd` の呼び出し時に件数と reason を収集:
- 「self-check が頻繁に発動するモデル」 を特定
- Phase E-1 (自己改善ハーネス) の入力データになる

これは Phase E-1 と一緒に実装する。

---

## 8. 結語

ハーネスは LLM のためのスクラッチ空間を提供すべきだが、 そのスクラッチを永続履歴に紛れさせるとモデルの判断品質を下げる。 「span 内で書いて、 完了で消える」 という素直な分離を入れることで:

1. モデルは in-turn で十分なガイドを受け取れる
2. ユーザー応答後は綺麗な context に戻る
3. 思考保全 (Phase 2) の土台ができる

これは一度入れれば全 tier・全 provider で恩恵があり、 Phase A-F のどの拡張とも独立に動作する。 設計のシンプルさを保ったまま、 「思考を無駄にしない」 という哲学を実装に焼き込む。
