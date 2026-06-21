# OpenClaw 互換アドオン 設計書（実現性調査 ＋ 実装設計）

## 0. ステータス・出典
- 状態: **設計書（実現性は検証で確定。アドオン各層を実装着手可能な粒度まで設計）。本書はドキュメントのみ＝コード変更なし**
- 起票: 2026-06-21 / 改訂: 2026-06-21（一次情報調査・コード検証・具体設計を反映）/ 作成: Claude Code
- 比較対象: **OpenClaw**（旧 Clawdbot / Moltbot、MIT、`openclaw.ai`）
- 関連: `docs/autonomy-improvement-proposal.md`、`docs/room-model-design.md`、`docs/slack-integration.md`、`docs/discord-gateway-design.md`
- 不変条件: **コア（`src/agent/agent-loop.ts`／provider 抽象 `src/providers/`／security `src/security/`）を改変しない**。
  すべての新機能は既存の動的シーム（レジストリ／ローダ／サーフェス／設定）へ差し込む。
- 出典:
  - 本アプリ: 後述の `file:line`（実コード検証済み）。
  - OpenClaw: `github.com/openclaw/{openclaw,clawhub}`、`docs.openclaw.ai/{clawhub, clawhub/skill-format, clawhub/cli, tools/skills, gateway/security, start/openclaw}`（一次情報、2026-06-21 取得）。
  - 旧版で「未確認」としていた ClawHub API/認証・プラグイン manifest・サンドボックスは本改訂で一次情報により**確定**。残課題は §7 に限定列挙。

## 1. 背景・目的
ユーザー仮説:
> 「本アプリ（lllmAgents＝Claude Code 型のローカル自律エージェント）の**コアは変えず**に、
> **アドオン的な拡張**を足すことで、OpenClaw と**同等の動作**ができ、**どちらの用途でも使える**のでは？」

本書はこの仮説を、両システムのアーキテクチャ比較と本アプリの実コード検証に基づいて評価し、コア無改変の「アドオン層」を
**実装着手可能な粒度**で設計する。結論を先に述べる:
- **成立する。** SKILL.md 形式の互換性と、本アプリが既に備える動的拡張シーム（11/12 が実在・ランタイム動的、§4）により、
  **コア無改変のアドオン層＋動作プロファイル**で OpenClaw 相当の主要動作（常駐・多チャネル・スキル取り込み）に寄せられる。
- ただしゴールは「**完全互換ではなく実用互換**」。デバイスメッシュや OpenClaw plugin SDK 互換は非現実的でスコープ外（§7）。
- 中心的な前提作業は **skill ローダの YAML パーサ化**（現状パーサは OpenClaw のネスト frontmatter を読めない）。これが全 skill 系機能の真の unblocker（§4・§5-5）。

## 2. 両システムの位置づけ

### 2.1 lllmAgents（本アプリ）
- **形態**: セッション起動型の REPL/CLI コーディング・自律エージェント。`localllm` 起動 → 対話 →（必要なら）常駐サーフェス。
  既存ヘッドレスモードは `--background`（Discord）と `--slack`（`src/index.ts:519,552`）。
- **コア**: 反復ツール実行ループ `src/agent/agent-loop.ts`、CLI フロント `src/cli/repl.ts`。
- **LLM**: ローカル（Ollama/LM Studio/llama.cpp/vLLM）＋クラウド（Anthropic/Azure 各種/Vertex/Gemini/Claude CLI/Claude Agent SDK）を
  `src/providers/provider-factory.ts` で抽象化（12〜14）。
- **ツール**: ファイル I/O・bash・検索・web・ブラウザ・vision・画像生成・サブエージェント等（`src/tools/definitions/`）。
- **拡張**: スキル（`~/.localllm/skills/<name>/SKILL.md`）、MCP、フック、ルール、Room A/B/C。
- **安全**: 3 階層権限（auto/confirm/deny）、sandbox（パス allowlist）、危険コマンド検出、OS コンテナ（bubblewrap/sandbox-exec）。
- **設計思想**: ローカルファースト、安全＝透明性、弱いローカルモデルをハーネスで実用水準へ。

