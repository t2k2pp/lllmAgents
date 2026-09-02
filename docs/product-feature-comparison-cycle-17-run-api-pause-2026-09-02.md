# Codex / Claude Code 機能比較・商品品質改善 cycle 17

- 実施日: 2026-09-02
- 基準commit: `87274f0`
- 対象gap: `GAP-PAUSE-01`
- 観点: local LLMを運用中に再起動・並列数変更できる、安全で可視なforeground run停止境界
- 状態: **完了（実装・全ローカル評価・最新実装SHA CI成功）**

## 1. 比較根拠

- OpenAI Responses APIはbackground responseのcancel、状態poll、切断後のstream再接続を提供する。一方、同期responseは接続終了によるcancelであり、agent runを「現在のresponse完了後・次response開始前」に保持する契約は公式資料で確認できない: [Background mode](https://developers.openai.com/api/docs/guides/background)
- Claude Code foregroundは`Ctrl+C`/`Esc`で現在処理をinterruptできる。background sessionは`stop`とconversationを保った`respawn`を提供する: [Interactive mode](https://code.claude.com/docs/en/interactive-mode), [Agent view](https://code.claude.com/docs/en/agent-view)
- 本アプリはhard interrupt、保存sessionの`/resume`、background taskの`task_cancel`、foreground steeringを備えていた。しかしlocal LLM運用のため「今のAPIだけ完了させ、後続APIを出さずに同じrunを保持する」操作は無かった。

## 2. 機能比較マトリックス

凡例: `◎` user-facing contract、`○`一部対応、`△`近い構成要素のみ、`—`確認した公式資料・実装に無し。

| 比較項目 | OpenAI Codex / API | Claude Code | cycle 16以前 | cycle 17結果 |
|---|---|---|---|---|
| foreground hard interrupt | ○ 同期responseは接続終了 | ◎ `Ctrl+C` / `Esc` | ◎ `Esc` / `Ctrl+C` + HTTP abort | ◎ 維持 |
| 処理中の追加指示 | ◎ steer相当 | ◎ message queue | ◎ 同一run steering | ◎ 維持 |
| 保存conversationの復元 | ○ conversation / response継続 | ◎ `--resume` | ◎ `/resume` / `/continue` | ◎ 維持 |
| background停止・再起動 | ◎ cancel / stream再接続 | ◎ `stop` / `respawn` | ○ `task_cancel`（respawnなし） | ○ 今回のforeground範囲外 |
| 現APIを完了してrunを境界停止 | — | — | — | ◎ `/run pause` |
| 停止中の同じrunを再開 | — | △ background `respawn` | — | ◎ `/run resume` |
| pause予約・到達・API実行数の可視性 | — | △ stopped表示 | — | ◎ statusと到達表示 |
| session resumeとの名前衝突回避 | n/a | n/a | `/resume`使用済み | ◎ `/run`名前空間 |

比較上の抜けは、competitorのinterrupt・background lifecycleに隣接しつつ、local LLMの運用に必要な`GAP-PAUSE-01`である。強制cancelは生成途中を捨て、通常turn完了待ちは次のAPIを自動発行するため、どちらも再起動窓の要求を満たさない。

## 3. 発見事項・設計・終端状態

| ID | 優先度 | 症状・原因 | 改善設計 | 回帰証拠 | 状態 |
|---|---|---|---|---|---|
| PAUSE-01 | P1 | 長いagent run中はmain LLMが次APIを自動発行し、local serverの安全な再起動窓を予約できない | `running → pause_requested → paused → running`のrun gate。進行中APIは完了、後続処理は境界で待機 | AgentLoop integration | 修正済み |
| PAUSE-02 | P1 | 主応答だけを止めてもcontext整理・分類器等が同じproviderへAPIを出し得る | providerの`chat` / `chatWithTools` / `chatWithVision`をProxyで一括gateし、provider固有メソッドは保持 | 3 API経路unit | 修正済み |
| PAUSE-03 | P1 | slash commandは全てturn後FIFOだったため、処理中pauseを入力しても手遅れになる | type-ahead中の`/run`だけを即時処理。その他commandの既存順序は維持 | command + 実PTY driver | 修正済み |
| PAUSE-04 | P1 | `/resume`は保存session復元、`/continue`もそのaliasで意味が衝突する | `/run pause|resume|status`へ分離し、`/resume`を変更しない | registry回帰 | 修正済み |
| PAUSE-05 | P1 | pause中のEscでgate待ちだけ解け、response内のtoolを実行すると中断契約に違反する | abortでgate waiterとHTTP signalを解放し、stream直後にabortを再検査 | AgentLoop回帰 | 修正済み |
| PAUSE-06 | P2 | foreground pauseをglobal停止と誤認するとbackground/second LLMがlocal serverを利用し得る | 到達表示とstatusで対象をmain foreground runと明示し、backgroundは`/tasks`案内 | UI文言 | 修正済み |

## 4. 実装契約

1. `/run pause`はCLI foreground runだけを対象とする。API実行中なら`pause_requested`となり、そのAPI接続は切断しない。
2. tracked main APIが0件になった時点で`paused`を表示する。API responseを受けた後の新規tool実行も`/run resume`まで進めない。pause要求時に既に動いているtool群は完了させる。
3. pause中は全main provider chat経路の新規開始を拒まず待機させる。暗黙のcancel・別modeへのfallbackはしない。
4. `/run resume`は同じrunを続ける。境界到達前ならpause予約の取消として扱う。
5. `Esc`/`Ctrl+C`はpause中もhard interruptとして働く。run終了時はgateを必ず`idle`へ戻す。
6. background taskとsecond LLMは独立した実行であり、自動停止しない。globalに安全な再起動が必要なら`/tasks`で停止状態も確認する。

## 5. 評価

- 変更前baseline: 対象3 files・15 tests成功、build成功。lintはerror 0、既存warning 279 / info 97。sandbox内Vitestのesbuild parent-directory access拒否は通常権限で再現しなかった。
- 対象回帰: API gate、AgentLoop integration、command registry、PTY driverの4 files・21 tests成功。
- 全体回帰: 129 files passed / 2 skipped、1323 tests passed / 11 skipped。coverageはStatements 43.63%、Branches 75.97%、Functions 67.19%、Lines 43.63%。
- build / lint: TypeScript build成功。lintはerror 0、既存warning 279 / info 97。
- E2E: 1 file・7 tests成功。
- 配布・静的gate: `validate:package`（544 files、9.4 MiB）、`validate:version`、`validate:skills`、production audit（脆弱性0）成功。
- Windows配布: `build:deploy`でSEA、skills 19件、agents 5件を生成し、`deploy/localllm.exe --version`が`v0.4.1 (build 87274f0-dirty)`でexit 0。
- 初回push CI `33642671572`: UbuntuとWindowsは成功。macOSの実PTYだけが失敗した。製品側はpause到達済みだったが、`expect` driverがbuffered final表示をpause到達前に待ってresumeを送れない順序誤りが原因。`pause到達 → resume → final表示`へ期待順を修正し、対象4 files・21 testsとbuild / formatを再確認した。
- 訂正後CI `33643363220`: macOS実PTYが再失敗。`expect`のpause正規表現がヘルプ欄の説明へ誤一致し、実到達前の`pause_requested`をresumeしていた。実到達メッセージ`runをLLM API境界で一時停止しました`との一致を必須化した。
- 最新実装SHA `da669e5` / CI `33643890486`: commit policy、Ubuntu / macOS / Windows tests、Linux / macOS実PTY、Windows deploy / exe smokeの全5 job成功。

## 6. 完了gate

- [x] 現行の公式一次資料による比較とmatrix
- [x] P1 gapの原因・影響・設計を記録
- [x] main provider全chat経路のgateとcommand名前分離
- [x] 対象unit / integration / PTY driver回帰
- [x] 全ローカル品質gate
- [x] Linux/macOS実PTYでpause中に2回目APIが始まらないことを確認
- [x] task差分だけをcommit/push
- [x] 最新実装SHAの全依存CI job成功
