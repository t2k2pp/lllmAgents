# docs 索引 (Documentation Index)

> **作成日**: 2026-07-04 (docs/production-readiness.md PR-11)
> docs 配下 70+ 本の設計書を分類し、どれが「実装済みの正」でどれが「構想・記録」かを一覧にする。
>
> **運用ルール**:
> - 新しい設計書を追加したら、この索引に1行追加する (Status 付き)
> - Status は索引で一元管理する (各ファイルへのヘッダ付与は、そのファイルを触るついでに行う)
> - Status 凡例: `implemented` = 実装済みの正 / `in-progress` = 実装進行中 / `proposal` = 未実装の構想 / `record` = レビュー・調査の記録 (更新しない) / `reference` = 手順書・参照資料 / `superseded` = 後継 doc に置き換え

## 正典 (常に実装と一致させる)

| ドキュメント | 内容 |
|---|---|
| [external_design.md](external_design.md) | 外部設計 — 機能一覧・ツール・コマンド・ユーザー視点の仕様 |
| [internal_design.md](internal_design.md) | 内部設計 — モジュール構成・AgentLoop・データフロー |
| [security_assessment.md](security_assessment.md) | セキュリティ評価と対策 — 脅威モデル・サンドボックス・クラウド LLM リスク |
| [config-reference.md](config-reference.md) | 設定リファレンス (`~/.localllm/config.json` / `credentials.json`) |
| [workspace-separation.md](workspace-separation.md) | ワークスペース構成 (src/dist/deploy/sandbox) と Stop フック |
| [production-readiness.md](production-readiness.md) | 製品品質改善計画 PR-01〜16 — P1〜P4 の進行管理表 |
| [issues.md](issues.md) | 設計書レビュー起点の課題一覧 (2026-07-04 棚卸し済み) |
| [product-review-cycle-1-2026-08-24.md](product-review-cycle-1-2026-08-24.md) | 商品品質レビュー・修正・評価サイクル第1回の記録 |
| [product-review-cycle-2-2026-08-25.md](product-review-cycle-2-2026-08-25.md) | Codex類似アプリ観点の商品品質レビュー・改善サイクル第2回の記録 |
| [product-review-closure-2026-08-25.md](product-review-closure-2026-08-25.md) | cycle 1 / 2 の未修正課題を終端状態まで処理する統合クローズ記録 |
| [product-feature-comparison-2026-08-26.md](product-feature-comparison-2026-08-26.md) | Codex / Claude Code 機能比較マトリックスとサブエージェントskill preload改善記録 |
| [product-feature-comparison-cycle-2-2026-08-26.md](product-feature-comparison-cycle-2-2026-08-26.md) | Codex / Claude Code 機能比較マトリックス第2回とモデル向けschedule改善記録 |
| [product-feature-comparison-cycle-3-2026-08-26.md](product-feature-comparison-cycle-3-2026-08-26.md) | Codex / Claude Code 機能比較マトリックス第3回とbackground task一覧・停止の改善記録 |
| [product-feature-comparison-cycle-4-2026-08-26.md](product-feature-comparison-cycle-4-2026-08-26.md) | Codex / Claude Code 機能比較マトリックス第4回とbackground agent steer改善記録 |
| [product-feature-comparison-cycle-5-2026-08-26.md](product-feature-comparison-cycle-5-2026-08-26.md) | Codex / Claude Code 機能比較マトリックス第5回とlocal plugin bundle改善記録 |
| [product-feature-comparison-cycle-6-2026-08-26.md](product-feature-comparison-cycle-6-2026-08-26.md) | Codex / Claude Code 機能比較マトリックス第6回とsafe mode改善記録 |
| [product-feature-comparison-cycle-7-2026-08-27.md](product-feature-comparison-cycle-7-2026-08-27.md) | Codex / Claude Code機能比較第7回とTUI session全期間scrollback改善記録 |
| [product-feature-comparison-cycle-8-2026-08-29.md](product-feature-comparison-cycle-8-2026-08-29.md) | Codex / Claude Code機能比較第8回、日本語IME右端描画・fail-fast・session fork改善記録 |
| [product-feature-comparison-cycle-9-2026-08-30.md](product-feature-comparison-cycle-9-2026-08-30.md) | Codex / Claude Code機能比較第9回、working-tree実差分とsession命名改善記録 |
| [product-feature-comparison-cycle-10-2026-08-30.md](product-feature-comparison-cycle-10-2026-08-30.md) | Codex / Claude Computer Use比較第10回、native OS window操作の実装・評価記録 |
| [native-computer-use.md](native-computer-use.md) | Native Computer Useの安全境界、tool/OS driver契約、実機gate |

## アーキテクチャ・ハーネス

