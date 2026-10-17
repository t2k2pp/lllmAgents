# Git フック (commit-msg / pre-commit)

> **作成日**: 2026-10-17
> **Status**: implemented

## 1. 目的

CI の検査で落ちる変更を、コミットの時点で止める。

経緯: 2026-10-14〜17 の main への push (CI #246〜#250) が、全 OS で `Type check & lint`
(biome の format 差分) によって失敗した。コミット前の確認が `tsc --noEmit` と vitest だけで、
`npm run lint` を通していなかったのが原因。さらに lint の失敗が後ろのステップ
(E2E・依存監査) の失敗を隠し、問題が積み重なった。人やエージェントの注意に頼らず、
仕組みで止める。

## 2. 構成

| ファイル | 役割 |
|---|---|
| `.githooks/commit-msg` | コミットメッセージ規則 (`scripts/commit-message-policy.js`) を検査する |
| `.githooks/pre-commit` | `scripts/pre-commit-check.mjs` を呼ぶ |
| `scripts/pre-commit-check.mjs` | `tsc --noEmit` (プロジェクト全体) と `biome check --staged` (ステージしたファイル) を実行する |
| `scripts/install-git-hooks.mjs` | `git config core.hooksPath .githooks` を設定する |

## 3. 有効化

- `npm install` / `npm ci` の `prepare` で `scripts/install-git-hooks.mjs` が自動実行され、
  `core.hooksPath=.githooks` になる。手動で設定し直す場合は `npm run setup:git-hooks`
- git 作業ツリーの外 (tarball 展開先など) では設定先が無いため、その旨を表示して何もしない
- 表示は stderr に出す。`npm pack --dry-run --json` (`validate:package`) の stdout に混ざると
  JSON 解析が失敗するため
- npm レジストリから利用者がインストールする場合、`prepare` は実行されない (npm の仕様)

## 4. pre-commit の検査範囲

| 検査 | 範囲 | 理由 |
|---|---|---|
| `tsc --noEmit` | プロジェクト全体 | 型はファイルをまたいで決まるため、変更ファイルだけでは判定できない |
| `biome check --staged --no-errors-on-unmatched` | ステージしたファイル | コミットに入るものだけを止める。未ステージの作業中ファイルで止めない |

- 対象は CI の `Type check & lint` (`npm run lint` = `tsc --noEmit && biome check .`) と同じ
- biome の warn は既存運用どおりコミットを止めない (エラーのみ止める)
- `node_modules` が無い場合は「`npm ci` を実行してください」と表示して失敗する (検査を飛ばさない)
- 失敗時の format 修正: `npx biome check --staged --write`
- ユニットテスト・E2E はコミットごとには回さない (所要時間が長いため)。push 前に CI と同じ手順で確認する

## 5. 運用ルール

- `git commit --no-verify` でフックを飛ばさない (`src/rules/builtin/git-workflow.md` の pre-commit hook スキップ禁止と同じ)
- フックで落ちたら原因を直してから、新しくコミットし直す
