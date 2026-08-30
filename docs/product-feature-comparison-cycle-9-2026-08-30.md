# Codex / Claude Code 機能比較・差分レビュー／セッション整理 cycle 9

- 日付: 2026-08-30
- 基準commit: `cee663e`
- 観点: Codex / Claude Code開発者の観点から、機能の有無だけでなく通常操作での完成度、失敗の可視性、セッション継続性を比較する
- 対象: cycle 8以降のREPLコマンド、Git差分表示、session保存・resume/fork、配布時のWindows Git解決
- 完了条件: 公式一次資料で比較表を更新し、既存`/diff`の実利用不能を閉じる。両比較製品にあり本アプリにないセッション命名を追加し、unit/E2E/実PTY相当・lint/build/package・最新push SHAのCIを通す

## 1. 比較基準と証拠

2026-08-30に次の公式一次資料を確認した。

- OpenAI: [Codex developer commands](https://developers.openai.com/codex/cli/slash-commands)。`/diff`はstage済み・未stage・未追跡を表示し、`/rename`は保存済みchatの名前を変える
- Anthropic: [Claude Code commands](https://code.claude.com/docs/en/commands)。`/diff`は未commit差分とturn別差分を表示し、`/rename`は現在sessionを命名する
- 本アプリ: `src/cli/repl.ts`、`src/agent/session-manager.ts`、unit/E2E、cycle 8記録、2026-08-29以降の運用ログ集計

記号は `◎`=主要状態で操作でき回帰gateあり、`○`=一部あり、`—`=同等機能なし。コマンド名が存在するだけでは `◎` にしない。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents（変更前） | 今回後 | 判定 |
|---|---|---|---|---|---|
| repository指示 / memory | AGENTS.md、memory | CLAUDE.md、rules、auto-memory | CLAUDE.md、rules、`/memory` | 同左 | ◎ |
| skills / agents / plugins | skills、subagents、plugins | skills、subagents、plugins/marketplace | skills、agents、local plugin | 同左 | ○（marketplaceなし） |
| parallel / background / steer | subagent/background/follow-up | subagents/dynamic workflow/cross-session message | task list/output/send/cancel | 同左 | ○（独立session間messageなし） |
| plan / goal / schedule | plan、goals、schedule | plan、tasks、loop | `/plan`、Goal Seek、goal-loop、schedule | 同左 | ◎ |
| session resume / fork | resume / fork | resume / fork / rewind | resume / fork | 同左 | ◎ |
| **session naming** | `/rename`、名前でresume | `/rename`、session pickerへ表示 | 自動titleのみ。明示変更不可 | **`/rename <name>`で保存・resume一覧へ反映** | **◎** |
| **working-tree diff** | `/diff`でstage/unstage/untracked | `/diff`で未commit/turn別diff | `/diff`は`--stat`だけ。untrackedなし。GitがPATHにないWindowsで失敗 | **実差分をstage/unstage/untracked込みで表示。Git既定install先も解決** | **◎** |
| code review | `/review` / `codex review` | `/review` / Code Review | code-review/pr-review skill、code-reviewer agent | 同左 | ○（専用UIなし） |
| checkpoint / rewind | conversation/file state | promptごとのcode/conversation rewind | artifact-scoped checkpoint | 同左 | ○ |
| permission / sandbox | approvals、sandbox、profiles | permission modes、managed policy | rules、Seatbelt/bwrap/WSL、safe mode | 同左 | ◎ |
| browser操作 | browser/computer surfaces | Chrome integration | Playwright browser tools | 同左 | ○ |
| OS desktop Computer Use | desktopで画面認識・入力 | macOS CLI/desktop、desktop app | なし | なし | — (`GAP-CU-01`) |
| multi-provider / local LLM | OpenAI中心 | Claude/一部third-party | 多provider/local LLM | 同左 | ◎（独自強み） |

## 3. 発見事項と改善設計

| ID | 優先度 | 変更前の証拠・影響 | 改善設計 | 終端 |
|---|:---:|---|---|---|
| DIFF-GIT-01 | P1 | `/diff`が`git diff --stat`だけを実行し、変更内容と未追跡ファイルを表示しない。現Windows環境ではGit for Windowsが標準位置に存在してもPATHに無く、汎用エラーになる | shellを介さずGit実行ファイルを検証・解決し、HEADとの差分と未追跡ファイルのno-index diffを結合。Git不在・非repository・出力上限超過は原因と復旧操作を返す | closed。unit 3件とE2E scenario 6で実差分・未追跡・失敗理由を確認 |
| GAP-SESSION-NAME-02 | P2 | `SessionMeta.title`は初回user文から自動生成されるだけで、長期作業を人が識別可能な名前へ変更できない | `/rename <name>`をregistry commandとして追加。control/format文字を空白化し、空名を拒否、80 grapheme上限、atomic session保存を行う | closed。unitとE2Eで名前の安全化・保存・`/resume list`反映を確認 |
| SKILL-VALIDATE-03 | P2 | runtime loaderが使う`trigger`/`context`/`tools`をvalidatorが拒否し、標準scriptも2 skillだけを固定検査していた。project skillを全件検証できない | validatorへruntime拡張と`--root`列挙を追加し、builtin/project skill全件を標準gateにする。Claude互換`allowed-tools`もruntimeのtools契約へ変換する | closed。loader/validator unit 12件、builtin 19・project 6 skillの実検証を通過 |
| PACK-NPM-04 | P1 | 配布評価で`npm pack --dry-run`がSEA executableと開発資産を含み446.7 MB（展開1.0 GB、1714 files）になった | `package.json#files`をruntime JS/typeと同梱assetへ限定。実pack JSONを検査し、800 files・展開32 MiB・exe/blob/tests/sandbox等の混入をCIで拒否 | closed。506 files、2.3 MB package、展開9.2 MiBへ縮小し、validator unit 7件を追加 |
| GAP-CU-01 | P2 | browser toolはChromium内だけでOS window拘束・screen capture・input injection・OS permissionがない | browserとは別機能として維持。OS別driverと安全境界を設計するまで同等扱いしない | open（今回範囲外。専用OS driver・権限・実機gateが必要） |

## 4. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存warning 279件・info 97件
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: unit 109 files passed / 3 skipped、1195 tests passed / 24 skipped。E2E 5/5 passed
- `npm.cmd run analyze:loop -- --since 2026-08-29`: session 0、user span 0、stuck-loop 0
- sandbox内のVitest起動は親directory読取制限で失敗したため、同じcommandを承認済み環境で再実行して上記ベースラインを取得
- ユーザー所有変更: `sandbox/`配下の未追跡6群。変更・stage対象外

## 5. 実装後評価

### 5.1 実装結果

- `/diff`: registry commandへ移し、HEADに対するstage済み・未stageのbinary-safe diffと、未追跡ファイルのno-index diffを一括表示する。PATHとGit for Windows既定install先を同一capabilityとして検証し、非repository・Git不在・8 MiB超過を復旧案内付きで失敗させる
- `/rename <name>`: 現在sessionのtitleをcontrol/format文字除去、空名拒否、80 grapheme制限後にatomic保存し、`/resume list`とpickerが同じmetadataを読む
- skill validation: runtimeとvalidatorのfrontmatter契約を揃え、`--root`で対象root直下を全列挙する。固定2件だけが緑になる状態を廃止した
- npm package: runtime allowlistと`validate:package`を追加し、実pack内容の容量・file数・禁止assetを各OSのCIで検査する

### 5.2 ローカル品質gate

- `npm.cmd run test:all`: unit 112 files passed / 3 skipped、1214 tests passed / 24 skipped。E2E 6/6 passed
- `npm.cmd run test:coverage`: 同unit全件passed。Statements 39.37%、Branches 76.52%、Functions 62.94%、Lines 39.37%
- `npm.cmd run lint`: exit 0、332 files検査、既存warning 279件・info 97件（error 0）
- `npm.cmd run build`: passed
- `npm.cmd run validate:skills`: builtin 19、`.localllm` project 5、`.claude` project 1、全25件passed
- `npm.cmd run validate:package`: 506 files、package 2.3 MB、展開9.2 MiB、禁止assetなし
- `npm.cmd audit --omit=dev --audit-level=high`: 0 vulnerabilities
- `npm.cmd run build:exe`: Windows SEA生成passed。隔離`USERPROFILE`で`--help` / `--version`はいずれもexit 0で、`.localllm`を生成しない
- `npm.cmd run analyze:loop -- --since 2026-08-29`: sessions 0、user spans 0、stuck-loops 0
- `git diff --check`: passed
- WindowsローカルはPTY driver対象外。変更後の実REPLはnon-TTY E2E scenario 6で操作し、Linux/macOSのCI `test:pty`は`/help → PgUp → PgDn → /quit`の実PTYを継続検証する

### 5.3 CI closure

- 実装境界: `6be5170`（`feat(cli): 差分レビューとセッション整理を実用化する`）
- GitHub Actions run: [33299645255](https://github.com/t2k2pp/lllmAgents/actions/runs/33299645255)
- `Commit message policy`: success
- `test (ubuntu-latest)`: success。bubblewrap統合、実PTY、npm package実内容検証を含む
- `test (macos-latest)`: success。Seatbelt統合、実PTY、npm package実内容検証を含む
- `test (windows-latest)`: success。Windows Git解決、unit/E2E、npm package実内容検証を含む
- dependent `Windows deploy / exe smoke`: success。SEA version、commit revision、agent/skill asset、CJS非混入を確認
- 本記録のclosure commitもlatest SHAとして同じworkflowを再実行し、全依存jobのsuccessを最終handoff条件にする

## 6. 残課題の終端判断

- `GAP-CU-01`: browser automationをnative OS Computer Useと偽って同等扱いしない。OS別screen/input driver、macOS Accessibility・Windows UIAccess等の権限、安全な対象window拘束、実機gateを独立設計する必要があるため、本cycleの安全なCLI機能追加とは分離した
- plugin marketplace、独立session間message、専用review UI、conversation rewindは比較表上の部分差であり、既存機能の故障ではない。今回の共有コア欠落は両製品に存在し安全に閉じられるsession namingを選定した
