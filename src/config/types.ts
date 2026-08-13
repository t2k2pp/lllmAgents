import { getDefaultRoomConfig } from "../agent/room-types.js";
import type { RoomConfig } from "../agent/room-types.js";
export type { RoomConfig } from "../agent/room-types.js";

export type ProviderType = "ollama" | "lmstudio" | "llamacpp" | "vllm";

export type CloudProviderType =
  | "vertex-ai"
  | "azure-openai"
  | "azure-gpt"
  | "azure-claude"
  | "azure-foundry"
  | "azure-anthropic"
  /** Anthropic Messages API (api.anthropic.com) を直接叩く。 ANTHROPIC_API_KEY 必須 */
  | "anthropic"
  /** ローカルにインストールされた Claude Code CLI (`claude -p`) をサブプロセスで呼ぶ */
  | "claude-cli"
  /** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) を in-process で使う。 claude login 済みセッション継承 (API キー不要)、 lllmAgent ツールを MCP 経由で公開してネイティブ tool_use を成立させる */
  | "claude-agent-sdk"
  /** Google AI Studio の Gemini API (generativelanguage.googleapis.com)。 GEMINI_API_KEY 1 個で Gemini 2.5 Pro/Flash 等を呼べる軽量ルート。 vertex-ai が GCP プロジェクト経由なのに対し、 こちらは個人開発者向けの直叩き API */
  | "gemini";

// セカンドLLMはローカルまたはクラウドのいずれかを指定可能
export type SecondLLMProviderType = ProviderType | CloudProviderType;

export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
}

export interface LLMEndpoint extends SamplingParams {
  /** ローカル系 (ollama/lmstudio/llamacpp/vllm) またはクラウド系 (vertex-ai/azure-*) */
  providerType: SecondLLMProviderType;
  /** ローカル系で必須。クラウド系では未使用 */
  baseUrl?: string;
  model: string;
  contextWindow?: number;
  // ── クラウド用フィールド (providerType がクラウド系の時に必須) ──
  /** Vertex AI: GCP プロジェクト ID */
  projectId?: string;
  /** Vertex AI: GCP リージョン */
  region?: string;
  /** Azure: リソース endpoint (https://...) */
  endpoint?: string;
  /** Azure: API Key (env:VAR / encrypted:... / 平文) */
  apiKey?: string;
  /** Azure OpenAI / Azure Claude: deployment name (Foundry では未使用) */
  deploymentName?: string;
  /** モデル特性の自由記述 (100〜300文字程度)。サブ/セカンドエージェント選択の判断材料としてシステムプロンプトに注入される */
  description?: string;
}

/**
 * セカンドLLMのエンドポイント設定。
 * メインLLM (LLMEndpoint) と完全に同一仕様。 サンプリングパラメータも保持できる。
 * これにより /swap (メイン⇔セカンド入替) で情報が欠落しない。
 */
export type SecondLLMEndpoint = LLMEndpoint;

export interface BudgetConfig {
  limitUsd: number; // 予算上限 (USD)
  warningThreshold: number; // 警告閾値 (0.0〜1.0、デフォルト0.8)
  stopThreshold: number; // 停止閾値 (0.0〜1.0、デフォルト0.95)
}

export interface CostConfig {
  referenceModels: string[]; // ローカルLLM利用時の参考コスト比較対象
}

/**
 * セカンドLLM の用途別サンプリング既定値 (D9: 2026-04-30 決定)。
 * `endpoint.temperature` 等が指定されていればそちらが優先。 ここが未指定なら
 * SecondLLMManager 内のハードコード fallback (consult/agent=0.2 / evaluator=0.1) が効く。
 */
export interface SecondLLMSamplingDefaults {
  /** consult (単発相談) 用の既定温度 */
  consultTemperature?: number;
  /** runAsAgent (タスク委任) 用の既定温度 */
  agentTemperature?: number;
  /** runAsEvaluator (成果物レビュー) 用の既定温度 */
  evaluatorTemperature?: number;
}

/**
 * セカンドLLM のループ上限 (ID-021: 2026-04-30 設定化)。
 * 既定値: agent=15 / evaluator=10。 増やすと「セカンドが試行錯誤に陥る」 リスク。
 */
