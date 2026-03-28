export type ProviderType = "ollama" | "lmstudio" | "llamacpp" | "vllm";

export type CloudProviderType = "vertex-ai" | "azure-openai" | "azure-claude";

// セカンドLLMはローカルまたはクラウドのいずれかを指定可能
export type SecondLLMProviderType = ProviderType | CloudProviderType;

export interface LLMEndpoint {
  providerType: ProviderType;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  temperature?: number;
}

export interface SecondLLMEndpoint {
  providerType: SecondLLMProviderType;
  model: string;
  // ローカルLLM用
  baseUrl?: string;
  // Vertex AI用
  projectId?: string;
  region?: string;
  // Azure用
  endpoint?: string;
  apiKey?: string;
  deploymentName?: string;
}

export interface BudgetConfig {
  limitUsd: number;          // 予算上限 (USD)
  warningThreshold: number;  // 警告閾値 (0.0〜1.0、デフォルト0.8)
  stopThreshold: number;     // 停止閾値 (0.0〜1.0、デフォルト0.95)
}

export interface CostConfig {
  referenceModels: string[];  // ローカルLLM利用時の参考コスト比較対象
}

export interface SecondLLMConfig {
  enabled: boolean;
  endpoint: SecondLLMEndpoint;
  budget: BudgetConfig | null;  // ローカルLLMの場合は null（予算不要）
  cost: CostConfig;
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

export interface Config {
  mainLLM: LLMEndpoint;
  visionLLM: LLMEndpoint | null;
  secondLLM: SecondLLMConfig | null;
  security: SecurityConfig;
  context: ContextConfig;
  discord?: DiscordConfig;
  /** true: テキストをリアルタイムにストリーミング表示。false(デフォルト): スピナー+完了後Markdownレンダリング */
  streamingDisplay?: boolean;
}

// ヘルパー: セカンドLLMがクラウドかローカルかを判定
export function isCloudProvider(type: SecondLLMProviderType): boolean {
  return (["vertex-ai", "azure-openai", "azure-claude"] as string[]).includes(type);
}

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

export const DEFAULT_PORTS: Record<ProviderType, number> = {
  ollama: 11434,
  lmstudio: 1234,
  llamacpp: 8080,
  vllm: 8000,
};

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  vllm: "vLLM",
};

export function getDefaultConfig(): Config {
  return {
    mainLLM: {
      providerType: "ollama",
      baseUrl: "http://localhost:11434",
      model: "",
      temperature: 0.7,
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
  };
}
