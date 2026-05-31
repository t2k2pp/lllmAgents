# スピナーモードの応答テキスト色分け再設計

作成: 2026-05-31 / 対象: `src/agent/agent-loop.ts`（スピナーモード = `streamingDisplay=false`）

## 1. 背景・課題

タイピングゲーム（元素記憶アプリ）作成セッション
`~/.localllm/logs/sessions/2026-05-30T01-34-11_main.jsonl`（model: gpt-5.4 / azure-gpt /
スピナーモード）で 2 つの UX 課題が観測された。

### 課題① 作業未完了なのにユーザーへ応答を返したように見える

`agent-loop.ts:811-821` は、**このターンが続くか終わるか（ディスポジション）を判定する前に**
バッファ済み `textContent` を白/Markdown で表示していた。

```ts
if (hasStartedOutput && !this.streamingDisplay) {
  const filteredText = createThinkingFilter()(textContent);
  if (filteredText.trim()) {
    if (hasMarkdown(filteredText)) console.log(renderMarkdown(filteredText)); // 白
    else console.log("\n" + filteredText);                                    // 白
  }
}
```

この直後に自己点検（`agent-loop.ts:1062` 〜: 検証未実施 / Evaluator 不合格 / ツール未呼び出し /
コードがテキスト応答に含まれる）が走り `continue` で作業継続する経路がある。すると

> 整形済みの「最終応答に見える白テキスト」→ 直後に `[自己点検 1/3]` → 作業継続

となり「完了していないのに応答を返した」ように見える。ツール呼び出しに伴うナレーション
（「〜を検証します」等、`finishReason=tool_calls`）も同経路で白表示され、毎ツール前に
"最終応答らしきもの"が白で出ていた。

### 課題② ユーザー向け応答が白でなく灰色になる

モデルが `response_complete` で締めた場合、実際のユーザー向け締め文（summary）は
`agent-loop.ts:947` で **灰色（chalk.dim）+ `[response_complete]` プレフィックス**で出ていた。

```ts
console.log("\n" + chalk.dim(`  [response_complete] ${summary}`)); // 灰色・ログ風
```

結果として色の意味が反転していた:
- 中間ナレーション → 白（最終応答に見える）
- 本当の締め文 → 灰色（ログに見える）

## 2. 設計方針（ユーザー合意済み 2026-05-31）

**「白＝ユーザーへの最終応答だけ。中間テキストは灰色」** に統一する。

| テキストの種類 | 旧 | 新 |
|---|---|---|
| ツール呼び出しに伴うナレーション | 白 | **灰色** |
| 自己点検で継続する中間テキスト | 白 | **灰色** |
| 最終テキスト応答（stop で turn 終了） | 白 ✓ | 白（維持） |
| `response_complete` の summary | 灰色 | **白/Markdown（最終応答へ昇格）** |

対象範囲: **スピナーモードのみ**。ストリーミングモード（`streamingDisplay=true`）は
ライブ出力で後から色を変更できないため今回は対象外（別タスク）。

## 3. 実装

### 3.1 遅延表示ヘルパー `flushAssistantText(dim)`

per-iteration（`agent-loop.ts:469-478` で宣言される `textContent` / `hasStartedOutput` の
スコープ内）に、ストリーミング for-await 完了直後にクロージャを定義する。

```ts
let assistantTextFlushed = false;
const flushAssistantText = (dim: boolean): void => {
  if (assistantTextFlushed || this.streamingDisplay || !hasStartedOutput) return;
  assistantTextFlushed = true;
  const filteredText = createThinkingFilter()(textContent);
  if (!filteredText.trim()) return;
  if (dim) {
    const indented = filteredText.split("\n").map((l) => "  " + l).join("\n");
    console.log("\n" + chalk.dim(indented));
  } else if (hasMarkdown(filteredText)) {
    console.log(renderMarkdown(filteredText));
  } else {
    console.log("\n" + filteredText);
  }
};
```

`assistantTextFlushed` で多重表示を防止（1 イテレーションにつき 1 回だけ表示）。

### 3.2 旧 811-821 ブロックの置換

