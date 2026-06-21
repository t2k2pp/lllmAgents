# OpenClaw 互換アドオン 実現性調査・設計案

## 0. ステータス
- 状態: **調査ドラフト（実現性調査 ＋ アドオン設計案）。コード変更なし＝ドキュメントのみ**
- 起票: 2026-06-21 / 作成: Claude Code（ユーザーレビュー前ドラフト）
- 比較対象: **OpenClaw**（https://openclaw.ai/ ／ GitHub org `openclaw`）
- 関連: `docs/autonomy-improvement-proposal.md`（OpenClaw 系チャネルボットと比較済み）、
  `docs/room-model-design.md`（マルチサーフェス Room モデル）、`docs/slack-integration.md`、`docs/discord-gateway-design.md`
- 調査手段の限界: 本環境のネットワークポリシーにより Web 検索は不可。OpenClaw の情報は GitHub org / 各リポジトリ README /
  ClawHub の WebFetch 取得結果に基づく（`https://openclaw.ai/` への直アクセスは 403）。
  取得できなかった点・推定箇所は本文で「未確認」と明示する。

## 1. 背景・目的
ユーザー仮説:
> 「本アプリ（lllmAgents = Claude Code 型のローカル自律エージェント）の**基本（コア）は変えず**に、
> **アドオン的な拡張機能**を足すことで、OpenClaw と**同等の動作**ができ、**どちらの用途でも使える**のでは？」

本書はこの仮説の実現性を、両システムのアーキテクチャ比較に基づいて評価し、コアを改変しない「アドオン層」の
設計案を提示する。結論を先に述べると、**SKILL.md 形式の一致と既存の拡張シーム（差し込み口）の充実により、
コア無改変のアドオン方式で両用途を満たすことは実現可能**である。

## 2. 両システムの位置づけ

### 2.1 lllmAgents（本アプリ）
- **形態**: セッション起動型の REPL / CLI コーディング・自律エージェント。`localllm` 起動 → 対話 →（必要なら）常駐サーフェス。
- **コア**: 反復ツール実行ループ `src/agent/agent-loop.ts`、CLI フロント `src/cli/repl.ts`。
- **LLM バックエンド**: ローカル（Ollama / LM Studio / llama.cpp / vLLM）＋クラウド（Anthropic / Azure 各種 / Vertex / Gemini /
  Claude Agent SDK）を `src/providers/provider-factory.ts` で抽象化（12+）。
- **ツール**: ファイル I/O・bash・検索・web・ブラウザ・vision・画像生成・サブエージェント等 24 種（`src/tools/definitions/`）。
- **拡張**: スキル（`~/.localllm/skills/<name>/SKILL.md`）、MCP、フック、ルール、Room（A/B/C）。
- **安全**: 3 階層権限（auto/confirm/deny）、sandbox（パス allowlist）、危険コマンド検出、OS コンテナ（bubblewrap / sandbox-exec）。
- **設計思想**: ローカルファースト、安全＝透明性、弱いローカルモデルをハーネスで実用水準に引き上げる。

### 2.2 OpenClaw（比較対象）
> 出典: GitHub org `openclaw`、`openclaw/openclaw` README、`openclaw/clawhub` README（WebFetch 取得）。

- **形態**: **常駐デーモン/ゲートウェイ型**のパーソナル AI アシスタント（"a personal AI assistant you run on your own devices"、
  マスコットは宇宙ロブスター Molty 🦞）。`npm install -g openclaw` →
  `openclaw onboard --install-daemon` で launchd/systemd 常駐サービス化、`openclaw gateway --port 18789` で前景デバッグ。
- **マルチチャネル**: WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage / IRC / Teams / Matrix /
  Feishu / LINE / Mattermost / Nostr / WeChat / QQ / WebChat など **20+ のメッセージング面**。
- **コンパニオン**: Windows Hub、macOS メニューバー、iOS/Android node（WebSocket でペアリング）。
- **スキル**: ワークスペース `~/.openclaw/workspace`、注入プロンプト `AGENTS.md` / `SOUL.md` / `TOOLS.md`、
  カスタムスキルは **`~/.openclaw/workspace/skills/<skill>/SKILL.md`**（＝本アプリと同一形式）。
- **ClawHub**: 公開スキル/プラグイン・**レジストリ（マーケット）**。`clawhub install @openclaw/demo`、`clawhub pin <skill>`、
  バージョン固定、ソフト削除、**意味検索（OpenAI embeddings + Convex vector search）**。code plugin / bundle plugin の
  ネイティブカタログも提供。SKILL.md frontmatter に**ランタイム要件（env vars / binaries / install specs）**を宣言。
