---
name: lllmagents-test
description: lllmAgentsアプリ（npm run start）を非TTY(パイプ)モードで起動して動作テストを行う。権限確認ダイアログの操作方法、不具合修正後のドキュメント更新とGitHub pushまでのワークフローを定義する。Claude Code自身がテスト実行者として使うスキル。
trigger: /test-lllm
---

# lllmAgents 動作テストスキル（AI向け）

## 概要

このスキルは **Claude Code（AI）がlllmAgentsアプリを動作テストする際の手順書**です。
アプリはインタラクティブなCLI REPLのため、Bashツールからのパイプ入力で操作します。

---

## 前提知識

### アプリの基本
- **起動コマンド**: `cd /c/Users/osia3/GitProjects/claudeclone/lllmAgents && npm run start`
- **LLM**: `qwen3.5:27b @ http://192.168.1.33:11434 (Ollama)`
- **設定ファイル**: `C:\Users\osia3\.localllm\config.json`

### TTY / 非TTY の挙動
| モード | REPL入力 | 権限確認 |
|--------|----------|----------|
| TTY（実ターミナル） | raw stdinキープレス | inquirer インタラクティブリスト |
| 非TTY（パイプ） | `NonTTYReader.readLine()` | テキストメニュー (1-5) |

非TTYモードでは `src/utils/non-tty-reader.ts` の **NonTTYReader シングルトン** が stdin を管理する。
readline を複数作成するとバッファが消失するため、REPLとPermissionManagerで共有している。

### 権限確認の仕組み
権限確認は `src/security/permission-manager.ts` の `askUserWithScope` で処理される。
- **並列ツール実行時も `_permissionQueue` で直列化**（10個のツールが同時に確認を出しても一つずつ処理）
- 非TTY時のメニュー選択肢:
  ```
  1: 許可 (今回のみ)
  2: 許可 (<tool> をセッション中常に許可)
  3: 許可 (<tool> を設定に保存して常に許可)  ← 使用禁止（下記参照）
  4: 拒否
  5: 中止
  ```

### config.json の autoApproveTools / requireApprovalTools
```json
"autoApproveTools": ["file_read", "glob", "grep", "browser_snapshot", "vision_analyze"],
"requireApprovalTools": ["file_write", "file_edit", "bash", "browser_navigate", "browser_click", "browser_type"]
```
`skill` ツールはどちらにも未登録のため、デフォルトで `ask`（確認必要）になる。

---

## テスト手順

### 基本パターン（パイプ入力）

```bash
cd /c/Users/osia3/GitProjects/claudeclone/lllmAgents
printf "<プロンプト>\n<選択1>\n<選択2>\n...\n/quit\n" | npm run start 2>&1
```

### 権限確認回数の見積もり
プロンプトに対してLLMが何回ツールを使うかを予測し、必要な行数を計算する。

例: `chunkbase-screenshot` で seed 1001-1010 を撮影する場合:
- `skill` ツール呼び出し: 5～10回（並列）→ 確認 5～10回
- `bash` ツール呼び出し: 10回（1枚ずつ or 並列）→ 確認 10回
- 合計 20回程度 + バッファとして10行追加 = **30行の選択肢を準備**

### 実際のコマンド例（chunkbase テスト）

```bash
printf "シード値1001から1010のChunkbaseスクリーンショットを撮影してください\n2\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n/quit\n" | npm run start 2>&1
```

- 最初の確認: `2`（skillをセッション中常に許可 → 以降の同ツールはスキップ）
- 以降の確認: `1`（今回のみ）

### タイムアウト設定
スクリーンショット撮影は1枚あたり約15-25秒かかる。10枚なら最大250秒。
Bashツールの timeout を十分大きく設定する（例: `timeout: 600000`）。

---

## ⚠️ 重要な注意事項

### 絶対に選択してはいけない: 選択肢 3「設定に保存して常に許可」

選択肢 3 を選ぶと **`~/.localllm/config.json` の `autoApproveTools` に永続追加**される。
これにより:
- 以降のテストで権限確認ダイアログが表示されなくなる（テスト不能）
- アプリのセキュリティ機能の動作確認ができなくなる
- **ユーザーが手動でconfigを修正しない限り元に戻らない**

**テストでは必ず 1（今回のみ）または 2（セッション中のみ）を選ぶ。**

### 余分な入力に注意
パイプに余分な行が残ると、タスク完了後にLLMがその行をプロンプトとして受け取り
意図しない追加操作（ビジョン分析など）を行う場合がある。
スクショ枚数など事前に把握できる場合は必要な行数を正確に計算する。

---

## 不具合修正後のワークフロー

不具合を発見・修正した場合は **必ず以下の手順を実施する**。

### Step 1: 動作確認（修正の検証）

上記テスト手順でアプリを再起動し、修正が正しく機能することを確認する。

### Step 2: 型チェック

```bash
cd /c/Users/osia3/GitProjects/claudeclone/lllmAgents
npx tsc --noEmit
```

エラーがないことを確認する。

### Step 3: docs/ 設計書の更新

修正内容に応じて関連する設計書を更新する:

| 修正の種類 | 更新する設計書 |
|-----------|---------------|
| セキュリティ・権限系 | `docs/security_assessment.md` |
| アーキテクチャ・内部設計 | `docs/internal_design.md` |
| 外部向け仕様変更 | `docs/external_design.md` |
| 改善計画の追記 | `docs/improvement-plan.md` |

設計書には以下を必ず記載:
- 修正した不具合の概要
- 根本原因の説明
- 実装した解決策
- 影響を受けるファイル

### Step 4: git commit & push

```bash
cd /c/Users/osia3/GitProjects/claudeclone/lllmAgents
git add <変更ファイル>
git status  # 確認
git commit -m "fix: <修正内容の簡潔な説明>"
git push origin main
```

**コミット前の確認事項:**
- `~/.localllm/config.json` は **絶対にコミットしない**（個人設定・Discord webhook URLが含まれる）
- `output/` や `screenshots/` はコミット不要（`.gitignore` 確認）
- `node_modules/` は含まない

---

## デバッグ tips

### 出力が途中で止まる場合
- 権限確認が来ているのに入力行が足りない → 行数を増やす
- LLMの応答が遅い → タイムアウトを伸ばす（600000ms推奨）

### ExitPromptError が出る場合
- `src/security/permission-manager.ts` の TTY 判定と `ExitPromptError` キャッチが機能していない
- `process.stdin.isTTY` の値を確認する

### 全ての確認が「中止(5)」になる場合
- `NonTTYReader` に行が届いていない（stdin バッファの問題）
- readline の競合（複数インスタンスが stdin を奪い合っていないか確認）

### スクリーンショットが白/空白になる場合
- Chunkbase の描画完了を待つ時間が不足（`capture.js` の `waitForTimeout` を増やす）
- `#map-canvas` が見つからずフォールバックしている（ログを確認）
