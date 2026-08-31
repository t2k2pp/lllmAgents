# 操作学習（Workflow Learning）

- Status: implemented
- 導入日: 2026-08-31
- 対象: local CLIの`browser_*` / `computer_*`

## 1. 目的と非目的

操作学習は、ユーザーが明示的に開始した区間でエージェントが成功させたbrowser/computer tool callを、再利用可能なproject-local skillへ変換する。PC操作を一回限りの実行で終わらせず、入力、検証、権限境界を含むworkflowとして残す。

任意の人間のmouse/keyboard操作を常時監視するscreen recorderではない。対象はエージェント経由で引数と成否を観測できるtool callだけであり、raw画面、tool出力、入力文字列は学習データとして保存しない。

## 2. 利用フロー

```text
/learn start <skill-name> <browser|computer|both> [説明]
> エージェントへ対象操作を順番に実演させる
/learn status
/learn finish
/<skill-name>
```

- skill名は64文字以内のkebab-case。
- browser/computer capabilityが登録されていなければ、導入・診断・再起動方法を示して開始前に失敗する。
- 最大50 step。1件でも対象toolが失敗するか並列実行されると記録をtaintし、`finish`は拒否する。`/learn cancel`後に最初から実演し直す。
- 記録中にremote surfaceまたはdelegated agentから対象操作が来た場合は、副作用前に拒否して記録をtaintする。記録はmain local CLIの単一実演者へ固定する。
- 保存先は`.localllm/skills/<skill-name>/SKILL.md`。既存skillは上書きしない。
- 保存直後から同じsessionでslash triggerを直接実行できる。

モデルからも`workflow_learn_start` / `status` / `finish` / `cancel`を呼べるが、ユーザーが操作学習を明示した場合に限る。4 toolはremote surfaceとworktree agentで利用できない。

## 3. 保存境界

| 観測値 | 保存形式 |
|---|---|
| 成功したtool名と安全な固定引数 | 順序付きstep |
| `browser_type.text` / `computer_type.text` | `<INPUT_n>` |
| query、fragment、資格情報、secretらしいpathを含むURL、data等の非HTTP URL | `<URL_n>` |
| secret、email、長いtokenらしい値を示すselector | `<SELECTOR_n>` |
| screenshot保存先 | 保存しない |
| computer window ID | `<WINDOW_ID_FROM_COMPUTER_WINDOWS>` |
| tool output、snapshot本文、画像 | 保存しない |
| 失敗したtool call | stepにせず記録全体をtaint |

生成skillには`disable-model-invocation: true`を必ず設定する。モデル向け`skill` toolとsub-agent preloadはこのfieldを検査して拒否するため、実行入口はユーザーのslash入力に限定される。

## 4. 再生時の安全契約

1. placeholder値を推測せず、不足値をユーザーへ確認する。
2. browser操作前に現在DOMを読み、記録selectorが同じ対象を指すか確認する。
3. computer操作前に`computer_windows`で対象を選び直す。一時window IDを再利用せず、座標も現在のwindow寸法で確認する。
4. skillは権限付与ではない。通常permissionと`computer_*`の呼出しごとの一回確認を維持する。
5. step失敗時は停止し、別のsurfaceや操作へ黙って置き換えない。
6. 最後にsurfaceに対応するsnapshot/screenshot等で結果を観測し、観測できない成功を主張しない。

## 5. filesystem安全性

保存時にproject rootと`.localllm/skills`のrealpath containmentを検証し、symlink/junctionによるproject外escapeを拒否する。専用一時directoryへ`SKILL.md`をatomic writeしてからrenameし、中途半端なskillを公開しない。保存済み同名directoryは削除・更新しない。

## 6. 評価gate

- unit: sanitization、scope、50-step境界、失敗/並列taint、no-overwrite、symlink escape、remote/worktree拒否、manual-only実行拒否。
- loader: `disable-model-invocation`のboolean契約とvalidator一致。
- browser smoke: 実Chromiumでdata URLのDOMへ秘密値を入力し、button click後の表示を観測。生成skillに入力値とraw URLが残らず、placeholderとmanual-only fieldが保存されることを確認。
- command UX: `/learn`のhelpと補完をregistry testで固定。

実ブラウザgateは`npm run test:workflow-learning:browser`。Playwright/Chromium不足時はskipせず、`localllm --install-browser`相当の導入を求めて失敗する。
