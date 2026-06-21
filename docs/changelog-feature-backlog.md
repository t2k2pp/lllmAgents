# Claude Code changelog 取り込みバックログ

> Claude Code 公式 changelog（v2.1 系・約 200 項目）と lllmAgents を突き合わせ、
> **取り込む価値があり、かつ未実装の機能候補**をまとめた一覧。
>
> **使い方**: 着手したいものを ID で指名してください（例:「**#CL-01 やって**」「CL-02 と CL-06 を実装して」）。
> 指名された候補だけを、設計書作成 → 実装 → 検証 → コミットの流れで進めます。
>
> - 調査日: 2026-06-21
> - 突き合わせ結論: lllmAgents は Claude Code の主要機能をほぼ網羅済み。本書は残った差分のうち価値の高いものに絞っている。
> - 工数感: **S**=半日以内 / **M**=1〜2日 / **L**=数日（設計書込み）

---

## 候補一覧

| ID | 機能 | 価値 | 工数 | 主な改修先 | ステータス |
|----|------|------|------|-----------|-----------|
| **CL-01** | フォールバックモデル連鎖 | ★★★ | M | `src/config/types.ts`, `src/providers/*`, `src/agent/` | 未実装 |
| **CL-02** | `/doctor` 診断コマンド | ★★★ | M | `src/cli/`（新規 `doctor.ts`）, 各 provider | 未実装 |
| **CL-03** | フック機構の拡張 | ★★☆ | M | `src/agent/hooks.ts`, `src/agent/sub-agent.ts` | 未実装 |
| **CL-04** | `--safe-mode` 起動フラグ | ★★☆ | S | `src/cli/`（起動引数） | 未実装 |
| **CL-05** | `/usage` カテゴリ別トークン内訳 | ★★☆ | S〜M | `src/cost/`, `src/cli/repl.ts` | 未実装 |
| **CL-06** | REPL 内クイックシェル `! <command>` | ★★☆ | S | `src/cli/repl.ts` | 未実装 |
| **CL-07** | サブエージェント worktree 分離 | ★☆☆ | M | `src/agent/sub-agent.ts` | 未実装（オプション） |
| **CL-08** | Rewind / "ここまで要約" | ★☆☆ | L | `src/checkpoint/`, 圧縮層 | 未実装（オプション） |
| **CL-09** | GFM 出力レンダリング | ★☆☆ | S〜M | markdown レンダラ | 未実装（要レンダラ調査） |
| **CL-10** | スキル frontmatter 残り（`disallowed-tools`/`effort`） | ★☆☆ | S | `src/skills/skill-loader.ts` | 一部実装済み（`context:fork` は済） |
| **CL-11** | ネットワーク途切れ自動リトライ強化 | ★☆☆ | S | `src/tenacious/` | 一部実装済み |

---

## 候補詳細

### CL-01 フォールバックモデル連鎖 — 価値★★★ / M
- **課題**: `config.mainLLM` は単一エンドポイント。ローカル LLM で頻発する「過負荷・タイムアウト・モデル未ロード・接続断」時に自動で別モデルへ切り替える経路がない。
- **設計方針**:
  - `Config` に `fallbackModels?: LLMEndpoint[]`（最大 3 程度）を追加。
  - 既存の **Model Registry slots**（`LLMSlotAssignments.named`, `src/config/types.ts:321`）を活かし、registry entry id 参照でも指定可に。
  - LLM 呼び出し層で接続失敗/overload 例外を捕捉し次候補へフェイルオーバー。既存リトライ `src/tenacious/` と連携（リトライ尽きたら次モデル）。
  - REPL: `/model fallback add|remove|list`。
- **反映先**: `src/config/types.ts`, `src/providers/*`（共通呼び出し点）, `src/agent/`, `src/cli/repl.ts`。
- **設計書**: `docs/fallback-model-design.md`（新規）。
- **関連 changelog**: model fallback / automatic retry on overload。

### CL-02 `/doctor` 診断コマンド — 価値★★★ / M
- **課題**: `/status` はあるが、起動前のヘルスチェックがない。ローカル特有の躓き（モデル未ロード・サンドボックス未導入・APIキー env 未解決）が分かりにくい。
- **診断項目**:
  1. main/second/vision LLM への疎通 + モデル存在（Ollama `/api/tags` 等、各 provider に `healthCheck()` を追加）
  2. サンドボックス可用性（bubblewrap / sandbox-exec の存在。`src/security/` の検出ロジック再利用）
  3. config 妥当性（必須フィールド・`env:`/`encrypted:` の解決可否）
  4. MCP サーバ接続状態（`src/mcp/`）
  5. Playwright/chromium プローブ（`features.browser` の既存プローブ再利用）
- **出力**: ✓ / ⚠ / ✗ の一覧 + 対処ヒント。
- **反映先**: `src/cli/repl.ts`（`case "/doctor"`）, `src/cli/doctor.ts`（新規）, 各 provider。
- **設計書**: `docs/doctor-design.md`（新規）。
- **関連 changelog**: `/doctor` health check。

### CL-03 フック機構の拡張 — 価値★★☆ / M
- **課題**: `src/agent/hooks.ts` の `HookEvent` は `session_start`/`session_end`/`pre_tool_use`/`post_tool_use`/`pre_compact` の 5 種のみ。`HookAction` も `continue`/`block`/`warn` の文字列のみで、Stop 系の「追記して継続」ができない。
- **設計方針**:
  - 追加イベント: `subagent_start` / `subagent_stop` / `message_display`。
  - `HookAction` を判別共用体に拡張し `{ action: "continue", additionalContext?: string }` を返せるように（Claude の Stop hook `additionalContext` 相当）。**後方互換**のため従来の文字列も受理。