- `toolCalls.length > 0` のテキストは「これから〜する」中間ナレーションと確定 → **その場で灰色 flush**。
- `toolCalls.length === 0` のテキストは「最終応答」か「自己点検で継続する中間」か未確定 →
  **ここでは出さず、下流のディスポジション地点で flush**。

```ts
if (toolCalls.length > 0) {
  flushAssistantText(true); // 中間ナレーション = 灰色
}
```

### 3.3 ディスポジション地点での flush

- 自己点検 4 経路（検証未実施 / Evaluator 不合格 / ツール未呼び出し / コードがテキスト）の
  `continue` 直前 → `flushAssistantText(true)`（灰色＝中間）
- 最終テキスト応答（`agent-loop.ts:1289` `final_text_response` 直前）→ `flushAssistantText(false)`（白）
- `response_complete` summary（`agent-loop.ts:947`）→ 灰色をやめ、白/Markdown で表示:

```ts
if (summary.length > 0) {
  console.log("\n" + (hasMarkdown(summary) ? renderMarkdown(summary) : summary));
}
```

（narration は同 turn の `toolCalls.length > 0` 経路で既に灰色 flush 済み。summary だけ白に昇格。）

## 3.4 ToDo 未完了ゲート（final_text_response 経路）— 挙動修正

色分けとは別の挙動課題として「ToDo 未完了なのにユーザーへ応答を返してターン終了する」
問題があった。ターン終了経路は 2 つある:

- `response_complete` 経路: `src/tools/definitions/response-complete.ts` に **未完了 todo ゲートあり**
  （open todo があり `force` でなければ `success:false` でブロック）。
- **`final_text_response` 経路**（`response_complete` を呼ばずテキストだけで返す `agent-loop.ts:1312`）:
  **ゲートが無かった**。再プロンプト判定 `shouldReprompt` は `!hasExecutedTools` が条件のため、
  一度でもツールを実行した後にテキストだけで返すと再プロンプトもスキップされ素通りで終了していた。

実ログ `2026-05-30T01-34-11_main.jsonl` では 21 ターン中 4 ターンがこの無ゲート経路で終了していた。

### 修正

`final_text_response` の直前にゲートを追加（ユーザー合意済み 2026-05-31、発火条件=タスク作業中のみ）:

```ts
if (hasExecutedTools && selfCheckRounds < MAX_SELF_CHECK_ROUNDS && !this.planManager?.isInPlanMode()) {
  const allTodos = getTodosCurrent();
  const openTodos = allTodos.filter((t) => t.status !== "completed");
  if (allTodos.length > 0 && openTodos.length > 0) {
    selfCheckRounds++;
    flushAssistantText(true); // 灰色
    // [自己点検 N/3] ToDo未完了 → nudge 注入して continue
    //   (1) 残項目を完了  (2) response_complete(force=true) で部分完了報告  (3) blocked + ask_user
    continue;
  }
}
// 上限到達などで未完了のまま抜ける場合は黄色で「ToDo N 項目未完了のまま応答」 を明示してから終了。
```

- 発火条件は `hasExecutedTools=true`（このターンで実装/検証ツールを実行済み = タスク作業中）のみ。
  会話的返答・挨拶では発火しない。
- 上限（`MAX_SELF_CHECK_ROUNDS`）で無限ループを防止。上限到達時は警告を出して終了。
- `ask_user` 等のツール呼び出しに移れば toolCalls 経路へ抜けるため、ゲートで詰まらない。

## 4. 影響範囲・非対象

- スピナーモードのみ。ストリーミングモードのライブ出力は変更しない。
- 履歴（`addAssistantMessage`）/ context への積み方は変更しない（表示のみの変更）。
- empty-response / garbage 経路は `hasStartedOutput=false` or 専用警告のため flush しない。

## 5. テスト

`hasMarkdown` の判定と、`response_complete` summary が白経路を通ることをユニットで担保する。
表示色（chalk.dim）は TTY 依存のため、ロジック分岐（dim/white の選択）をテスト対象とする。
最終的な対話品質はスピナーモードでの手動 TTY 確認が必要（パイプモードでは検証不可）。