export interface SecondLLMIterationLimits {
  /** runAsAgent のツール呼出ループ上限 */
  maxAgentIterations?: number;
  /** runAsEvaluator のツール呼出ループ上限 */
  maxEvaluatorIterations?: number;
}

export interface SecondLLMConfig {
  enabled: boolean;
  endpoint: SecondLLMEndpoint;
  budget: BudgetConfig | null; // ローカルLLMの場合は null（予算不要）
  cost: CostConfig;
  /** 用途別サンプリング既定値 (D9)。 endpoint.temperature が指定されていればそちら優先 */
  samplingDefaults?: SecondLLMSamplingDefaults;
  /** ループ上限の上書き (ID-021)。 未指定なら既定値 (agent=15/evaluator=10) */
  iterationLimits?: SecondLLMIterationLimits;
}

export interface SecurityRuleConfig {
  /** 自動許可するパターンルール例: "bash(npm *)", "file_write(./src/**)" */
  allow: string[];
  /** 常に拒否するパターンルール例: "bash(rm -rf *)" */
  deny: string[];
  /** 常に確認するパターンルール例: "bash(git push *)" */
  ask: string[];
}

export interface ProcessSandboxConfig {
  /** OS-level サンドボックスを有効にするか（デフォルト: false） */
  enabled: boolean;
  /**
   * サンドボックスレベル（FS書込とネットワークの2軸。docs/wsl-sandbox-design.md §7）:
   * - "none"    : OS-level 隔離なし（アプリレベルのみ）
   * - "fs"      : ファイルシステム書込のみ隔離・ネットワークは許可（npm/pip 等を止めない開発向け）
   * - "network" : ネットワーク名前空間隔離のみ（Linux: unshare --net, macOS: sandbox-exec で network deny）
   * - "full"    : ネットワーク + ファイルシステム隔離（Linux: bwrap, macOS: sandbox-exec）
   */
  level: "none" | "fs" | "network" | "full";
  /**
   * ネット allowlist（Phase 2b）。 fs レベルでプロキシ経由通信を許可するドメイン群。
   * `*.example.com` ワイルドカード可。 三状態に注意（resolveAllowedDomains）:
   *   - 省略(undefined) → 既定プリセット（npm/pip/GitHub 等）を使う
   *   - [](空配列)      → 全ドメイン不許可（既定に戻さない。 意図的な全閉じ）
   *   - 指定           → その配列のみ
   */
  allowedHosts?: string[];
  /**
   * Phase 3: 封じ込め（macOS fs + proxy 強制）時に bash 実行確認を自動許可するか（既定 ON）。
   * 破壊的コマンド・CWD 外参照・allowlist 外通信は引き続き確認する。false で封じ込めは
   * 維持しつつ自動許可だけ無効化（docs/wsl-sandbox-design.md §7.2）。
   */
  autoAllowBashWhenContained?: boolean;
}

export interface SecurityConfig {
  allowedDirectories: string[];
  blockedCommands: string[];
  autoApproveTools: string[];
  requireApprovalTools: string[];
  /** Discord経由のリクエストで自動許可するツール（インタラクティブ確認なし） */
  discordAutoApproveTools: string[];
  /** Slack経由のリクエストで自動許可するツール（インタラクティブ確認なし） */
  slackAutoApproveTools: string[];
  /**
   * 背景サーフェス(Discord/Slack)の autorun (docs/async-surface-permission-delivery-design.md 5.3)。
   * 非同期面では人が15分以内に確認できず、同期ボタン確認(失効 interaction token で必ず401)が
   * 成立しない。 true: deny/サンドボックス/危険コマンドの安全ガードを通過したツールを自動許可。
   * false: 従来のブリッジ確認に退避(対話可能な環境向け。 既定は未指定=true)。
   */
  discordAutorun?: boolean;
  slackAutorun?: boolean;
  /** Claude Code 互換のパターンベース権限ルール（ツール名リストより優先） */
  rules?: SecurityRuleConfig;
  streamCommandOutput?: boolean;
  /** OS-level プロセスサンドボックス設定（bash ツール実行に適用） */
  processSandbox?: ProcessSandboxConfig;
}

/**
 * コンテキスト縮約の手段 (docs/context-forgetting.md §6)。
 *  - compress: 従来通り常に要約圧縮
 *  - forget: 常に忘却。 忘却が失敗したらその回だけ圧縮にフォールバック
 *  - hybrid (既定): まず忘却を試し、 削減が目標の 60% に届かなければ続けて圧縮
 */
