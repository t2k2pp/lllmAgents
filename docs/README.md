# docs 索引 (Documentation Index)

> **作成日**: 2026-07-04 / **作り直し**: 2026-10-25 (docs 整理。 記録を `archive/` に分け、 設計書を実装と照合し直した)
>
> **運用ルール**:
> - 新しい設計書を追加したら、 この索引の該当する表に 1 行足す (Status 付き)
> - 設計と実装が違ったら実装を正として設計書を直す (違和感があれば直す前に利用者へ報告する)
> - 作業の記録・完了した ToDo・後継に置き換えられた設計は [archive/](archive/README.md) へ移す (`git mv`。 参照も書き換える)
> - Status 凡例: `implemented` = 実装済みの正 / `in-progress` = 実装の途中 / `design` = 設計済み・未実装 (実装の手順まで決めたもの) / `proposal` = 未実装の構想・計画 / `reference` = 手順書・参照資料

## どの時にどれを見るか

| やりたいこと | まず読む | あわせて読む |
|---|---|---|
| 全体像をつかむ (初めて触る) | [external_design.md](external_design.md) §1〜3 → [internal_design.md](internal_design.md) §1〜2 | [workspace-separation.md](workspace-separation.md) |
| スラッシュコマンドを足す・変える | [external_design.md](external_design.md) §2.2・§2.6 (同じ目的のやり方を 2 つ作らない) | スキル `add-repl-command`、 `src/cli/commands/` のレジストリ |
| 起動オプション・キー操作・表示 (TUI) を変える | [external_design.md](external_design.md) §2.4・§2.5 | [tui-alternate-screen.md](tui-alternate-screen.md)、 [stdin-ownership.md](stdin-ownership.md)、 [repl-io-robustness.md](repl-io-robustness.md) |
| 設定キーを足す・意味を調べる | [config-reference.md](config-reference.md) | `src/config/types.ts` |
| ツールを足す・権限を変える | [external_design.md](external_design.md) §3・§4 | [security_assessment.md](security_assessment.md)、 [wsl-sandbox-design.md](wsl-sandbox-design.md) |
| システムプロンプト・モデルへの説明文を変える | [prompt-prefix-stability.md](prompt-prefix-stability.md) (前方一致を壊さない) | [system-prompt-redesign.md](system-prompt-redesign.md)、 [prompt-language-policy.md](prompt-language-policy.md)、 [internal_design.md](internal_design.md) §16 |
| ハーネスの促し・ToDo・Goal の振る舞い | [internal_design.md](internal_design.md) §16 | [strategic-todo-design.md](strategic-todo-design.md)、 [reactive-intervention-coherence-design.md](reactive-intervention-coherence-design.md)、 [request-elaboration-design.md](request-elaboration-design.md)、 [goal-seek-mode-design.md](goal-seek-mode-design.md) |
| コンテキストの整理・`/compact`・`/handoff`・キャッシュが外れる | [context-reduction-redesign.md](context-reduction-redesign.md) | [internal_design.md](internal_design.md) §2.5、 [handoff-design.md](handoff-design.md)、 [prompt-prefix-stability.md](prompt-prefix-stability.md) |
| LLM の動作が遅い (ローカル LLM) | [prompt-prefix-stability.md](prompt-prefix-stability.md) | [todo-local-llm-speed.md](todo-local-llm-speed.md)、 [server-aware-runtime-design.md](server-aware-runtime-design.md) (サーバの枠・スロットに合わせる)、 [response-latency-improvement.md](response-latency-improvement.md) |
| プロバイダ・モデル設定 (`/models`) | [model-registry.md](model-registry.md) | [model-orchestration.md](model-orchestration.md)、 [model-apply-immediacy.md](model-apply-immediacy.md)、 各プロバイダの設計書 |
| セカンド LLM・サブエージェント・評価 | [v030_second_llm_design.md](v030_second_llm_design.md) | [internal_design.md](internal_design.md) §2.2、 [evaluation-loop.md](evaluation-loop.md)、 [main_second_swap_design.md](main_second_swap_design.md) |
| Discord / Slack | [room-model-design.md](room-model-design.md) | [discord-gateway-design.md](discord-gateway-design.md)、 [slack-integration.md](slack-integration.md)、 [channel-interaction-bridge-design.md](channel-interaction-bridge-design.md) |
| スキルを足す | [external_design.md](external_design.md) §10 | スキル `skill-creator`、 [workspace-separation.md](workspace-separation.md) (同期) |
| コミット・push・CI | [git-hooks.md](git-hooks.md) | CLAUDE.md「コミット前の検査」 |
| 配布物 (exe) を作る・リリースする | [workspace-separation.md](workspace-separation.md) | [release-workflow.md](release-workflow.md)、 [exe-playwright-externalization.md](exe-playwright-externalization.md)、 [setup-mac.md](setup-mac.md) |
| セキュリティの影響を確かめる | [security_assessment.md](security_assessment.md) | [nodejs-security-review-2026-10.md](nodejs-security-review-2026-10.md) |
| 過去の経緯 (なぜこうなったか) を調べる | 該当の機能設計書の改訂履歴 | [archive/README.md](archive/README.md) |

