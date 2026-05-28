---
name: commit
description: lllmAgents プロジェクトの git commit ワークフロー。 ユーザーがコミット・変更の保存・git add/commit を要求した時、 または「実装が一区切り着いたから push まで」 と判断した時に使う。 このプロジェクトでは「実装後は push」 が原則 (CLAUDE.md / 永続メモリ準拠)。 conventional-commit 風 prefix + 日本語本文 + Stop フックの未 push 警告との連携 まで含む。
---

# Commit (lllmAgents 向け)

## このプロジェクトのコミット規約

最近 5 件のスタイル (`git log --oneline -5` 相当) を見て同じ流儀に揃える。 観測されている流儀:

```
feat(cli): Vision LLM を registry / slot に統合 + /model vision 実装 (Phase 5)
refactor(cli): /status 集約 + /stream toggle + /resume 統合 + /permission 対話化
refactor(cli): /discord / /slack / /chatlog / /search を /integrations に統合 (#3)
docs: Phase optimize (S/A/B) + Model Registry を反映してコマンド表記を最新化
feat(skill): claude-code-driver - lllmAgents から Claude Code CLI を対話TTY駆動するスキル追加
```

特徴:

- **prefix**: `feat` / `fix` / `refactor` / `docs` / `chore` のどれか
- **scope**: 影響範囲を `(cli)` / `(skill)` / `(provider)` 等の括弧で
- **件名**: 日本語可。 50-80 文字目安。 「なぜ」 ではなく 「何を」 簡潔に
- **本文 (必要なら)**: 「なぜ」 を書く。 関連 issue や設計書を参照
- **Co-Authored-By**: Claude が手伝った時は HEREDOC で末尾に付ける

## 手順

### Step 1: 状態確認 (並列で OK)

```bash
git status              # 変更ファイル一覧 (-uall は禁止: メモリ大量消費)
git diff --stat         # 変更量の概観
git diff                # 実差分
git log --oneline -5    # 直近スタイル参照
```

### Step 2: 機密ファイル除外

以下が含まれていたら **必ず除外してユーザーに警告**:

- `.env`, `.env.*` (環境変数)
- `credentials.json`, `*token*`, `*secret*` 系
- `~/.localllm/` 配下 (ユーザー個人設定)
- `node_modules/`, `dist/`, `deploy/`, `sandbox/` (gitignore 済みのはず)

`git add -A` / `git add .` は避け、**具体的なファイル名を列挙** して `git add` する。

### Step 3: コミットメッセージ生成

prefix + scope + 件名を 1 文で。 設計書を伴う変更なら本文に `設計書: docs/foo.md` のような参照を入れる。

### Step 4: ユーザー確認

**ユーザーが明示的にコミットを依頼している** ことを再確認。 「コードを書いて」 「直して」 は コミット依頼ではない (CLAUDE.md / メモリ準拠: 通常依頼は user 合意で収束してから commit)。

### Step 5: commit

HEREDOC でメッセージを渡す:

```bash
git commit -m "$(cat <<'EOF'
feat(cli): /foo コマンドを追加して bar 設定を切り替え可能にする

#42 の依頼への対応。 設計書: docs/foo-command.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Step 6: push 判断 (CLAUDE.md 準拠)

CLAUDE.md および永続メモリ (`feedback_post_implementation_push`) の基準:

| 状況 | push する? |
|------|----------|
| 仕様明確で影響小、 単独完結する変更 | 即時 push |
| 設計探索フェーズ、 全体影響の大きな変更 | user 合意まで保留 |
| user が「コミットだけして」 と言った | push しない |
| user が「push まで」 と言った | push する |

Stop フック (`scripts/on-stop.js`) は未 push commits があると警告するので、 push 漏れは検知される (= 安心して push できる時にすればよい)。

## やってはいけないこと

- `git config` の更新
- `git push --force` (main/master) — どうしても必要なら user に明示確認
- `--no-verify` で pre-commit hook skip — user 明示依頼以外禁止
- `--amend` で既存 commit を改変 — pre-commit hook 失敗時は新規 commit を立てる
- 機密ファイルを含めた一括 `git add -A`
- 「コードを書いて」 だけ言われた時の勝手なコミット

## CI/フックとの関係

- **Stop フック**: 会話終了時に未 push commits の有無を警告 + sync-skills を走らせる
- **pre-commit hook**: 現状ライト (lint だけ等)。 落ちたら原因を直してから新規 commit (--amend ではない)

## 完了条件

- [ ] `git log -1` で意図したメッセージになっている
- [ ] 機密ファイルが含まれていない
- [ ] push 判断が CLAUDE.md ルールに沿っている
- [ ] (push したなら) `git status` でクリーン

## 関連スキル

- `/refactoring` — 大規模変更で「実装区切りごとにコミット & push」 と組み合わせる
- `/build-fix` — コミット前に `npm run lint` で型エラーゼロを確認
- `/claude-code-driver` — `/ultrareview` のレビュー結果を見てからコミットしたい時
