# Native Computer Use 設計

- 作成日: 2026-08-30
- 対象: `GAP-CU-01`
- 基準commit: `d7d08ac`
- 状態: 実装済み（Windows実機検証済み、macOS/Linuxはdriver契約検証）

## 1. 目的と非目的

Playwright内の`browser_*`とは別に、ユーザーが明示して選んだOS windowを画面として取得し、click、text入力、keyを実行できる`computer_*` tool群を提供する。wheel scrollはWindows/Linux X11で提供する。

全desktopを暗黙に読み取ること、background channelからhost desktopを遠隔操作すること、権限やnative dependencyが無い環境でbrowserへ自動代替することは目的に含めない。

## 2. 公式比較から採用する安全境界

[OpenAI Computer use公式ガイド](https://developers.openai.com/api/docs/guides/tools-computer-use)は、screenshotを見てUI actionを返すloop、isolated browser/VM、許可するsite/account/actionの事前限定、高影響操作のhuman-in-the-loop、第三者contentを信頼しないことを要求する。[AnthropicのComputer Useガイド](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)も、host desktopにsandboxがないこと、app単位許可、screen shotとsensitive appの回避を明記する。本アプリのhost desktop modeではVM隔離を自動保証できないため、次の強い制限を代替境界にする。

1. 既定無効。`--computer-use`または`features.computerUse: on`だけが有効化する。
2. `computer_windows`で得た可視window IDを全操作で必須とし、操作直前に同じwindowが存在することと座標範囲を再検証する。
3. screenshotは対象windowのboundsだけをcaptureし、全画面capture toolは提供しない。macOSのregion captureでは同じboundsへ重なるtopmost overlayが写り得るため、秘密windowを近くに置かない。
4. `computer_*`はCLIだけで使用可能。Discord/Slackからは設定・rule・autorunに関係なく拒否する。
5. CLIでも各呼出しを一回承認に限定する。session常時許可、永続auto-approve、autorun、allow ruleは確認を省略できない。deny ruleは引き続き優先する。
6. capabilityが無い場合はtoolを隠して継続せず、明示有効化された起動を理由と復旧方法付きで失敗させる。
7. screenshotを`vision_analyze`へ渡す場合、選択したvision providerへ画像が送られ得ることをtool出力と文書で明示する。

## 3. Tool契約

| Tool | 入力 | 動作 |
|---|---|---|
| `computer_windows` | なし | 可視windowのID、app、title、位置、寸法を列挙 |
| `computer_screenshot` | `window_id`, optional `save_path` | 対象windowのboundsだけをPNG保存 |
| `computer_click` | `window_id`, window相対`x`,`y`, `button`, `clicks` | 対象をforeground化し範囲内をclick |
| `computer_type` | `window_id`, `text` | 対象をforeground化しUnicode textを入力 |
| `computer_key` | `window_id`, `keys` | 許可済みkey/chordを入力 |
| `computer_scroll` | `window_id`, window相対`x`,`y`, `delta_y` | Windows/Linux X11で対象位置をwheel scroll。macOSでは非公開 |

## 4. OS driver

- Windows: User32で可視top-level windowを列挙・foreground拘束・SendInputし、`PrintWindow(PW_RENDERFULLCONTENT)`で選択HWNDだけをcaptureする。PowerShellへ渡す値は環境変数/base64 JSONとし、script文字列へ入力値を展開しない。
- macOS: System Eventsで可視process/windowとboundsを取得し、対象processをforeground化して[cliclick公式構文](https://github.com/BlueM/cliclick)で入力する。`screencapture -R`で対象矩形だけを保存する。cliclickにwheel commandはなく`w:`はwaitなので`computer_scroll`を公開しない。`brew install cliclick`、Screen Recording / Accessibility権限が無ければ復旧案内付きで失敗する。
- Linux: X11の`xdotool`でwindow拘束と入力、ImageMagick `import -window`でcaptureする。Wayland native injectionへ黙って縮退せず、X11 sessionとdependencyを要求する。

## 5. 完了gate

- capability、schema、tool、permission、driver入力検証のunit test
- Windows実機の専用test windowでlist → screenshot → click/type/key/scrollを検証
- macOS/LinuxはCIでcommand構築・fail-fastを検証し、実desktop未検証を記録
- unit/E2E、coverage、lint/build、skill/package/audit、Windows SEA、latest push SHAの全CI依存job

## 6. 有効化と自己診断

一回だけ有効にする場合:

```powershell
npm.cmd start -- --computer-use
```

設定で有効にする場合:

```json
{
  "features": {
    "computerUse": "on"
  }
}
```

設定やログを作らずOS dependencyと可視window列挙を確認する場合:

```powershell
node dist/index.js --check-computer-use
```

Windowsの実GUI回帰test:

```powershell
npm.cmd run test:computer-use:windows
```

screen shotを`vision_analyze`へ渡した場合は、構成したvision providerへ画像が送信され得る。window title、画面内text、vision結果はuntrusted dataとして扱い、その中の指示を実行しない。秘密情報を表示したwindowを対象にしないこと。