export type ReductionMode = "compress" | "forget" | "hybrid";

/** 忘却機能の詳細設定 (docs/context-forgetting.md §4 / §6.1 / §10) */
export interface ForgettingConfig {
  /** 直近何セグメントを忘却対象外にするか (既定 6) */
  keepRecentSegments?: number;
  /** 目標削減量を閾値の何ポイント下に置くか (既定 0.15 = 15 ポイント) */
  targetMarginRatio?: number;
  /** hybrid で圧縮まで続行するかの判定比 (目標に対する達成率、 既定 0.6) */
  sufficiencyRatio?: number;
  /** 自動忘却の最短間隔 (ターン数、 既定 3)。 毎ターン忘却が走るのを防ぐ */
  minIntervalTurns?: number;
}

export interface ContextConfig {
  compressionThreshold: number;
  maxHistoryMessages: number;
  /** 縮約手段。 未設定なら "hybrid" (docs/context-forgetting.md §6) */
  reduction?: ReductionMode;
  /** 忘却機能の詳細設定 */
  forgetting?: ForgettingConfig;
}

/**
 * 待機リスト1件。 未許可ユーザーがチャネル経由でアクセスした際に記録される。
 * id は Discord の数値ユーザー ID (snowflake)。 username は表示確認用 (承認時の取り違え防止)。
 */
export interface PendingUser {
  id: string;
  username?: string;
  /** 最初にアクセスした ISO 時刻 */
  firstSeen: string;
  /** 直近のアクセス ISO 時刻 */
  lastSeen: string;
  /** アクセス試行回数 */
  attempts: number;
}

export interface DiscordConfig {
  enabled: boolean;
  webhookUrl: string;
  // Slash Command 受信用 (Discord Developer Portal で取得)
  applicationId?: string;
  publicKey?: string; // [未使用] 旧 Endpoint 方式の署名検証用。 Gateway 方式移行で不要 (後方互換のため型に残す)
  botToken?: string; // Bot トークン (Gateway 接続・コマンド登録・follow-up 送信)
  interactionPort?: number; // [未使用] 旧 Endpoint 方式の HTTP ポート。 Gateway 方式移行で不要 (後方互換のため型に残す)
  listenEnabled?: boolean; // 起動時に受信 (Gateway 接続) を自動開始するか
  /** コマンド・確認ボタンを受け付けるユーザー ID。 未設定/空 = 全員拒否 (fail-closed, proposal §6)。 利用には設定が必須 */
  allowedUserIds?: string[];
  /**
   * 未許可ユーザーが /ask を試みた際に自動で記録される待機リスト。
   * REPL の /integrations Discord メニュー or `/discord approve <ID>` で allowedUserIds へ移す。
   * 許可リストへの手入力 (数値 ID のタイプミスが起きやすい) を不要にするための仕組み。
   */
  pendingUsers?: PendingUser[];
  /** 権限確認ボタンのタイムアウト秒 (デフォルト 300。 ask_user はこの 2 倍) */
  interactionTimeoutSec?: number;
  /**
   * image_generate で生成した画像を webhook に自動添付するか (既定 true)。
   * false で添付を無効化 (テキスト通知は従来どおり)。docs/image-generation.md
   */
  attachGeneratedImages?: boolean;
  /**
   * 添付画像の目標サイズ上限 (MB、既定 8)。これを超える画像はコードで自動縮小してから
   * 添付する (オリジナルは無加工)。Discord のアップロード上限はサーバの boost で変わるため、
   * 安全側の既定値を採用している。
   */
  maxAttachmentMb?: number;
}

export interface SlackConfig {
  enabled: boolean; // Webhook通知の有効/無効
  webhookUrl: string; // 通知用Incoming Webhook URL
  botToken?: string; // xoxb- Bot Token (Bolt用)
  appToken?: string; // xapp- App-Level Token (Socket Mode用)
  /** メッセージ・確認ボタンを受け付けるユーザー ID。 未設定/空 = 全員拒否 (fail-closed, proposal §6)。 利用には設定が必須 */
  allowedUserIds?: string[];
  /** 権限確認ボタンのタイムアウト秒 (デフォルト 300。 ask_user はこの 2 倍) */
  interactionTimeoutSec?: number;
}

