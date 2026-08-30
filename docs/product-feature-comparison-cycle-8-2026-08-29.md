# Codex / Claude Code 機能比較・日本語TUI/fail-fastレビュー cycle 8

- 日付: 2026-08-29
- 実装・ローカル評価完了: 2026-08-30
- 基準commit: `9720e09`
- 観点: Codex / Claude Code開発者の観点から見た機能充足だけでなく、通常操作で使える完成度、失敗の可視性、安全性、運用性
- 対象: `3f6f509` / `066b2be`以降のTUI、日本語入力、session、sandbox、search、Evaluator、context圧縮、SDK MCP bridge
- 完了条件: 一次資料で比較表を更新し、Mac日本語右端描画と意味を変える自動フォールバックのP1を閉じる。安全に閉じられる欠落機能を実装し、unit/E2E/PTY/lint/build/package/最新push SHAのCIを通す

## 1. 比較基準と証拠

2026-08-29に次の公式一次資料を確認した。

- OpenAI: [Codex CLI](https://developers.openai.com/codex/cli/)、[Codex developer commands](https://developers.openai.com/codex/cli/slash-commands)
- Anthropic: [Claude Code overview](https://code.claude.com/docs/en/overview)、[Checkpointing](https://code.claude.com/docs/en/checkpointing)、[Computer use](https://code.claude.com/docs/en/computer-use)、[Platforms and integrations](https://code.claude.com/docs/en/platforms)
- 本アプリ: 実装・テスト・履歴、cycle 7記録、2026-08-27以降の運用ログ集計（session 1、user span 1、stuck-loop 0。prompt/応答原文は未取得）

記号は `◎`=主要状態で操作でき回帰gateあり、`○`=一部あり、`—`=同等機能なし。API名や設定項目が存在するだけでは `◎` にせず、失敗時に別機能へ黙って切り替わらないことも完成度に含める。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents（変更前） | 今回後 | 判定 |
|---|---|---|---|---|---|
| repository指示 / memory | AGENTS.md、memory | CLAUDE.md、rules、auto-memory | CLAUDE.md、rules、`/memory` | 同左 | ◎ |
| skills / agents / plugins | skills、subagents、plugins | skills、subagents、plugins/teams | skills、agents、local plugin | 同左 | ○（marketplaceなし） |
| parallel / background / steer | subagent/background/follow-up | background/agent teams/follow-up | task list/output/send/cancel | 同左 | ◎ |
| plan / goal / schedule | plan、goals、schedule | plan、tasks、loop/routine | `/plan`、Goal Seek、goal-loop、schedule | 同左 | ◎ |
| session resume / fork | resume / fork | resume、session fork、checkpoint rewind | resumeのみ | **`/fork [id\|latest]`、`forkedFrom`、deep copy** | **◎** |
| checkpoint / rewind | conversation/file state | promptごとのcode/conversation rewind | artifact-scoped checkpoint | 同左 | ○ |
| permission / safe mode | approvals、sandbox、profiles | permission modes、safe mode | rules、Seatbelt/bwrap/WSL、safe mode。ただし不足時に隔離を降格 | **設定levelを成立できなければ実行前停止** | ◎ |
| web search | web search | web search | SearXNG失敗時にDuckDuckGoへ自動変更 | **選択providerだけを実行、失敗理由と明示変更手順** | ◎ |
| browser操作 | browser/computer surfaces | Chrome integration | Playwright browser tools | 同左 | ○ |
| **OS desktop Computer Use** | desktopで画面認識・入力 | macOS CLI/desktop、desktop app | **なし** | **なし** | **— (GAP-CU-01)** |
| image input / generation | image context/generation | image context | vision/image generation | 同左 | ◎ |
| side-effect-free CLI info | `--help` / `--version` | `--help` / `--version` | `--version`も初期化後、`--help`未実装 | **両方を全初期化前に終了、隔離HOME E2E/SEA gate** | **◎** |
| TUI scrollback | TUI scroll/raw scrollback/classic | fullscreen/classic | cycle 7で全session PgUp/PgDn | 同左 | ◎ |
| IME / Unicode input | terminal editor | terminal editor | CJK幅2のみ。最終列を埋め、code unit単位編集 | **最終列予約、grapheme折返し/移動/削除** | **◎（layout自動gate、Mac実機感触は継続）** |
| independent Evaluator | review/subagent | review/subagent | second不在時main自己評価、失敗をpassed扱い | **second必須、未実行を可視化、異常/非JSONはfail** | ◎ |
| MCP schema safety | typed tools | typed MCP tools | 未知schemaを`z.any()` | **登録時fail-fast** | ◎ |
| multi-provider / local LLM | OpenAI中心 | Claude/一部third-party | 多provider/local LLM | 同左 | ◎（独自強み） |

## 3. 発見事項と終端

| ID | 優先度 | 変更前の証拠・影響 | 終端 |
|---|:---:|---|---|
| TUI-IME-01 | P1 | 入力layoutが`width + charWidth > columns`で、幅ちょうどを許す。DECAWM端末は最終列描画後に折返し待ちとなり、再描画ごと余計な改行を確定し得る | **closed**。`columns - 1`を描画上限にし、日本語1文字追加ごと全行`width < columns`を検証 |
| TUI-UNICODE-02 | P1 | cursor/backspace/deleteがUTF-16 code unit単位で、surrogate、結合文字、ZWJ emojiを破壊する | **closed**。`Intl.Segmenter`のgrapheme cluster単位へ統一 |
| TUI-FALLBACK-02 | P1 | 30ms/chunk推測がEnterを貼付改行へ変え、500ms watchdogがraw ownership違反を自動修復して原因を隠す | **closed**。ブラケット貼付とScreenManager所有権だけを正規経路にした |
| FAIL-SANDBOX-01 | P1 | `full→network→none`降格、Linux `fs`依存不足時ネット全開、設定ONでもbash続行 | **closed**。要求level/必須toolのreadiness gate、`/sandbox on`保存前検査、bash実行前検査 |
| FAIL-BASH-01 | P1 | WindowsでGit Bash不在時、POSIX commandを意味の違うcmd.exeへ渡す | **closed**。Git for Windows導入手順付きpermanent error |
| FAIL-CHECK-06 | P1 | Goal Loopの決定的check runnerにも独立したGit Bash→cmd.exe置換が残り、bash toolと検証結果の意味が不一致 | **closed**。bash toolと同じresolver契約を共有し、Git Bash不在はspawn前に明示失敗 |
| FAIL-CONTEXT-01 | P1 | context length不明時32Kを採用し、過剰送信/早期圧縮のどちらも起こり得る | **closed**。API/既知名でも不明なら`mainLLM.contextWindow`を要求して起動停止 |
| FAIL-QUALITY-01 | P1 | Evaluatorの独立性消失、失敗pass、要約失敗時500文字へ損失置換、未知MCP schema全許可 | **closed**。いずれも自動代替せず、元履歴保持または診断付き失敗 |
| FAIL-ROUTE-02 | P1 | forget不成立→compress、clear失敗→forget、未割当sub-agent model→main、進捗/意図判定失敗→成功寄り分類 | **closed**。明示mode/routeだけを実行し、履歴保持または診断付き失敗 |
| FAIL-CAPABILITY-03 | P1 | 未知モデルをT2/32Kと仮定、画像縮小不能でも上限超過の原本を送信 | **closed**。tier/contextの明示を要求し、添付準備不能は送信前に停止 |
| FAIL-PACKAGE-04 | P1 | SEA生成失敗時にNode依存のshell/batch wrapperを同じ「実行ファイル成功」として生成 | **closed**。SEA失敗はbuild失敗とし、deployにもwrapper用CJSを混在させない |
| CLI-EARLY-05 | P1 | `--help`が未実装で通常起動し、外部接続・log retention・session cleanupまで進む。検証時に実HOMEで古いsession 1件がretentionにより削除され、復旧不能となった | **closed**。`-h/--help`と`--version`をcrash/output/config/log/MCP/channel初期化より前に処理。隔離HOMEのE2Eと実SEAで状態非生成を確認 |
| GAP-FORK-01 | P2 | resumeはあるが会話を元IDのまま上書きせず分岐できない | **closed**。元不変の`/fork`とdeep-copy/lineage test |
| GAP-CU-01 | P2 | browser toolはChromium内だけ。window列挙、対象アプリ拘束、screen capture、input injection、OS permissionなし | **open**。MCP名だけの実装は不可。macOS/Windows driver、アプリ単位許可、秘密画面、autorun/channel境界、配布/実機gateを先に設計する |

未解決P0/P1はない。Computer Useは機能差を隠さずP2として残す。

## 4. フォールバック分類

| 分類 | 例 | 方針 |
|---|---|---|
| 明示supported mode | `--no-alt-screen`、非TTY line input、Ctrl+J、`/sandbox off` | 維持。ユーザー選択または入出力形態が明示され、名称・testがある |
| 同一意味の保全/no-op | 圧縮結果が原文以上なら原文維持、添付不能時に本文を欠損なく分割 | 維持。意味やデータを弱めず、観測可能 |
| 契約上のdefault | 未指定samplingをserver defaultへ委譲、vision専用slot未指定時はmainが画像を担当 | 維持。未指定時の正規契約として文書化し、失敗後の代替とは分ける |
| 禁止する意味変更 | shell/provider/model/evaluator/sandbox/schema/履歴を別物へ自動置換 | 今回のP1を修正。失敗状態、要求能力、復旧操作を返す |

## 5. 改善設計

1. 入力layoutを純粋関数へ分離し、端末最終列を予約する。入力のindexは保存互換のUTF-16、分割境界はgrapheme clusterとする。
2. 貼付はterminal protocolの開始/終了markerだけで識別する。raw stdinはScreenManagerの単一所有とし、InteractiveInputは自己修復しない。
3. sandboxは「設定値」と「実効値」が一致するまでactiveとみなさない。依存不足時は`on`を保存せず、既存不正設定でもbashをspawnしない。
4. provider/search/evaluator/schema/context圧縮/model選択/判定器/画像添付は、別経路で成功らしく見せず、同じ要求を直す情報を返す。
5. session forkは元データを一切mutateせず、messages/todos/goalをdeep copyし、新IDと`forkedFrom`を付けて保存後に切り替える。
6. Computer Useはbrowser/MCP一般対応を同等扱いしない。対象アプリ許可とOS native gateが設計できるまで「なし」と表示する。
7. 情報表示optionはどの初期化よりも先に処理し、HOMEへの書込み、retention、外部接続を起こさない。

## 6. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存warning 281件・info 103件
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: unit 101 files passed / 3 skipped、1172 tests passed / 24 skipped、E2E 4/4 passed
- `npm.cmd run analyze:loop -- --since 2026-08-27`: session 1、user span 1、stuck-loop 0
- ユーザー所有変更: `sandbox/`配下の未追跡6群。変更・stage対象外

## 7. 実装後評価

- TDD: 日本語最終列、sandbox降格、Git Bash→cmd、未知MCP schemaの変更前失敗を確認後、対象63 testsをgreen化
- 追加機能: session forkの元不変/deep-copy/lineage testをgreen化
- `npm.cmd run lint`: exit 0（既存warning 279件・info 101件、error 0）
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: unit 109 files passed / 3 skipped、1195 tests passed / 24 skipped。E2E 5/5 passed
- `npm.cmd run test:coverage`: passed。statement/line 39.07%、branch 76.48%、function 62.78%
- `npm.cmd run build:exe`: Windows SEA生成 passed。隔離した`HOME`/`USERPROFILE`で実SEAの`--help`がexit 0、`.localllm`非生成
- `npm pack --dry-run`: passed。`npm audit --omit=dev --audit-level=high`: production 0件
- `npm audit --audit-level=high`: dev-only 13件（low 5 / moderate 1 / high 7）。Vitest coverage配下の既知依存で`npm audit fix`解なし。配布runtimeには含まれないが依存更新時に再評価する
- `npm.cmd run validate:skills -- --root .agents/skills` / `--root .claude/skills`: passed
- `npm.cmd run analyze:loop -- --since 2026-08-27`: session 1、user span 1、stuck-loop 0
- Windowsローカルでは`test:pty`は設計どおり非対応。Linux/macOS PTY（macOSは幅20、日本語右端、scrollback）は最新push SHAのCI結果で終端する
- push後CI: `1dfb2c5`はLinux/macOS PTY fixtureの未知model capability未設定で失敗し、`216f3a8`では両OS PTYを含むtest matrixがgreen化。dependent package jobは、SEA生成成功後も削除済みCJSを旧CI smokeが要求して失敗した。SEA-only契約へgateを更新し、次SHAで全dependent jobsを再評価する