### 2.2 OpenClaw（比較対象）
- **形態**: **常駐デーモン/ゲートウェイ型**のパーソナル AI アシスタント（マスコット = 宇宙ロブスター Molty 🦞）。
  `npm install -g openclaw` → `openclaw onboard --install-daemon` で launchd/systemd 常駐化、`openclaw gateway` で前景デバッグ。
- **自律 heartbeat**: Gateway は**プロンプト無しで自律行動する heartbeat** を持つ（既定 30 分毎、Anthropic OAuth 時 1 時間毎）。
- **マルチチャネル**: WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/IRC/Teams/Matrix/Feishu/LINE/Mattermost/Nostr/WeChat/QQ/WebChat 等 **20+ 面**。
- **スキル**: SKILL.md＋YAML frontmatter。ロードは複数ソース（`<workspace>/skills`、`~/.openclaw/skills` 等）から、**SKILL.md は任意深さ**で発見し、
  ディレクトリ名ではなく frontmatter `name` で命名。注入プロンプトは `AGENTS.md`/`SOUL.md`/`TOOLS.md`。
- **frontmatter（拡張）**: `metadata.openclaw` 配下に `requires.{env,bins,anyBins,config}`・`envVars`・`install`(brew/node/go/uv)・`os`・`always`・`user-invocable`・`command-dispatch` 等。最小は `name`+`description`。
- **ClawHub（レジストリ）**: 公開スキル/プラグインのマーケット。配布は **3 系統** — skill=ZIP、code plugin=npm tarball(ClawPack)、bundle plugin=展開ファイル。
  `clawhub install @openclaw/demo`、`clawhub pin <skill>`、版固定、意味検索。install は cwd の `./skills` に展開し版を `.clawhub/lock.json` に記録。
- **manifest（code plugin）**: npm `package.json` に `openclaw.compat.pluginApi` ＋ `openclaw.build.openclawVersion`（必須）。**OpenClaw plugin SDK/API に依存**。
- **first-class ツール**: browser, canvas, nodes, cron, sessions, Discord/Slack actions。MCP は first-class。
- **エコシステム**: ClawRouter（ルーティング GW）、CrabFleet（fleet 運用）、ClawSweeper（issue/PR トリアージ）、コンパニオンアプリ（Windows Hub/macOS メニューバー/モバイル node メッシュ）。
- **安全**: `agents.defaults.sandbox.mode` ∈ **off(既定=full host)/all/agent/session/shared**（Docker バックエンド）。
  **trusted single-operator モデルで、敵対的マルチテナント境界ではないと明言**。loopback バインド＋bearer token、DM はペアリングコード、グループは mention 必須。
- **LLM**: 多数プロバイダ対応（current flagship を推奨）。

### 2.3 一言で
- lllmAgents = **「開発作業を安全に自律実行するセッション型コーディングエージェント」**。
- OpenClaw = **「自分のデバイスに常駐し、あらゆるチャットから呼べるパーソナルアシスタント基盤＋スキル・マーケット」**。

両者の**コア（LLM 反復ツールループ＋スキル＋MCP）はほぼ同型**で、差は主に**運用形態（常駐・自律 heartbeat・多チャネル・配布/マーケット）**にある。

## 3. 機能差分マトリクス