export interface NotificationsConfig {
  /**
   * この秒数未満で完了したタスクは webhook 完了通知を送らない (デフォルト 0 = 常に送る)。
   * 長時間タスクの完了だけ知りたい場合に設定する (例: 60)。
   */
  minDurationSec?: number;
}

export interface SearchConfig {
  /** 検索プロバイダー: "duckduckgo" (デフォルト) | "searxng" */
  provider: "duckduckgo" | "searxng";
  /** SearXNG の JSON API エンドポイント (例: "http://localhost:8888") */
  searxngUrl?: string;
}

export interface ObsidianConfig {
  /** Obsidian Vault の絶対パス */
  vaultPath: string;
  /** ナレッジノートの保存先ディレクトリ (vault相対、デフォルト: "Knowledge") */
  knowledgeDir?: string;
  /** 全ノートに自動付与するタグ (デフォルト: ["lllmagents"]) */
  defaultTags?: string[];
}

export interface ChatLogConfig {
  /** チャットログ保存の有効/無効 */
  enabled: boolean;
  /** 保存先 Obsidian Vault の絶対パス（ナレッジ用vaultとは別指定可） */
  vaultPath: string;
}

/** 運用ログ (人間がトレースする用)。詳細: docs/llm-logging.md */
export interface OpsLogConfig {
  /** 運用ログを書き出すか（デフォルト: true） */
  enabled: boolean;
  /** 出力レベル。 trace/debug/info/warn/error。 設定値以上のレコードのみ記録 */
  level: "trace" | "debug" | "info" | "warn" | "error";
  /** 出力先。 未指定なら ~/.localllm/logs/ops/<sid>.jsonl */
  path?: string;
}

/**
 * ログ・セッションの世代管理 (docs/production-readiness.md PR-15)。
 * 起動時に一度だけ適用する。削除時は件数を1行表示する (黙って消さない)。
 */
export interface LogRetentionConfig {
  /** ops / LLM I/O ログの保持日数。0 で無制限。既定 30 */
  logMaxAgeDays?: number;
  /** セッション JSON の保持件数 (新しい順)。0 で無制限。既定 100 */
  sessionMaxCount?: number;
}

export interface LoggingConfig {
  /** 運用ログ設定 */
  ops?: OpsLogConfig;
  /** ログ・セッションの世代管理 (PR-15) */
  retention?: LogRetentionConfig;
}

/**
 * 能力ティアのユーザ override (Phase A-5)。 capability-tier.ts の
 * CapabilityOverride と同形だが、 config.json から読むので JSON-friendly な型のみ。
 *
 * 使い方 (config.json):
 *   "modelCapabilities": {
 *     "my-custom-llama-fine-tune": { "tier": "T3", "contextWindow": 8192 },
 *     "qwen3.6-35b-a3b-special": { "tier": "T1", "promptStyle": "concise" }
 *   }
 */
export interface ModelCapabilityOverride {
  tier?: "T1" | "T2" | "T3";
  contextWindow?: number;
  promptStyle?: "concise" | "standard" | "verbose+examples";
  supportsToolCalling?: "native" | "json-mode" | "regex-fallback";
  supportsParallelTools?: boolean;
  reliableInstructionFollowing?: boolean;
}

/**
 * Model Registry: 接続設定の登録一覧。 docs/model-registry.md §2.1
 *
 * LLMProfile (旧) を一般化し、 サンプリング違いのバリアントを別エントリで持てるよう
 * ID を UUID 化したもの。 既存 LLMProfile は本型の alias。
 */
export interface LLMRegistryEntry {
  /** 安定 ID (UUID v4 新規 / 旧データから移行された場合は 8 文字 hex のまま) */
  id: string;
  /** 表示名。 初期値は generateEntryName で自動生成、 後から user 編集可能 */
  name: string;
  /** 接続情報 + サンプリングパラメータ */
  endpoint: LLMEndpoint;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601。 並び替えキー */
  lastUsedAt: string;
  /** 任意タグ (将来: グループ・絞り込み用) */
  tags?: string[];
}

/**
 * 現在の slot 割当。 main / second は型に直書きで互換維持、 named は任意拡張用。
 * docs/model-registry.md §2.3
 */
