# 設計書整理時の気づき・Issue一覧

> **作成日**: 2026-03-15（設計書統合整理作業中に記録）
> **棚卸し**: 2026-07-04 (docs/production-readiness.md PR-11) — 各 Issue に現状を追記した。
> 10 件中 9 件は解消済み。残 1 件 (ISSUE-02 の一部バックログ) は下記に現状を記載し、本ファイルはこれ以上更新しない (新規課題は production-readiness.md か GitHub Issues へ)。

---

## [ISSUE-01] ツール数の表記不整合 — ✅ 解消 (2026-07-04 棚卸し)

> ツール数の正はソースコード (`src/tools/definitions/`)。external_design.md 統合版で表記は修正済みで、以降は設計書側に固定の個数を書かず「ソースが正」とする運用。

**発見箇所**: `external_design.md` (旧版) §3、`internal_design.md` §2.5、`claude_code_comparison.md`

**問題**:
- `external_design.md` では「21種の機能（ツール）」と記載
- `current_datetime_tool_design.md` で追加された `current_datetime` ツールを反映すると22種になる
- `claude_code_comparison.md` の比較表でも「21種」と記載されていた

**対応**: 統合版 `external_design.md` では22種に修正済み。ただし、実際のソースコード（`src/tools/definitions/`）のツール数との整合性を確認すること。

**確認すべき箇所**: `src/index.ts` の `toolRegistry.register()` 呼び出し数

---

## [ISSUE-02] `improvement-plan.md` のフェーズ3以降が未実装のまま放置 — 🔶 一部解消 (2026-07-04 棚卸し)

> improvement-plan.md 自体は既に削除済み。Discord 双方向連携は実装済み (docs/discord-gateway-design.md が正)。BROWSER-01 / PERF-01 / CTX-01 / WEB-03 の4件は未実装のバックログとして残る (実装するかは需要が出た時点で判断。管理はこの4行が正)。

**発見箇所**: `improvement-plan.md` Phase 3, Phase 5

**問題**:
以下の改善項目が "将来実装" として設計書に残っているが、実装状況が不明。

| ID | 内容 | Phase |
|---|---|---|
| BROWSER-01 | Playwright accessibility API 置き換え (`page.accessibility.snapshot()`) | 3 |
| PERF-01 | トークン生成速度表示 (tokens/sec) | 3/5 |
| CTX-01 | Ollamaトークナイザー使用 (`POST /api/tokenize`) | 3/5 |
| WEB-03 | 検索プロバイダー拡張 (Tavily API対応) | 3 |
| Discord双方向連携 | Discord Slash Command受信 (Phase 3) | 3 |

**対応方針**: 実装するかアーカイブするかを明示的に決定し、GitHub Issues に移行または削除する。

---

## [ISSUE-03] v0.3.0 セカンドLLM機能の実装状況が不明 — ✅ 解消 (2026-07-04 棚卸し)

> 実装済み。`src/second-llm/` / `src/providers/` (vertex-ai, azure 系) が存在し、consult / agent / evaluator 委任が動作している。

**発見箇所**: `v030_second_llm_design.md`

**問題**:
- 設計書は非常に詳細に書かれているが、実装状況（未着手/進行中/完了）が記載されていない
- `src/` 配下に `second-llm/`, `cost/`, `providers/vertex-ai.ts` 等が存在するか不明
- 設計書と実装の乖離がある可能性がある

**確認すべき箇所**: `src/second-llm/`, `src/cost/`, `src/providers/vertex-ai.ts`, `src/providers/azure-openai.ts`

**対応方針**: 実装状況を調査し、設計書の先頭に実装進捗セクションを追加する。

---

## [ISSUE-04] `skill-creator` スキルの実装状況が不明 — ✅ 解消 (2026-07-04 棚卸し)

> `src/skills/builtin/skill-creator/SKILL.md` として実装済み (Python スクリプト群方式ではなく SKILL.md 主体の現行スキル形式)。ビルトインは 18 スキルに拡大している。

**発見箇所**: `skill_architecture_design.md` §3

**問題**:
- `skill_architecture_design.md` では `src/skills/builtin/skill-creator/` 配下に Python スクリプト群（`init_skill.py`, `package_skill.py`, `quick_validate.py`）を配置する設計が記載されている
- `src/skills/builtin/` の実際のファイル構成を確認していない
- 組み込みスキル一覧（commit, pr-review, tdd, build-fix）との整合性も不明

**確認すべき箇所**: `src/skills/builtin/` ディレクトリ構成

---

## [ISSUE-05] `web_fetch` の URLスキーム制限が未成熟 — ✅ 解消 (2026-07-04 棚卸し)

> 実装済み。web_fetch は http/https のみに制限されている (security_assessment.md / production-readiness.md §0 参照)。

**発見箇所**: `security_assessment.md` §3.3