| 領域 | lllmAgents | OpenClaw | 差分の性質 |
|---|---|---|---|
| スキル形式 | `<root>/skills/<name>/SKILL.md`、フラット frontmatter | SKILL.md 任意深さ、`metadata.openclaw` ネスト frontmatter | **レイアウト/本文は互換、frontmatter 意味論に差**（§5-5） |
| frontmatter パーサ | 行単位 split（ネスト不可、`skill-loader.ts:17-25`） | 本物の YAML | **本アプリ要 YAML 化**（前提作業） |
| ワークスペース注入 | `CLAUDE.md`/`AGENTS.md` 他（`project-context.ts:9-16`、`SOUL.md`/`TOOLS.md` は未対応） | `AGENTS.md`/`SOUL.md`/`TOOLS.md` | **2 ファイル追加で吸収可** |
| MCP | first-class（`src/mcp/mcp-manager.ts`、3 設定ディレクトリ、reload） | first-class（MCP Registry） | 共通 |
| マルチチャネル | Room A/B/C＝REPL/Discord/Slack（`src/agent/room-manager.ts`） | 20+ 面 | **OpenClaw が広い**（アダプタ SDK で拡張、§5-3） |
| 常駐形態 | `--background`/`--slack` の非同期サーフェス | 常駐デーモン/GW（launchd/systemd） | **GW 化で吸収可**（§5-2） |
| 自律 heartbeat | 無し（周期素は `loop/loop-manager.ts` のみ、cron は外部 MCP） | first-class（既定 30 分毎） | **新規 ticker で吸収可**（§5-2/§5-7） |
| スキル配布 | ローカルのみ（手動配置・builtin 同梱） | ClawHub（install/pin/意味検索/版管理） | **本アプリに無い**（§5-4、公開読取で実現性高） |
| コードプラグイン | MCP＋ビルド時ツール登録 | code/bundle plugin（manifest＋ランタイム要件） | bundle は吸収可、**SDK 依存 code plugin は対象外**（§5-6） |
| プロバイダ抽象 | `provider-factory.ts`（12〜14） | ClawRouter | 共通機能、実装形態が違う |
| サブエージェント | task ツール＋サブエージェント | CrabFleet（fleet 運用） | 本アプリは単機内、OpenClaw は運用面 |
| デバイス連携 | なし | コンパニオン＋node メッシュ | **スコープ外（§7）** |
| 安全モデル | 3 階層権限＋sandbox＋危険コマンド検出（既定で厳格） | mode 既定 off=full host、single-operator | **本アプリの方が既定で厳格** |

### OpenClaw 側にあって本アプリに無い/弱い主要 5 点
1. **常駐デーモン/ゲートウェイ＋自律 heartbeat**（always-on＆unprompted）。本アプリはセッション/非同期サーフェス止まり。
2. **大量メッセージング面アダプタ**（Telegram/WhatsApp/Signal/iMessage 等）。本アプリは Discord/Slack のみ。
3. **ClawHub スキル/プラグイン・レジストリ**（install/pin/意味検索/版管理）。本アプリはローカルのみ。
4. **コード/バンドル・プラグイン**（manifest＋ランタイム要件宣言で自動導入）。本アプリは MCP/ビルド時登録のみ。
5. **コンパニオンアプリ/デバイス node メッシュ等の常駐前提機能**。

## 4. 実現性評価（結論: 高い — 実コード検証済み）

「コアを変えずアドオンで両用途」が成立する根拠は、**動的拡張シームが既に実在し、起動時ではなくランタイムで登録/解除できる**こと。
Explore による実コード検証の結果、12 項目中 11 がそのまま使える（残り 1 は新規追加対象）:

| # | シーム | 実体（file:line） | ランタイム動的 |
|---|---|---|---|
| 1 | ツール登録/解除 | `tool-registry.ts:51,59` `register()/unregister()`（MCP が live トグルで実使用） | ✅ |
| 2 | スキル ON/OFF・トリガ解決 | `skill-registry.ts`（global＋個別＋runtime/persistent） | ✅ |
| 3 | スキル多ディレクトリ読込 | `skill-loader.ts:97-113`（`~/.localllm/skills/`＋`.claude/skills/`＋`.localllm/skills/`） | ✅ |
| 4 | MCP ブリッジ＋reload | `mcp-manager.ts:231` `reload()`、即時 enable/disable | ✅ |
| 5 | フック | `hook-manager.ts`（PreToolUse tool スコープ/PostToolUse/SessionStart/Stop） | ✅ |
| 6 | Room＋実行直列化 | `room-types.ts`/`room-run-queue.ts`/`room-manager.ts`（A/B/C 固定・FIFO・borrow-run-return） | ✅ |
| 7 | プロバイダ抽象 | `provider-factory.ts`（12〜14） | n/a |
| 8 | 機能トグル設定 | `config/types.ts:466,473,480,486`（mcp/skills の global＋個別） | ✅ |
| 9 | コア反復ループ | `agent-loop.ts`（無改変対象） | n/a |
| 10 | 受信→実行フロー | `discord/interaction-server.ts:305-336`＝enqueue→runInRoom→agentLoop.run（Slack 同型 `slack-bot.ts:239-287`） | ✅ |
| 11 | 設定 deep-merge | `config-manager.ts:22-58 loadConfig()`（セクション単位マージ＝プロファイル差込口） | n/a |
| 12 | スキル install CLI | **未実装**（`/skills on\|off\|reload\|toggle` のみ） — §5-4 で新設 | — |