| ドキュメント | Status | 内容 |
|---|---|---|
| [product-feature-comparison-cycle-11-worktree-design-2026-08-31.md](product-feature-comparison-cycle-11-worktree-design-2026-08-31.md) | implemented | Codex/Claude比較、類似機能監査、sub-agent worktree分離の実装・安全・評価記録 |
| [harness-engineering.md](harness-engineering.md) | implemented | ハーネス改善の起点 (テトリスセッション分析→システムプロンプト再設計ほか) |
| [harness-engineering-phase5.md](harness-engineering-phase5.md) | in-progress | Phase 5 計画 — Claude Code 比較で見える本質的弱点と段階的改善 |
| [harness-engineering-phase5-progress.md](harness-engineering-phase5-progress.md) | in-progress | Phase 5 の進捗トラッカー |
| [multi-tier-harness-roadmap.md](multi-tier-harness-roadmap.md) | in-progress | マルチティア (T1/T2/T3) ハーネス戦略ロードマップ |
| [system-prompt-redesign.md](system-prompt-redesign.md) | implemented | システムプロンプト再構成 (behavioral/rest 2層+tool-guides 遅延注入) |
| [prompt-language-policy.md](prompt-language-policy.md) | in-progress | プロンプト言語ポリシー (モデル向け英語正本。Phase 1 済 / 2,3 未) |
| [prompt-ja-reference.md](prompt-ja-reference.md) | reference | プロンプト日本語リファレンス (参照用スナップショット) |
| [prompt-optimization.md](prompt-optimization.md) | implemented | システムプロンプト最適化 |
| [prompt-cache-cost-reduction.md](prompt-cache-cost-reduction.md) | implemented | プロンプトキャッシュによるコスト削減 |
| [strategic-todo-design.md](strategic-todo-design.md) | implemented | 準システムプロンプト+戦略 ToDo アーキテクチャ |
| [lightweight-register-anchors-design.md](lightweight-register-anchors-design.md) | implemented | 軽量タスクの過剰プラン抑制 (軽いアンカー) |
| [reactive-intervention-coherence-design.md](reactive-intervention-coherence-design.md) | implemented | 反応的介入レイヤーの整合 (成果物形状の単一前提) |
| [agent-events-design.md](agent-events-design.md) | implemented | AgentLoop イベント化 (AgentEventBus) |
| [todo-goal-lifecycle.md](todo-goal-lifecycle.md) | implemented | ToDo / Goal Slot のライフサイクル |
| [ephemeral-context-design.md](ephemeral-context-design.md) | implemented | Ephemeral Context (span スコープの揮発メッセージ) |
| [context-intelligence.md](context-intelligence.md) | implemented | コンテキストインテリジェンス (圧縮・履歴管理) |
| [evaluation-loop.md](evaluation-loop.md) | implemented | 評価ループ (/try 試行錯誤モード) |
| [tool-call-salvage-pipe-format-design.md](tool-call-salvage-pipe-format-design.md) | implemented | ツール呼び出しサルベージ (`<\|tool\|>call:` 形式) |
| [input-compression-design.md](input-compression-design.md) | implemented | opt-in 入力圧縮モード (/compress-input) |

## LLM プロバイダ・モデル管理

| ドキュメント | Status | 内容 |
|---|---|---|
| [model-registry.md](model-registry.md) | implemented | Model Registry (LLM 接続のレジストリ化、main/second/vision slot) |
| [model-setup.md](model-setup.md) | implemented | /model setup ウィザード |
| [v030_second_llm_design.md](v030_second_llm_design.md) | implemented | セカンド LLM (consult / agent / evaluator 委任) |
| [main_second_swap_design.md](main_second_swap_design.md) | implemented | /swap (メイン⇔セカンド入れ替え) |
| [main-second-subagent-comparison.md](main-second-subagent-comparison.md) | record | メイン / セカンド / サブエージェントの役割比較整理 |
| [llm-profiles.md](llm-profiles.md) | superseded | 旧 LLM プロファイル (→ [model-registry.md](model-registry.md)) |
| [llm-profile-descriptions.md](llm-profile-descriptions.md) | implemented | モデル特性説明 (サブエージェント選択の材料) |
| [azure-gpt-provider.md](azure-gpt-provider.md) | implemented | azure-gpt プロバイダ |
| [gemini-aistudio-provider.md](gemini-aistudio-provider.md) | implemented | gemini (Google AI Studio) プロバイダ |
| [claude-providers.md](claude-providers.md) | implemented | Claude 系プロバイダ (anthropic / claude-cli ほか) |
| [claude-agent-sdk-provider-design.md](claude-agent-sdk-provider-design.md) | implemented | claude-agent-sdk プロバイダ |

## REPL / UX

| ドキュメント | Status | 内容 |
|---|---|---|
| [repl-io-robustness.md](repl-io-robustness.md) | implemented | REPL I/O 堅牢化 (raw mode 自己修復・Esc 中断) |
| [interrupt-and-progress-design.md](interrupt-and-progress-design.md) | implemented | 中断手段と進捗表示 |
| [spinner-mode-response-coloring-design.md](spinner-mode-response-coloring-design.md) | implemented | 応答テキストの色分け (構造ベース) |
| [ux-transparency.md](ux-transparency.md) | implemented | UX 透明性+サンプリングパラメータ |
| [context-inspector.md](context-inspector.md) | implemented | /context ドリルダウン |
| [cost-token-command-design.md](cost-token-command-design.md) | implemented | /cost (コスト・トークン可視化) |
| [integrations-command-cleanup.md](integrations-command-cleanup.md) | implemented | /integrations への統合コマンド集約 |
| [response-latency-improvement.md](response-latency-improvement.md) | implemented | 応答速度改善 |
| [loop_feature.md](loop_feature.md) | implemented | /loop (定期実行) |

