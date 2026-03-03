---
name: projects
description: 既知のプロジェクトとそのインスティンクト統計を一覧表示します
command: true
---

# Projects コマンド

continuous-learning-v2 のプロジェクトレジストリエントリとプロジェクトごとのインスティンクト/オブザベーション数を一覧表示します。

## 実装

プラグインのルートパスを使用してインスティンクト CLI を実行します:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/continuous-learning-v2/scripts/instinct-cli.py" projects
```

または `CLAUDE_PLUGIN_ROOT` が設定されていない場合（手動インストール）:

```bash
python3 ~/.claude/skills/continuous-learning-v2/scripts/instinct-cli.py projects
```

## 使い方

```bash
/projects
```

## 実行内容

1. `~/.claude/homunculus/projects.json` を読み取る
2. 各プロジェクトについて以下を表示:
   - プロジェクト名、ID、ルート、リモート
   - パーソナルおよび継承されたインスティンクト数
   - オブザベーションイベント数
   - 最終確認タイムスタンプ
3. グローバルインスティンクトの合計も表示