## まず読むもの (正典。 常に実装と一致させる)

| ドキュメント | 内容 |
|---|---|
| [external_design.md](external_design.md) | 外部設計 — コマンド・キー操作・起動オプション・ツール・権限・設定の概要 (利用者から見た仕様) |
| [internal_design.md](internal_design.md) | 内部設計 — モジュール構成・AgentLoop・コンテキストの整理・サブエージェント・ハーネスの介入 |
| [config-reference.md](config-reference.md) | 設定リファレンス (`~/.localllm/config.json` / `credentials.json`) とデータの置き場所 |
| [security_assessment.md](security_assessment.md) | セキュリティ評価と対策 — 脅威モデル・サンドボックス・クラウド LLM のリスク |
| [workspace-separation.md](workspace-separation.md) | ワークスペース構成 (src / dist / deploy / sandbox) と Stop フック |
| [git-hooks.md](git-hooks.md) | Git フック (commit-msg / pre-commit) — コミット前に CI と同じ型・lint 検査 |
| [release-workflow.md](release-workflow.md) | リリース自動ビルド (最新パッチ版 Node 24 の exe を Windows runner でビルドして Release へ) |
| [prompt-prefix-stability.md](prompt-prefix-stability.md) | プロンプトの前方一致を壊さない約束 (CLAUDE.md のルール。 送った並びは書き換えず、 変わる情報は末尾に足す) |
| [context-reduction-redesign.md](context-reduction-redesign.md) | コンテキストの整理 (予約で時期を決め、 決まった段階で 1 回だけ書き換え・先読み・計測)。 実機での確認 §14.3 B が残る |

## 機能別の設計書

Status の記載が無いものは `implemented`。

### エージェントループ・プロンプト・ハーネス

| ドキュメント | Status | 内容 |
|---|---|---|
| [system-prompt-redesign.md](system-prompt-redesign.md) | | システムプロンプト再構成 (behavioral / rest の 2 層 + tool-guides の遅延注入) |
| [prompt-language-policy.md](prompt-language-policy.md) | in-progress | モデル向けは英語が正本 (Phase 1 済み / 2・3 未) |
| [prompt-cache-cost-reduction.md](prompt-cache-cost-reduction.md) | | プロンプトキャッシュでのコスト削減 (§3.1 は prompt-prefix-stability.md で改訂) |
| [strategic-todo-design.md](strategic-todo-design.md) | | 準システムプロンプト + 戦略 ToDo (`todo_append` / `todo_mark` / `todo_delete`) |
| [todo-goal-lifecycle.md](todo-goal-lifecycle.md) | | ToDo / Goal の寿命 (`/clear`・session 復元・`/todo all`) |
| [reactive-intervention-coherence-design.md](reactive-intervention-coherence-design.md) | | 反応的介入の整合 (成果物の形を 1 つに決めつけない。 軽いタスクの過剰プラン抑制も含む) |
| [request-elaboration-design.md](request-elaboration-design.md) | | 依頼の膨らませ方 (要件展開)・ループ点検 |
| [env-info-and-app-basics.md](env-info-and-app-basics.md) | | 実行環境情報の補強 (使える Python・git bash のパス) とデータを扱うアプリの土台 |
| [agent-events-design.md](agent-events-design.md) | | AgentLoop のイベント化 (AgentEventBus) |
| [ephemeral-context-design.md](ephemeral-context-design.md) | | 揮発メッセージ (`Message.ephemeral`。 整理イベントでまとめて除く) |
| [context-intelligence.md](context-intelligence.md) | | 意図の分類 (A 節が現行。 B 節の階層圧縮は削除済みで記録扱い) |
| [handoff-design.md](handoff-design.md) | | `/handoff` (引き継ぎメモを残してリセット)・メモの形 |
| [context-inspector.md](context-inspector.md) | | `/context` のドリルダウン |
| [evaluation-loop.md](evaluation-loop.md) | | 評価ループ (書き込み後の Evaluator・`/try`) |
| [tool-call-salvage-pipe-format-design.md](tool-call-salvage-pipe-format-design.md) | | ツール呼び出しのサルベージ (`<\|tool\|>call:` 形式) |
| [input-compression-design.md](input-compression-design.md) | | opt-in 入力圧縮 (`/compress-input`) |
| [sequential-execution.md](sequential-execution.md) | | ツールの逐次実行 (既定) とレート制限での停止 |
| [file-tools-line-endings.md](file-tools-line-endings.md) | | file_read / file_edit / file_write の改行コード |
| [fix-plan-process-and-timeout-management.md](fix-plan-process-and-timeout-management.md) | | bash のプロセス分離・無通信監視・対話待ちの防止 |
| [model-path-capability-and-startup-error-fix.md](model-path-capability-and-startup-error-fix.md) | | パス付きモデル名の能力ティア解決と起動時の例外の表示 |