加えて重要な検証事実:
- **`package.json` に YAML パーサ依存が無い**（dependencies: `@anthropic-ai/*, @slack/bolt, chalk, glob, inquirer, jimp, marked, marked-terminal, ora, playwright, undici, zod`）。
  skill frontmatter は `line.indexOf(":")` の素朴パーサ（`skill-loader.ts:17-25`）で**ネスト構造を読めない** → OpenClaw skill 取り込みの**最大の前提作業**。
- **組込みスケジューラ/cron が無い**。周期実行の素は `loop/loop-manager.ts`（setInterval＋parseInterval）のみ。
- `AGENTS.md` は `project-context.ts:9-16 INSTRUCTION_FILES` で**既に注入**（`SOUL.md`/`TOOLS.md` は未対応 → 2 行追加で吸収）。
- `PermissionManager` はツール名＋params で自動ゲート → 動的登録ツールも**追加コード無し**で権限制御下に入る。

したがって差分は「サーフェス層・ローダ層・設定層」に閉じており、**コア無改変のアドオン層で OpenClaw 相当の運用に寄せることは現実的**。

## 5. アドオン設計（実装粒度）

各案を「目的 → 接続シーム(実ファイル) → 新インターフェース(概略シグネチャ) → コア無改変の根拠 → 工数/リスク」で記す。
設計原則: **(a) コア無改変**（既存レジストリ/ローダ/サーフェスへ動的登録）、**(b) 設定駆動**（差は「プロファイル」と設定値で表現）、**(c) 安全は緩めない**（assistant でも 3 階層権限・sandbox を既定維持）。

### (1) 動作プロファイル（coding / assistant）— *難度: 低*
- **目的**: 同一バイナリで 2 既定姿勢。`coding`（現状）＝セッション型。`assistant`（OpenClaw 風）＝常駐寄り（autoResume ON・persona 注入・チャネル広め・heartbeat 有効）。
- **接続シーム**: `config/types.ts`（`Config` に `profile?: "coding" | "assistant"`）＋`config-manager.ts:22-58 loadConfig()`。
- **新規**: `src/config/profiles.ts`
  ```ts
  export type ProfileName = "coding" | "assistant";
  export function getProfilePreset(name: ProfileName): Partial<Config>;
  ```
  `loadConfig()` 末尾で、`profile === "assistant"` のとき preset を **ユーザ JSON の下に**レイヤ（ユーザ値が常に勝つ）。
  既存の `mergeToolList`/`mergeRoomConfig` と同一の重ね方で、新機構は持ち込まない。
- **コア無改変の根拠**: プロファイルは `loadConfig` で選ぶ**既定値ソース**にすぎず、`agent-loop`/provider/security は解決済み `Config` のみを見る。persona は既存システムプロンプト経路（§5-7）で注入。
- **工数/リスク**: 低。リスク = 優先順位バグ（preset がユーザ値を上書きしないよう必ず `...parsed` の下に置く）。preset は既存フラグ（`roomConfig.autoResume`、新 `heartbeat`/`gateway` ブロック）に限定し、preset 内で新挙動を発明しない。

### (2) 常駐ゲートウェイ — *難度: 中*
- **目的**: always-on ヘッドレスで (a) サーフェス常時接続、(b) heartbeat で**プロンプト無し**の自律 tick。
- **接続シーム**: `index.ts:519-548`（`--background`）の一般化、`room-run-queue.ts:26 enqueue()` ＋ `room-manager.ts runInRoom`、ticker は `loop/loop-manager.ts`。
- **新規**: `src/gateway/gateway.ts`
  ```ts
  export interface GatewayConfig {
    enabled: boolean; surfaces: Surface[];
    heartbeat?: { intervalMs: number; room: RoomId; prompt: string; onlyWhenIdle: boolean };
    bind?: { host: string; port: number; bearerToken?: string };
  }
  export class Gateway { start(): Promise<void>; stop(): Promise<void>; }
  ```
  - **heartbeat はキューを迂回しない**: tick は `roomQueue.enqueue(() => roomManager.runInRoom(hbRoom, () => agent.run(hbPrompt, {source})))`。
    これで自律 tick が受信トラフィックと同一の単一 AgentLoop 上で直列化される。`onlyWhenIdle` は `roomQueue.pending === 0` を確認してから enqueue。既定 30 分（OpenClaw 準拠）。
  - **OS デーモン化は `scripts/`**: 新 `scripts/install-daemon.js` が systemd unit / launchd plist / Windows Task Scheduler XML を生成し `localllm --gateway` を起動。アプリ本体はプロセス常駐に徹する（`--background` が常駐実績）。