export interface LLMSlotAssignments {
  /** main slot に居る registry entry の id (空文字なら未割当) */
  main: string;
  /** second slot に居る registry entry の id */
  second?: string;
  /** 任意名前付きスロット (third / vision / eval / cheap 等)。 Phase 4 で UI 追加予定 */
  named?: Record<string, string>;
}

/** model-registry.json の永続化形式。 docs/model-registry.md §3 */
export interface ModelRegistryStore {
  version: 1;
  entries: LLMRegistryEntry[];
  slots: LLMSlotAssignments;
}

/**
 * 機能トグル。環境依存のケイパビリティを強制制御する。
 * docs/exe-playwright-externalization.md §B（capability ゲート）
 */
export interface FeaturesConfig {
  /**
   * ブラウザ機能 (browser_* / game_smoke) の有効化方針。
   * - "auto"(既定): 起動時プローブで playwright+chromium が揃っていれば有効。
   * - "off": 常に無効（ツール非登録）。エージェントは試行しない。
   * - "on": プローブ結果に関わらず登録（デバッグ用。未準備なら実行時に誘導エラー）。
   */
  browser?: "auto" | "on" | "off";
  /**
   * プロンプトキャッシュ (コスト削減)。 docs/prompt-cache-cost-reduction.md
   * Anthropic 系プロバイダ (anthropic / azure-anthropic) で system+tools と会話履歴に
   * cache_control を付与し、 入力課金を読込分 0.1× に下げる。 GPT/Gemini は自動キャッシュ
   * のため本フラグに関係なく安定プレフィクス化の恩恵を受ける (cache_control 不要)。
   * - enabled(既定 true): cache_control を付与する。 false で従来どおり無印。
   * - ttl(既定 "5m"): ephemeral キャッシュの TTL。 長く間欠的なセッションは "1h" を選べる
   *   (書込 2× だが TTL が長い)。
   */
  promptCache?: {
    enabled?: boolean;
    ttl?: "5m" | "1h";
  };
}

/**
 * 画像生成バックエンドの種別。設計: docs/image-generation.md
 * - "azure-image": Azure OpenAI images/generations (gpt-image-1 系 / gpt-image-2)
 * - "sd-webui":    Stable Diffusion WebUI (AUTOMATIC1111) /sdapi/v1/txt2img
 * - "comfyui":     ComfyUI /prompt + /history ポーリング (テンプレートワークフロー方式)
 */
export type ImageProviderType = "azure-image" | "sd-webui" | "comfyui";

/** 画像生成プロファイル (登録単位)。docs/image-generation.md §3 */
export interface ImageGenProfile {
  /** 一意な表示名 (= /image use の引数) */
  name: string;
  providerType: ImageProviderType;
  /** azure-image: リソース base URL (normalizeEndpoint 適用) */
  endpoint?: string;
  /** azure-image: API Key (env:VAR / encrypted:... / 平文) */
  apiKey?: string;
  /** azure-image: deployment 名 (例: gpt-image-2) */
  model?: string;
  /** sd-webui / comfyui: 例 http://localhost:7860 / http://localhost:8188 */
  baseUrl?: string;
  /** comfyui: テンプレートワークフロー JSON の絶対パス。未指定で組み込み txt2img */
  workflowTemplate?: string | null;
  /** comfyui: 組み込みテンプレートの CheckpointLoaderSimple に注入する checkpoint 名 */
  checkpoint?: string;
  /** ツールパラメータ未指定時の既定サイズ "WxH" (既定 "1024x1024") */
  defaultSize?: string;
  /** azure-image: 既定品質 (既定 "medium"。high は 1024x1024 で $0.21/枚と高額なため) */
  defaultQuality?: "low" | "medium" | "high";
  /** sd-webui / comfyui: 既定 negative prompt */
  negativePrompt?: string;
  /** sd-webui / comfyui: サンプリングステップ数 (既定 25) */
  steps?: number;
}

/** 画像生成機能の設定。docs/image-generation.md */
export interface ImageGenConfig {
  /** 機能トグル。false ならツール非登録 (browser ゲートと同型) */
  enabled: boolean;
  /** アクティブな profile の name (1つだけアクティブ) */
  active?: string;
  profiles: ImageGenProfile[];
}

