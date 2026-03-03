---
name: promote
description: プロジェクトスコープのインスティンクトをグローバルスコープに昇格させます
command: true
---

# Promote コマンド

continuous-learning-v2 でインスティンクトをプロジェクトスコープからグローバルスコープに昇格させます。

## 実装

プラグインのルートパスを使用してインスティンクト CLI を実行します:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/continuous-learning-v2/scripts/instinct-cli.py" promote [instinct-id] [--force] [--dry-run]
```

または `CLAUDE_PLUGIN_ROOT` が設定されていない場合（手動インストール）:

```bash
python3 ~/.claude/skills/continuous-learning-v2/scripts/instinct-cli.py promote [instinct-id] [--force] [--dry-run]
```

## 使い方

```bash
/promote                      # 昇格候補を自動検出
/promote --dry-run            # 自動昇格候補をプレビュー
/promote --force              # プロンプトなしで全ての適格な候補を昇格
/promote grep-before-edit     # 現在のプロジェクトから特定のインスティンクトを1つ昇格
```

## 実行内容

1. 現在のプロジェクトを検出
2. `instinct-id` が指定されている場合、そのインスティンクトのみを昇格（現在のプロジェクトに存在する場合）
3. それ以外の場合、以下の条件を満たすクロスプロジェクト候補を検索:
   - 2つ以上のプロジェクトに存在する
   - 信頼度の閾値を満たしている
4. 昇格されたインスティンクトを `~/.claude/homunculus/instincts/personal/` に `scope: global` で書き込む
