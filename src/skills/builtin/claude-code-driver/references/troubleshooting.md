# troubleshooting.md — トラブル対応

## 症状別チェック

### 1. 終了コード 2 (認証エラー)

```
[drive-claude] auth error detected
```

- `claude login` 状態を確認: `claude /status` または `claude -p "ping"`
- subscription が期限切れか、 API key 環境変数 (`ANTHROPIC_API_KEY`) が失効
- 対応: user に手動で `claude login` を促す。 lllmAgents から勝手に login コマンドを
  叩かない (対話入力が必要なため非TTY では完結できない)

### 2. 終了コード 1 (タイムアウト)

```
[drive-claude] timeout waiting for response (turn N)
```

- `/ultrareview` 等の重いコマンドは 10 分以上かかる。 `--timeout 1800` 以上を試す
- ネットワーク不安定で claude バックエンドへの接続が遅い可能性
- claude 内部で stuck (Plan モードで accept 待ちなのに自動 deny で返した、 等)
- 対応: timeout を伸ばす、 タスクを分割、 または手動 claude に切り替え

### 3. 終了コード 3 (権限拒否)

```
[drive-claude] permission prompt; no auto policy -> deny
```

- claude が edit/bash 等の許可を要求したが、 expect 側で安全側に倒して deny した
- 対応: `--permission-mode acceptEdits` を claude に渡す (`-- --permission-mode acceptEdits`)
- または user に「権限を許可する設計か?」 を確認

### 4. プロンプト記号が見つからずタイムアウト

- claude のバージョンが上がって UI が変わった
  → drive-claude.exp の `prompt_patterns` を更新
- ターミナル幅が極端に狭い (PTY のカラム数) でレイアウトが崩れた
  → expect で `stty rows 40 cols 200 < $spawn_id_get_user` 等で固定する手も
- 対応: `claude --version` を確認、 references/permissions.md のパターン履歴と照合

### 5. ANSI エスケープが出力に混入

- drive-claude.exp の `strip_ansi` は CSI/OSC/ESC 1文字を除去するが、 全パターン
  網羅ではない
- 対応: 残るシーケンスを観察して strip_ansi の regex を追加。 もしくは出力を
  `col -b` や `sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g'` に通す

### 6. bash ツールの 120 秒タイムアウトで打ち切られる

- lllmAgents の `bash` ツールは 120 秒で死ぬ
- 対応:
  - `run_in_background: true` を bash ツール呼び出しに指定
  - もしくは `nohup expect ... > /tmp/claude.log 2>&1 &` で投げっぱなしにして PID を返す
  - 結果は `tail -f /tmp/claude.log` で後追い

### 7. CWD が想定と違う

- claude は起動時の CWD をプロジェクトとして扱う
- bash ツールはデフォルトで lllmAgents の CWD を引き継ぐが、 expect 内で CWD を
  変えていないか確認
- 対応: `bash -lc "cd /target && expect drive-claude.exp ..."`

### 8. 同じ session-id で `--resume` できない

- session-id を覚えてるが claude が「not found」 と言う
- 原因: 別 CWD で起動した、 別マシン、 別 claude config dir (`CLAUDE_CONFIG_DIR`)
- 対応: 1 回目と同じ CWD・同じ user で起動

### 9. expect が見つからない

```
sh: expect: command not found
```

- macOS は標準で入っているが、 一部の最小環境では無い
- Linux: `apt install expect` / `yum install expect`
- 対応: user に install を促す。 lllmAgents から sudo は叩かない

### 10. 非TTY (パイプ) 環境で動かない

- `lllmagents-test` スキルのように pipe 入力で起動した lllmAgents から本スキルを
  発火すると、 親プロセスは pipe stdin/stdout だが、 expect 側で spawn する claude
  は新しい PTY が割り当てられるので、 **理論的には動く**
- ただし claude 側が「TTY じゃない」 と判断する経路 (LANG, TERM 環境変数) が
  足りないと UI が崩れる可能性
- 対応: `env TERM=xterm-256color expect drive-claude.exp ...` を試す

## ログの所在

- expect 自身の診断: stderr (lllmAgents の bash ツールが回収)
- claude 自身のログ: `~/.claude/` 配下 (claude のバージョンによる)
- lllmAgents の LLM I/O ログ: `~/.localllm/llm-logs/`

## 「もう諦めて手動 claude に切り替えたい」 判断

以下のいずれかが起きたら、 自動駆動を諦めて user に手動 claude を提案するのが筋:

- 終了コード 2 が繰り返し出る (認証問題)
- 終了コード 3 が繰り返し出る (権限設計のミスマッチ)
- タイムアウトを伸ばしても完了しない (本質的に長いタスク)
- claude のバージョンが上がって pattern が壊れている疑い