**問題**:
- `web_fetch` ツールが `file://` 等のプロトコルハンドラを処理した場合、サンドボックスを迂回してシステムの機密ファイルを漏洩させるリスクがある
- 設計書では「厳密なURLスキーム制限が未成熟な場合」との但し書きがあるが、現在の実装状況が不明

**対応方針**: `src/tools/definitions/web-fetch.ts` で URLスキームを `https://` と `http://` のみに制限する実装を確認・追加する。

---

## [ISSUE-06] `browser_screenshot` の `save_path` 未指定時の挙動とセキュリティ — ✅ 解消 (2026-07-04 棚卸し)

> 実装済み。`save_path` 未指定時は OS 一時ディレクトリへ自動保存する (improvement-plan BROWSER-02 の方針を採用。`src/tools/definitions/browser.ts` 参照)。

**発見箇所**: `browser_screenshot_design.md`、`improvement-plan.md` §BROWSER-02

**問題**:
- `save_path` 未指定時は「従来通り先頭100文字を返す後方互換を維持する」とあるが、この挙動はそもそも設計意図と合っているか再考の余地がある
- `improvement-plan.md` §BROWSER-02 では「`save_path` が未指定の場合、OS一時ディレクトリに自動保存」という別の方針も提案されていた
- 実装がどちらの方針に従っているか、また `save_path` がサンドボックスチェックをパスしているか確認が必要

**確認すべき箇所**: `src/tools/definitions/browser.ts` の `browser_screenshot` 実装

---

## [ISSUE-07] セカンドLLM（クラウドLLM）利用時のプライバシーリスクが未文書化 — ✅ 解消 (2026-07-04 棚卸し)

> security_assessment.md §5「セカンドLLM（クラウドLLM）利用時のデータプライバシーリスク」として文書化済み (既定無効・ローカル LLM 推奨の警告を含む)。

**発見箇所**: `external_design.md` §1.2（Claude Code比較）、`v030_second_llm_design.md`

**問題**:
- LocalLLM Agent の主要な設計目標の1つは「データプライバシーの絶対的な保護」
- しかし v0.3.0 でクラウドLLM（Vertex AI / Azure AI）をセカンドLLMとして利用できる機能を追加しようとしている
- クラウドLLMにタスクを委譲した場合、コードや機密情報が外部に送信されるリスクが生まれる
- このトレードオフについて `security_assessment.md` に追記が必要

**対応方針**: `security_assessment.md` §3 に「セカンドLLM（クラウド）利用時のデータ漏洩リスク」セクションを追加し、ユーザーへの明示的な警告を設計に組み込む。

---

## [ISSUE-08] AgentLoop の最大イテレーション数（50回）の根拠が不明確 — ✅ 解消 (2026-07-04 棚卸し)

> 固定 50 回は廃止され、能力ティア別の `capability.maxIterations` (hard cap) + レジスター別ソフトキャップに置き換わっている。設計は docs/multi-tier-harness-roadmap.md / docs/lightweight-register-anchors-design.md、override は `modelCapabilities` 設定で可能。

**発見箇所**: `internal_design.md` §2.1

**問題**:
- AgentLoop のメインループは最大50回のイテレーションで強制終了する
- この数値の根拠（なぜ50か）が設計書に記載されていない
- ユーザーが設定で変更できるか不明

**確認すべき箇所**: `src/agent/agent-loop.ts` の `MAX_ITERATIONS` 定数と設定ファイルとの紐付け

---

## [ISSUE-09] Discord双方向連携の設計書が `improvement-plan.md` にしか存在しない — ✅ 解消 (2026-07-04 棚卸し)

> 独立設計書 docs/discord-gateway-design.md (Gateway/WS 方式) が存在し、実装済み。

**発見箇所**: `improvement-plan.md` §Phase 3

**問題**:
- Discord Slash Command 受信（双方向連携）は Phase 3 として設計されているが、独立した設計書が存在しない
- 実装が開始された場合、`improvement-plan.md` の小さなセクションのみを参照することになる

**対応方針**: 実装着手前に `docs/discord_interactive_design.md` として独立設計書を作成する。

---

## [ISSUE-10] CLAUDE.md の `src/agent/` と `src/agents/` の区別が混乱しやすい — ✅ 解消 (2026-07-04 棚卸し)

> CLAUDE.md は改訂され Architecture セクション自体が README/internal_design 参照に移行した。モジュール構成の正は internal_design.md (`src/agent/` = コアロジック、`src/agents/` = エージェント定義とローダー)。

**発見箇所**: `CLAUDE.md` の Architecture セクション

**問題**:
- `src/agent/` はエージェントのコアロジック（AgentLoop, PlanManager等）
- `src/agents/` はエージェント定義ファイル（.md）とそのローダー
- 外部から見ると紛らわしく、設計書でも混用が見られた

**対応方針**: `CLAUDE.md` の Architecture セクションのコメントを補強し、両者の違いを明確化する。