- **ファーストクラス・ツール**: browser, canvas, nodes, cron, sessions, Discord/Slack actions。MCP は first-class（MCP Registry）。
- **エコシステム**: ClawRouter（プロバイダ・ルーティング GW）、CrabFleet（エージェント運用のミッションコントロール）、
  ClawSweeper（issue/PR 大規模トリアージ）、Peekaboo（mac スクショ）、mcporter（TS から MCP 呼び出し）。
- **安全**: 既定で main セッションは **full host access**。group/channel 用に `agents.defaults.sandbox.mode: "non-main"` で
  非主セッションを Docker/SSH/OpenShell サンドボックス化。DM はペアリングコードで未知の送信者を制御。
- **LLM**: 多数プロバイダ対応（"prefer a current flagship model"、OpenAI を主要サブスクとして強調）。

### 2.3 一言で
- lllmAgents = **「開発作業を安全に自律実行するセッション型コーディングエージェント」**。
- OpenClaw = **「自分のデバイスに常駐し、あらゆるチャットから呼べるパーソナルアシスタント基盤＋スキル・マーケット」**。

両者は**コア（LLM 反復ツールループ＋スキル＋MCP）はほぼ同型**で、差は主に**運用形態（常駐・多チャネル・配布/マーケット）**にある。

## 3. 機能差分マトリクス

| 領域 | lllmAgents | OpenClaw | 差分の性質 |
|---|---|---|---|
| スキル形式 | `~/.localllm/skills/<name>/SKILL.md` | `~/.openclaw/workspace/skills/<skill>/SKILL.md` | **ほぼ同一**（相互運用容易） |
| ワークスペース注入 | `CLAUDE.md` / `MEMORY.md` | `AGENTS.md` / `SOUL.md` / `TOOLS.md` | 名称差のみ（シムで吸収可） |
| MCP | あり（`src/mcp/mcp-manager.ts`、stdio/SSE、ON/OFF） | first-class（MCP Registry） | 共通 |
| マルチチャネル | Room A/B/C＝REPL / Discord / Slack（`src/agent/room-manager.ts`） | 20+ 面 | **OpenClaw が広い** |
| 常駐形態 | セッション起動型（＋ Discord/Slack 非同期サーフェス） | **常駐デーモン/GW**（launchd/systemd） | **OpenClaw が常駐前提** |
| スキル配布 | ローカルのみ（手動配置・builtin 同梱） | **ClawHub レジストリ**（install/pin/意味検索/版管理） | **本アプリに無い** |
| コードプラグイン | MCP＋ビルド時ツール登録 | code/bundle plugin（manifest＋ランタイム要件で自動導入） | **本アプリに無い動的経路** |
| プロバイダ抽象 | `provider-factory.ts`（12+） | ClawRouter（ルーティング GW） | 共通機能、実装形態が違う |
| サブエージェント/多エージェント | task ツール＋サブエージェント | CrabFleet（fleet 運用） | 本アプリは単機内、OpenClaw は運用面 |
| デバイス連携 | なし | コンパニオンアプリ＋node メッシュ | **スコープ外（§6）** |
| cron/常駐ジョブ | scheduled-tasks 系 MCP | first-class cron | 近い（吸収可） |
| 安全モデル | 3 階層権限＋sandbox＋危険コマンド検出 | main=full host／non-main=Docker等 | **本アプリの方が既定で厳格** |

### OpenClaw 側にあって本アプリに無い/弱い主要 5 点
1. **常駐デーモン/ゲートウェイ**（always-on）。本アプリはセッション起動型。
2. **大量メッセージング面アダプタ**（Telegram / WhatsApp / Signal / iMessage 等）。本アプリは Discord/Slack のみ。
3. **ClawHub スキル/プラグイン・レジストリ**（install / pin / 意味検索 / 版管理）。本アプリはローカルのみ。
4. **コード/バンドル・プラグイン**（manifest＋ランタイム要件宣言で自動インストール）。本アプリは MCP/ビルド時登録のみ。
5. **コンパニオンアプリ/デバイス node メッシュ・first-class cron 等の常駐前提機能**。

## 4. 実現性評価（結論: 高い）

「コアを変えずアドオンで両用途」が成立する理由:

1. **スキル形式が一致**。両者とも `SKILL.md`（frontmatter＋本文）かつ `<root>/skills/<name>/SKILL.md` レイアウト。
   本アプリのローダ `src/skills/skill-loader.ts` は既に `.claude/skills/` 互換も読む。
   → OpenClaw スキル資産を**ほぼ無加工で取り込める**見込み（ランタイム要件 frontmatter のマッピングのみ要対応）。
2. **拡張シーム（差し込み口）が既に整っている**。アドオンはコアを触らず以下へ動的登録するだけで成立する:
   - `ToolRegistry.register/unregister`（`src/tools/tool-registry.ts`）— ツールの動的追加・除去。
   - `SkillRegistry`（`src/skills/skill-registry.ts`）— ランタイム ON/OFF、トリガ解決。
   - `MCPManager`（`src/mcp/mcp-manager.ts`）— 外部ツールのブリッジ（reload 対応）。
   - `HookManager`（`src/hooks/hook-manager.ts`）— ライフサイクル/ツール契機のフック。
   - `RoomManager` / `room-run-queue`（`src/agent/`）— サーフェス横断の会話スロットと実行直列化。
   - `provider-factory.ts`（`src/providers/`）— プロバイダ追加。
   - `config/types.ts` のフラグ（`skillsEnabled` / `disabledSkills` / `mcpEnabled` 等）— 機能の設定駆動 ON/OFF の前例。
3. **常駐化の素地がある**。既に Discord/Slack の非同期サーフェスと Room 実行キューを持つため、
   「常駐ゲートウェイ」はこの延長線上のアドオンとして実装できる（コア反復ループは共通）。
4. **コア（`agent-loop` / `provider` / `security`）に手を入れずに済む**。差分は主に運用形態であり、
   それらは本アプリでは「サーフェス層・ローダ層・設定層」に閉じている。

したがって、**コア無改変のアドオン層＋動作プロファイル**で OpenClaw 相当の運用に寄せることは現実的である。
ただし「完全互換」ではなく「**同等の主要動作（常駐・多チャネル・スキル取り込み）を満たす実用互換**」が現実的な目標
（デバイス node メッシュ等はスコープ外。§6）。

## 5. アドオン設計案

### 設計原則
- **コア無改変**。アドオンは既存レジストリ/ローダ/サーフェスへ**動的登録**するプラグイン層として実装する。
- **設定駆動**。動作の違いは「プロファイル」と設定値で表現し、コードパスは共通に保つ（`config/types.ts` の既存流儀を踏襲）。
- **安全は緩めない**。assistant プロファイルでも本アプリの 3 階層権限・sandbox を既定で維持（§6）。

### (1) 動作プロファイル / モード — *コア改変: 不要 / 難度: 低*
同一バイナリに動作プロファイルを追加:
- `coding`（既定・現状）: セッション型コーディングエージェント。
- `assistant`（OpenClaw 風）: 常駐既定 ON、アシスタント・ペルソナ、自動 Resume、チャネル広め、cron 有効。

プロファイルは**既定値のプリセット**に過ぎず、`config/types.ts` にプロファイル項目を足し、
起動時に既定をプロファイルで切り替える（`skillsEnabled` 等の既存トグルと同じ仕組み）。依存シーム: `config-manager`。

### (2) 常駐ゲートウェイ・アドオン — *コア改変: 不要 / 難度: 中*
既存 Discord/Slack 非同期サーフェス＋`room-run-queue` を土台に、ヘッドレス常駐モードを提供。
OS デーモン化（systemd/launchd ラッパ、`openclaw onboard --install-daemon` 相当）は**配布スクリプト側**
（`scripts/` / `deploy/`）で吸収し、アプリ本体はプロセス常駐に徹する。依存シーム: `RoomManager`, surface 層。

### (3) チャネルアダプタ SDK — *コア改変: 不要 / 難度: 中*
Room モデルを抽象境界として、新メッセージング面（Telegram / Signal 等）を**アダプタ・プラグイン**として
追加できる小さなインターフェース（受信→Room へ enqueue、送信←Room からの出力）を定義。
既存 Discord/Slack 配線（`src/discord/`, `src/slack/`）を参照実装とする。依存シーム: `RoomManager`, `room-run-queue`。

### (4) ClawHub 互換レジストリ・クライアント — *コア改変: 不要 / 難度: 低〜中*
`~/.localllm/skills/` に対し install / pin / 一覧する CLI コマンド（例: `localllm skill install <ref>`）を追加。
SKILL.md 形式が一致するため、処理は **fetch → 展開 → frontmatter マッピング → 配置** が中心。
ClawHub の公開スキルを直接取り込める可能性が高い（API/認証要件は要確認）。依存シーム: `skill-loader` / `SkillRegistry`。

