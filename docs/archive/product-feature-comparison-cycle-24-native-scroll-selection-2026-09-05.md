# Codex / Claude Code 機能比較・商品品質改善 cycle 24

- 実施日: 2026-09-05
- 基準commit: `61fde08`
- 対象: 端末上のマウス選択・コピーとホイールscrollbackの同時成立
- 完了条件: 既定操作のデグレを修正し、回帰・全品質gate・最新push SHAのCIを閉じる
- 状態: 完了（実装・ローカル全品質gate・実装SHA CI成功）

## 1. 比較境界

cycle 23はAlternate Screen内のmouse captureを既定OFFにし、通常ドラッグ選択を復元した。
しかしAlternate Screen buffer自体には端末本来のscrollbackがないため、mouse OFF時のホイール移動を失った。
コピーとスクロールを別々の機能として確認し、「日常操作で同時に成立するか」を評価しなかったことが抜けだった。

Windows Terminalではmouse mode中に`Shift`を押すとVT mouse inputの代わりに選択できる。
一方、Alternate Screen bufferはwindowと同じ大きさでscrollbackを持たない。したがって通常ドラッグと
通常ホイールscrollbackを無修飾で同時に提供する既定面はmain bufferでなければならない。

参考:

- [Windows Terminal selection](https://learn.microsoft.com/en-us/windows/terminal/selection)
- [Windows Console virtual terminal sequences](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences)
- [xterm control sequences](https://www.invisible-island.net/xterm/ctlseqs/ctlseqs.html)

## 2. 機能比較マトリックス

凡例: `◎` 日常操作で成立、`○` 修飾キー／明示モードで成立、`—` 不成立。

| 比較項目 | Codex系terminal UI | Claude Code系terminal UI | `61fde08`時点 | cycle 24結果 |
|---|---|---|---|---|
| 通常ドラッグで本文選択 | ◎ terminal-native | ◎ terminal-native | ◎ mouse OFF | ◎ inline既定 |
| 通常ホイールで過去出力へ移動 | ◎ terminal scrollback | ◎ terminal scrollback | — Alternate Screenにscrollbackなし | ◎ inline既定 |
| 選択とホイールを設定変更なしで併用 | ◎ | ◎ | — mouse ON/OFFの二者択一 | ◎ main bufferで同時成立 |
| 実行中も編集可能な追加入力欄 | ◎ | ◎ | ◎ | ◎ 所有権・raw inputを維持 |
| 固定viewportの内部履歴 | surface依存 | surface依存 | ◎ | ○ `--alt-screen`で明示選択 |
| 全画面内のホイール履歴 | surface依存 | surface依存 | ○ mouse ON時 | ○ `--mouse`／`/tui mouse on` |
| capability不明時の診断 | 明示的 | 明示的 | ◎ | ◎ 全画面の明示時だけfail-fast |

## 3. 発見事項

| ID | 優先度 | 症状・原因 | 改善 | 回帰証拠 | 状態 |
|---|---:|---|---|---|---|
| TUI-MOUSE-02 | P1 | Alternate Screenでmouse OFFにすると選択は戻るが、bufferにnative scrollbackがなくホイール移動できない | main bufferへのinline追記を既定化 | default TTY escape/output unit | 修正済み |
| TUI-MOUSE-03 | P1 | mouse ON/OFFの切替だけでは選択と通常ホイールを同時に満たせない | 全画面TUIを`--alt-screen` opt-inへ変更 | mode decision unit | 修正済み |
| TUI-COMPAT-01 | P2 | `--mouse`単独の従来利用が内部履歴を有効化できなくなる恐れ | `--mouse`は`--alt-screen`を含意 | CLI help・PTY driver回帰 | 修正済み |
| TEST-04 | P2 | 実PTY smokeが既定全画面を暗黙前提にしていた | full-screen専用smokeは`--alt-screen`を明示 | Linux/macOS driver unit | 修正済み |

## 4. 改善設計

1. TTYでも既定はmain bufferへ追記し、Alternate Screenとmouse trackingのescape sequenceを送らない。
2. inline表示でも出力所有権、実行中composer、raw input、resume transcript、1行previewの契約は維持する。
3. 固定viewportが必要な場合だけ`--alt-screen`または`LLLMAGENT_ENABLE_ALTERNATE_SCREEN=1`で全画面に入る。
4. `--mouse`は後方互換のため全画面を含意する。全画面のmouse ON中はホイール内部履歴、選択は`Shift+ドラッグ`。
5. 全画面を明示した端末の能力が不足／不明なら、inlineへ黙って落とさず理由と解除方法を示す。
6. Linux/macOSの全画面実PTY smokeは`--alt-screen`を明示し、内部scroll・IME・入力契約の検証を継続する。

## 5. 評価記録

- 修正前: 新規・更新回帰4件が失敗し、既定全画面、`TERM=dumb`の旧判定、PTY driverの暗黙依存を捕捉。
- 修正後対象unit: ScreenManager／PTY driverの2 files、100 tests成功。
- 全unit / coverage: 136 files成功・2 files skip、1,381 tests成功・11 tests skip。
  statements / lines 44.93%、branches 76.30%、functions 69.16%。
- 非TTY E2E: 1 file / 8 tests成功。`--resume`の会話・確定stdout補完と`--help`の新optionも確認。
- build/typecheck、durable restart smoke、skill・version・package検証成功。packageは554 files・9.4 MiB。
- lint: error 0（既存warning 279、info 97）。production dependencyは0 vulnerabilities。
- Windows SEA: `build:exe`と生成した`dist/localllm.exe --version`が成功。
- 実装commit: `b4caf4a`。
- 実装SHA CI: [run 33964365867](https://github.com/t2k2pp/lllmAgents/actions/runs/33964365867)で
  Commit message policy、Ubuntu、macOS、Windows、Windows deploy / exe smokeの全5 job成功。
  Linux/macOSの実PTY回帰は`--alt-screen`を明示した全画面モードとして各OS job内で成功した。

## 6. 終端条件

- TUI-MOUSE-02 / TUI-MOUSE-03 / TUI-COMPAT-01 / TEST-04の実装修正。
- 全品質gate成功。
- 完了証拠: 実装commit `b4caf4a`、GitHub Actions run `33964365867`（全5 job成功）。