### 自律実行

| ドキュメント | Status | 内容 |
|---|---|---|
| [goal-seek-mode-design.md](goal-seek-mode-design.md) | | Goal Seek mode (受け入れ条件で駆動。 Phase 1。 Phase 2 以降は未実装) |
| [goal-loop-deterministic-check-design.md](goal-loop-deterministic-check-design.md) | | `/goal-loop` (決定的な検証の終了コード 0 まで反復) |
| [goal-promotion-design.md](goal-promotion-design.md) | | 依頼から Goal への昇格の提案 |
| [checkpoint-and-smoke-design.md](checkpoint-and-smoke-design.md) | | 自動チェックポイント (シャドウ Git) と `game_smoke` |
| [durable-run-resume-design.md](durable-run-resume-design.md) | | `/run pause` (保存して止める 1 方式。 再起動を跨いで再開・起動時の再開確認) |
| [loop_feature.md](loop_feature.md) | | `/loop` と schedule ツール (定期実行) |

### LLM プロバイダ・モデル管理

| ドキュメント | Status | 内容 |
|---|---|---|
| [model-registry.md](model-registry.md) | | Model Registry (登録一覧 + main / second / vision のスロット。 `/models`) |
| [model-orchestration.md](model-orchestration.md) | | 任意のスロットとサブエージェントの結び付け |
| [model-apply-immediacy.md](model-apply-immediacy.md) | | モデル設定の即時反映と設定のずれの表示 |
| [v030_second_llm_design.md](v030_second_llm_design.md) | | セカンド LLM (相談 / エージェント / Evaluator への委任) |
| [main_second_swap_design.md](main_second_swap_design.md) | | `/swap` (メイン ⇔ セカンドの入れ替え) |
| [llm-profile-descriptions.md](llm-profile-descriptions.md) | | モデル特性の説明 (委任先を選ぶ材料) |
| [azure-gpt-provider.md](azure-gpt-provider.md) | | azure-gpt (Responses API) |
| [gemini-aistudio-provider.md](gemini-aistudio-provider.md) | | gemini (Google AI Studio) |
| [claude-providers.md](claude-providers.md) | | Claude 系 (anthropic / claude-cli / claude-agent-sdk) |
| [claude-agent-sdk-provider-design.md](claude-agent-sdk-provider-design.md) | | claude-agent-sdk |

### REPL / UX

| ドキュメント | Status | 内容 |
|---|---|---|
| [repl-io-robustness.md](repl-io-robustness.md) | | REPL I/O の堅牢化 (raw mode の自己修復・Esc 中断) |
| [interrupt-and-progress-design.md](interrupt-and-progress-design.md) | | 中断の手段と進捗表示 |
| [stdin-ownership.md](stdin-ownership.md) | | stdin の所有権の一元化・処理中の入力欄・Shift+Tab |
| [tui-alternate-screen.md](tui-alternate-screen.md) | | 表示 (inline 既定 / 全画面 TUI は明示選択)・マウス・コピー |
| [prompt-history-resume.md](prompt-history-resume.md) | | 入力欄の ↑↓ 履歴の永続化 |
| [spinner-mode-response-coloring-design.md](spinner-mode-response-coloring-design.md) | | 応答テキストの色分け (構造ベース) |
| [ux-transparency.md](ux-transparency.md) | | UX の透明性 + サンプリングパラメータ |
| [cost-token-command-design.md](cost-token-command-design.md) | | `/cost` (コスト・トークンの可視化) |
| [response-latency-improvement.md](response-latency-improvement.md) | in-progress | 応答速度の改善 (A1 の live preview は実装済み) |

### チャネル統合 (Discord / Slack / Room)

| ドキュメント | Status | 内容 |
|---|---|---|
| [room-model-design.md](room-model-design.md) | | Room モデル (A/B/C のサーフェス別の会話・受信順キュー・foreground steering) |
| [discord-gateway-design.md](discord-gateway-design.md) | | Discord の受信 (Gateway 方式) |
| [slack-integration.md](slack-integration.md) | | Slack 統合 (Socket Mode) |
| [channel-interaction-bridge-design.md](channel-interaction-bridge-design.md) | | チャネルでの権限確認 / ask_user |
| [channel-progress-design.md](channel-progress-design.md) | | チャネルの進捗中間報告 |
| [async-surface-permission-delivery-design.md](async-surface-permission-delivery-design.md) | | 非同期サーフェスの権限・配信・観測性 (背景面の autorun) |
| [task-report-notification-design.md](task-report-notification-design.md) | | 完了報告の構造化と Webhook 通知 |

