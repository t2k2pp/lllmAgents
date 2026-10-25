# docs/archive 索引 (記録・完了した作業メモ・置き換えられた設計)

> ここにある文書は **更新しない記録** です。 今の仕様は docs/README.md の正典と機能別の設計書を見てください。
> 本文のコマンド・ファイル・設定キーは書かれた当時のもので、 今は無いものを含みます。
> 移した日: 2026-10-25 (docs 整理)。 元のパスは `docs/<同じ名前>` (git の履歴は `git log --follow` で辿れる)。

## 置き換えられた設計 (後継あり)

| 文書 | 後継 |
|---|---|
| [context-forgetting.md](context-forgetting.md) | 忘却 (LLM に忘れるものを選ばせる・`/forget`) → [context-reduction-redesign.md](../context-reduction-redesign.md) |
| [context-strategy.md](context-strategy.md) | 区切りでの圧縮・忘却・Clear の使い分け → [context-reduction-redesign.md](../context-reduction-redesign.md)。 §2.2 の引き継ぎメモの形は [handoff-design.md](../handoff-design.md) へ移した |
| [context-reduction-reasoning-model-fix.md](context-reduction-reasoning-model-fix.md) | 忘却・圧縮の思考モデル対応 (対象コードは削除)。 脇の呼び出しの思考オフは [internal_design.md](../internal_design.md) §2.5 |
| [llm-profiles.md](llm-profiles.md) | `/profiles` → [model-registry.md](../model-registry.md) |
| [channel-session-queue-design.md](channel-session-queue-design.md) | チャネルのセッション分離とキュー → [room-model-design.md](../room-model-design.md) |

## 完了した計画・ToDo

| 文書 | 内容 |
|---|---|
| [production-readiness.md](production-readiness.md) | 製品品質の改善計画 PR-01〜16 (2026-07-04。 全項目完了) |
| [issues.md](issues.md) | 2026-03 の設計書レビュー起点の課題一覧 (2026-07-04 棚卸しで凍結) |
| [harness-engineering-phase5.md](harness-engineering-phase5.md) / [harness-engineering-phase5-progress.md](harness-engineering-phase5-progress.md) | ハーネス Phase 5 の計画と進捗。 第 8 ラウンドで後付けの警告挿入は全廃 (今の形は [internal_design.md](../internal_design.md) §16) |
| [todo-legacy-ways-cleanup.md](todo-legacy-ways-cleanup.md) | 同じことをする複数のやり方の一本化 T1〜T5 (完了)。 **末尾の「未対応・要判断」 は未解決** (docs/README.md の「未解決の判断事項」) |
| [todo-request-elaboration.md](todo-request-elaboration.md) | 依頼の膨らませ方の改善 (23 項目完了。 設計は [request-elaboration-design.md](../request-elaboration-design.md)) |
| [todo-context-reduction-fix.md](todo-context-reduction-fix.md) | 忘却・圧縮の思考モデル対応の ToDo (完了。 対象コードは削除) |
| [todo-cycle-18.md](todo-cycle-18.md) / [todo-cycle-19-model-path-capability-and-startup-error-fix.md](todo-cycle-19-model-path-capability-and-startup-error-fix.md) / [todo-cycle-20-interactive-resume.md](todo-cycle-20-interactive-resume.md) | 比較サイクル 18〜20 の ToDo (完了) |
| [handover-2026-10-25-context-reduction.md](handover-2026-10-25-context-reduction.md) | コンテキスト整理の作り直しの引き継ぎ書。 実機で確かめる項目は [context-reduction-redesign.md](../context-reduction-redesign.md) §14.3 B |
| [integrations-command-cleanup.md](integrations-command-cleanup.md) | `/integrations` への集約 (2026-06-20)。 直接コマンドは 2026-10-25 に削除 |

## レビュー・調査の記録

| 文書 | 内容 |
|---|---|
| [prompt-tech-debt-review.md](prompt-tech-debt-review.md) | プロンプト棚卸しレビュー (2026-04-29) |
| [agent-loop-efficiency-review.md](agent-loop-efficiency-review.md) | Agent Loop 効率レビュー (2026-05-06。 米国株アプリのログ分析) |
| [main-second-subagent-comparison.md](main-second-subagent-comparison.md) | メイン / セカンド / サブエージェントの役割の整理 (2026-04-30) |
| [room-model-review.md](room-model-review.md) | Room モデル実装レビュー (2026-06-14) |
| [prompt-ja-reference.md](prompt-ja-reference.md) | 英語化前のプロンプト日本語スナップショット (2026-06-09。 同期しない) |

## 商品品質・機能比較サイクルの記録 (2026-08-24〜09-06)

Codex / Claude Code との比較と、 各回で実装した改善の記録。 実装した仕様は各機能の設計書と docs/external_design.md / docs/internal_design.md に載せてある。

