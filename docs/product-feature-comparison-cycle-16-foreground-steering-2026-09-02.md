# Codex / Claude Code 機能比較・商品品質改善 cycle 16

- 実施日: 2026-09-02
- 基準commit: `dc377c9`
- 対象gap: `GAP-STEER-01`
- 観点: 長時間のforeground処理中に届いたユーザーの訂正・追加条件を、失わず、手遅れになる前に現在の処理へ反映できること
- 状態: **実装・ローカル評価完了**（cross-OS実PTY／deployの終端はpush後の最新SHA CIを正本とする）

## 1. 比較根拠

- OpenAI Codex app-serverは、実行中の通常turnへ追加入力を追加する`turn/steer`を公開し、active turn ID不一致やsteer非対応turnを明示エラーにする: [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#example-steer-an-active-turn)
- Codex TUIは、将来turn用の`queued_user_messages`、送信済みで履歴確定待ちの`pending_steers`、steer拒否後の再試行queueを別FIFOとして保持し、previewにも分けて出す: [input_queue.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/input_queue.rs)
- Claude Codeは、処理中にEnterで送った通常メッセージをqueueし、tool call中ならtool完了直後に同じturnへ渡す。turn終了時に残れば最古1件を次turnに送り、command／shell commandはturn終了まで保持する。Escはqueueを保持したままturnを中断する: [Interactive mode](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)
- 本アプリにはraw stdinを受ける`startTypeAhead()`と`pendingInputs`があった。しかし全入力を`AgentLoop.run()`完了後の`drainPendingInputs()`で別turnとして処理し、実行中runのhistoryへ入れる経路はなかった。

## 2. 機能比較マトリックス

凡例: `◎` user-facing contractとして利用可能、`○`一部あり、`△`近い構成要素だけ、`—`確認した公式資料／実装に無し。

| 比較項目 | Codex | Claude Code | cycle 15以前 | cycle 16結果 |
|---|---|---|---|---|
| 処理中の通常入力受付 | ◎ | ◎ | ○ raw type-ahead | ◎ 維持 |
| 現在turnへのsteer | ◎ `turn/steer` | ◎ tool完了後 | — turn全体完了後に別run | ◎ reply／tool境界で同じrun |
| 将来turn用queueとの分離 | ◎ separate FIFO | ◎ messageとcommandを分離 | — 全て`pendingInputs` | ◎ 通常message=steer、command=turn後 |
| 安全な反映境界 | ◎ active regular turn | ◎ current tool群完了後 | — | ◎ reply完了／tool result記録後 |
| FIFO・上限 | ◎ FIFO | ◎ FIFO | ○ FIFO、上限なし | ◎ steer 20件・各4000文字 |
| 受理・反映の可視性 | ◎ preview分類 | ◎ 入力欄上に一覧 | ○ turn後queue件数だけ | ○ 受理件数・反映境界を即時表示 |
| queueの取り戻し・個別編集 | ◎ | ◎ Upで入力欄へ戻す | △ `/queue clear`一括のみ | △ 維持（残差） |
| hard interruptとの分離 | ◎ | ◎ Ctrl+C/Esc | ◎ ESC/Ctrl+C | ◎ 維持、未反映入力を次turnへ救出 |
| 実行中command | surface依存 | ◎ 一部即時、他はturn後 | ○ 全てturn後 | ○ turn後を明示 |
| background sub-agent steer | ◎ | ◎ agent/team message | ◎ `task_send` | ◎ 維持 |

## 3. 発見事項・設計・終端状態

| ID | 優先度 | 症状・原因 | 改善設計 | 回帰証拠 | 状態 |
|---|---|---|---|---|---|
| STEER-01 | P1 | `pendingInputs`を`AgentLoop.run()`終了後にしかdrainせず、長いtool連鎖への訂正が手遅れになる | `AgentLoop.queueSteering()`を追加し、reply完了／tool result記録直後にFIFO user messageを同じrunへ注入 | reply境界・tool境界integration | 修正済み |
| STEER-02 | P1 | 実PTYは処理中`/quit`の次turn実行だけを検証し、通常messageの同一turn反映を検出できない | delayed SSE中に通常messageを送り、2回目のLLM要求と`STEER_OK`応答を必須化 | PTY driver unit成功。Linux/macOS実PTYはCIで実行 | 実装済み・CI待ち |
| STEER-03 | P2 | queueが無制限で、受理不能状態の契約もなかった | steerを20件・各4000文字に制限し、空・超過・満杯・非実行中を状態で返してUIに理由表示 | limit unit | 修正済み |
| STEER-04 | P1 | abort/errorが反映境界より先に終わると、AgentLoop側へ渡した入力の所有者が曖昧になり得る | REPL finallyで未反映steerをtakeし、turn後FIFOへ移して表示 | queue ownership unit・既存abort経路 | 修正済み |
| STEER-05 | P2 | 処理中入力は受理件数だけで、一覧・個別編集・取り戻しUIがない | composerを常時表示するTUI再設計が必要 | 比較差分 | 範囲外。今回の同一turn反映gateを妨げないUX拡張 |
| STEER-06 | P1 | 初期実装は`isProcessing`だけを所有権判定に使い、REPLがRoomRunQueueを待つ間のDiscord/Slack runへ誤注入し得た | active `currentSource=cli`も必須にし、別surface中はturn後FIFOへ保持 | cross-surface ownership unit | 修正済み |

設計上、steerは現在のLLM接続やtoolを強制停止しない。通常replyなら生成終了後、tool callなら現在のtool群を完了してresult pairingを履歴へ記録した後に反映する。即時停止の意図は既存ESC/Ctrl+Cへ残し、queueとinterruptを混同しない。

## 4. 評価

- 変更前baseline: 関連3 files・12 tests成功、build成功。lintはerror 0、既存warning 279 / info 97。sandbox内Vitestは既知のesbuild parent-directory access拒否になり、通常権限で再現しないことを確認。
- TDD red: 新規integration 3件は`queueSteering is not a function`、別turnのまま最大50要求へ進むことで失敗。
- targeted: steering、Room所有権、terminal input、PTY driverの5 files・23 tests成功。新規integrationはreply境界、tool result後のFIFO、入力上限、cross-surface誤注入防止を確認。
- full unit: 128 files成功・2 files skipped、1317 tests成功・11 tests skipped。
- E2E: 非TTY REPL 7 tests成功。coverageも同じ1317 tests成功、statements / lines 43.33%、branches 76.19%、functions 66.68%。
- build / lint: TypeScript build成功。lintはerror 0、既存warning 279 / info 97。
- package / policy: skill validation、version policy、npm package validation（540 files、9.3 MiB）、OS非依存runtime audit（high以上0件）成功。
- Windows SEA: fresh `dist/localllm.exe`を生成し、`--version`、`--help`、`--check-computer-use`がexit 0。既存`deploy/localllm.exe`をPID 27604が実行中のためdeploy directory上書きはfail-fastし、processを停止しなかった。clean checkoutのdependent Windows deploy / exe smokeを最新SHA CIで閉じる。
- Linux/macOS実PTY: push後CIでdelayed SSE preview、通常type-ahead受理、同一runの2回目要求、終了まで確認する。

## 5. 完了gate

- [x] 公式一次資料と現行sourceによる比較
- [x] P1 gapの原因・影響・設計を記録
- [x] reply/tool両境界の実装とintegration test
- [x] 全ローカル品質gate（実行中deploy binaryの上書きだけCIへ移管）
- [ ] Linux/macOS実PTY
- [ ] task差分だけをcommit/push
- [ ] 最新push SHAの全依存CI job
