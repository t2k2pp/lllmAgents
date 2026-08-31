# Codex / Claude 応答可視性比較・商品品質改善 cycle 13

- 実施日: 2026-08-31〜2026-09-01
- 基準commit: `02d7bda`
- 対象gap: `GAP-UX-01`
- 観点: ユーザーが「応答が返ってこない」と感じる空白時間と、受信済み本文の可視性
- 状態: 実装・ローカル品質gate済み（実PTYとlatest push SHAのCIはcommit後の完了条件）

## 1. 比較根拠

- OpenAIの[Model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5)は、streaming UIでは最初の可視応答までの時間が体感を左右し、長いtool workflowでは短いuser-visible preambleを先に出すこと、tool-heavy flowで`phase`とpreambleを正しく扱うことを推奨する。
- OpenAIの[Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)は、responseが`in_progress`状態を持ち、streamingでtext/tool output deltaを扱えることを示す。
- Anthropicの[Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)は、`stream-json`、turn-by-turnを表示する`--verbose`、partial streaming eventを含める`--include-partial-messages`、長時間hookの`hook_progress`を提供する。
- 本アプリはproviderから`stream:true`でchunkを受け、system promptも開始時の短い方針/完了level宣言を要求していた。しかし既定の`streamingDisplay=false`では本文を完了までbufferし、UIにはtoken数だけを出していた。

## 2. 機能比較マトリックス

凡例: `◎` user-facing contractとして利用可能、`○` 構成要素あり、`△` opt-inまたは既定経路に欠落、`—` 調査した公式資料で同等記載を確認できず。

| 比較項目 | Codex / OpenAI | Claude / Anthropic | cycle 12以前 | cycle 13結果 |
|---|---|---|---|---|
| text deltaのstream | ◎ Responses streaming | ◎ `stream-json` partial messages | ◎ 全主要providerで受信 | ◎ 維持 |
| 最初のuser-visible update | ◎ tool前preambleを推奨 | ○ verbose/partial turn output | △ modelへ要求するが既定UIがbuffer | ◎ 最初の本文chunkからlive preview |
| 長時間処理の状態 | ◎ `in_progress` / phase | ◎ hook progress / verbose | ◎ 待機秒・thinking・tool spinner | ◎ 本文previewと経過/速度を同居 |
| 最終Markdown品質 | surface依存 | surface依存 | ◎ buffered modeで確定render | ◎ 確定renderを維持 |
| 狭幅・日本語TTY | 公式資料の確認範囲外 | 公式資料の確認範囲外 | ○ TUI幅計算あり | ◎ grapheme表示幅でpreviewを切詰め |
| previewの安全性 | surface依存 | surface依存 | — | ◎ ANSI/control除去、thinking非表示 |
| 実端末の回帰検出 | 製品側eval | 製品側eval | △ PTYは起動/入力/scrollのみ | ◎ delayed SSEでpreview先行を検証 |

## 3. gap選定と設計

`GAP-UX-01`をP1として選んだ。実際のmodel/APIレイテンシとは別に、既に到着したassistant textをUIが隠し、長文生成では体感TTFTを生成完了時刻まで延ばしていたためである。

全面streamingを既定化すると、生成途中のtable/code fenceが崩れ、既存のMarkdown確定表示というproject慣行を失う。本cycleではその規約を変えず、次のhybrid契約を追加した。

1. `streamingDisplay=false`でも、thinkingを除いた受信済みassistant textを一過性の1行previewへ出す。
2. previewは意味分類・要約をせず、改行、ANSI、control characterだけを除く。
3. terminal幅を超えず、日本語/emojiはdisplay width単位で切り詰める。48桁未満ではtoken統計より本文を優先する。
4. previewはscrollback/historyへ確定記録せず、完了時は従来のMarkdown本文だけを残す。
5. providerがtextを出さずtool callだけ返す場合は、既存のtool summary spinnerを表示する。存在しない本文を捏造しない。

## 4. 発見事項と回帰証拠

| ID | 優先度 | 症状・原因 | 修正 | 回帰証拠 | 終端状態 |
|---|---|---|---|---|---|
| UX-01 | P1 | default UIが受信済み本文を完了までbufferし、「返ってこない」空白を作る | `formatBufferedResponseStatus`を受信chunkごとにspinnerへ反映 | preview unit、delayed SSE PTY | 修正済み |
| UX-02 | P1 | 既存PTY smokeはLLMを呼ばず、表示回帰を検出できない | mock LLMが先頭text後にfinalを3秒保留し、2秒以内のpreview表示を必須化 | Linux `script` / macOS `expect` CI経路 | 修正済み |
| UX-03 | P2 | 生chunkを状態行へ出すとANSI/controlで描画を壊し得る | SGR/control除去と空白正規化 | ANSI/newline/BEL unit | 修正済み |
| UX-04 | P2 | 固定文字数truncateは日本語の全角幅で折返す | 共通display-widthで列幅truncate、狭幅は本文優先 | 幅20の日本語unit | 修正済み |
| UX-05 | P1 | 初回CI run `33443572716`のLinux/macOS実PTYで、親の`CI`環境変数を継承したOraが対話spinnerを無効化 | 対話PTY子だけ`CI`キーを除去し、非対話の親CI契約は維持 | interactive child env unit、次runのLinux/macOS実PTY | 修正済み・CI再検証待ち |

## 5. 評価

- baseline: 通常権限で122 files（2 skipped）、1288 tests（11 skipped）成功。sandbox内のVitest起動は既知のesbuild parent directory access制限で失敗し、通常権限で製品不具合でないことを確認。
- targeted: response preview、PTY driver、agent-loop salvageの3 files・11 tests成功。
- build/typecheck: `npm run build`成功。
- lint: error 0。既存279 warnings / 97 infosはnon-blocking設定。
- full unit: 123 files（2 skipped）、1293 tests（11 skipped）成功。
- E2E: 7 tests成功。
- coverage: statements 42.76%、branches 75.69%、functions 65.64%、lines 42.76%。
- skill/package: 25 skills検証成功。package dry-runは538 files、9.3 MiBで成功。
- runtime audit: production dependencyはhigh以上を含め0 vulnerabilities。
- Linux・macOS実PTY / latest SHA CI: commit前のため未実施。push後に同じcycleの完了gateとして確認する。

## 6. 残差

| ID | 優先度 | 内容 | 状態 |
|---|---|---|---|
| UX-R1 | P2 | modelが最初のtext chunk自体を長時間返さない場合、previewは出せない | 範囲外。待機秒・context量は表示済み。provider/modelの実TTFT改善は別lever |
| UX-R2 | P2 | Windows CIには対話console hostがなく実PTY smokeを実行できない | blocked。Windowsはunit/build/E2E、実PTYはLinux/macOSで同じScreenManager契約を検証 |
| UX-R3 | P3 | multi-line live Markdown preview | 範囲外。1行previewと最終Markdownの非重複を優先し、画面置換APIなしでの擬似再描画は行わない |

## 7. 完了gate

- [x] 公式資料による比較マトリックスとgap選定
- [x] 原因・影響・修正・回帰testを記録
- [x] 既存buffered Markdown規約を維持したhybrid設計
- [x] targeted test / build
- [x] full unit / E2E / coverage / lint / package / audit
- [ ] Linux/macOS delayed SSE実PTY
- [ ] task差分だけをcommit/push
- [ ] latest pushed SHAの全依存CI job