- **コア無改変の根拠**: 現 `--background` と同じく `roomManager`/`roomQueue`/`agent` を組み合わせるだけ。heartbeat は既存 FIFO への別プロデューサ。
- **工数/リスク**: 中。リスク = **自律 tick は安全に敏感**（必ず `PermissionManager` 下／既定は read-only・notify 寄りの prompt、`autorunMode` はユーザ制御のまま）。`onlyWhenIdle` を守らないと対話ターンを枯渇させる。クラッシュ再起動はデーモンスクリプトの責務。

### (3) チャネルアダプタ SDK — *難度: 中*
- **目的**: Discord/Slack 配線を抽象化し、新面（Telegram/Signal 等）をプラグイン化。
- **接続シーム**: `interaction-server.ts:305-336` と `slack-bot.ts:239-287`（両者は enqueue→runInRoom(bindingFor)→agent.run→イベント収集の**同型**）。
- **新規**: `src/channels/channel-adapter.ts`
  ```ts
  export interface InboundMessage { surface: Surface; text: string; userId: string; channelId: string; isDM: boolean; replyContext?: unknown; }
  export interface ChannelAdapter {
    readonly surface: Surface;
    start(): Promise<void>; stop(): Promise<void>;
    onMessage(h: (m: InboundMessage) => void): void;
    sendText(channelId: string, text: string, ctx?: unknown): Promise<void>;
    requestPermission?(req: PermissionRequest): Promise<PermissionDecision>; // 既存権限ブリッジ型を再利用
  }
  ```
  ＋ `src/channels/channel-runner.ts`（Discord/Slack の重複 intake を共通化。既存クラスは改変せず、後から opt-in 可能に）
  ```ts
  export class ChannelRunner { handle(adapter: ChannelAdapter, msg: InboundMessage): { position: number; result: Promise<void> }; }
  ```
  - `room-types.ts` の `Surface` と bindings を拡張。Room A/B/C は固定のまま、新面は既存 Room（例: Room B）へ多重化。
- **コア無改変の根拠**: `ChannelRunner` は `roomQueue`/`roomManager`/`agent` 上の薄いオーケストレーション層（Discord/Slack が今 inline でやっていること）。権限ブリッジ（`interaction-server.ts:490`/`slack-bot.ts:376` 実装）をそのまま再利用。
- **工数/リスク**: 中。リスク = 新面は既存 Room へ多重化するため**チャネル横断の文脈混在**（許容だが要明記）。ストリーミング/進捗 UX（`ChannelProgressTracker`）は最小 IF では抽象化せず、初版は「最終回答のみ」で可。

### (4) ClawHub 互換クライアント — *難度: 低〜中*
- **目的**: `localllm skill install/pin/list/update <ref>`。ClawHub から取得（**公開読取＝認証不要**）→ unzip → frontmatter 写像 → `~/.localllm/skills/<name>/SKILL.md` 配置 → lock 記録。
- **接続シーム**: `skill-loader.ts`（配置先＝既存ロードディレクトリ #1）、`skill-registry.ts`（install 後の live 登録）、REPL コマンド配線。
- **新規**: `src/skills/clawhub-client.ts`
  ```ts
  export interface LockEntry { name: string; version: string; source: string; pinned: boolean; installedAt: string; sha?: string; }
  export class ClawHubClient {
    search(query: string): Promise<ClawHubRef[]>;   // 公開読取
    install(ref: ClawHubRef): Promise<LockEntry>;    // fetch zip → unzip → frontmatter 写像 → 配置
    update(name?: string): Promise<LockEntry[]>;      // pinned はスキップ
    pin(name: string): void; list(): LockEntry[];
  }
  ```
  - 取得は既存 `undici`。**unzip 手段が唯一の新依存**（小型 lib 推奨。Windows での `tar`/`unzip` シェルは互換性リスク）。frontmatter 写像は §5-5 の YAML パーサを呼ぶ。
  - lock は `~/.localllm/skills/.clawhub-lock.json`（OpenClaw `.clawhub/lock.json` の類似物）。
  - **新コマンド 4 点チェックリスト**（`/skills`・`/mcp`・`/room` の前例に倣う）:
    1. REPL 実装: `repl.ts:4418` の `/skills` を拡張し `install|pin|list|update`。成功時は新ディレクトリを読み込み `skillRegistry.register()` で**即時**有効化（現 `/skills reload` は次回起動まで遅延）。
    2. completer: `cli/completer.ts` に追加（`install <ref>` は `needsArg: true`）。
    3. help: help 一覧に追加。
    4. README/docs: skills 節＋必要なら `docs/clawhub-client-design.md`。
