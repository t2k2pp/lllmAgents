export type ProviderType = "ollama" | "lmstudio" | "llamacpp" | "vllm";

export interface LLMEndpoint {
  providerType: ProviderType;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  temperature?: number;
}

export interface SecurityConfig {
  allowedDirectories: string[];
  blockedCommands: string[];
  autoApproveTools: string[];
  requireApprovalTools: string[];
}

export interface ContextConfig {
  compressionThreshold: number;
  maxHistoryMessages: number;
}

export interface Config {
  mainLLM: LLMEndpoint;
  visionLLM: LLMEndpoint | null;
  security: SecurityConfig;
  context: ContextConfig;
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
    security: {
      allowedDirectories: [],
      blockedCommands: [],
      autoApproveTools: [
        "file_read", "glob", "grep", "browser_snapshot", "vision_analyze",
        "ask_user", "todo_write", "enter_plan_mode", "exit_plan_mode", "task_output",
      ],
      requireApprovalTools: ["file_write", "file_edit", "bash", "browser_navigate", "browser_click", "browser_type"],
    },
    context: {
      compressionThreshold: 0.8,
      maxHistoryMessages: 100,
    },
  };
}
