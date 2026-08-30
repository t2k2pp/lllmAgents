/**
 * モデル名から既知の context length (トークン数) を推定する。
 *
 * 設計方針:
 * - 各プロバイダの listModels/getModelInfo で「実 API から取得できない場合」の
 *   一次推定として使う。確信が無いモデルは0を返し、呼び出し側は実API値または
 *   ユーザーの明示設定を要求する。推測定数で実行は継続しない。
 * - 4096 のような小さな値を捏造して返すと、auto-compression が早期発火し
 *   tool_call/tool_result 履歴破損を誘発するため避ける。
 * - 著名モデルだけ網羅し、未知モデルは 0 を返す (heuristic vs unknown を明確化)。
 */
export function inferContextLength(modelName: string): number {
  const m = modelName.toLowerCase();

  // Anthropic Claude (3.x / 4.x 系すべて 200K 以上)
  if (/claude/.test(m)) return 200_000;

  // OpenAI: GPT-5 / 4.1 系は 200K〜1M, 4o / o1 / o3 系は 128K
  if (/gpt-?5|gpt-?4\.1/.test(m)) return 200_000;
  if (/gpt-?4o|^o[13]\b|-o[13]-/.test(m)) return 128_000;
  if (/gpt-?4-turbo/.test(m)) return 128_000;
  if (/gpt-?4(?!o)/.test(m)) return 8_192;
  if (/gpt-?3\.5/.test(m)) return 16_385;

  // Google Gemini (1.5 以降は 1M〜2M)
  if (/gemini.*(1\.5|2|2\.5|3)/.test(m)) return 1_000_000;
  if (/gemini/.test(m)) return 32_768;

  // Moonshot Kimi (K2 系 = 256K)
  if (/kimi.*k2/.test(m)) return 256_000;
  if (/kimi/.test(m)) return 128_000;

  // Meta Llama 3.1 以降は 128K
  if (/llama.*(3\.1|3\.2|3\.3|4)/.test(m)) return 128_000;
  if (/llama.*3/.test(m)) return 8_192;

  // Mistral / Mixtral
  if (/mistral.*large|mixtral|mistral.*nemo/.test(m)) return 128_000;
  if (/mistral/.test(m)) return 32_768;

  // Cohere Command R
  if (/command.*r/.test(m)) return 128_000;

  // Qwen 2.5 以降は 128K
  if (/qwen.*(2\.5|3)/.test(m)) return 128_000;
  if (/qwen/.test(m)) return 32_768;

  // DeepSeek
  if (/deepseek/.test(m)) return 128_000;

  // Phi-3 Medium 以降は 128K
  if (/phi-?3.*medium|phi-?3\.5|phi-?4/.test(m)) return 128_000;
  if (/phi/.test(m)) return 4_096;

  return 0; // 不明 — 呼び出し側で明示設定を要求する
}