- **コア無改変の根拠**: 既存ロードディレクトリへのファイル配置＋registry 登録のみ。loop/provider/security 不変。
- **工数/リスク**: 低〜中。リスク = (a) ClawHub の正確な API 面/ZIP レイアウト/ToS は要再確認 → fetch 層を IF 背後に置き transport 差し替え可に。(b) 意味検索（embeddings/Convex）に不達なら名前一致へ degrade。(c) unzip が唯一の新ランタイム依存。(d) 取り込んだ skill の `requires`/`install` 未充足は**黙って有効化せず**未充足を提示（§5-5）。

### (5) SKILL.md frontmatter interop（核心）— *難度: 中*
- **目的**: OpenClaw skill を実際に読む。彼らの frontmatter は `metadata.openclaw.{requires.*, envVars, install, os, always, user-invocable, command-dispatch}` のネストで、**現パーサでは一切読めない**。
- **接続シーム**: `skill-loader.ts:17-48 parseSkillFile` の frontmatter 解析を置換（`SkillDefinition` の形・ロードフローは維持）。
- **必要作業**:
  1. **YAML パーサ追加**（現状ゼロ）。`yaml` npm 依存を追加推奨（堅牢性が要、素朴パーサが文書化された失敗点）。
  2. `parse(frontmatter)` でオブジェクト化。既存フラットキー（`name/description/trigger/context/tools`）の後方互換を保ったまま `metadata.openclaw` を読む。
  3. `SkillDefinition`（`skill-registry.ts:1-19`）を拡張: `requires?`、`os?`、`always?`、`userInvocable?`、`commandDispatch?`、未写像保存 `openclawRaw?`。
- **フィールド別写像（gap を正確に）**:

  | OpenClaw | lllmAgents の扱い |
  |---|---|
  | `name`, `description` | 直接（既存対応） |
  | trigger/prefix | 直接 → `SkillRegistry` トリガ |
  | `user-invocable` | **honored** → `/trigger` を登録するか否か |
  | `always` | **honored** → 本文をシステムプロンプトへ無条件注入（既存 list()→skillInfos 経路、`index.ts:397`）。要上限キャップ |
  | `os` | **honored・gating** → ロード時に `process.platform` 非該当なら skip |
  | `requires.{env,bins,anyBins,config}` | **honored・前提チェック（advisory）** → env/PATH を検証、未充足は `disableSkill` で理由付き無効化。**auto-install しない** |
  | `install`(brew/node/go/uv) | **v1 は提示のみ・非実行** → 安全姿勢上インストーラ自動実行は不採用 |
  | `envVars` | 部分 honored → code plugin（§5-6）実行時に露出、prompt-only では advisory |
  | `command-dispatch` | parse のみ・v1 advisory（`openclawRaw` に保存） |

- **「skill 形式ほぼ同一」の正直な範囲**: **レイアウトと本文は相互運用可。`metadata.openclaw` の runtime-requirement 意味論は、本アプリが auto-install を持たず安全モデルが厳格なため部分的にしか強制できない。**
- **コア無改変の根拠**: ローダと `SkillDefinition` 型、既存 skill-info 注入（`index.ts`）に限定。loop/provider/security 不変。
- **工数/リスク**: 中（YAML 置換は小、写像＋前提チェックが本体）。リスク = YAML 依存追加／**後方互換**（既存 builtin `src/skills/builtin/*/SKILL.md` が同一に parse されること＝回帰テスト必須）／`always` 注入のプロンプト肥大（要キャップ）。

