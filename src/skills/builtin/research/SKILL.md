---
name: research
description: lllmAgents プロジェクトでの調査・コードベース理解・設計把握ワークフロー。 ユーザーが「この機能どうなってる」「〜の挙動を調べて」「PR を読み解いて」 と要求した時、 または 大きな実装の前に影響範囲を把握する必要がある時に使用する。 docs/ 配下の設計書群・main_second_swap 等の重要文書・git log の使い分けまで含む。
---

# Research (lllmAgents 向け)

## このプロジェクトの「真実の在処」

lllmAgents は **コード → 設計書 → メモリ** の 3 層に知識が分散している。 調査時はこの優先順位で当たる。

| 層 | 場所 | 何が分かるか |
|----|------|------------|
| 1. コード | `src/` | 現在の実装と振る舞い (= 唯一動いている真実) |
| 2. 設計書 | `docs/*.md` (44 本) | 「なぜそうしたか」 と意図された設計 |
| 3. CLAUDE.md / README.md | ルート | ユーザー向け説明 / 作業ルール |
| 4. git log / blame | `.git` | 変更の経緯と意図 |
| 5. 永続メモリ | `~/.claude/projects/.../memory/` | Claude が過去に学んだ事実・user の好み |

**注意**: 設計書は実装より古くなっていることがある。 設計書とコードが矛盾していたら **コードを真実とする** (CLAUDE.md の「設計書と実装の整合性を常に保つ」 ルールは作業時のルールであって、 調査時の参照優先度ではない)。

## docs/ 配下の主要文書 (起点として読むべきもの)

| 文書 | 用途 |
|------|------|
| `docs/internal_design.md` | アーキテクチャ全体・モジュール構成・データフロー (mermaid 図あり) |
| `docs/external_design.md` | 外部仕様 (REPL コマンド、 ツール、 設定) |
| `docs/config-reference.md` | 設定ファイル全項目の意味 |
| `docs/llm-profiles.md` | LLM プロファイル機構 |
| `docs/model-registry.md` | モデル一覧管理 |
| `docs/workspace-separation.md` | src/dist/deploy/sandbox の役割分担 |
| `docs/<feature>-design.md` | 各機能の設計書 (feature ごと 1 本ある) |

**まず `ls docs/ | sort` で全件見て、 該当しそうなファイルを 1-2 本選んで読む** のが最短ルート。

## 調査手順

### Step 1: 仮説を立てる前にまず広く読む

1. `glob "src/**/*.ts"` で関連ディレクトリを把握
2. `grep -r "<キーワード>" src/ --include="*.ts" -l` で対象ファイル候補を出す
3. `docs/` に該当する設計書があるか確認 (`ls docs/ | grep -i <キーワード>`)
4. 候補を 3-5 本に絞ってから `file_read` で精読

### Step 2: 推測ではなく実証 (永続メモリ: `feedback_diagnose_before_speculate`)

仮説を立てたら **検証**:

```bash
# 例: 「この設定キーは本当に使われている?」
grep -rn "configKey" src/ --include="*.ts"

# 例: 「この関数は誰から呼ばれている?」
grep -rn "functionName(" src/ --include="*.ts"

# 例: 「この変更はいつ・なぜ入った?」
git log -p --all -S "識別子" -- src/ | head -50
git blame src/path/to/file.ts | head -30
```

### Step 3: 外部情報が必要なら web_search / web_fetch

ライブラリの仕様確認 (vitest, anthropic SDK, playwright 等) は web_search → web_fetch。 ただし 永続メモリ (`feedback_llamacpp_parallel_ctx` 等) で既に合意済みの事実は再確認しない。

### Step 4: 文書化 (依頼があれば)

調査結果を残す場合の配置:

| 種類 | 配置 |
|------|------|
| 新機能の設計書 | `docs/<feature>-design.md` (CLAUDE.md 準拠) |
| 一過性のメモ・検証ログ | `sandbox/<topic>-YYYY-MM-DD.md` (リポジトリには push しない選択肢あり) |
| 過去の振り返り・レビュー | `sandbox/` または PR コメント |
| user が見やすい sharable な調査結果 | 会話内 + 必要なら docs/ |

## 報告フォーマット

```
## 調査対象と目的
<何を調べたか・なぜ調べたか>

## 発見した事実
- src/foo/bar.ts:42 — XXX が定義されている
- docs/foo-design.md §3 — 設計意図は YYY
- git log によれば 2026-03-15 の commit abc1234 で導入

## 結論と推奨
<結論。 user の問いへの直接回答>

## 推測と事実の区別
- 事実: コード/設計書/git log で確認したもの (上記の §発見した事実)
- 推測: <ここに「未確認の仮説」を明示する。 「おそらく」 で曖昧にしない>

## 不明点・追加調査候補
<もし残っていれば>
```

## やってはいけないこと

- **推測を事実として書く** — 「おそらく〜」 は減点。 確認できないなら「未確認」 と明示
- **コードを読まずに設計書だけで結論** — 設計書は古いことがある
- **grep 1 回で結論** — 同じ概念に複数の命名 (snake_case / camelCase / 日本語名) があるので 2-3 パターン試す
- **永続メモリの古い情報を鵜呑み** — memory は過去のスナップショット。 今のコードと矛盾したら今のコードを信じてメモリを更新する

## 関連スキル

- `/code-review` — 調査結果を踏まえて品質指摘までするなら
- `/refactoring` — 調査結果を踏まえて変更するなら (影響範囲調査は refactoring の中核ステップでもある)
- `/claude-code-driver` (`/ultrareview`) — 自分で読みきれない規模ならクラウド claude 委譲