## 自律実行モード

| ドキュメント | Status | 内容 |
|---|---|---|
| [goal-seek-mode-design.md](goal-seek-mode-design.md) | implemented | Goal Seek mode (acceptance criteria 駆動の自律実行) |
| [goal-loop-deterministic-check-design.md](goal-loop-deterministic-check-design.md) | implemented | /goal-loop (決定的検証ゲート型ループ) |
| [goal-promotion-design.md](goal-promotion-design.md) | implemented | 指示→ゴール昇格の標準パス化 |
| [checkpoint-and-smoke-design.md](checkpoint-and-smoke-design.md) | implemented | 自動チェックポイント (シャドウ Git) + game_smoke |

## チャネル統合 (Discord / Slack / Room)

| ドキュメント | Status | 内容 |
|---|---|---|
| [room-model-design.md](room-model-design.md) | implemented | Room モデル (A/B/C のサーフェス別セッション分離) |
| [room-model-review.md](room-model-review.md) | record | Room モデル実装レビュー記録 |
| [discord-gateway-design.md](discord-gateway-design.md) | implemented | Discord 受信の Gateway (WS) 方式 |
| [slack-integration.md](slack-integration.md) | implemented | Slack 統合 (Socket Mode) |
| [channel-interaction-bridge-design.md](channel-interaction-bridge-design.md) | implemented | チャネル対話ブリッジ (権限確認 / ask_user) |
| [channel-progress-design.md](channel-progress-design.md) | implemented | チャネル進捗中間報告 |
| [channel-session-queue-design.md](channel-session-queue-design.md) | implemented | チャネルセッション分離とリクエストキュー |
| [async-surface-permission-delivery-design.md](async-surface-permission-delivery-design.md) | implemented | 非同期サーフェス権限の配信・観測性 |
| [task-report-notification-design.md](task-report-notification-design.md) | implemented | 完了報告の構造化と proactive 通知 |

## ツール・スキル・外部連携

| ドキュメント | Status | 内容 |
|---|---|---|
| [image-generation.md](image-generation.md) | implemented | 画像生成 (Azure GPT Images / SD WebUI / ComfyUI) |
| [obsidian-integration.md](obsidian-integration.md) | implemented | Obsidian ナレッジベース連携 |
| [chat-log.md](chat-log.md) | implemented | チャットログ保存 |
| [llm-logging.md](llm-logging.md) | implemented | LLM I/O ログ+運用ログ (ops-logger) |
| [exe-playwright-externalization.md](exe-playwright-externalization.md) | implemented | exe での Playwright 外部化 (--install-browser) |
| [wsl-sandbox-design.md](wsl-sandbox-design.md) | implemented | bash 封じ込め (Seatbelt / bwrap / WSL2) |
| [claude-code-driver-skill.md](claude-code-driver-skill.md) | implemented | claude-code-driver スキル |
| [ascii-art-skill-design.md](ascii-art-skill-design.md) | implemented | ASCII アート化スキル |
| [product-quality-cycle-skill.md](product-quality-cycle-skill.md) | implemented | 観点指定の商品品質レビュー・改善サイクルスキル |
| [plugin-bundle-design.md](plugin-bundle-design.md) | implemented | 明示的に信頼したローカルplugin bundleのmanifest・安全境界・loader設計 |
| [safe-mode-design.md](safe-mode-design.md) | implemented | カスタマイズを一括停止して診断・復旧する`--safe-mode`の境界 |
| [blender-mcp-integration.md](blender-mcp-integration.md) | implemented | Blender MCP 連携の改修ポイント |

## 調査・提案 (未実装の構想)

| ドキュメント | Status | 内容 |
|---|---|---|
| [openclaw-compat-addon-feasibility.md](openclaw-compat-addon-feasibility.md) | proposal | OpenClaw 互換アドオンの実現性調査・実装設計 |
| [autonomy-improvement-proposal.md](autonomy-improvement-proposal.md) | proposal | 他エージェントアプリ比較と自律性向上の提案 |
| [agent-loop-efficiency-review.md](agent-loop-efficiency-review.md) | proposal | Agent Loop 効率レビュー (米国株投資支援アプリのログ分析起点) |
| [changelog-feature-backlog.md](changelog-feature-backlog.md) | proposal | Claude Code changelog 由来の機能バックログ |
| [prompt-tech-debt-review.md](prompt-tech-debt-review.md) | record | プロンプト棚卸しレビュー (2026-04-29) |

## 手順書・参照

| ドキュメント | Status | 内容 |
|---|---|---|
| [setup-mac.md](setup-mac.md) | reference | macOS セットアップ手順 |
