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
| UX-05 | P1 | 初回CI run `33443572716`のLinux/macOS実PTYで、親の`CI`環境変数を継承したOraが対話spinnerを無効化 | 対話PTY子だけ`CI`キーを除去し、非対話の親CI契約は維持 | interactive child env unit、run `33444396488`でspinner有効時の次問題へ到達 | 修正済み |
| UX-06 | P1 | run `33444396488`でもLinux/macOS実PTYがpreviewを観測せず、初回frameが従来placeholderのまま、本文は`start()`後のproperty差替えに依存していた | 最初の本文chunkからpreviewを組み立て、その文字列をspinnerの初回frameとして`start()`する | preview formatter unit、run `33445065726`で入力送信側の次問題へ到達 | 修正済み |
| UX-07 | P1 | run `33445065726`では入力・HTTP・表示のどこで停止したか判別不能だった。PageDownと本文も待機せず連続送信していた | prompt再描画後に本文を別chunkで送信し、`previewSubmitted` / `requestSeen` flagをActions annotationへ追加 | run `33445587420`で両flagがtrueとなり入力・HTTP到達を実証 | 修正済み |
| UX-08 | P1 | run `33445587420`は`previewSubmitted=true` / `requestSeen=true` / `previewSeen=false`。mock serverが`req.resume()`後に`end` listenerを登録し、短いbodyでeventを取り逃すraceがあった | `end` listenerを先に登録してからbodyをdrainし、`responseStarted` flagも追加 | run `33445892804`で両OSとも`responseStarted=true`を実証 | 修正済み |
| UX-09 | P1 | run `33445892804`は両OSで`responseStarted=true`でも`previewSeen=false`。user-visible statusがoraの複数writeを推定する経路だけに依存していた | ScreenManagerへ明示的な一過性status APIを追加し、受信chunkから直接更新・停止時解除 | ScreenManager unit、次runのLinux/macOS実PTY | 修正済み・CI再検証待ち |
| UX-10 | P1 | run `33446816215`も両OSで`responseStarted=true` / `previewSeen=false`。明示status APIが初回可視tokenを16msのframe queueへ戻し、描画中は更新要求を捨てる契約だった | 初回preview更新は予約済みframeを取消して同期描画し、unitもtimerを進めず表示を要求 | ScreenManager immediate-render unit、次runのLinux/macOS実PTY | 修正済み・CI再検証待ち |
| UX-11 | P1 | run `33447276315`のmacOSでも同期描画後に`previewSeen=false`。provider単体では先頭chunkを約21msでyieldしたため、AgentLoop到達と画面反映の境界が未確定 | 明示debug時だけ本文非記録のTTY/alternate/exclusive/chunk到達情報を出し、PTY annotationへ`previewChunkSeen`を追加 | run `33447866610`で両OSとも`previewChunkSeen=false`を実証 | 修正済み |
| UX-12 | P1 | run `33447866610`はmock側の`responseStarted=true`でもAgentLoopにchunk未到達。mockが`writeHead`/`write`の呼出時刻だけを記録し、先頭SSE byteのflush境界を保証していなかった | `flushHeaders()`と`setNoDelay(true)`後に先頭chunkを書き、`firstChunkWritten`もannotationへ追加 | run `33448302713`で両OSとも`firstChunkWritten=true`を実証 | 修正済み |
| UX-13 | P1 | run `33448302713`は先頭chunk書込後も`previewChunkSeen=false`。provider parserとAgentLoopのどちらで停止したか、また別POSTを誤計測したか未確定 | 明示debug時に本文非記録のSSE text delta到達を出し、`postRequests` / `providerTextChunkSeen`をPTY annotationへ追加 | run `33465117715`で両OSとも`postRequests=1` / `providerTextChunkSeen=true`を実証 | 修正済み |
| UX-14 | P1 | run `33465117715`はparser到達後もpreview分岐へ未到達。VLLM think-filter出口かAgentLoopのdisplay mode分岐か未確定 | think-filter出口、AgentLoop text入口、`streamingDisplay`値を本文非記録の明示debug flagとしてannotationへ追加 | run `33465444230`で両OSともfilter出口・AgentLoop到達、`streamingDisplay=false`を実証 | 修正済み |
| UX-15 | P1 | run `33465444230`はbuffered分岐へ到達後、最初のpreview組立前で停止。待機spinner停止、thinking解除、think-tag filterのどこか未確定 | 3境界を個別の本文非記録flag / filtered文字数としてannotationへ追加 | run `33465741626`で両OSとも`waitingSpinnerStopped=false`を実証 | 修正済み |
| UX-16 | P1 | Linux/macOS実PTYだけでOraの待機spinner停止が戻らず、受信済みtextのpreview処理を塞ぐ。疑似TTY単体では再現せず端末実装依存 | alternate screenの待機・thinking・preview状態をScreenManager直接管理へ統一し、Oraは通常画面だけで使用 | ScreenManager unit、次runのLinux/macOS delayed SSE実PTY | 修正済み・CI再検証待ち |
| UX-17 | P1 | run `33466220944`のUbuntuは`previewSeen=true` / `previewBeforeFinal=true`で本機能は合格したが、最終本文表示と次の入力欄復帰の間にPTY試験が`/quit`を送りtimeout | Linux/macOSとも次の`> `プロンプト復帰を観測してから`/quit`を送る案を検証 | run `33466602563`で両OSともalternate-screenの復帰promptを生byte列では安定観測できないと判明 | UX-18へ再設計 |
| UX-18 | P1 | run `33466602563`は両OSともpreview先行表示に合格したが、alternate-screenの復帰promptを生byte列`> `で観測できず試験が終了操作を送れなかった | preview表示直後のrun中type-aheadへ`/quit`を送り、最終本文後にキューから安全に終了する実ユーザー経路を検証 | PTY driver unit、次runのLinux/macOS delayed SSE実PTY | 修正済み・CI再検証待ち |
| UX-19 | P1 | run `33466869961`は両OSとも`quitSent=true`でもtimeout。応答ループ、type-ahead受理、終了cleanupのどこで停止したか未確定 | 最終本文・キュー追加・追加入力処理・Goodbyeの既存表示を本文非記録flagとしてannotationへ追加 | run `33467086493`のUbuntuで`finalSeen=true` / `quitQueuedSeen=true` / `pendingQuitSeen=false` / `goodbyeSeen=false`を実証 | 修正済み |
| UX-20 | P1 | 最終本文後の`response_complete`実行でも共通`createSpinner`がOraを起動し、alternate-screen実PTYの`succeed`で停止。待機spinnerと同根だがツール表示経路に残存 | alternate-screenではOraのtimer/stopを起動せず、互換操作をScreenManagerの一過性statusと確定行へ写像。通常画面は従来Oraを維持 | managed spinner unit、次runのLinux/macOS delayed SSE実PTY | 修正済み・CI再検証待ち |

## 5. 評価

- baseline: 通常権限で122 files（2 skipped）、1288 tests（11 skipped）成功。sandbox内のVitest起動は既知のesbuild parent directory access制限で失敗し、通常権限で製品不具合でないことを確認。
- targeted: OpenAI-compatible provider、ScreenManager、response preview、PTY driver、agent-loop salvageの5 files・95 tests成功。
- build/typecheck: `npm run build`成功。
- lint: error 0。既存279 warnings / 97 infosはnon-blocking設定。
- full unit: 123 files（2 skipped）、1294 tests（11 skipped）成功。
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