export interface Config {
  mainLLM: LLMEndpoint;
  visionLLM: LLMEndpoint | null;
  secondLLM: SecondLLMConfig | null;
  security: SecurityConfig;
  context: ContextConfig;
  discord?: DiscordConfig;
  slack?: SlackConfig;
  /** 完了通知の共通設定 (A-6: docs/task-report-notification-design.md) */
  notifications?: NotificationsConfig;
  /** Goal Seek 関連 (B-1: docs/goal-promotion-design.md) */
  goalSeek?: {
    /** 複雑なタスクで Goal Seek 昇格を自動提案する (デフォルト true) */
    autoPropose?: boolean;
  };
  /** Web検索設定 */
  search?: SearchConfig;
  /** Obsidian Vault 連携 (ナレッジベース) */
  obsidian?: ObsidianConfig;
  /** 機能トグル (環境依存ケイパビリティの強制制御) */
  features?: FeaturesConfig;
  /** 画像生成機能 (Azure GPT Images / SD WebUI / ComfyUI)。docs/image-generation.md */
  imageGen?: ImageGenConfig;
  /** true: テキストをリアルタイムにストリーミング表示。false(デフォルト): スピナー+完了後Markdownレンダリング */
  streamingDisplay?: boolean;
  /**
   * コスト表示の日本円換算レート (1ドルあたりの円)。未設定ならドルのみ表示。
   * 設定すると /cost 表示やセッション終了サマリのコストが円のみ表示に切り替わる。
   * REPL `/cost rate <数値>` で設定、`/cost rate off` でリセット。
   */
  jpyPerUsd?: number;
  /** ツールの最大並列実行数（デフォルト: 3）。vLLM KVキャッシュやリソースに合わせて調整 */
  maxParallelTools?: number;
  /** 自律実行モード（再起動後も維持） */
  autorunMode?: boolean;
  /**
   * opt-in 入力圧縮モード（再起動後も維持。既定 false）。
   * ON のとき、project指示/メモが tier別閾値を超えたら起動時に一度だけ意図保持圧縮しキャッシュ。
   * 縮まなければ原文を使い、原文は常に保持する。詳細: docs/input-compression-design.md
   */
  inputCompression?: boolean;
  /** チャットログ保存設定（Obsidian Vault に会話ログを蓄積） */
  chatLog?: ChatLogConfig;
  /** ログ設定 (運用ログ等)。詳細: docs/llm-logging.md */
  logging?: LoggingConfig;
  /**
   * 起動時の更新チェック (docs/production-readiness.md PR-14)。
   * GitHub の最新リリースタグを非同期で確認し、新しければ1行通知する。
   * 対話セッション (TTY) のみ実行、失敗は黙ってスキップ。enabled: false でオフ (既定 on)
   */
  updateCheck?: { enabled?: boolean };
  /**
   * モデル別の能力ティア override (Phase A-5)。
   * fine-tune 等で自動判定が誤る場合に modelId をキーに上書きできる。
   * 詳細: docs/multi-tier-harness-roadmap.md §3.3
   */
  modelCapabilities?: Record<string, ModelCapabilityOverride>;
  /**
   * Phase F-1b: MCP サーバー全体の ON/OFF。
   * - 未指定 (undefined) または true → mcp-servers.json を読んで接続 (既存挙動)
   * - false → 設定があっても接続スキップ (= 一時的に MCP を切りたいとき)
   * 起動時の --no-mcp フラグでも同等。 REPL /mcp on /off で動的切替可能。
   * REPL で切替した結果はここに保存され、 再起動後も維持される。
   */
  mcpEnabled?: boolean;
  /**
   * Phase F (MCP per-server persistent skip): REPL /mcp toggle で外したサーバの永続リスト。
   * mcp-servers.json の `disabled: true` とは独立 (= mcp-servers.json は user/admin 編集、
   * こちらは REPL からの動的操作の永続化先)。 起動時に読み出して mcpManager.disableServer
   * へ流し込む。 サーバ name (mcp-servers.json の name フィールド) で識別。
   */
  disabledMcpServers?: string[];
  /**
   * Phase F (Skills ON/OFF): スキル機能全体の ON/OFF。
   * - 未指定 (undefined) または true → ~/.localllm/skills/ から全部ロード (既存挙動)
   * - false → ロードはするが registry 層で無効化 (= 中級者が一時 OFF)
   * 起動時 --no-skills フラグや REPL /skills on /off で切替。
   */
  skillsEnabled?: boolean;
  /**
   * Phase F (Skills ON/OFF): 永続的にスキップするスキル名のリスト (= ファイル削除なし)。
   * 各 skill の `name` フィールドで指定。 REPL /skills toggle <name> で動的に追加削除可能。
   * 将来的にグループ単位の指定も検討 (例: { groups: ["dev"], skills: ["foo"] })。
   */
  disabledSkills?: string[];
  /**
   * 自動チェックポイント (シャドウ Git)。 docs/checkpoint-and-smoke-design.md §4。
   * 既定 OFF のオプトイン。 REPL `/checkpoint on|off` で切替し、 結果はここに永続化。
   */
  checkpoints?: CheckpointConfig;
  /**
   * Room モデル設定 (docs/room-model-design.md)。 サーフェス→既定 Room の binding と
   * Room ごとの自動 Resume。 未指定なら getDefaultRoomConfig() (REPL=A/Discord=B/Slack=C)。
   * REPL/Discord/Slack の `/room` 操作結果はここに永続化される。
   */
  roomConfig?: RoomConfig;
}