### ツール・スキル・外部連携

| ドキュメント | Status | 内容 |
|---|---|---|
| [image-generation.md](image-generation.md) | | 画像生成 (Azure GPT Images / SD WebUI / ComfyUI) |
| [obsidian-integration.md](obsidian-integration.md) | | Obsidian ナレッジベース (`knowledge_save` / `knowledge_search`) |
| [chat-log.md](chat-log.md) | | 会話ログの保存 |
| [llm-logging.md](llm-logging.md) | | LLM I/O ログ + 運用ログ (ops-logger) |
| [exe-playwright-externalization.md](exe-playwright-externalization.md) | | exe での Playwright 外部化 (`--install-browser`。 §A は未実装) |
| [wsl-sandbox-design.md](wsl-sandbox-design.md) | | bash の封じ込め (Seatbelt / bwrap / WSL2) |
| [native-computer-use.md](native-computer-use.md) | | Native Computer Use (`computer_*`) の安全境界と OS ドライバ |
| [workflow-learning.md](workflow-learning.md) | | 操作学習 (browser / computer の操作を手動起動の skill に) |
| [plugin-bundle-design.md](plugin-bundle-design.md) | | 明示的に信頼したローカル plugin bundle |
| [safe-mode-design.md](safe-mode-design.md) | | `--safe-mode` (カスタマイズを止めて診断) |
| [claude-code-driver-skill.md](claude-code-driver-skill.md) | | claude-code-driver スキル |
| [ascii-art-skill-design.md](ascii-art-skill-design.md) | | ASCII アート化スキル |
| [product-quality-cycle-skill.md](product-quality-cycle-skill.md) | | 観点を指定した品質レビュー・改善サイクルのスキル |
| [unity-integration.md](unity-integration.md) | | Unity 連携 (`localllm unity setup / doctor`) |
| [unity-production-recovery.md](unity-production-recovery.md) | | Unity 制作支援とコンテキストの復旧 |

## 構想・計画 (未実装)

| ドキュメント | Status | 内容 |
|---|---|---|
| [server-aware-runtime-design.md](server-aware-runtime-design.md) | design | サーバに合わせて動く (llama.cpp の /props で枠・スロット数・モデルを読み、 段階を判定し直す。 脇の呼び出し・サブエージェントを別スロット (id_slot) かセカンド LLM へ振り分ける) |
| [todo-local-llm-speed.md](todo-local-llm-speed.md) | proposal | ローカル LLM の処理速度改善の計画 (未着手) |
| [multi-tier-harness-roadmap.md](multi-tier-harness-roadmap.md) | in-progress | マルチティア (T1/T2/T3) ハーネスのロードマップ (一部実装済み) |
| [autonomy-improvement-proposal.md](autonomy-improvement-proposal.md) | proposal | 自律性向上の提案 (A-1〜A-6・B-1 は実装済み。 A-7〜A-9・B-2・B-3 が未着手) |
| [changelog-feature-backlog.md](changelog-feature-backlog.md) | proposal | Claude Code changelog 由来の機能バックログ |
| [openclaw-compat-addon-feasibility.md](openclaw-compat-addon-feasibility.md) | proposal | OpenClaw 互換アドオンの実現性調査と設計 |

## 手順書・参照

| ドキュメント | Status | 内容 |
|---|---|---|
| [setup-mac.md](setup-mac.md) | reference | macOS のセットアップ手順 |
| [blender-mcp-integration.md](blender-mcp-integration.md) | reference | Blender MCP の接続手順 (コード改修なし) |
| [nodejs-security-review-2026-10.md](nodejs-security-review-2026-10.md) | reference | Node.js のセキュリティ調査 (2026-10-22 時点) と本アプリへの影響 |

## 未解決の判断事項

- config の `mainLLM` / `secondLLM` / `visionLLM` と model-registry のスロットの二重管理: 「今は触らない」 と決定済み (external_design §2.6)
- `/try` の評価役に Generator の作業ログを渡している件 (経緯を断つか): [evaluation-loop.md](evaluation-loop.md) §3.2.1
- 次のチャットの出発点 (判断待ち 4 件・次の作業): [handover-2026-10-27-context-and-server.md](handover-2026-10-27-context-and-server.md)
- コンテキストの整理の実機確認の結果と残り: [context-reduction-redesign.md](context-reduction-redesign.md) §15

## アーカイブ

過去の比較・品質サイクルの記録、 完了した ToDo、 置き換えられた設計、 レビューの記録、 初期の設計書 (DESIGN.md) は [archive/README.md](archive/README.md)。
