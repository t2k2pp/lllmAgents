# 応答テキストの色分け設計（構造ベース）

作成: 2026-05-31 (v1) / 改訂: 2026-06-12 (v2) / 対象: `src/agent/agent-loop.ts`

## 改訂履歴

| 版 | 日付 | 方針 |
|---|---|---|
| v1 | 2026-05-31 | 意味分類ベース: 「白＝最終応答だけ。中間ナレーションは灰色」 |
| v2 | 2026-06-12 | **構造ベース: モデルがユーザーに向けた言葉はすべて白。灰色はハーネスメタ情報のみ** (v1 の色分け方針を廃止) |

## 1. v2 の背景 — v1 で起きた事故

セッション `~/.localllm/logs/sessions/2026-06-11T22-02-08_main.jsonl`
（「自己紹介をして」「俳句を詠んで」「今、1ドル何円？」）で、**本物の回答が灰色表示**された。

- 「自己紹介をして」「俳句を詠んで」: モデルはツールなしのテキストで正しく回答したが、
  intent classifier が依頼を `task` と誤分類 → 自己点検「ツール未呼び出し」が発火 →
  回答テキストが「継続する中間テキスト」として `flushAssistantText(true)` で灰色化。
  次イテレーションの `response_complete` summary（「〜という依頼に対して回答しました」という
  メタ文）だけが白で表示された。
- 「1ドル何円？」: 回答本文と `response_complete` を同一応答で返したため、
  「ツール同伴テキスト＝中間ナレーション」の一律規則で本文が灰色化。

### 根本原因

v1 の色分けは「このテキストは本文か、つなぎか」という**意味の分類**をハーネスが推測していた。
意味の分類は将来の予測（このターンは続くか）と意図の推定（task か会話か）を含むため原理的に外れ、
外れたときの被害が「ユーザーへの言葉が読みづらい灰色になる」という最悪の形で出る。
テキストマッチングによる救済は全網羅不可能なので採らない（ユーザー合意 2026-06-12）。

## 2. v2 設計方針（ユーザー合意済み 2026-06-12）

Claude Code と同じ**構造ベース**に揃える。色は意味の推測でなく、出力の構造的事実だけで決める。

| 色 | 意味 | 対象 |
|---|---|---|
| **通常色（白/Markdown）** | モデルがユーザーに向けて発した言葉すべて | assistant テキスト全部（ツール同伴・自己点検継続を問わない） |
| **灰色（chalk.dim / gray）** | 視線を素通りしてよい情報 | thinking、スピナー、ツール実行サマリ、`[自己点検 N/M]` 等のハーネスメタ行、`[response_complete]` summary 行（本文と重複するため） |

- 「中間か最終か」の判定は**表示には一切使わない**。判定不要になるので誤分類が原理的に消える。
- 冗長なナレーション（「〜します」連発）が白で出てうるさくなる懸念は、色でごまかさず
  システムプロンプト側で抑制する（Claude Code と同じ扱い）。

### 2.1 `response_complete` summary の扱い

summary は設計上、本文の要約（重複情報）なので:

- **本文テキストが同伴する場合**（同一イテレーションに空でない assistant テキストがある）:
  summary は灰色メタ行 `[response_complete] <summary>`。スピナー/ストリーミング両モード統一。
- **本文が無い場合**（モデルが `response_complete` 単独で締めた）:
  summary がユーザーに向けた唯一の言葉なので**白/Markdown で表示**し、最終応答として扱う。

これも構造的事実（本文の有無）だけで決まり、テキストの中身は見ない。

### 2.2 final フラグ（チャネル通知用）— 表示と分離

`assistant_text` イベントの `final` と `runStats.finalText`（`task_complete.finalResponse` の源）は
CLI 表示と切り離し、構造で決める:

- `final=true`: span を終わらせる応答のテキスト
  - `response_complete` を含む応答の本文（無ければ summary）
  - ツールなしで turn が終わる最終テキスト（`final_text_response` / 自己点検上限到達）
- `final=false`: span が継続する応答のテキスト
  - 実行ツール同伴のナレーション、自己点検で continue する中間テキスト

