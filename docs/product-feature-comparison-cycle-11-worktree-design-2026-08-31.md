# Codex / Claude Code 機能比較・sub-agent worktree 分離 cycle 11 設計

- 日付: 2026-08-31
- 基準 commit: `ad1dde8b7b7953f00dd256ba0c97cc31d3860662`
- 状態: **実装・ローカル評価完了**（cross-OS / deploy の終端は実装commitに紐づくGitHub Actions checkを正本とする）
- 観点: Codex / Claude Code の開発者観点から、機能名の有無だけでなく、通常操作での完成度、並列編集の正しさ、失敗の可視性、回収・保持・配布まで比較する
- 実装境界: 比較で選定した `GAP-02` を、workspace/Git/security/task lifecycle/回収 UI まで一体で実装する
- 完了条件: 対象回帰、全 unit/E2E、cross-OS Git、lint/build/package/SEA、最新 push SHA の全依存 CI job を通す

## 1. 比較基準と証拠

外部仕様は 2026-08-31 に公式一次資料を再確認した。

- OpenAI: [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- Anthropic: [Extend Claude Code](https://code.claude.com/docs/en/features-overview)、[Interactive mode](https://code.claude.com/docs/en/interactive-mode)、[Run agents in parallel](https://code.claude.com/docs/en/agents)、[Worktrees](https://code.claude.com/docs/en/worktrees)、[Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- 本アプリ: `README.md`、`docs/external_design.md`、`docs/internal_design.md`、cycle 1〜10 の比較記録、`docs/changelog-feature-backlog.md`、直近履歴、現行 source/test

OpenAI は、同じ project の複数 chat を独立 checkout で並列実行し、managed worktree を detached HEAD で作り、Local との Handoff で変更を安全に移す。Claude Code は session と sub-agent の双方に worktree を提供し、`isolation: worktree`、main checkout への edit/command/Git redirect の遮断、変更あり worktree の保持、lock と retention sweep を契約にしている。

記号は `◎`=主要状態で操作でき、失敗契約と回帰 gate がある、`○`=類似機能または一部のみ、`—`=同等機能なし。名前や API が存在するだけでは `◎` にしない。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents 現状 | 判定・根拠 |
|---|---|---|---|---|
| repository 指示 | `AGENTS.md` | `CLAUDE.md`、rules | `AGENTS.md` / `CLAUDE.md` / `LOCALLLM.md` / rules | ◎ |
| 永続 memory | memories と生成制御 | auto-memory、project/user memory | `MEMORY.md`、`knowledge_*`、`/memory` | ◎ |
| file mention / image context | `@`、`/mention`、image input | `@` path autocomplete、image input | `@path`補完、text/directory/image 展開 | ◎。`input-resolver` 14件、completer 39件の回帰あり |
| skills | local/plugin skills、選択 UI | skills、frontmatter、plugin skill | builtin/user/project/plugin skill、`context:fork`、preload | ◎（管理 UI は限定） |
| custom agent / sub-agent | subagents、agent 定義、follow-up | custom subagents、background、named agent | 5 builtin + custom/plugin agent、model/skill/max-turn 指定 | ◎ |
| plugin bundle | skills/MCP/agent を bundle | skills/agents/hooks/MCP、marketplace | trusted local bundle | ○。remote marketplace/install/update/署名なし (`GAP-04B`) |
| MCP / hooks / rules | MCP、hooks、rules | MCP、広い lifecycle hooks、permissions | MCP、hooks、rules | ○。中核はあるが hook event と管理面は狭い |
| parallel / background lifecycle | parallel subagents、wait/close | subagents、agent view、tasks | `task`、`task_list/output/cancel`、並列上限 | ◎（parent 集約） |
| 実行中 agent の steering | follow-up routing | named follow-up、team message | FIFO `task_send`、provider abort、stale tool skip | ◎（peer-to-peer はなし） |
| **parallel editing の worktree 分離** | chat/scheduled task worktree | session/sub-agent worktree、`isolation: worktree` | `isolation: worktree`、agent別detached checkout、diff/apply/discard、変更保持 | **◎ (`GAP-02` closed)** |
| plan / task / goal | plan、goal | plan、tasks | `/plan`、ToDo、Goal Seek、goal-loop | ◎ |
| schedule / loop | scheduled tasks | scheduled tasks、`/loop` | `/loop` + `schedule_create/list/delete` | ○。session scoped、永続 scheduler ではない |
| session resume / fork / naming | resume、fork、rename、archive | resume、fork、rename、session picker | `/resume`、`/fork`、`/rename` | ◎（archive はなし） |
| rewind / checkpoint | Record & Replay、chat fork | prompt単位 code/conversation rewind | artifact-scoped shadow Git checkpoint | ○。会話と repository 全体の rewind ではない |
| working-tree diff | staged/unstaged/untracked | uncommitted/turn diff | `/diff`で staged/unstaged/untracked と binary を表示 | ◎ |
| dedicated code review | `/review` / `codex review` | `/review`、Code Review | code-review skill / agent、pr-review skill | ○。能力はあるが target 選択 UI と専用結果面なし |
| quick shell / terminal | `!`、background terminal、`/ps` | `!`、background Bash、`/tasks` | LLM 経由 `bash`、`/parallel` | ○。直接 quick shell なし (`CL-06`) |
| permissions / sandbox / safe mode | profiles、approval、OS sandbox | permission modes、sandbox、safe mode | rules、Seatbelt/bwrap/WSL、autorun、safe mode | ◎ |
| web / browser | web search、browser/computer surfaces | web search、Chrome integration | web search/fetch、Playwright browser | ◎（browser は opt-in） |
| native Computer Use | window/screen 操作 | app 操作と app permission | opt-in、window限定 capture/input、CLI 毎回確認 | ○。Windows 実機済み、macOS/Linux 実 desktop 未検証 |
| image generation | image generation | tool/plugin 経由 | Azure GPT Images / SD WebUI / ComfyUI | ◎（独自 multi-provider） |
| structured non-interactive output | JSON/JSONL、schema、SDK | json/stream-json/schema、SDK | non-TTY text pipe中心 | ○ (`GAP-08`) |
| cloud / IDE / remote handoff | IDE、cloud、Local↔Worktree Handoff | IDE、agent view、remote sessions | CLI、Discord/Slack Room | ○。remote channel はあるが cloud handoff ではない |
| multi-provider / local LLM | OpenAI中心 | Claude中心、一部 provider | Ollama/LM Studio/llama.cpp/vLLM/OpenAI/Anthropic/Azure/Gemini | ◎（本アプリの差別化） |

## 3. 「既存の似た機能」を見落としていないか

`GAP-02` と誤認し得る既存機能を、source と挙動で個別に除外した。

| 既存機能 | 実装 | 似ている点 | worktree 分離と同等でない理由 |
|---|---|---|---|
| `/diff` の `worktree-diff.ts` | `src/cli/worktree-diff.ts` | Git working tree を扱う | 名前は working-tree diff の意味。`git worktree add/list/remove`、checkout 所有、agent cwd は一切ない |
| shadow Git checkpoint | `src/checkpoint/checkpoint-manager.ts` | 別 Git directory に snapshot を保持 | 同じ実ファイルを全 agent が編集する。衝突隔離ではなく復元用履歴 |
| session `/fork` | `src/agent/session-manager.ts` | 元を変えず新 ID を作る | messages/todos/goal の deep copy だけで filesystem は共有 |
| Room / channel session | `src/agent/room-manager.ts` | conversation state を分離 | tool は同じ process cwd と PermissionManager を使う |
| background `task` | `src/agent/sub-agent.ts` | context と provider request を並列化 | `SubAgent` は共有 ToolRegistry/PermissionManager から ToolExecutor を作り、workspace root を持たない |
| `@path` attachment | `src/cli/input-resolver.ts`、`completer.ts` | agent に対象 file を明示 | context attachment であり編集 checkout は分離しない |
| plugin / custom agent | `plugin-loader.ts`、`agent-loader.ts` | agent ごとに tool/skill を変えられる | frontmatter に isolation がなく、全 tool path は process-global |

この gap は新しい推測ではない。cycle 1/2/3/4/6 で `GAP-02`、`docs/changelog-feature-backlog.md` で `CL-07` として継続記録されている。今回の再調査では、`file_read/write/edit`、`glob/grep`、`bash`、sandbox、permission、system prompt が `process.cwd()` に依存するため、過去の「`sub-agent.ts` を直す M 規模」という見積りが不足していることまで確認した。

## 4. 候補 gap の優先順位

| 候補 | 両製品との共通性 | 既存類似の充足度 | 利用価値 / リスク | 優先度 | 判断 |
|---|---:|---:|---|:---:|---|
| `GAP-02` sub-agent worktree 分離 | 高 | なし | parallel write の上書き・不整合を防ぎ、既存 task 群を完成させる | **P1** | **実装・回帰追加済み** |
| `GAP-08` structured non-interactive output | 高 | text pipeあり | CI/automation に有用だが並列編集の正しさを直さない | P2 | 後続 |
| dedicated review UI | 高 | skill/agentあり | discovery と target 選択の UX gap。能力自体はある | P2 | 「類似機能なし」ではないため選外 |
| conversation rewind | Claudeで強い | fork/checkpointあり | 有用だが会話履歴・filesystemの二相復元が必要 | P2 | 後続 |
| plugin marketplace/update | 高 | local bundleあり | supply-chain trust、署名、更新 rollback が必要 | P2 | local plugin を「なし」と誤判定しない |
| quick shell `!` | 高 | bash toolあり | turn節約になるが既存中核の完成度への影響は小さい | P3 | 小さく閉じる選択を避け、今回は選外 |

`GAP-02` は以前 P2 だったが、現在は `task(run_in_background)` と editing agent を正式機能として提供し、並列数も設定可能である。二つの `file_write` が同じ path を更新すれば後勝ちで成果を失い得るため、単なる追加 UI ではなく既存並列機能の正しさを閉じる P1 と再評価する。

## 5. 発見事項

| ID | 優先度 | 証拠・原因 | 影響 | 設計上の終端 |
|---|:---:|---|---|---|
| PAR-WT-01 | P1 | background/parallel agent が context だけ分離し、file/bash は同じ cwd を共有 | 同じ file の上書き、片方の test が他方の途中状態を検証、取消後の残存変更 | **closed**: agent ごとのcheckoutを所有し、並列同名編集と取消後保持を回帰化 |
| WS-ROOT-02 | P1 | path tool、bash、permission、sandbox、system prompt が process-global cwd を参照 | `git worktree add`だけ追加すると、表示上は隔離済みでも main checkout を編集する偽の安全性 | **closed**: immutable `WorkspaceContext` とrealpath containmentを全file/path toolへ伝播 |
| CHECKPOINT-GIT-03 | P1 | `/diff` は Git for Windows 標準位置を解決するが checkpoint は文字列 `git` のみ。明示 ON でも Git 不在時は警告して起動継続 | Windowsで機能間の判定が不一致。「保護 ON」だが snapshot 0件の状態を許す | **closed**: Git resolverを共通化し、checkpoint明示ONの利用不能を起動前error化 |
| WT-SUPPLY-04 | P1 | repository-local Git hook/filter は checkout 中に process を起動し得る | untrusted repository から worktree 作成だけで任意 command 実行の可能性 | **closed**: empty hooks、fsmonitor無効化、実効filter/includeの作成前拒否を回帰化 |
| WT-RETENTION-05 | P1 | background cancel/process crash と worktree cleanup の ownership が未設計 | 変更あり worktree の誤削除、または無期限蓄積 | **closed**: lockとdurable record、cancel/crash復旧、変更あり自動削除禁止を回帰化 |
| DOC-WT-06 | P2 | backlog は `sub-agent.ts` だけを改修する M 規模・価値★☆☆と記載 | 実装者が workspace/security/cross-OS gate を省略する | **closed**: 本記録とbacklogを実装結果へ同期 |

## 6. 選定機能の外部契約

### 6.1 agent 定義と `task`

1. `AgentDefinition` に `isolation?: "shared" | "worktree"` を追加し、frontmatter `isolation: worktree` を読む。未指定は後方互換の `shared`。
2. `task` に optional `isolation: "worktree"` を追加する。call-site は shared agent を今回だけ強化できるが、definition で worktree 必須の agent を shared へ降格できない。
3. worktree は main orchestrator からの local CLI 呼出しだけ許可する。Discord/Slack、nested agent、second-LLM 経路は理由と recovery action を返して拒否し、shared 実行へ自動代替しない。
4. `explore` / `plan` でも指定は受けるが、変更ゼロなら終了時に自動除去する。editing agent だけを暗黙に worktree 化はしない。
5. v1 の base は明示的に `HEAD` の commit SHA とする。main checkout に staged/unstaged/untracked があれば、未反映状態を黙って捨てず起動前に fail-fast する。stash、自動 commit、未追跡/ignored file のコピーはしない。

例:

```yaml
---
name: refactorer
description: Applies isolated refactors
tools: [file_read, file_write, file_edit, glob, grep, bash]
isolation: worktree
---
```

```json
{
  "subagent_type": "general-purpose",
  "description": "refactor parser",
  "prompt": "Refactor the parser and run focused tests.",
  "run_in_background": true,
  "isolation": "worktree"
}
```

### 6.2 可視化と直接操作

- `SubAgentResult` / `task_list` に `isolation`、`workspaceId`、`baseCommit`、`worktreePath`、`workspaceState` (`active|cleaned|changed|applied|discarded|error`)、`changedFiles` を追加する。prompt/follow-up本文は従来どおり list に出さない。
- `task_output` は変更あり workspace の管理recordを結果回収後も消さない。shared task と変更なし worktree は従来どおり回収後に解放できる。
- read-only `task_diff(agent_id)` と、ユーザー直接操作用 `/tasks [list]`、`/tasks diff <id>` を追加する。diff は stage/unstage/untracked、binaryを含め、既存 8 MiB 上限を共通化する。
- mutation は `task_apply(agent_id)` / `/tasks apply <id>`、`task_discard(agent_id)` / `/tasks discard <id>` に分ける。apply/discard は inherently-safe に入れず、local CLI の明示確認を必須とする。
- worktree 作成不能、main dirty、Git 不在、隔離違反、apply競合では、観測状態と具体的 recovery を返す。shared task へは落とさない。

## 7. 内部設計

### 7.1 `WorkspaceContext` を process-global cwd から分離

```ts
interface WorkspaceContext {
  mode: "shared" | "worktree";
  root: string;
  mainCheckoutRoot: string;
  repositoryCommonDir?: string;
  workspaceId?: string;
  baseCommit?: string;
}
```

1. main loop は起動時 cwd を immutable な shared context に固定する。`SubAgent` は context を constructor で受け、`ToolExecutor` が毎 tool call に渡す。
2. `file_read/write/edit`、`glob/grep`、`bash`、diff、screenshot保存など path を扱う handler は `process.cwd()` ではなく context.root で相対 path を解決する。
3. system prompt の Working directory / Git 情報も context から生成する。worktree agent には main checkout path を書かず、isolation root と「外へ出ない」契約を注入する。
4. `PermissionManager` / `Sandbox` は read root と write root を分ける。worktree agent の write root は worktree のみ。preloaded skill は read-only追加とし、`addAllowedDir` で書込みまで許す現行契約を分離する。
5. `ToolHandler` に workspace policy (`aware|agnostic|forbidden`) を持たせる。filesystem/process を動かす未知の plugin/MCP tool は worktree agent から既定拒否する。network-only/read-only core tool は明示 `agnostic` とする。
6. `process.chdir()` は使わない。並列 agent 間で process cwd が競合するため、test でも禁止を固定する。

### 7.2 shell / Git redirect の遮断

- bash/PowerShell の child process は `cwd: context.root` で起動し、OS sandbox の write allowlistから main checkoutを除く。
- file tool は realpath containment を毎回検証し、symlink/junction で main checkoutへ到達する path を拒否する。存在しない作成先は最初に存在する親を realpath して判定する。
- worktree agent の command は main checkout を指す `cd`、`git -C`、`--git-dir`、`--work-tree`、`GIT_DIR`、`GIT_WORK_TREE` を拒否する。構文を安全に追跡できない command は実行せず、分割した command への書換えを案内する。
- PowerShell も少なくとも process cwd と絶対path containmentを同じ gate に通す。OS差を理由に main checkout 操作を許さない。
- isolation中に対象 worktree が消えた、Git identity が変わった、common dir が main repository と一致しない場合は次 tool 前に task を失敗させる。

### 7.3 `GitCapability` / `WorktreeManager`

`src/cli/worktree-diff.ts` の Git executable 解決を `src/git/git-command.ts` へ移し、diff、checkpoint、worktree、test helper が同じ capability を使う。PATH と Git for Windows の既定 install 先だけを同じ Git として試し、別 VCS や shell へ代替しない。

`WorktreeManager` は repository 単位の queue で shared `.git/worktrees` 更新を直列化する。

1. `rev-parse --show-toplevel`、`--git-common-dir`、`HEAD`、status を取得する。non-repository、unborn HEAD、dirty checkout は作成前に拒否する。
2. managed root は `~/.localllm/worktrees/<repo-hash>/<workspace-id>`。短い random ID を使い、managed root/親/target の symlink・junction と containment を確認する。
3. `git worktree add --detach <path> <baseSha>` を shell なしで実行する。作成後に top-level、common-dir、HEAD が期待値と一致するまで agent を起動しない。
4. repository-local hooks は検証済み empty hooks dir で無効化し、`core.fsmonitor=false` とする。local config の filter driver を列挙して checkout 時の external process を無効化する。`includeIf` 等で安全に確定できなければ fail-fast する。
5. active中は `git worktree lock --reason localllm:<pid>:<workspace-id>` と durable metadata を保持する。終了/cancelで unlockし、状態を再集計する。
6. change/untracked/独自commitが無ければ通常 remove。いずれかがあれば path と diff を保持する。periodic sweep は clean/appliedだけを対象にし、判定不能や未回収変更を force remove しない。

### 7.4 変更の回収

`task_apply` は自動 merge/cherry-pickを行わず、workspaceの `baseCommit` から最終 filesystem state への binary patch を main checkoutへ適用する。

事前条件:

- task が終端済みで、manager metadata と Git identity が一致する
- main checkout の `HEAD === baseCommit`
- main checkout が staged/unstaged/untracked を含め clean
- patch が size/path/type gate を通り、submodule/gitlink・worktree外symlink等の未対応状態を含まない
- `git apply --check --binary` が全体成功する

適用後は changed path の blob hash / deletion / mode を worktree と比較する。完全一致した場合だけ `applied` とし、worktree を安全に removeする。競合、race、検証不一致では partial success と表示せず task/worktree を保持し、mainの観測状態と手動 recoveryを返す。silent `--3way`、自動commit、force cleanupは行わない。

`task_discard` は登録済み managed path と identity を再検証し、変更一覧を表示したうえで明示確認された場合だけ `git worktree remove --force` する。任意 path を引数に取らず、agent IDからのみ解決する。

### 7.5 checkpoint との棲み分け

- shadow checkpoint は一つの checkout 内での復元履歴、worktree は同時編集の隔離であり、置換関係ではない。
- worktree agent の file tool に main session の CheckpointManager を接続しない。別 checkoutへのsnapshot混入を防ぐ。
- `task_apply` 前の main checkout は clean を要求するため、自動 checkpoint を rollback の代用品にしない。
- checkpoint が明示 ON で Git capability 不足なら起動を止める。警告後に snapshot 0件で続ける現行挙動は `CHECKPOINT-GIT-03` として同じ実装 cycle で閉じる。

## 8. 実装単位

1. **Red contract**: shared cwdへの書込み、Git redirect、dirty/non-repo/Git不在、symlink/filter/hook実行、cancel/cleanupを失敗testで固定する。
2. **Git core**: resolver/runner/config inspection/identity/lock と既存 diff/checkpoint の統合。
3. **Workspace context**: ToolExecutor、path tools、bash、permission/sandbox、system promptを per-agent root化する。
4. **Lifecycle**: AgentDefinition/task schema、WorktreeManager、SubAgentManager state、cancel/crash/retention。
5. **Recovery UX**: task list/output/diff/apply/discard と `/tasks`、docs/help。
6. **Distribution**: package allowlist、SEA asset/import、cross-OS smoke、CHANGELOG/README/internal/external design を同期する。

各境界で test/lint/build を通すが、実装途中の green を機能完了とは扱わない。特に「worktreeを作れた」だけでは、main checkout遮断と変更保持が未完成なので `GAP-02` は closed にならない。

## 9. 評価計画

### 9.1 unit / integration

- AgentDefinition の `isolation` parse、call-site強化、definition必須をsharedへ降格不能
- foreground/background、task_send、task_cancel、max-turn、provider errorの全終端でlock/stateが一貫
- 二つのediting agentが同名relative fileを同時編集しても checkout と結果が独立
- file read/write/edit、glob/grep、bashがworktree rootを使い、main absolute path、symlink/junction、`git -C`、env redirectを拒否
- Git PATHなし + Windows標準位置、path space/日本語、detached HEAD、unborn/non-repo、dirty checkout
- malicious post-checkout hook/filter/fsmonitor がsentinelを作らず、安全に無効化不能なら作成自体が失敗
- clean worktree自動削除、changed/untracked/commitあり保持、cancel/crash保持、retentionで未回収変更を削除しない
- diffのtext/binary/untracked/deletion/mode、8 MiB上限
- applyのHEAD drift、dirty main、conflict、race、binary/untracked/deletion、post-image hash不一致でfail-closed
- discardが未登録pathやidentity不一致を拒否し、明示確認なしでforce removeしない
- checkpoint explicit ON時のGit不足を起動失敗にし、標準Git resolverを共有

### 9.2 E2E / 実環境

- mock LLMで二つのbackground taskをworktree起動し、同じfileへ異なる変更を加える。実行中もmainが不変、`/tasks diff`で各差分を識別、片方だけapply後にmainが完全一致することを確認
- agentがmain checkout absolute pathと`git -C <main>`を試み、tool errorになりmain hashが不変であることを確認
- task cancel後に変更ありworktreeが残り、再起動後もlist/diff/discardできることを確認
- Windows/macOS/Linuxのtemp Git repositoryで作成・lock・remove・binary patchを実行。WindowsはGit for WindowsのPATH外解決とspace/日本語pathを含める
- SEAを隔離HOMEで起動し、help/versionに副作用がなく、worktree scenarioがNode開発環境だけでなく配布artifactでも動くことを確認
- TUI key処理は変更対象外。ただし `/tasks` 出力はnon-TTY E2Eと実PTYで長いpath/diffのscrollを確認する

### 9.3 全体 gate

- 対象回帰を複数回実行し、列挙順・mtime・Windows lock依存を除く
- `npm.cmd run test:coverage`、`test:e2e`、`lint`、`build`、`validate:skills`、`validate:package`
- `npm.cmd audit --omit=dev --audit-level=high`
- Windows SEA build + real executable smoke
- pushした最新SHAの commit policy、Ubuntu、macOS、Windows、dependent Windows deploy/package smokeを全job終端まで監視

## 10. 明示的な非対象

- remote/cloud worktree、mobile/Discord/Slackからのcreate/apply
- SVN/Perforce等の非Git VCS
- remote default branch fetch、PR URL/番号からのworktree
- `.worktreeinclude` によるignored secret/configのコピー
- branch自動作成、commit、push、PR作成、auto merge/cherry-pick/3-way fallback
- plugin/MCP toolの一律workspace-aware認定
- main session自体のLocal↔Worktree Handoff

これらを shared mode へ自動代替しない。要求された場合は「未対応能力、観測状態、回復/代替の明示選択」を返す。

## 11. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存 warning 279件 / info 97件、error 0
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: unit 116 files passed / 3 skipped、1238 tests passed / 24 skipped。後続 E2E 7 tests も通過したため command 全体が exit 0
- `npm.cmd run test:e2e`: 1 file / 7 tests passed（設計記録の件数を独立再確認）
- `npm.cmd run analyze:loop -- --since 2026-08-30`: session 0、user span 0、stuck-loop 0。prompt/response原文は取得・転載していない
- sandbox制限内では esbuild が repository 上位directoryを走査して `Access is denied`。同一 `test:all` を許可済み環境で再実行して上記結果を取得
- 作業開始時の tracked change: 0。`sandbox/`配下に大量の未追跡 user artifact があり、本設計の変更・stage対象外
- 基準 `HEAD` と `origin/main`: ともに `ad1dde8b7b7953f00dd256ba0c97cc31d3860662`

## 12. 実装で判明した追加事項と修正

| ID | 原因 | 修正 | 回帰証拠 |
|---|---|---|---|
| WT-APPLY-07 | tracked patchへuntracked binary diffを混在させても`git apply`が新規binaryを実体化しない | tracked差分はbinary patch、untrackedは排他的copyに分け、適用後にpath/type/mode/hashを照合。不一致時はrollbackしてworktree保持 | tracked/binary/untrackedの同時apply test |
| WT-FILTER-08 | `git status`自体がrepository filterを起動し得るため、status後の検査では遅い | status前に対象tracked pathの実効filter属性をshellなしで検査し、外部driverが有効なら作成拒否 | marker processが起動しない悪性filter test |
| WT-FILTER-09 | globalにfilter driverが存在するだけで、当該repository未使用でも拒否すると正常repoを壊す | 全設定名ではなくcheckout対象pathの実効属性だけを拒否 | 通常repoの実worktree suite |
| WT-VERIFY-10 | diff文字列比較は改行・表現差で同じ最終状態を不一致にし得る | filesystem signatureによる最終状態検証へ変更 | Windows実Git apply test |
| WT-META-11 | foreground `task`応答の組立てが`SubAgentResult`のworkspace metadataを落としていた | background/outputと同じisolation/workspace/base/state/filesを返す | foreground task tool回帰 |
| WT-TIMEOUT-12 | 実Git統合testの既定10秒はWindows coverage並列時の11〜12秒実測を下回った | 重い2 scenarioだけ30秒にし、coverage全体を再実行 | coverage下で120 files / 1272 tests pass |
| WT-MODE-13 | apply前のunsupported mode確認が実装設計だけで回帰化されていなかった | raw mode 120000/160000を適用前に拒否しworktree保持 | 実gitlink apply拒否test |
| WT-WINPATH-14 | 初回pushのWindows CIで、Git common-dirの相対/絶対表現をNode側で補正した結果、同一worktreeをidentity不一致と判定 | Git自身の`rev-parse --path-format=absolute`でtop/common-dirを正規化し、mismatch時はexpected/observedを表示 | correction commitのWindows coverageとdependent deploy job |

## 13. 実装結果と終端

- `GAP-02` と `PAR-WT-01`〜`WT-RETENTION-05`: **実装・対象回帰 closed**。`WorkspaceContext`、`WorktreeManager`、agent定義/taskの`isolation`、`task_diff/apply/discard`、`/tasks`を追加した。
- 変更なしworktreeは自動除去し、変更・cancel・異常終了はdurable recordとともに保持する。process再起動後も`error`状態でdiff/discardへ回収し、勝手に削除しない。
- applyはcleanかつ同じbaseのmainにだけ許可し、自動merge/commit/3-way/stash/fallbackを行わない。
- Native Windowsではfile toolによるworktree編集とGit lifecycleを提供する。bashのwrite rootをOS強制できないため実行前に恒久エラーとし、WSL2またはfile toolを案内する。shared modeへ自動降格しない。
- ローカル対象評価: 実Git worktree/security/sub-agent 20件がpass。`test:coverage`は120 files / 1272 pass / 11 skip、E2Eは`/tasks`を含む7件、lintはerror 0（既存warning 279 / info 97）、build、skill/package validation、runtime audit（0 vulnerability）がpass。
- Windows SEAは`dist/localllm.exe`を生成し、実binaryの`--version` / `--help`を確認した。既存`deploy/localllm.exe`をPID 29368が使用中だったためlocal deploy directoryの上書きはfail-fastし、稼働processを強制終了しなかった。clean checkoutのdependent Windows deploy/exe smokeを最新push SHAのCIで閉じる。