export interface CheckpointConfig {
  /**
   * true で file_write/file_edit 後にシャドウ Git へ自動コミット。
   * 未設定時の既定は「成果物フォルダ (sandbox/output 等) にスコープ解決できた時のみ ON」。
   * cwd 全体 (開発リポジトリ等) になる場合は OFF。 明示設定すればその値が優先。
   */
  enabled?: boolean;
  /**
   * 版管理する作業フォルダ (work-tree)。 cwd 相対 or 絶対。
   * 未指定なら `<cwd>/sandbox/output` があればそこ、 無ければ cwd。
   * 成果物フォルダに限定して src/ や機密の巻き込みを避ける用途。
   */
  workTreeDir?: string;
  /** これを超えるファイルはチェックポイント対象から外す (MB)。 既定 25。 0 で無制限 */
  maxFileSizeMb?: number;
  /**
   * 古いセッションのチェックポイントを自動掃除する保持ポリシー (セッション開始時に適用)。
   * 1 年前・100 セッション前のスナップショットを溜め込まないための上限。 数字は好みで調整。
   */
  retention?: {
    /** 保持する最大セッション数 (新しい順)。 0 で無制限。 既定 20 */
    maxSessions?: number;
    /** この日数より古いセッションは削除。 0 で無制限。 既定 60 */
    maxAgeDays?: number;
  };
}

// ヘルパー: セカンドLLMがクラウドかローカルかを判定
export function isCloudProvider(type: SecondLLMProviderType): boolean {
  return (
    [
      "vertex-ai",
      "azure-openai",
      "azure-gpt",
      "azure-claude",
      "azure-foundry",
      "azure-anthropic",
      "anthropic",
      "claude-cli",
      "claude-agent-sdk",
      "gemini",
    ] as string[]
  ).includes(type);
}

/**
 * Claude (Anthropic) モデルのハードコード一覧。
 * `anthropic` (直接 API) / `claude-cli` (CLI ラッパー) 両プロバイダで /model list の選択肢として使う。
 *
 * 動的取得 (api.anthropic.com/v1/models) ではなく固定リストを採用している理由:
 * - claude-cli はオフライン (API キー不要) でモデル切替できるべき
 * - 主要モデルは数個に集約されており、API 失敗時の UX を単純化したい
 * - alias (`opus` / `sonnet` / `haiku`) も同時に登録できる
 */
export interface ClaudeModelEntry {
  id: string;
  label: string;
  contextWindow: number;
  /** CLI で `claude --model <alias>` に渡せる短縮名 (なければ id をそのまま使う) */
  cliAlias?: string;
}
export const CLAUDE_MODELS: readonly ClaudeModelEntry[] = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", contextWindow: 200_000, cliAlias: "opus" },
  { id: "claude-opus-4-7[1m]", label: "Claude Opus 4.7 (1M context)", contextWindow: 1_000_000 },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", contextWindow: 1_000_000, cliAlias: "sonnet" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000, cliAlias: "haiku" },
];

export interface ModelInfo {
  name: string;
  size: number;
  contextLength: number;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
  digest?: string;
  family?: string;
}

export interface ModelDetail extends ModelInfo {
  parameterSize?: string;
  quantizationLevel?: string;
  format?: string;
}

/**
 * 人間可読なトークン数表記をパースする。
 * "128k" → 128000, "256K" → 256000, "1m" → 1000000, "4096" → 4096
 * パース不能なら NaN を返す。
 */