### (6) コード/バンドルプラグインローダ — *難度: 中（bundle）／高（SDK シム=対象外）*
- **目的**: 第 2 の動的ツール経路。ランタイムにツールを `ToolRegistry.register` で登録するプラグインを読み込み、`PermissionManager` でゲート。
- **接続シーム**: `tool-registry.ts:51,59`（MCP が `mcp-manager.ts:204` で live 使用中）。権限はツール名で自動ゲート。
- **新規**: `src/plugins/plugin-loader.ts`
  ```ts
  export interface PluginHostApi { registerTool(handler: ToolHandler): void; config: Readonly<Config>; }
  export interface LocalPluginModule { register(api: PluginHostApi): void | Promise<void>; }
  export class PluginLoader { loadBundle(dir: string): Promise<string[]>; unloadAll(): void; }
  ```
  - **bundle plugin（展開ファイル）**: manifest＋JS エントリのディレクトリを `import()` し `register(api)` 実行。ツールは `ToolRegistry` に載るので権限ゲート＆loop 可視、loop 改変ゼロ。
  - **OpenClaw code plugin（ClawPack）**: `package.json` に `openclaw.compat.pluginApi`＋`openclaw.build.openclawVersion` 必須＝**OpenClaw plugin SDK 依存**。対応には SDK 面の再実装（シム）が必要 → **高工数・v1 対象外**。
- **推奨**: v1 は **skill＋native bundle** に限定。ClawPack/SDK plugin は需要が出るまで先送り、シムは別大型タスクとして文書化。
- **コア無改変の根拠**: MCP 経路と同型（動的 register、無改変 `PermissionManager` ゲート）。loop はツールの出自を知らない。
- **工数/リスク**: 中（native bundle）／高（SDK シム=対象外）。リスク = bundle plugin は**フル信頼でインプロセス実行**（ツール呼び出しのみ権限ゲート、プラグインコード自体は非サンドボックス）→ プラグイン単位の明示 opt-in と provenance 明示を必須化。

### (7) 互換シム — *難度: 低*
- **`SOUL.md`/`TOOLS.md`**: `project-context.ts:9-16 INSTRUCTION_FILES`（現 `CLAUDE.md`/`AGENTS.md` 等）に 2 ファイル追加。注入経路は不変。assistant プロファイルの persona はここで供給。`loadProjectInstructions` に precedence 定義（`SOUL.md` persona と `CLAUDE.md` の競合順）。
- **cron**: §5-2 の heartbeat ticker を `src/gateway/scheduler.ts` に一般化（`loop-manager.ts` の `parseInterval` 再利用）、各ジョブは `roomQueue` へ enqueue。first-class cron ツールは不要、写像で吸収。
- **MCP**: 既に first-class（`mcp-manager.ts` が 3 設定ディレクトリ読込）。シム＝設定形式マッピングのみ（OpenClaw MCP entry → `mcp-servers.json`）。

### 設計案サマリ表
| 案 | コア改変 | 依存する既存シーム | 概算難度 |
|---|---|---|---|
| (1) 動作プロファイル | 不要 | config-manager / config/types | 低 |
| (2) 常駐ゲートウェイ | 不要 | room-run-queue / room-manager / index(--background) / loop-manager / 配布 scripts | 中 |
| (3) チャネルアダプタ SDK | 不要 | room-types / room-run-queue / 既存権限ブリッジ | 中 |
| (4) ClawHub 互換クライアント | 不要 | skill-loader / skill-registry / repl / completer | 低〜中 |
| (5) SKILL.md interop | 不要 | skill-loader / skill-registry / index(skill 注入) | 中 |
| (6) bundle プラグイン | 不要 | tool-registry / permission-manager | 中（bundle）/ 高（SDK シム=対象外） |
| (7) 互換シム | 不要 | project-context / gateway scheduler / mcp 設定 | 低 |

## 6. 段階導入ロードマップ（不変条件: 各 Phase で「コア無改変」維持）

