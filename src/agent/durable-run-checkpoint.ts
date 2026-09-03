import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { LiveModelBinding } from "./model-drift.js";

export const DURABLE_RUN_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface DurableRunState {
  userMessageText: string;
  nextIteration: number;
  emptyResponseRetries: number;
  codeBlockRetried: boolean;
  hasExecutedTools: boolean;
  lastToolSignature: string;
  repeatToolCount: number;
  pendingVerification: string[];
  pendingEvalFiles: string[];
  selfCheckRounds: number;
  progressGateRetries: number;
  coherenceGateRetries: number;
}

export interface DurableRunCheckpoint {
  schemaVersion: typeof DURABLE_RUN_CHECKPOINT_SCHEMA_VERSION;
  checkpointId: string;
  state: "durable_paused" | "resuming";
  savedAt: string;
  sessionId: string;
  source: "cli";
  cwdRealpath: string;
  modelBinding: {
    provider: string;
    endpointFingerprint: string;
    model: string;
  };
  boundary: "before_llm_request";
  run: DurableRunState;
}

export type CheckpointParseResult = { ok: true; checkpoint: DurableRunCheckpoint } | { ok: false; reason: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

export function parseDurableRunCheckpoint(value: unknown): CheckpointParseResult {
  if (!value || typeof value !== "object") return { ok: false, reason: "checkpointがobjectではありません" };
  const cp = value as Partial<DurableRunCheckpoint>;
  if (cp.schemaVersion !== DURABLE_RUN_CHECKPOINT_SCHEMA_VERSION) {
    return { ok: false, reason: `未対応のcheckpoint schema version: ${String(cp.schemaVersion)}` };
  }
  if (cp.state !== "durable_paused" && cp.state !== "resuming") {
    return { ok: false, reason: `不正なcheckpoint state: ${String(cp.state)}` };
  }
  if (
    typeof cp.checkpointId !== "string" ||
    typeof cp.savedAt !== "string" ||
    typeof cp.sessionId !== "string" ||
    cp.source !== "cli" ||
    typeof cp.cwdRealpath !== "string" ||
    cp.boundary !== "before_llm_request" ||
    !cp.modelBinding ||
    typeof cp.modelBinding.provider !== "string" ||
    typeof cp.modelBinding.endpointFingerprint !== "string" ||
    typeof cp.modelBinding.model !== "string" ||
    !cp.run ||
    typeof cp.run.userMessageText !== "string" ||
    !isNonNegativeInteger(cp.run.nextIteration) ||
    !isNonNegativeInteger(cp.run.emptyResponseRetries) ||
    typeof cp.run.codeBlockRetried !== "boolean" ||
    typeof cp.run.hasExecutedTools !== "boolean" ||
    typeof cp.run.lastToolSignature !== "string" ||
    !isNonNegativeInteger(cp.run.repeatToolCount) ||
    !isStringArray(cp.run.pendingVerification) ||
    !isStringArray(cp.run.pendingEvalFiles) ||
    !isNonNegativeInteger(cp.run.selfCheckRounds) ||
    !isNonNegativeInteger(cp.run.progressGateRetries) ||
    !isNonNegativeInteger(cp.run.coherenceGateRetries)
  ) {
    return { ok: false, reason: "checkpointの必須フィールドが壊れています" };
  }
  return { ok: true, checkpoint: cp as DurableRunCheckpoint };
}

export function fingerprintLiveBinding(binding: LiveModelBinding): string {
  return crypto.createHash("sha256").update(binding.signature).digest("hex");
}

export function currentCwdRealpath(): string {
  return fs.realpathSync.native(process.cwd());
}

export function createDurableRunCheckpoint(input: {
  sessionId: string;
  liveBinding: LiveModelBinding;
  run: DurableRunState;
}): DurableRunCheckpoint {
  return {
    schemaVersion: DURABLE_RUN_CHECKPOINT_SCHEMA_VERSION,
    checkpointId: crypto.randomUUID(),
    state: "durable_paused",
    savedAt: new Date().toISOString(),
    sessionId: input.sessionId,
    source: "cli",
    cwdRealpath: currentCwdRealpath(),
    modelBinding: {
      provider: input.liveBinding.providerType,
      endpointFingerprint: fingerprintLiveBinding(input.liveBinding),
      model: input.liveBinding.model,
    },
    boundary: "before_llm_request",
    run: structuredClone(input.run),
  };
}

export function validateDurableResume(
  checkpoint: DurableRunCheckpoint,
  current: { sessionId: string; liveBinding: LiveModelBinding | null },
): string[] {
  const differences: string[] = [];
  if (checkpoint.sessionId !== current.sessionId) differences.push("session IDが一致しません");
  let cwd: string;
  try {
    cwd = currentCwdRealpath();
  } catch (error) {
    differences.push(`現在の作業フォルダを解決できません: ${error instanceof Error ? error.message : String(error)}`);
    cwd = "";
  }
  if (cwd && checkpoint.cwdRealpath !== cwd)
    differences.push(`cwdが異なります (保存時=${checkpoint.cwdRealpath}, 現在=${cwd})`);
  if (!current.liveBinding) {
    differences.push("現在のmodel/provider bindingが未確定です。/model apply後に再試行してください");
  } else {
    if (checkpoint.modelBinding.provider !== current.liveBinding.providerType) differences.push("providerが異なります");
    if (checkpoint.modelBinding.model !== current.liveBinding.model) differences.push("modelが異なります");
    if (checkpoint.modelBinding.endpointFingerprint !== fingerprintLiveBinding(current.liveBinding)) {
      differences.push("provider endpointが異なります");
    }
  }
  return differences;
}