### (5) コード/バンドル・プラグイン・ローダ — *コア改変: 不要 / 難度: 中〜高*
manifest（互換フィールド）＋ランタイム要件宣言を読み、`ToolRegistry.register` でツールを動的登録するローダ。
MCP と並ぶ**第 2 の動的拡張経路**。サンドボックス/権限は既存 `PermissionManager` を必ず経由させる。
依存シーム: `ToolRegistry`, `PermissionManager`。

### (6) 互換シム — *コア改変: 不要 / 難度: 低*
- ワークスペース注入: OpenClaw の `AGENTS.md` / `SOUL.md` / `TOOLS.md` ↔ 本アプリ `CLAUDE.md` / `MEMORY.md` の読み替え。
- cron: 既存 scheduled-tasks 系 MCP で OpenClaw の first-class cron 相当を吸収。
- MCP: 既に first-class のため設定面の互換マッピングのみ。

### 設計案サマリ表
| 案 | コア改変 | 依存する既存シーム | 概算難度 |
|---|---|---|---|
| (1) 動作プロファイル | 不要 | config-manager | 低 |
| (2) 常駐ゲートウェイ | 不要 | RoomManager / surface / 配布 scripts | 中 |
| (3) チャネルアダプタ SDK | 不要 | RoomManager / room-run-queue | 中 |
| (4) ClawHub 互換クライアント | 不要 | skill-loader / SkillRegistry | 低〜中 |
| (5) コード/バンドルプラグイン | 不要 | ToolRegistry / PermissionManager | 中〜高 |
| (6) 互換シム | 不要 | system-prompt / config | 低 |

## 6. リスク・非互換・スコープ外
- **スコープ外（相当機能で部分代替）**: コンパニオン native アプリ、デバイス node メッシュ、ClawRouter / CrabFleet /
  ClawSweeper 等の独自インフラ。本アプリは provider 抽象・Room・サブエージェントで一部代替できるが、完全互換は目指さない。
- **安全モデルの差**: OpenClaw は main セッション full host が既定。本アプリの強み（3 階層権限・sandbox・危険コマンド検出）は
  assistant プロファイルでも**維持を推奨**。「OpenClaw 風」を選んでも安全既定は緩めない方針を明記する。
- **ClawHub の API/認証要件は未確認**。公開取得の可否・利用規約・依存（Convex/embeddings）次第で (4) の実装範囲が変わる。
- **多チャネル面の保守コスト**: 20+ 面の完全網羅は非現実的。アダプタ SDK＋優先度の高い数面に絞るのが現実解。
- **未確認事項の明示**: OpenClaw の内部詳細は README/org 記載の範囲。プラグイン manifest スキーマ・sandbox 実装詳細は
  実装前に一次情報での再確認が必要。

## 7. 段階導入ロードマップ（不変条件: 各 Phase で「コア無改変」を維持）
- **Phase 1（最小コア）**: (1) 動作プロファイル ＋ (2) 常駐ゲートウェイ ＋ (6) 互換シム。
  → 「常駐パーソナルアシスタントとして使える」状態。
- **Phase 2**: (4) ClawHub 互換 install/pin。→ OpenClaw スキル資産の取り込み。
- **Phase 3**: (5) コード/バンドル・プラグインローダ。→ 動的ツール拡張。
- **Phase 4**: (3) 追加チャネルアダプタ（優先度順）。→ メッセージング面の拡大。

## 8. 結論
**仮説は成立する。** 本アプリは SKILL.md 形式が OpenClaw と一致し、ツール/スキル/MCP/フック/Room/プロバイダの
各レジストリという**動的拡張シーム**を既に備えるため、**コア（agent-loop / provider / security）を改変せず**、
アドオン層と動作プロファイルを足すだけで OpenClaw 相当の主要動作（常駐・多チャネル・スキル取り込み）に寄せられる。
最小の実用互換は **(1) プロファイル ＋ (2) 常駐 ＋ (4) ClawHub 互換** の 3 点で達成でき、コーディング用途と
パーソナルアシスタント用途の**両用**が、安全モデルを維持したまま実現可能である。
完全互換（デバイスメッシュ等）は目指さず「実用互換」を到達目標とするのが現実的。
