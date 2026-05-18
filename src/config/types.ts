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
  | "claude-cli";

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
  limitUsd: number;          // 予算上限 (USD)
  warningThreshold: number;  // 警告閾値 (0.0〜1.0、デフォルト0.8)
  stopThreshold: number;     // 停止閾値 (0.0〜1.0、デフォルト0.95)
}

export interface CostConfig {
  referenceModels: string[];  // ローカルLLM利用時の参考コスト比較対象
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
  budget: BudgetConfig | null;  // ローカルLLMの場合は null（予算不要）
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
   * サンドボックスレベル:
   * - "none"    : OS-level 隔離なし（アプリレベルのみ）
   * - "network" : ネットワーク名前空間隔離（Linux: unshare --net, macOS: sandbox-exec で network deny）
   * - "full"    : ネットワーク + ファイルシステム隔離（Linux: bwrap, macOS: sandbox-exec）
   */
  level: "none" | "network" | "full";
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
  /** Claude Code 互換のパターンベース権限ルール（ツール名リストより優先） */
  rules?: SecurityRuleConfig;
  streamCommandOutput?: boolean;
  /** OS-level プロセスサンドボックス設定（bash ツール実行に適用） */
  processSandbox?: ProcessSandboxConfig;
}

export interface ContextConfig {
  compressionThreshold: number;
  maxHistoryMessages: number;
}

export interface DiscordConfig {
  enabled: boolean;
  webhookUrl: string;
  // Slash Command 受信用 (Discord Developer Portal で取得)
  applicationId?: string;
  publicKey?: string;       // Ed25519 公開鍵 (署名検証用)
  botToken?: string;        // Bot トークン (コマンド登録・follow-up 送信)
  interactionPort?: number; // HTTP サーバーポート (デフォルト: 3003)
  listenEnabled?: boolean;  // 起動時に interaction サーバーを自動起動するか
}

export interface SlackConfig {
  enabled: boolean;           // Webhook通知の有効/無効
  webhookUrl: string;         // 通知用Incoming Webhook URL
  botToken?: string;          // xoxb- Bot Token (Bolt用)
  appToken?: string;          // xapp- App-Level Token (Socket Mode用)
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

export interface LoggingConfig {
  /** 運用ログ設定 */
  ops?: OpsLogConfig;
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

export interface Config {
  mainLLM: LLMEndpoint;
  visionLLM: LLMEndpoint | null;
  secondLLM: SecondLLMConfig | null;
  security: SecurityConfig;
  context: ContextConfig;
  discord?: DiscordConfig;
  slack?: SlackConfig;
  /** Web検索設定 */
  search?: SearchConfig;
  /** Obsidian Vault 連携 (ナレッジベース) */
  obsidian?: ObsidianConfig;
  /** true: テキストをリアルタイムにストリーミング表示。false(デフォルト): スピナー+完了後Markdownレンダリング */
  streamingDisplay?: boolean;
  /** ツールの最大並列実行数（デフォルト: 3）。vLLM KVキャッシュやリソースに合わせて調整 */
  maxParallelTools?: number;
  /** 自律実行モード（再起動後も維持） */
  autorunMode?: boolean;
  /** チャットログ保存設定（Obsidian Vault に会話ログを蓄積） */
  chatLog?: ChatLogConfig;
  /** ログ設定 (運用ログ等)。詳細: docs/llm-logging.md */
  logging?: LoggingConfig;
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
}

// ヘルパー: セカンドLLMがクラウドかローカルかを判定
export function isCloudProvider(type: SecondLLMProviderType): boolean {
  return ([
    "vertex-ai",
    "azure-openai",
    "azure-gpt",
    "azure-claude",
    "azure-foundry",
    "azure-anthropic",
    "anthropic",
    "claude-cli",
  ] as string[]).includes(type);
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
};

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
        "file_read", "glob", "grep", "browser_snapshot", "vision_analyze",
        "ask_user", "todo_write", "enter_plan_mode", "exit_plan_mode", "task_output",
        "web_search", "web_fetch",
      ],
      requireApprovalTools: ["file_write", "file_edit", "bash", "browser_navigate", "browser_click", "browser_type"],
      discordAutoApproveTools: [
        "file_read", "glob", "grep",
        "web_search", "web_fetch",
        "browser_snapshot", "vision_analyze",
        "current_datetime", "sandbox_info",
      ],
      slackAutoApproveTools: [
        "file_read", "glob", "grep",
        "web_search", "web_fetch",
        "browser_snapshot", "vision_analyze",
        "current_datetime", "sandbox_info",
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
    },
    discord: {
      enabled: false,
      webhookUrl: "",
      interactionPort: 3003,
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
  };
}
