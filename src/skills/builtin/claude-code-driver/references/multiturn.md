# multiturn.md — 多ターン対話のパターン

## 多ターンを実現する 3 つの方式

| 方式 | 仕組み | 向き |
|------|--------|------|
| (a) 同一 expect プロセス内で stdin から prompt 流す | 本スキルの `--quit-after-response` を付けず stdin 入力 | リアルタイム連続対話 |
| (b) `--resume <session-id>` で都度新規プロセス | claude 側に session DB がある | バッチ的にセッションを再開・再利用 |
| (c) `--continue` で直前セッションを再開 | session-id 管理不要 | 直前を続けるだけの簡易ケース |

## 方式 (a): stdin から多ターン

```bash
expect ~/.localllm/skills/claude-code-driver/scripts/drive-claude.exp \
  --prompt "プロジェクトの概要を教えて" \
  --timeout 600 <<EOF
src/ ディレクトリの主要ファイルを列挙して
それぞれに 1 行コメントを付けて
/__quit__
EOF
```

stdin EOF または `/__quit__` で終了。 出力は各ターンごとに
`----- TURN END -----` で区切られる。

メリット: 同一プロセス内なので claude のコンテキストが連続している。
デメリット: bash ツール経由だと 120 秒で打ち切られやすい。 nohup 化を検討。

## 方式 (b): --resume で都度起動

claude は対話セッションを内部 DB に保存する。 session-id を覚えておけば後から再開可能。

```bash
# 1 回目
SESSION_ID=$(expect drive-claude.exp \
  --prompt "X を調査して" \
  --quit-after-response 2>&1 | grep -oE 'session_id=[a-z0-9-]+' | head -1)

# 2 回目以降
expect drive-claude.exp \
  --resume "$SESSION_ID" \
  --prompt "前の結果を踏まえて Y を実装" \
  --quit-after-response
```

注意: 現状の drive-claude.exp は session-id を直接出力しない。 取得するには
claude 側で `--output-format json` を併用する必要があるが、 これは TTY モードと
両立しにくい。 必要なら次のいずれかで対応:

- claude を `-p --output-format json` で 1 回目だけ headless で叩いて session_id を取得
- claude 起動時に `--session-id <自前で生成した uuid>` で固定値を渡す (バージョンによる)

## 方式 (c): --continue

```bash
expect drive-claude.exp \
  --quit-after-response \
  -- --continue \
  ;# expect 側引数の後に `--` で claude 直渡し
```

「直前セッションを続ける」 だけ。 session-id 管理不要だが、 並行で複数セッション
を扱う場合は使えない。

## セッションを途中で人間に渡したい場合

スクリプトでの自動駆動を途中で打ち切り、 続きは user が手動 claude で行う運用:

1. drive-claude.exp で初期調査を回し、 結果を保存
2. user に session-id (drive-claude.exp が stderr に出すログから拾う) を伝える
3. user が手動で `claude --resume <id>` して続行

session-id の確認方法: claude の `~/.claude/projects/<hash>/` 配下に保存される
JSONL を見るか、 claude 起動直後にステータス行を見る。 詳細は claude 本家ドキュメント
に従う (バージョン依存)。

## 失敗パターン

- `--resume <id>` で「session not found」 → 別 CWD で起動した可能性。 claude は
  CWD ごとに session DB を持つ
- 多ターン中に context window が溢れる → claude が自動圧縮する (claude 側機構)。
  lllmAgents 側で介入する手段は無い