依存関係（→ は前提）:
```
[P0] (5) YAML パーサ化  ── 全 skill 系の真の unblocker
        └─► (4) ClawHub install/pin ── 実 parser で frontmatter 写像
                 └─► (5) requires/os/always 強制 ── 取り込み後に意味を持つ
[P0] (1) 動作プロファイル（独立）
        └─► (2) 常駐ゲートウェイ（assistant が有効化）
                 └─► (3) チャネルアダプタ SDK（新面が GW に乗る）
[P1] (7) 互換シム（小、(1)/(2) と並行）
[P2] (6) native bundle プラグイン
[P3] (6) OpenClaw SDK plugin シム ── 需要があれば（高工数）
```
- **MVP（実用互換の最小）** = **(1) プロファイル ＋ (2) 常駐 GW ＋ (5) YAML パーサ ＋ (4) ClawHub install**。
  → 「OpenClaw skill を取り込める常駐パーソナルアシスタント」が、安全既定を保ったまま成立。
- **Phase 2**: (5) requires/os/always 強制で取り込み品質を底上げ。
- **Phase 3**: (3) 追加チャネルアダプタ（優先度順）。
- **Phase 4**: (6) native bundle プラグイン。

## 7. リスク・スコープ外・残課題

### 実現不可（目指さない）
- **デバイス/node メッシュ＋コンパニオンアプリ**（Windows Hub/macOS メニューバー/モバイル node）。対応アーキ無し。
- **ClawRouter / CrabFleet / ClawSweeper** 等の独自インフラ。`provider-factory`（ルーティング）と `task` サブエージェント（fleet 近似）で部分代替のみ、互換ではない。
- **OpenClaw plugin SDK（ClawPack code plugin）**。SDK 面の再実装シムが必要で高工数 → 明示的に先送り。
- **`install` auto-installer（brew/node/go/uv）** と **main=full-host 既定**。本アプリの 3 階層権限＋sandbox と衝突するため**不採用**。assistant プロファイルでも安全既定は緩めない。

### 実用互換可（本設計で到達）
- SKILL.md 相互運用（レイアウト/本文は同一、runtime-requirement は部分強制）。
- ClawHub 公開 install/pin/update＋lock 類似物。
- 常駐 always-on ゲートウェイ＋heartbeat（既存 Room キュー上）。
- Discord/Slack intake を一般化したチャネルアダプタ SDK。
- 既存動的 `ToolRegistry` 経路の native bundle プラグイン（権限ゲート付き）。
- AGENTS/SOUL/TOOLS 注入、cron-as-scheduler、MCP 設定写像。

### 残課題（一次情報でも未確定 — 実装前に再確認）
- ClawHub の意味検索バックエンド（OpenAI embeddings＋Convex vector search）の公開エンドポイント仕様・利用規約・レート制限。
- ClawHub skill ZIP の正確な内部レイアウトと code/bundle plugin manifest の完全スキーマ（必須/任意フィールドの境界）。
- OpenClaw `command-dispatch: tool` の実行意味論（v1 は advisory 扱い）。

## 8. 結論
**仮説は成立する（検証により支持）。** 本アプリは SKILL.md のレイアウト/本文が OpenClaw と互換で、ツール/スキル/MCP/フック/Room/プロバイダ/設定の
各シーム（11/12 が実在・ランタイム動的、§4）を備えるため、**コア（agent-loop / provider / security）を改変せず**、
アドオン層と動作プロファイルで OpenClaw 相当の主要動作（常駐・自律 heartbeat・多チャネル・スキル取り込み）に寄せられる。
- **最小の実用互換** = **(1) プロファイル ＋ (2) 常駐 ＋ (5) YAML パーサ ＋ (4) ClawHub install**。コーディング用途とパーソナルアシスタント用途の**両用**が、**安全モデルを維持したまま**実現可能。
- ただし確定した前提として: **skill 取り込みは skill-loader の YAML パーサ化が必須前提**（現パーサはネスト frontmatter を読めない）。
- **code plugin（OpenClaw SDK 依存）は最重・対象外**とし、native bundle に限定する。
- 完全互換（デバイスメッシュ／独自インフラ）は目指さず「**実用互換**」を到達目標とするのが現実的。
