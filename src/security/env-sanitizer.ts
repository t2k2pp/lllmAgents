/**
 * bash 子プロセスへ引き渡す環境変数のサニタイズ（最小権限化）。
 *
 * 背景 (docs/harness-egress-and-cot-guard-design.md §3.4):
 * - モデルが環境変数や設定ファイルを探索して外部へ送信しようとする挙動への対策として、
 *   親プロセス（ハーネス本体）が保持しているクラウド認証情報・LLM APIキー・チャットボットトークン・
 *   暗号化パスフレーズ等を bash 子プロセスの環境変数から除去する。
 */

const EXACT_SECRET_ENV_NAMES = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "COHERE_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "DASHSCOPE_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_ANTHROPIC_API_KEY",
  "AZURE_CLIENT_SECRET",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
  "ALICLOUD_SECRET_KEY",
  "OSS_ACCESS_KEY_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "LOCALLLM_PASSPHRASE",
]);

const SECRET_ENV_SUFFIX_RE =
  /_(?:API_KEY|SECRET_KEY|ACCESS_KEY_SECRET|CLIENT_SECRET|BOT_TOKEN|APP_TOKEN|SIGNING_SECRET|PRIVATE_KEY|PASSPHRASE)$/i;

/** 環境変数名が子プロセスから隠蔽すべき機密変数に該当するか判定する。 */
export function isSecretEnvVar(name: string): boolean {
  const upper = name.trim().toUpperCase();
  if (!upper) return false;
  if (EXACT_SECRET_ENV_NAMES.has(upper)) return true;
  return SECRET_ENV_SUFFIX_RE.test(upper);
}

/** 親プロセスの環境変数から機密認証情報を除去した新しい環境変数オブジェクトを返す。 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (isSecretEnvVar(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