エッジケース: `response_complete` 後に Q→A gate が stalled で span を継続させた場合、
本文は final=true で発火済みだが、後続イテレーションの最終テキストが `finalText` を上書きするため
`task_complete.finalResponse` は正しく最後の言葉になる。

### 2.3 既知の限界（色とは別の問題）

自己点検が誤発火した場合（例: 「俳句を詠んで」を task と誤分類）、本物の回答は
final=false で発火し、次イテレーションのメタ文（「既に上記で完了しています」）が
finalText になる。**CLI 表示は両方白なので可読性は損なわれない**が、チャネル
（Slack/Discord の `finalResponse`）にはメタ文が載る。根本対策は intent classifier の
分類精度改善で、本設計の範囲外（別タスク）。

## 3. 実装

### 3.1 `flushAssistantText(final)` — 表示は常に白、引数は final フラグへ意味変更

```ts
let assistantTextFlushed = false;
const flushAssistantText = (final: boolean): void => {
  if (assistantTextFlushed) return;
  const filteredText = createThinkingFilter()(textContent);
  if (!filteredText.trim()) return;
  assistantTextFlushed = true;
  // イベントは表示モードに依存せず発火する (チャネル購読者向け)
  this.events.emit("assistant_text", { text: filteredText, final });
  if (final) this.runStats.finalText = filteredText;
  // CLI 表示: ストリーミングモードはライブ出力済みのためここでは表示しない。
  // 構造ベース (v2): モデルがユーザーに向けた言葉はすべて白/Markdown — dim 分岐なし
  if (this.streamingDisplay || !hasStartedOutput) return;
  if (hasMarkdown(filteredText)) console.log(renderMarkdown(filteredText));
  else console.log("\n" + filteredText);
};
```

### 3.2 呼び出し箇所と final 値（すべて構造的事実）

| 箇所 | 構造的状況 | final |
|---|---|---|
| ツール呼び出し同伴テキスト | `response_complete` を含む → span 終了予定 | `toolCalls` に response_complete があれば true、無ければ false |
| 自己点検 4+1 経路（検証未実施 / Evaluator / ツール未呼び出し / コードブロック / ToDo 未完了）の continue 直前 | span 継続 | false |
| 自己点検上限到達で turn 終了 | span 終了 | true |
| `final_text_response`（ツールなしで turn 終了） | span 終了 | true |

### 3.3 `response_complete` summary 表示

```ts
if (summary.length > 0) {
  if (assistantTextFlushed || (this.streamingDisplay && hasStartedOutput)) {
    // 本文をユーザーが既に読んでいる → summary は重複情報 = 灰色メタ行 (両モード統一)
    console.log("\n" + chalk.dim(`  [response_complete] ${summary}`));
  } else {
    // 本文なし → summary がユーザーへの唯一の言葉 = 白/Markdown + 最終応答に採用
    this.events.emit("assistant_text", { text: summary, final: true });
    this.runStats.finalText = summary;
    console.log("\n" + (hasMarkdown(summary) ? renderMarkdown(summary) : summary));
  }
}
```

## 4. ToDo 未完了ゲート（final_text_response 経路）— v1 から継続

色分けとは独立の挙動として v1 で導入し、v2 でも維持する。

- `response_complete` 経路: `src/tools/definitions/response-complete.ts` に未完了 todo ゲートあり。
- `final_text_response` 経路: `hasExecutedTools=true` かつ未完了 todo がある場合、
  自己点検 nudge を注入して continue（上限 `MAX_SELF_CHECK_ROUNDS` で警告を出して終了）。

## 5. 影響範囲・非対象

- 履歴（`addAssistantMessage`）/ context への積み方は変更しない（表示とイベントのみ）。
- thinking の灰色表示（ストリーミングモードの `[思考]` ブロック等）は対象外（従来どおり灰色）。
- 自己点検ループ・intent classifier 自体は維持（色と切り離したので誤発火の被害は
  「余計な 1 往復」に縮退）。分類精度の改善は別タスク。

## 6. テスト

- 表示色は TTY 依存のため、パイプモード + `FORCE_COLOR=1` で ANSI コードを観察し、
  本文に dim (`\x1b[2m`) が付かないこと、`[response_complete]` 行に付くことを確認する。
- 最終的な対話品質はスピナーモードでの手動 TTY 確認が必要（パイプモードでは検証不可）。
