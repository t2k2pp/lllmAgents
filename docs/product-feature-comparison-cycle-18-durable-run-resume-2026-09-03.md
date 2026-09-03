# 商品品質レビュー cycle 18: durable run resume

- 日付: 2026-09-03
- 観点: Codex / Claude Code開発者、local LLM運用、再起動耐性、二重tool防止
- 課題: `GAP-DURABLE-RUN-01`
- 状態: **完了（実装・全ローカル評価・訂正後最新実装SHA CI全5ジョブ成功）**


## 機能比較マトリックス

| 利用者の操作 | OpenAI Codex | Claude Code | cycle 17 | cycle 18 |
|---|---|---|---|---|
| 保存conversationを選んで復元 | `codex resume` / `/resume` | `--resume` / `-r` | `/resume` / `/continue` | 維持 |
| foreground runをAPI境界でプロセス内pause | 公式資料で同等契約を確認できず | 公式資料で同等契約を確認できず | `/run pause` | 維持 |
| background sessionのstop/restart | background terminal管理 | `stop` / `respawn` | `/tasks`等 | 対象外を明示 |
| pause後にアプリ・PCを停止 | conversation復元とは別 | conversation復元とは別 | 不可 | `/run pause --durable`到達後に可 |
| 復元sessionのrun継続を明示開始 | conversation resume | conversation resume | 不可 | `/resume <id>` → `/run resume` |
| cwd/model/provider差分の診断 | cwd差分を選択 | 起動flagで指定 | なし | `/run inspect` + fail-fast |
| resume途中の不明状態を自動再実行しない | 公開CLI契約外 | 公開CLI契約外 | なし | `blocked_unknown_progress` |

一次資料:

- [OpenAI Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)

## 抜けと優先順位

| ID | 優先度 | 抜け | 改善 | 評価 |
|---|---:|---|---|---|
| DUR-01 | P1 | process-memoryのpauseはPC再起動で消える | versioned checkpointをsession JSONへatomic保存 | schema test |
| DUR-02 | P1 | conversation復元だけではrun制御位置が戻らない | 次LLM API前のiteration/run stateをrehydrate | 別AgentLoop integration |
| DUR-03 | P1 | pause前toolの再実行は副作用を重複させる | tool result pairing確定後だけdurable_pausedへ遷移 | execution count回帰 |
| DUR-04 | P1 | resume中の強制終了は到達点不明 | `resuming`を永続化し次回自動resumeを拒否 | blocked state回帰 |
| DUR-05 | P1 | cwd/model/provider差分で誤作業し得る | fingerprint比較、差分表示、明示discard | validation test |
| DUR-06 | P2 | `resume`語がsession/runで衝突する | `/resume`=session、`/run resume`=runを維持 | command registry回帰 |
| DUR-07 | P2 | 診断にprompt/tool引数を出すと秘密を漏らす | inspectは件数・ID・差分だけ表示 | command test |
| DUR-08 | P1 | pause中の`/parallel`がturn後FIFOではresumeまで反映されない | paused中だけ即時commandとして適用 | 実PTY smoke |

## 実装境界

- `RunApiGate`: process pauseとdurable requestを区別。durableはprovider完了だけでpausedにせず、AgentLoopが保存後に到達させる。
- `AgentLoop`: 次API直前に履歴・Todo・Goal・run stateを保存。restoreはrehydrateだけで自動実行しない。
- `SessionData`: optional `runCheckpoint`。unknown schemaをready扱いせず、forkへ複製しない。
- CLI: `/run pause --durable|status|inspect|resume|discard`。既存`/resume`を変更しない。
- 安全性: endpointはSHA-256 fingerprintだけを保存。resume開始を先に保存し、異常終了時は自動再実行しない。

## 評価記録

- 基準: 4 files / 23 tests成功。
- 実装後対象: 5 files / 30 tests成功。
- 別AgentLoop試験で、pause前tool 1回、再開後API 1回、tool result引継ぎ、正常完了時checkpoint削除を確認。
- `test:coverage`: 130 files成功 / 2 files skip、1331 tests成功 / 11 tests skip。statement/line 43.91%、branch 76.26%、function 67.54%。
- `test:e2e`: 7 tests成功。`lint`、`build`、`test:durable-restart`、`validate:package`、`validate:version`、`validate:skills`成功。
- Windowsローカルのcross-process smokeで、別processへのsession JSON引継ぎ、API 1回、tool非再実行、checkpoint削除を確認。
- 配布: `build:deploy`成功。SEA / deployの`localllm.exe --version`はいずれも`v0.4.1 (build c72872d-dirty)`でexit 0。
- 監査: cycle中に新規検出した`fast-uri 3.1.5` High 5件と`qs 6.15.3` Moderate 5件を、それぞれ互換修正版`3.1.7` / `6.16.0`へlockfile更新。production auditは0 vulnerabilities。
- 初回push CI `33738112466`: Commit policy、Ubuntu test（Linux実PTY含む）、Windows testは成功。macOS実PTY smokeだけが失敗した。macOSの`expect`プログラムに`/parallel 4`の送信手順が抜けており`parallelSent false`となったことが原因。`EXPECT_PROGRAM`へ`/parallel 4`送信と`driver.parallelSentMarker`の検出を追加し、期待順（`pause到達 → /parallel 4適用 → resume`）を修正した。
- 訂正後最新実装SHA `bd5d1f9` / CI `33748152471`: Commit policy、Ubuntu / macOS / Windows tests、Linux / macOS実PTY、Windows deploy / exe smokeの全5 job成功。