- **反映先**: `src/agent/hooks.ts`（型・`emit` 戻り値）, `src/agent/sub-agent.ts`（subagent 発火）, REPL 出力層（`message_display` 発火）。
- **設計書**: `docs/hooks.md`（あれば更新／無ければ新規）。
- **関連 changelog**: SubagentStart/Stop hooks, Stop hook additionalContext。

### CL-04 `--safe-mode` 起動フラグ — 価値★★☆ / S
- **課題**: CLAUDE/project 指示・skills・hooks・MCP が原因の不具合を切り分ける手段がない。
- **設計方針**: `--safe-mode` で上記カスタマイズ群を一括無効化して起動。各ローダーに safeMode ガードを通すだけ。
- **反映先**: `src/cli/` の起動引数パース。
- **関連 changelog**: `--safe-mode` flag。

### CL-05 `/usage` カテゴリ別トークン内訳 — 価値★★☆ / S〜M
- **課題**: `/cost`（金額）はあるが、main / second / subagent / skill / MCP 別のトークン帰属内訳がない。どこがコンテキストを食っているか分からない。
- **設計方針**: `src/cost/` の集計に呼び出し元カテゴリのタグ付けを追加し、`/usage` で内訳表示。既存 `/cost` は据え置き。
- **反映先**: `src/cost/`, `src/cli/repl.ts`。
- **関連 changelog**: `/usage` token breakdown。

### CL-06 REPL 内クイックシェル `! <command>` — 価値★★☆ / S
- **課題**: ちょっとした `ls` / `git status` の確認に LLM ターンを消費している。
- **設計方針**: 行頭 `!` で LLM を介さず直接 bash 実行。**既存のサンドボックス・権限チェックは通す**。
- **反映先**: `src/cli/repl.ts` の入力ディスパッチ。
- **関連 changelog**: `!` bash quick-run in REPL。

### CL-07 サブエージェント worktree 分離 — 価値★☆☆ / M（オプション）
- **概要**: サブエージェントに `isolation:"worktree"` 相当の独立 git worktree を与え、変更が無ければ自動破棄。
- **注意**: 既存の checkpoint（シャドウ Git, `src/checkpoint/`）との棲み分け整理が必要。需要が出てから。
- **反映先**: `src/agent/sub-agent.ts`。

### CL-08 Rewind / "ここまで要約" — 価値★☆☆ / L（オプション）
- **概要**: 会話の特定地点までの巻き戻し、または「ここまでを要約して続行」。
- **設計方針**: 既存 `src/checkpoint/` と圧縮層を組み合わせた部分巻き戻し UI。コストは大きめ。
- **反映先**: `src/checkpoint/`, 圧縮層, REPL。

### CL-09 GFM 出力レンダリング — 価値★☆☆ / S〜M（要調査）
- **概要**: `- [ ]` チェックボックス・テーブル罫線など GitHub Flavored Markdown の端末レンダリング。
- **前提**: 現行 markdown レンダラ実装の確認が先（chalk 直書きか専用レンダラか）。見た目改善で機能影響は小。

### CL-10 スキル frontmatter 残り — 価値★☆☆ / S（一部実装済み）
- **状況**: `context: fork` は **実装済み**（`src/skills/skill-loader.ts` / `skill-registry.ts`、pr-review・code-stats が使用）。
- **残り**: `disallowed-tools`（スキル単位のツール禁止）、`effort`（思考量ヒント。ローカル LLM では効果限定的）。需要を見て。

### CL-11 ネットワーク途切れ自動リトライ強化 — 価値★☆☆ / S（一部実装済み）
- **状況**: `src/tenacious/` に基本的なリトライあり。ストリーミング途中での切断からの再開や、より細かいバックオフ戦略は強化余地。CL-01 と合わせると効果的。

---

## 既に実装済み（取り込み対象外）

突き合わせの過程で「未実装かと思ったが既にある」と確認した項目。再調査を避けるため記録する。

| 機能 | 実装箇所 | 備考 |
|------|---------|------|
| 粒度の高いパターン権限ルール（`Tool(arg)` allow/deny/ask、glob 対応） | `src/security/rules.ts`（`evaluateRules`/`checkCommand`）, `config.security.rules`, `permission-manager.ts:127,276` | `bash(npm *)` / `file_write(./src/**)` 等が動作 |
| スキル `context: fork`（独立コンテキスト実行 + 許可ツール絞り） | `src/skills/skill-loader.ts`, `src/skills/skill-registry.ts` | pr-review / code-stats が使用 |
| 破壊的コマンドの確認フォールバック | `src/security/destructive-commands.ts` | `rm`/`git reset --hard`/`checkout -- .`/`clean -fd`/force push 等を検出し確認へ。Claude の「明示要求時のみ許可」とは方式が違うが安全側として十分 |
| プロンプトキャッシュ（コスト削減） | `config.features.promptCache` | Anthropic 系で cache_control 付与 |
| サンドボックス（FS/network/full） | `config.security.processSandbox` | bwrap / sandbox-exec |
| Plan モード・todo・サブエージェント・MCP・skills・チェックポイント | 各 `src/` 配下 | 主要機能は網羅済み |

---

## スコープ外（今回は取り込まない）

lllmAgents の方向性（ローカル LLM 中心・単体運用）と合わない、または公式専用基盤に依存するもの。

- プラグイン marketplace / プラグイン配布基盤
- Agent Teams（複数エージェント協調の公式 UI）
- 音声入力 / ネイティブ IDE 拡張（VS Code/JetBrains）統合
- OpenTelemetry メトリクスエクスポート
- Claude.ai / 公式クラウドアカウント前提の機能（usage limit 表示、web セッション連携 等）
