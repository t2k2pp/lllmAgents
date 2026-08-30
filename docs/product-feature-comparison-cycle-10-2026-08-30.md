# Codex / Claude Computer Use 機能比較・商品品質改善 cycle 10

- 実施日: 2026-08-30
- 基準commit: `d7d08ac`
- 対象gap: `GAP-CU-01`
- 状態: 実装・Windows実機評価済み（latest push SHAのCIはcommit後の完了条件）

## 1. 比較根拠

- OpenAIの[Codex利用ガイド](https://help.openai.com/en/articles/11369540-getting-started-with-codex)はCodexのComputer Useと、処理対象にscreen shotが含まれることを明記する。
- OpenAIの[Computer use開発者ガイド](https://developers.openai.com/api/docs/guides/tools-computer-use)は、screen shotとUI actionのloop、隔離環境、許可site/account/actionの事前限定、高影響操作のhuman-in-the-loopを要求する。
- Anthropicの[Claude Computer Useガイド](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)は、macOS/Windowsのdesktop app操作、appごとの許可、screen shot、blocklistとhost desktopにsandboxがないリスクを明記する。
- macOS driverの入力契約は[cliclick公式README](https://github.com/BlueM/cliclick)の`kd` / `kp` / `ku` / `t`構文を正とした。
- Appleの[CGEventCreateScrollWheelEvent](https://developer.apple.com/documentation/coregraphics/cgeventcreatescrollwheelevent)がnative wheel eventの正規APIである。未検証のQuartz bridgeを入れず、cliclickに存在しないwheelはgapとして残した。

## 2. 機能比較マトリックス

| 比較項目 | Codex / OpenAI | Claude / Anthropic | cycle 9時点 | cycle 10結果 |
|---|---|---|---|---|
| OS desktopの認識・入力 | Computer Useでscreen shotとUI action | 画面を見てappをclick/type | なし | `computer_windows/screenshot/click/type/key` + Windows/Linuxの`scroll` |
| browser automationとの分離 | Computer Useを独立機能として案内 | connector → browser → screen interactionを区別 | `browser_*`のみ | `computer_*`を独立capabilityとして登録 |
| 明示有効化 | UI/環境側で機能を有効化 | Settingsでtoggle | なし | 既定off、`--computer-use`または`features.computerUse=on` |
| 操作対象の限定 | 許可site/account/actionを事前限定 | appごとに許可、blocklist | なし | 可視window ID必須、操作前再検証、window相対座標 |
| screen shotの範囲 | harness次第 | 許可appのscreen shot | なし | 全画面toolなし、選択window boundsだけを保存 |
| 人の確認 | 高影響操作はhuman-in-the-loop | 新しいappへのaccess確認 | 通常permissionのみ | 全`computer_*`呼出しを毎回一回確認。永続許可なし |
| remote surface | Codex Windowsには別途remote control機能あり | cloud sessionからdesktop app経由で到達可能 | Discord/Slackあり | native操作はCLI限定。Discord/Slackを常時拒否 |
| capability診断 | 製品UI側 | 製品UI側 | なし | 副作用なしの`--check-computer-use` |
| OS | desktop製品依存 | macOS / Windows | なし | Windows / macOS / Linux X11 driver。Waylandはfail-fast |
| 実動作gate | 製品管理 | 製品管理 | なし | Windows専用可視window smoke。macOS/Linuxは契約testのみ |

## 3. 抜けの判定と設計判断

`GAP-CU-01`は、Playwrightのbrowser tab内操作をOS desktop操作と同等扱いできないため、cycle 7〜9でP2のまま残していた。今回、次の境界を同時に実装できる見通しが立ったため選定した。

1. windowを先に列挙し、返されたID以外を操作しない。
2. full desktop captureを公開しない。
3. browserへの暗黙fallbackを禁止する。
4. local CLI以外からの呼出しをhard denyする。
5. autorun、autoApprove、allow ruleでも一回確認を省略しない。

Codex/Claudeのremote controlやClaudeの永続app許可をそのまま追従しなかったのは、CLIプロセス単体ではhost desktopを十分に隔離できないためである。機能数より被害半径を優先した意図的差分であり、同等機能とは表示しない。

## 4. 実装

- `src/computer-use/`: capability検出、Windows User32、macOS System Events/cliclick、Linux X11のdriver。
- `src/tools/definitions/computer.ts`: 6 toolと入力境界。
- `src/security/permission-manager.ts`: local CLI限定、毎回一回許可、remote/autorun/永続許可の回避防止。
- `src/index.ts`: opt-in登録、要求時のfail-fast、副作用なしの自己診断。
- `scripts/computer-use-windows-smoke.mjs`: 専用WinForms windowを使う実機回帰gate。

## 5. 発見した不具合と修正

| ID | 症状 | 原因 | 修正 | 回帰証拠 |
|---|---|---|---|---|
| CU-01 | opt-in、tool、権限境界が存在しない | browser capabilityだけでhost desktop driverが未実装 | OS別driver、6 tool、schema/CLI gateを追加 | capability/tool/schema/driver test |
| CU-02 | autorun・allow rule・remote channelで確認を回避できる設計になり得る | 既存permissionの汎用判定をそのまま使う想定 | `computer_*`専用の先行判定と一回許可UIを追加 | permission testでremote拒否、2回連続確認 |
| CU-03 | 最初のWindows smokeでbefore/after PNGが同一 | `CopyFromScreen`は対象window自身の再描画と、重なった他windowを排除できない | HWNDへ直接描画要求する`PrintWindow(PW_RENDERFULLCONTENT)`へ変更 | PNG SHA-256差分、実画像目視、入力結果file |
| CU-04 | macOSのBackspace/forward Deleteと文字chordがcliclick契約不一致 | `backspace`を`kp`へ渡し、通常文字も`kp:a`としていた | `delete`/`fwd-delete`へ対応し、modifier中の通常文字は`t:a`へ変換 | driver argv contract test |
| CU-05 | 並行test中のWindows smokeでforeground化が一過性失敗 | `SetForegroundWindow`だけではWindows foreground lockを越えられない | foreground/target input threadを操作中だけattachし、top/active/foregroundを揃えて必ず最終検証 | 修正後に実GUI smokeを3回連続実行 |
| CU-06 | macOSの左側displayでclick座標がrelative扱いになる | cliclickは負数をrelative、`=-100`をabsoluteとして解釈する | global座標の負数へ`=`を付け、right double-clickも2 eventとして構築 | multi-display argv contract test |
| CU-07 | macOSのscrollが入力せず待機する | cliclickの`w:`をwheelと誤認したが、公式仕様ではwait | macOSでは`computer_scroll`を非公開とし、driver直呼出しも理由付きで失敗 | tool露出/driver fail-fast test |
| CU-08 | latest SHAのmacOS CIだけruntime auditが400で失敗 | OS別optional packageを含む実体treeの監査が旧quick endpointへfallbackし、`Invalid package tree`になった | `--package-lock-only`で全OSが同一lockfileを監査。endpointエラーやHigh以上は引き続きfail | local lockfile auditと次pushの3 OS CI |

## 6. 評価

### Windows実機

`npm.cmd run test:computer-use:windows`で、専用可視WinForms windowに対して以下を確認した。

- 列挙したwindow IDと寸法`496x359`への拘束
- 空欄と日本語入力後の対象window PNGを取得し、非空かつSHA-256が異なる
- clickで入力欄をfocusし、閉じるbuttonを実際に作動
- Unicode `CU-SMOKE-日本語-42`、Backspace、`Ctrl+B` chord event、wheel scroll
- 最終入力文字列をhelper process側で照合

### 自動test

- capability、config schema、tool入力、permission、OS driver command構築をunit test化
- `--help`と`--check-computer-use`がisolated HOMEへstateを作らないE2Eを追加
- macOS/LinuxはCIでdriver契約とfail-fastを検証するが、実desktop操作は未検証。実機同等性は主張しない
- `npm.cmd run test:coverage`: 116 files、1238 tests成功（24 skipped、statement 40.11%、branch 76.14%）
- `npm.cmd run test:e2e`: 7 scenarios成功
- `npm.cmd run lint`: error 0（既存warning/infoは非blocking設定）
- `npm.cmd run validate:skills`、`validate:package`（522 files / 9.2 MiB）、runtime audit（0 vulnerabilities）成功
- 初回pushのmacOS `Audit runtime dependencies`は脆弱性ではなくnpm registryの`400 Invalid package tree`で失敗。lockfile限定監査へ修正し、OS別optional package実体による揺れを除去
- fresh `dist/localllm.exe`をSEA buildし、`--version`、`--help`、`--check-computer-use`を実行。既存`deploy/localllm.exe`は実行中PIDのlockを検出して安全に上書き拒否したため、deploy directory全体のsmokeはpush後CIへ委ねる

## 7. 残差

| ID | 優先度 | 内容 | 状態 |
|---|---|---|---|
| GAP-CU-02 | P2 | Claude相当のapp単位blocklist/管理UI | open。現在はより厳しい呼出しごとの一回許可 |
| GAP-CU-03 | P2 | macOS/Linuxの可視desktop smoke、macOS native wheel | open。対応hostで専用GUI gateとQuartz wheel driverを追加するまで同等扱いしない |
| GAP-CU-04 | P3 | remote control | 意図的非対応。host隔離・本人性・監査設計なしでは追加しない |

## 8. 完了gate

- [x] 比較マトリックスとgap選定
- [x] fail-fast / permission / target拘束のRed→Green
- [x] Windows実GUI smokeとcapture目視
- [x] 全unit / E2E / coverage / lint / package / skill / audit
- [x] Windows SEA buildとfresh exeのversion/help/Computer Use診断
- [ ] latest pushed SHAの全CI依存job