export function parseTokenCount(input: string): number {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
  if (!match) return NaN;
  const num = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === "k") return Math.round(num * 1000);
  if (suffix === "m") return Math.round(num * 1000000);
  return Math.round(num);
}

export const DEFAULT_PORTS: Record<ProviderType, number> = {
  ollama: 11434,
  lmstudio: 1234,
  llamacpp: 8080,
  vllm: 8000,
};

export const PROVIDER_LABELS: Record<SecondLLMProviderType, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  vllm: "vLLM",
  "vertex-ai": "Vertex AI",
  "azure-openai": "Azure OpenAI (Chat Completions)",
  "azure-gpt": "Azure OpenAI (Responses API)",
  "azure-claude": "Azure Claude",
  "azure-foundry": "Azure AI Foundry",
  "azure-anthropic": "Azure Anthropic (Messages API)",
  anthropic: "Anthropic API (Claude direct)",
  "claude-cli": "Claude Code CLI (claude -p)",
  "claude-agent-sdk": "Claude Agent SDK (in-process)",
  gemini: "Google AI Studio (Gemini)",
};

/**
 * Google AI Studio (Gemini API) のモデルハードコード一覧。
 * `gemini` プロバイダの /model list / /model setup gemini で選択肢として使う。
 * 動的取得 (generativelanguage.googleapis.com/v1beta/openai/models) もフォールバック可能だが、
 * 主要モデルはここに固定で持ち、 オフラインでも切替できるようにする。
 */
export interface GeminiModelEntry {
  id: string;
  label: string;
  contextWindow: number;
  supportsVision: boolean;
  supportsTool: boolean;
}
export const GEMINI_MODELS: readonly GeminiModelEntry[] = [
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", contextWindow: 1_048_576, supportsVision: true, supportsTool: true },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    contextWindow: 1_048_576,
    supportsVision: true,
    supportsTool: true,
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    contextWindow: 1_048_576,
    supportsVision: true,
    supportsTool: true,
  },
  {
    id: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    contextWindow: 1_048_576,
    supportsVision: true,
    supportsTool: true,
  },
  {
    id: "gemini-2.0-flash-lite",
    label: "Gemini 2.0 Flash Lite",
    contextWindow: 1_048_576,
    supportsVision: true,
    supportsTool: true,
  },
];

export function getDefaultConfig(): Config {
  return {
    mainLLM: {
      providerType: "ollama",
      baseUrl: "http://localhost:11434",
      model: "",
    },
    visionLLM: null,
    secondLLM: null,
    security: {
      allowedDirectories: [],
      blockedCommands: [],
      autoApproveTools: [
        "file_read",
        "glob",
        "grep",
        "browser_snapshot",
        "vision_analyze",
        "ask_user",
        "todo_write",
        "enter_plan_mode",
        "exit_plan_mode",
        "task_output",
        "web_search",
        "web_fetch",
      ],
      requireApprovalTools: ["file_write", "file_edit", "bash", "browser_navigate", "browser_click", "browser_type"],
      discordAutoApproveTools: [
        "file_read",
        "glob",
        "grep",
        "web_search",
        "web_fetch",
        "browser_snapshot",
        "vision_analyze",
        "current_datetime",
        "sandbox_info",
      ],
      slackAutoApproveTools: [
        "file_read",
        "glob",
        "grep",
        "web_search",
        "web_fetch",
        "browser_snapshot",
        "vision_analyze",
        "current_datetime",
        "sandbox_info",
      ],
      rules: {
        allow: [],
        deny: [],
        ask: [],
      },
      streamCommandOutput: true,
    },
    context: {
      compressionThreshold: 0.8,
      maxHistoryMessages: 100,
      // docs/context-forgetting.md §6 — 既定は hybrid。 忘却が失敗しても圧縮に落ちるので
      // 最悪でも従来と同じ動作になる。 従来動作に固定したい場合は /forget mode compress
      reduction: "hybrid",
    },
    discord: {
      enabled: false,
      webhookUrl: "",
      listenEnabled: false,
    },
    slack: {
      enabled: false,
      webhookUrl: "",
    },
    logging: {
      ops: {
        enabled: true,
        level: "info",
      },
    },
    roomConfig: getDefaultRoomConfig(),
  };
}
