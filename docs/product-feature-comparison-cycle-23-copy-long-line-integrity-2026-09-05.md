# Codex / Claude Code 機能比較・商品品質改善 cycle 23

- 実施日: 2026-09-05
- 基準commit: `3139ba7`
- 対象: TUIのマウス選択・コピー、長文／resume本文の表示完全性
- 完了条件: 実sessionで残存したP1を修正し、回帰・全品質gate・最新push SHAのCIを閉じる
- 状態: 完了（実装・ローカル全品質gate・実装SHA CI成功）

## 1. 比較境界

cycle 21で実行中のmouse capture切替、cycle 22でresume対話補完を追加した後の実利用回帰を扱う。
Codex／Claude Code系のCLIでは、生成中の進捗表示が確定本文を隠さず、端末上の本文を利用者が選択・コピーできることが
診断導線の前提になる。本アプリは切替APIを持っていたが、初期値と描画単位に抜けがあり、機能の存在だけでは
実際の操作契約を満たしていなかった。

## 2. 機能比較マトリックス

凡例: `◎` user-facing contract、`○`一部あり、`—`無し。

| 比較項目 | Codex | Claude Code | 3139ba7時点 | cycle 23結果 |
|---|---|---|---|---|
| 起動直後の本文選択・コピー | ◎ 端末native選択 | ◎ 端末native選択 | — mouse capture既定ON | ◎ native選択を既定化 |
| マウスホイールで内部履歴移動 | terminal依存 | terminal依存 | ◎ SGR tracking | ◎ `--mouse`／runtime opt-inで維持 |
| キーボードで内部履歴移動 | surface依存 | surface依存 | ◎ PgUp/PgDn | ◎ mouse OFFでも維持 |
| 画面幅を超える確定本文 | ◎ 末尾まで到達可能 | ◎ 末尾まで到達可能 | — 画面幅で切り捨て | ◎ ANSI/grapheme対応折り返し |
| resumeした複数行本文 | ◎ | ◎ | ○ 配列要素内の改行を許容 | ◎ 論理行へ正規化 |
| session保存の端末幅非依存 | ◎ conversation基準 | ◎ conversation基準 | ◎ 論理行保存 | ◎ 維持、折り返しは表示時のみ |

## 3. 再現証拠と発見事項

利用者が指定したsession `mtns71kw-aitc`は、実行中binaryと同じ`3139ba7`でresumeされており、更新漏れではなかった。
prompt・応答原文を転載せず保存構造だけを集計すると、1,691件の保存行に改行内包要素が2件、120文字超が100件、
最大論理行は65,697文字だった。現行rendererは各論理行を端末幅で切り捨てていたため、内容が保存されていても
右側を表示・選択できなかった。

| ID | 優先度 | 症状・原因 | 改善 | 回帰証拠 | 状態 |
|---|---:|---|---|---|---|
| COPY-02 | P1 | mouse trackingが既定ONでnative drag selectionを奪う | copy-firstの既定OFF、mouse wheelは明示opt-in | ScreenManager default／escape unit | 修正済み |
| DISPLAY-03 | P1 | Alternate Screenが長い論理行を幅で切り捨て、末尾を不可視にする | ANSI・graphemeを維持した物理行折り返し | ASCII／日本語／ANSI／emoji unit | 修正済み |
| RESUME-05 | P1 | 保存snapshotと補完本文が要素内改行を含み、複数行を1行として描画する | restore・legacy・補完の論理行正規化 | transcript unit | 修正済み |
| TEST-03 | P2 | mouse切替APIだけを検査し、既定値と長文末尾を検査していない | 修正前に6件失敗する回帰を追加 | 対象unit | 修正済み |

## 4. 改善設計

1. 選択・コピーを診断の基本導線とし、mouse trackingは既定OFFにする。
2. ホイール履歴は削除せず、`/tui mouse on`、`--mouse`、`LLLMAGENT_ENABLE_MOUSE=1`で明示的に有効化する。
3. 保存snapshotは端末幅非依存の論理行を維持し、CRLF／埋め込み改行だけを行境界へ正規化する。
4. 描画時にだけ論理行を端末幅の物理行へ変換し、ANSI装飾・結合文字・ZWJ emojiを途中で壊さない。
5. scroll offsetと新着行数は折り返し後の物理行で数え、長文でも先頭・末尾へ移動可能にする。

## 5. 評価記録

- 修正前: 新規回帰6件が失敗。既定mouse ON、埋め込み改行、長文切り捨てをそれぞれ捕捉。
- 修正後対象: 3 files / 117 tests成功。E2E 1 file / 8 tests成功。
- 全unit / coverage: 136 files成功・2 files skip、1,377 tests成功・11 tests skip。
  statements / lines 44.93%、branches 76.29%、functions 69.15%。
- build/typecheck、durable restart smoke、skill・version・package検証成功。packageは554 files・9.4 MiB。
- lint: error 0（既存warning 279、info 97）。production dependencyは0 vulnerabilities。
- Windows SEA: `build:exe`と生成した`dist/localllm.exe --version`が成功。
- 実session相当performance: 1,691保存要素（最大65,697文字）を正規化し、120桁の初回描画42.8ms、本文保持。
- 実装commit: `17ad8c7`。
- 実装SHA CI: [run 33958892657](https://github.com/t2k2pp/lllmAgents/actions/runs/33958892657)で
  Commit message policy、Ubuntu、macOS、Windows、Windows deploy / exe smokeの全5 job成功。
  Linux/macOSの実PTY回帰も各OS job内で通過した。

## 6. 終端状態

- COPY-02 / DISPLAY-03 / RESUME-05 / TEST-03: 実装修正済み。
- 未解決P0/P1: 0件。
- 完了証拠: 実装commit `17ad8c7`、GitHub Actions run `33958892657`（全5 job成功）。
