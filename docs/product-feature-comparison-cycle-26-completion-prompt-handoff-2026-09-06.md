# Codex / Claude Code 機能比較・商品品質改善 cycle 26

- 実施日: 2026-09-06
- 基準commit: `2642238`
- 対象: 応答完了時の処理中composer、診断ログ、通常promptへの表示handoff
- 完了条件: session `mtns71kw-aitc`の末尾表示を説明可能にし、重複promptとログ競合を修正、全品質gate・最新push SHAのCIを閉じる
- 状態: 実装・ローカル評価完了、CI待ち

## 1. session証拠

対象sessionは129 messages、terminal transcript 2,417行だった。user message 107の再検索依頼に対し、
assistant message 127へ`GPT-6 Astra`の完全な最終回答、message 128へ`response_complete`のtool結果が保存されている。
terminal transcriptにも最終段落、`response_complete`、Discord送信、session保存、終了まで残っていた。
したがって今回の主因は回答生成・永続化の欠落ではなく、その直後の表示handoffである。

貼付ログでは`[処理中・追加入力] [autorun] >`、`[INFO] [strategy]`、次の`[autorun] >`が同じ末尾へ重なった。
`InteractiveInput`は完了Abortでsoft ownerをreleaseするだけで、classic streamへ最後に描いた物理行を消去していなかった。
さらにloggerはraw stderrへ直接書き、stdout側のScreenManagerが管理するcomposerを迂回していた。

## 2. 機能比較マトリックス

凡例: `◎` user-facing contract、`○`一部あり、`—`無し。

| 比較項目 | Codex系CLI | Claude Code系CLI | `2642238`時点 | cycle 26結果 |
|---|---|---|---|---|
| 最終回答を履歴へ完全保存 | ◎ | ◎ | ◎ | ◎ session / transcriptで再確認 |
| 完了後に処理中入力欄を残さない | ◎ | ◎ | — inline物理行が残存 | ◎ Abort時に消去してrelease |
| 次の通常promptを1つだけ表示 | ◎ | ◎ | — stale promptへ連結 | ◎ prompt handoffを回帰化 |
| 実行中ログで編集中文字を壊さない | ◎ | ◎ | ○ stdoutのみ保護 | ◎ logger診断もsoft owner排他へ統合 |
| classicのstdout / stderr分離 | ◎ | ◎ | ◎ | ◎ `2>`契約を維持 |
| Alternate Screenの診断をscrollbackへ残す | ◎ | ◎ | ○ runtime errorのみ | ◎ loggerを含む共通診断経路 |

## 3. 発見事項

| ID | 優先度 | 原因・影響 | 修正 | 状態 |
|---|---:|---|---|---|
| HANDOFF-01 | P1 | 完了Abortがinline composerの物理行を消さず、次promptと連結 | release前にlive行を消去 | 修正済み |
| HANDOFF-02 | P1 | loggerのraw stderrがScreenManagerを迂回し、strategyログがcomposerへ割込み | 共通diagnostic経路で消去・stderr・再描画 | 修正済み |
| HANDOFF-03 | P2 | runtime errorだけが画面所有権を理解し、一般loggerと契約が分裂 | `writeDiagnostic()`へ集約 | 修正済み |

## 4. 改善設計

1. `InteractiveInput`の完了Abortはclassic streamだけlive行を消去し、その後にlistener解除と所有権releaseを行う。
2. `ScreenManager.writeDiagnostic()`を人間向け診断の単一経路にする。
3. classic streamはstderrをstdoutへ混ぜず、pinned / soft ownerがあればclearとredrawで書込みを挟む。
4. Alternate Screenは診断を確定scrollbackへ送り、画面外stderrによる破壊を防ぐ。
5. loggerは文字列format後に同じ診断経路を使う。直接`console.error`へ戻るデグレもテストする。

## 5. 評価記録

- 修正前: 新規回帰2件失敗（完了Abort後もcomposer行が残る、strategy診断がclear / redrawを通らない）。
- 修正後対象: lifecycle、runtime diagnostic、logger、ScreenManagerの4 files / 102 tests成功。
- 全unit: 138 files / 1,387 tests成功（2 files / 11 testsはplatform条件によりskip）。
- E2E: 8 tests成功。別processからの`--resume` transcript / 会話本文復元も成功。
- coverage: statements 45.49%、branches 76.25%、functions 69.01%、lines 45.49%。
- build / lint / built-in skill / version / npm package / dependency audit / durable restart: 成功。lintはerror 0、既知のwarning 279 / info 97。
- Windows PTY smoke: 対話console hostが無いため設計どおりskip。Linux / macOS CIで実行する。
- Windows SEA: `dist/localllm.exe --version`成功。停止済みの配布先へ`build:deploy`し、`deploy/localllm.exe --version`成功。
- 実装commitと最新push SHAのCI結果は完了時に追記する。

## 6. 終端条件

- HANDOFF-01〜03の実装修正。
- 全unit / E2E / coverage / build / lint / package / Windows SEA成功。
- 最新push SHAの全依存CI job成功。
