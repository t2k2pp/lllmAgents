# Codex / Claude Code 機能比較・商品品質改善 cycle 20

- 実施日: 2026-09-05
- 基準commit: `d720c4f`
- 対象gap: `GAP-INTERACTIVE-RESUME-01`
- 観点: 長時間runの操作可能性、session再開時の視覚的連続性、モード切替、配布診断性
- 状態: **実装・ローカル品質gate通過（最新SHA CI待ち）**

## 1. 比較根拠

- Codexは`/resume`で選択したchat transcriptを再読込し、元の履歴を保ったまま継続する: [OpenAI Developer commands](https://developers.openai.com/codex/cli/reference)
- Claude Codeは作業中も入力欄へ文字を入力でき、Enterでqueueし、queued entryを入力欄上に表示する。通常messageはtool群完了後の同じturnへ渡す: [Claude Code Interactive mode](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)
- Claude Codeは`Shift+Tab`でpermission modeを循環し、Plan modeも同じ操作で選べる: [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works#control-what-claude-can-do)
- Claude Code sessionはlocal transcriptとして継続保存され、resumeでconversationとsession stateを復元する: [Manage sessions](https://code.claude.com/docs/en/sessions)
- 本アプリはcycle 16で同一turn steering、cycle 18でdurable run resumeを実装済みだった。しかし処理中入力はraw stdinを非表示で読むだけで、保存sessionもmessage履歴だけを復元していた。

## 2. 機能比較マトリックス

凡例: `◎` user-facing contractとして利用可能、`○`一部あり、`△`内部要素だけ、`—`無し。

| 比較項目 | Codex | Claude Code | d720c4f時点 | cycle 20結果 |
|---|---|---|---|---|
| session選択・conversation復元 | ◎ | ◎ | ◎ `/resume` / `--resume` | ◎ 維持 |
| resume時の過去transcript再表示 | ◎ | ◎ | — messageだけ復元し画面は戻らない | ◎ 確定stdoutをsession別復元 |
| LLM処理中の入力欄 | ◎ | ◎ | △ raw受信のみ、入力文字が見えない | ◎ 固定composerで編集内容を表示 |
| 通常messageの同一turn steering | ◎ | ◎ | ◎ reply/tool境界 | ◎ 表示可能なcomposerから利用可能 |
| 実行中commandの振り分け | ○ | ◎ | ◎ `/run`即時、他はturn後 | ◎ 維持 |
| modeのkeyboard循環 | ○ command/picker | ◎ `Shift+Tab` | — | ◎ 通常→Autorun→Plan→通常 |
| queue一覧・入力欄への取り戻し | ○ | ◎ `Up` | △ 件数と`/queue clear` | △ 残差 |
| PC再起動を跨ぐrun継続 | — conversation resume | — conversation resume | ◎ durable checkpoint | ◎ stdout復元と併用 |

## 3. 発見事項と改善設計

| ID | 優先度 | 症状・原因 | 改善 | 回帰証拠 | 状態 |
|---|---:|---|---|---|---|
| INT-01 | P1 | `startTypeAhead()`がraw byteを受けるだけでecho/redrawせず、「LLM処理中」は入力不能に見える | 通常`InteractiveInput`を再利用し、statusの下へ固定する処理中composerを追加 | Linux/macOS実PTYでprefix・入力文字の表示とEnter後steerを確認 | 修正済み |
| INT-02 | P1 | spinner/progressと入力欄が同じ1行の所有権を奪い合う | ScreenManagerに通常live ownerとpinned ownerの二段構成を追加。確定stdout割込み後もcomposerを再描画 | owner併存unit、実PTY | 修正済み |
| INT-04 | P1 | `Shift+Tab`の`ESC [ Z`がstdin chunk境界で分割されると、先頭ESCだけを単独中断と誤認し得る | ESC debounce中に後続byteを受けたら中断予約を解除 | split-sequence unit、実PTY | 修正済み |
| MODE-01 | P1 | Plan/Autorunはcommand操作だけで、Claude Code相当の`Shift+Tab`がない | 通常→Autorun→Plan→通常を循環し、編集中bufferを保持。永続設定の保存失敗時は切替をrollback | mode/key unit、実PTY | 修正済み |
| RESUME-01 | P1 | `restoreSession()`がconversation stateだけを戻し、過去の表示が空になる | transient spinner/composerを除く確定stdoutをversioned `terminalTranscript`へsession別保存し、restore時にscrollbackを置換 | unitと別process E2E | 修正済み |
| RESUME-02 | P1 | 旧sessionや破損schemaで無言の空画面または誤読になり得る | 旧sessionはmessage/tool履歴から明示的に再構成。不正schemaも警告し再構成 | legacy/invalid unit | 修正済み |
| RESUME-03 | P1 | Discord/Slack用Roomを内部で切替えるだけでもCLI画面を上書きし得る | CLIの明示resume/Room移動だけ表示を復元し、background借用はsession stateだけを切替 | Room回帰 | 修正済み |
| INT-03 | P2 | queued entryの一覧・個別編集・`Up`取り戻しはない | queue modelとcomposer内の編集対象を統合する必要がある | 比較差分 | 次cycle候補 |

## 4. d720c4fレビュー

`d720c4f`のパス付きmodel candidate抽出、起動例外を通常画面へ戻してから表示する順序、SEA生成に同じNode実体を使う判断は妥当であり維持した。追加で次の2点を補正した。

| ID | 問題 | 修正 |
|---|---|---|
| D720-01 | `process.config.variables.single_executable_application !== false`は値が`undefined`でもSEA対応とみなし、非対応Nodeへ黙って進み得る。`NODE_EXE`も存在だけを検証していた | 全candidateを子processで`=== true`確認し、明示`NODE_EXE`が非対応なら理由と復旧方法を示してfail-fast。引数はshell文字列でなく`execFileSync`で渡す |
| D720-02 | Qwen3 Flash/Next/Turbo規則がsize規則より先にあり、`Qwen3-4B-Flash`までT2へ過大分類する | 14B以下の明示sizeを先にT3分類し、Flash等のmarketing suffixより実サイズを優先 |

## 5. 実装境界

- `ScreenManager`: 確定stdout observer、scrollback snapshot/restore、通常statusと固定composerの同時描画。
- `SessionData`: 最大10,000行のversion 1 terminal transcript。上限超過は`truncated`を保持し、resume時に省略を表示。
- `AgentLoop` / `RoomManager`: active sessionへstdoutを帰属させ、明示的なCLI resumeだけ画面を載せ替える。durable resumeの内部rollbackでは画面を戻さない。
- `InteractiveInput` / `REPL`: 処理中も通常入力と同じ編集器を使い、AbortSignalでrun終了時に安全に解放。`Shift+Tab`時もbufferを失わない。
- d720c4f補正: SEA capabilityの実測、Qwen小型優先規則。

## 6. 評価記録

- TypeScript build: 成功。
- 対象unit: 6 files / 162 tests成功。別の初回対象runは6 files / 167 tests成功。
- E2E: 8 tests成功。新規scenarioは1回目processでstdoutをsession JSONへ保存し、2回目processの`--resume`で同じmarkerを再表示した。
- 実PTY: Windowsローカルはdriver対象外。Linux/macOSで処理中composer、入力文字の表示、`Shift+Tab`によるAutorun切替、pause/resume、同一turn steeringをCIで実行する。
- 全unit/coverage: 133 files成功 / 2 files skipped、1,356 tests成功 / 11 tests skipped。statement/line coverageは44.1%、branch 76.52%、function 67.7%。
- lint: error 0（既存warning 279、info 97）。`test:durable-restart`、`validate:skills`、`validate:version`、`validate:package`も成功。
- audit: package-lockのruntime high vulnerability 0件。
- 配布: `build:exe`と生成した`dist/locallm.exe --version`は成功。ローカル`build:deploy`は使用中の`deploy/locallm.exe`（PID 25504）を上書きせず、意図したfail-fastを確認した。clean環境でのdeploy/package smokeは最新SHA CIで閉じる。
- 最新SHA CI: 後続gateで記録する。

## 7. 完了gate

- [x] 公式一次資料と現行sourceによる比較
- [x] P1 gapとd720c4fの補正点を設計・実装
- [x] 対象unitと別process resume E2E
- [x] 全ローカル品質gate
- [ ] task差分だけをcommit/push
- [ ] 最新push SHAの全依存CI job
