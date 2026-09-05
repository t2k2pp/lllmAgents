import type { SecondLLMProviderType } from "../config/types.js";
import type { ChatParams } from "./base-provider.js";

type SamplingField = "temperature" | "top_p" | "top_k" | "repetition_penalty";

export interface CompatibleSamplingParameters {
  fields: Partial<Record<SamplingField, number>>;
  omitted: SamplingField[];
}

const warned = new Set<string>();

/**
 * OpenAI reasoning model families reject temperature/top_p unless a documented
 * no-reasoning mode is selected. This app currently does not send an explicit
 * reasoning effort, so omitting those fields is the only request shape that is
 * valid across the supported GPT-5+ deployments.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  const normalized = model.trim().toLowerCase().split("/").at(-1) ?? "";
  return /^(?:gpt-[56](?:[.-]|$)|o[1-9](?:[.-]|$)|codex(?:[.-]|$))/.test(normalized);
}

/** Build only the sampling fields supported by the selected provider/model. */
export function compatibleOpenAISamplingParameters(
  providerType: SecondLLMProviderType,
  model: string,
  params: Pick<ChatParams, SamplingField>,
): CompatibleSamplingParameters {
  const fields: Partial<Record<SamplingField, number>> = {};
  const omitted: SamplingField[] = [];
  const officialAzureOpenAI = providerType === "azure-gpt" || providerType === "azure-openai";
  const reasoningModel = officialAzureOpenAI && isOpenAIReasoningModel(model);

  for (const key of ["temperature", "top_p", "top_k", "repetition_penalty"] as const) {
    const value = params[key];
    if (value === undefined) continue;
    const unsupportedOpenAIExtension = officialAzureOpenAI && (key === "top_k" || key === "repetition_penalty");
    const unsupportedReasoningSampling = reasoningModel && (key === "temperature" || key === "top_p");
    if (unsupportedOpenAIExtension || unsupportedReasoningSampling) omitted.push(key);
    else fields[key] = value;
  }

  return { fields, omitted };
}

/** Surface capability negotiation once instead of silently ignoring user configuration. */
export function warnOmittedSamplingParameters(
  providerType: SecondLLMProviderType,
  model: string,
  omitted: SamplingField[],
): void {
  if (omitted.length === 0) return;
  const key = `${providerType}:${model}:${omitted.join(",")}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `  ⚠ model=${model} (${providerType}) では ${omitted.join(", ")} が非対応のため送信しません。` +
      " 設定を消す場合は /model temperature auto のように指定してください。",
  );
}

/** Test isolation only. */
export function resetSamplingCompatibilityWarnings(): void {
  warned.clear();
}