| 回 | 文書 | 主な実装 (今の仕様の置き場所) |
|---|---|---|
| review 1 / 2 / closure | [product-review-cycle-1-2026-08-24.md](product-review-cycle-1-2026-08-24.md) / [product-review-cycle-2-2026-08-25.md](product-review-cycle-2-2026-08-25.md) / [product-review-closure-2026-08-25.md](product-review-closure-2026-08-25.md) | 信頼性・Windows のスキルとシェル出力 |
| 1 | [product-feature-comparison-2026-08-26.md](product-feature-comparison-2026-08-26.md) | サブエージェントの skill preload (internal_design §8) |
| 2 | [product-feature-comparison-cycle-2-2026-08-26.md](product-feature-comparison-cycle-2-2026-08-26.md) | モデル向け schedule ツール (loop_feature.md) |
| 3 / 4 | [product-feature-comparison-cycle-3-2026-08-26.md](product-feature-comparison-cycle-3-2026-08-26.md) / [product-feature-comparison-cycle-4-2026-08-26.md](product-feature-comparison-cycle-4-2026-08-26.md) | background task の一覧・停止・追加指示 (internal_design §2.2) |
| 5 | [product-feature-comparison-cycle-5-2026-08-26.md](product-feature-comparison-cycle-5-2026-08-26.md) | ローカル plugin bundle (plugin-bundle-design.md) |
| 6 | [product-feature-comparison-cycle-6-2026-08-26.md](product-feature-comparison-cycle-6-2026-08-26.md) | safe mode (safe-mode-design.md) |
| 7 / 15 | [product-feature-comparison-cycle-7-2026-08-27.md](product-feature-comparison-cycle-7-2026-08-27.md) / [product-quality-cycle-15-tui-mouse-scrollback-2026-09-01.md](product-quality-cycle-15-tui-mouse-scrollback-2026-09-01.md) | TUI の scrollback (tui-alternate-screen.md) |
| 8 | [product-feature-comparison-cycle-8-2026-08-29.md](product-feature-comparison-cycle-8-2026-08-29.md) | 日本語 IME の右端描画・fail-fast・session fork |
| 9 | [product-feature-comparison-cycle-9-2026-08-30.md](product-feature-comparison-cycle-9-2026-08-30.md) | `/diff` の実差分・`/rename` (external_design §2.2) |
| 10 | [product-feature-comparison-cycle-10-2026-08-30.md](product-feature-comparison-cycle-10-2026-08-30.md) | Native Computer Use (native-computer-use.md) |
| 11 | [product-feature-comparison-cycle-11-worktree-design-2026-08-31.md](product-feature-comparison-cycle-11-worktree-design-2026-08-31.md) | sub-agent の worktree 分離 (internal_design §2.2) |
| 12 | [product-feature-comparison-cycle-12-workflow-learning-2026-08-31.md](product-feature-comparison-cycle-12-workflow-learning-2026-08-31.md) | 操作学習 (workflow-learning.md) |
| 13 | [product-feature-comparison-cycle-13-response-preview-2026-08-31.md](product-feature-comparison-cycle-13-response-preview-2026-08-31.md) | 受信中の 1 行プレビュー (external_design §2.4) |
| 14 | [product-feature-comparison-cycle-14-release-version-2026-09-01.md](product-feature-comparison-cycle-14-release-version-2026-09-01.md) | version の単一ソース化・`--check-update` (release-workflow.md) |
| 16 | [product-feature-comparison-cycle-16-foreground-steering-2026-09-02.md](product-feature-comparison-cycle-16-foreground-steering-2026-09-02.md) | 処理中の入力を同じ turn に渡す (room-model-design.md / stdin-ownership.md) |
| 17 / 18 | [product-feature-comparison-cycle-17-run-api-pause-2026-09-02.md](product-feature-comparison-cycle-17-run-api-pause-2026-09-02.md) / [product-feature-comparison-cycle-18-durable-run-resume-2026-09-03.md](product-feature-comparison-cycle-18-durable-run-resume-2026-09-03.md) | `/run pause` (durable-run-resume-design.md。 17 のプロセス内 pause は廃止) |
| 20 | [product-feature-comparison-cycle-20-interactive-resume-2026-09-05.md](product-feature-comparison-cycle-20-interactive-resume-2026-09-05.md) | 処理中の入力欄・Shift+Tab・resume 時の出力の復元 (stdin-ownership.md) |
| 21〜24 | [cycle 21](product-feature-comparison-cycle-21-response-copy-api-compat-2026-09-05.md) / [cycle 22](product-feature-comparison-cycle-22-resume-preview-integrity-2026-09-05.md) / [cycle 23](product-feature-comparison-cycle-23-copy-long-line-integrity-2026-09-05.md) / [cycle 24](product-feature-comparison-cycle-24-native-scroll-selection-2026-09-05.md) | 応答エラーの可視化・コピー・長い行・inline 既定 (tui-alternate-screen.md)、 OpenAI の sampling 互換 (config-reference.md) |
| 25 | [product-feature-comparison-cycle-25-search-recovery-2026-09-05.md](product-feature-comparison-cycle-25-search-recovery-2026-09-05.md) | 検索の復旧・SearXNG の劣化診断 (external_design §3.1 web_search) |
| 26 | [product-feature-comparison-cycle-26-completion-prompt-handoff-2026-09-06.md](product-feature-comparison-cycle-26-completion-prompt-handoff-2026-09-06.md) | 応答完了時の入力欄の表示の引き渡し |
