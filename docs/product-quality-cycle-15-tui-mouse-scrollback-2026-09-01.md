# 商品品質サイクル15: TUIマウススクロールバック

- 観点: Alternate Screen TUIで、保持済みの過去出力へマウスホイールから到達できること
- 対象: `ScreenManager`、interactive input、PTY smoke、利用案内
- 日付: 2026-09-01
- 基準commit: `9edc718`
- 完了条件: ホイールが入力履歴へ化けず過去ログを上下し、PgUp/PgDn・排他prompt・classic streamを退行させず、unit・実PTY・全品質ゲート・最新push SHAのCIを通す

## ベースラインと再現

- 作業ツリーにはユーザー所有の未追跡 `sandbox/` があり、本サイクルでは変更・stage対象外とした。
- 変更前の関連テストは `screen-manager` / `pty-driver` の84件が成功し、buildとlintも成功した。lintには既存の279 warnings / 97 infosがあるがerrorは0件だった。
- TDDで、mouse trackingの入退場、SGR wheelの上下移動、chunk境界、readline入力filter、排他prompt中の一時解除を追加した。変更前は5件が失敗し、新規filter moduleも存在しなかった。
- ウインドウを縦に広げると過去出力が表示されるため、出力データの保持・viewport描画ではなく、ホイール入力から`viewOffset`へ至る操作経路の欠落と切り分けた。

## 発見事項

| ID | 優先度 | 症状・原因 | 修正 | 回帰証拠 | 終端状態 |
|---|---|---|---|---|---|
| TUI-MOUSE-01 | P1 | Alternate Screen開始時にmouse reportingを有効化しておらず、端末がwheel-upをcursor-upへ変換する。`InteractiveInput`はこれを入力履歴の↑として扱うため、過去出力ではなく直前コマンドが現れる | `1000` normal trackingと`1006` SGR coordinatesを有効化し、SGR/X10 wheelをScreenManagerの3行scrollへ写像 | ScreenManager unit、Linux/macOS実PTY mouse report | 修正済み |
| TUI-MOUSE-02 | P1 | Node readlineはSGR reportを1つのkeyとして解釈せず、数字・区切り・末尾`M`へ分割するため、scrollだけ追加すると入力欄を汚染する | `MouseKeypressFilter`でSGR/X10 report全体だけを除外し、その直後の通常文字は保持 | filter unit、PTYでwheel-down後の`PREVIEW_REQUEST`到達 | 修正済み |
| TUI-MOUSE-03 | P2 | mouse reportを常時有効にするとinquirer等の排他promptへ未対応sequenceを渡す | 排他所有へ遷移するとreportを解除し、最後の排他所有解放時に再開 | ScreenManager ownership unit | 修正済み |
| TUI-DOC-01 | P2 | welcome、`/help`、READMEがPgUp/PgDnだけを案内し、ホイール対応を発見できない | mouse wheelとPage keyの役割を利用案内・正典TUI設計へ反映 | build / docs差分確認 | 修正済み |

## 実装設計

1. `ScreenManager`をalternate screenとmouse trackingの所有者にし、開始・終了・排他prompt遷移を対称にする。
2. raw stdinのPageUp/PageDown・SGR mouse・legacy X10 mouseをchunk境界越しに復元し、Page keyは1画面、wheelは3行ずつ動かす。
3. raw dataを消費して他listenerを壊さず、readline側ではmouse report断片だけを明示的に捨てる。貼り付け中の内容は先に処理してmouse filter対象にしない。
4. 実PTY smokeをPageUp/PageDownの疑似入力からSGR wheel-up/downへ変更する。wheel-down後のLLM request成功により、入力文字汚染も同時に検出する。
5. classic streamではmouse trackingを有効化せず、端末本来のscrollbackへ委ねる既存契約を維持する。

## 評価

- targeted: `tests/cli/screen-manager.test.ts`、`tests/cli/terminal-input.test.ts`、`tests/scripts/pty-driver.test.ts` の91件成功
- build: `npm.cmd run build` 成功
- lint: 変更後もerror 0、既存warning 279 / info 97
- full unit: 127 files、1313 passed / 11 skipped。coverageも同数成功（Statements 43.05%、Branches 75.64%、Functions 66.14%、Lines 43.05%）
- E2E: non-TTY REPL 7/7成功
- distribution: build、skill validation、version policy、npm package validation（540 files / 9.3 MiB）、production audit（0 vulnerabilities）成功
- 実PTY: Windowsローカルには本リポジトリのPTY driverが無いため、Linux `script` / macOS `expect` のCIでwheel-up → scroll案内 → wheel-down → 後続入力を検証する
- push / CI: 未実施。最新push SHAの全依存job完了後に本記録を閉じる

## 境界

- Alternate Screenを明示的に使わない`--no-alt-screen`ではmouse reportingを変更しない。
- 排他prompt中のホイールはTUI scrollbackへ奪わず、そのpromptと端末の既存挙動を優先する。
- 実マウス機器の物理eventそのものはheadless CIから生成できない。対応端末が物理wheelを変換する標準SGR report以降をLinux/macOS実PTYで検証する。
