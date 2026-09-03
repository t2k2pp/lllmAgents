import { describe, expect, it } from "vitest";
import {
  createDurableRunCheckpoint,
  parseDurableRunCheckpoint,
  validateDurableResume,
} from "../../src/agent/durable-run-checkpoint.js";
import type { LiveModelBinding } from "../../src/agent/model-drift.js";

const binding: LiveModelBinding = {
  signature: "openai-compat|local-model|http://127.0.0.1:8080/v1|||||",
  model: "local-model",
  providerType: "openai-compat",
  label: "local",
};

function checkpoint() {
  return createDurableRunCheckpoint({
    sessionId: "session-1",
    liveBinding: binding,
    run: {
      userMessageText: "作業を続ける",
      nextIteration: 2,
      emptyResponseRetries: 1,
      codeBlockRetried: true,
      hasExecutedTools: true,
      lastToolSignature: "bash:{}",
      repeatToolCount: 1,
      pendingVerification: ["src/a.ts"],
      pendingEvalFiles: [],
      selfCheckRounds: 0,
      progressGateRetries: 0,
      coherenceGateRetries: 0,
    },
  });
}

describe("durable run checkpoint", () => {
  it("schema version付きで生成し、endpointの生情報でなくfingerprintだけを保存する", () => {
    const value = checkpoint();
    expect(parseDurableRunCheckpoint(value)).toEqual({ ok: true, checkpoint: value });
    expect(value.modelBinding.endpointFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(value)).not.toContain("127.0.0.1");
  });

  it("cwd/session/model/provider/endpoint差分をfail-fast用に列挙する", () => {
    const value = checkpoint();
    expect(validateDurableResume(value, { sessionId: "session-1", liveBinding: binding })).toEqual([]);
    const differences = validateDurableResume(value, {
      sessionId: "different",
      liveBinding: { ...binding, model: "other", providerType: "ollama", signature: "other" },
    });
    expect(differences.join(" ")).toMatch(/session ID/);
    expect(differences.join(" ")).toMatch(/provider/);
    expect(differences.join(" ")).toMatch(/model/);
    expect(differences.join(" ")).toMatch(/endpoint/);
  });

  it("未知schemaとresume途中状態を黙ってready扱いしない", () => {
    expect(parseDurableRunCheckpoint({ ...checkpoint(), schemaVersion: 999 })).toEqual({
      ok: false,
      reason: "未対応のcheckpoint schema version: 999",
    });
    expect(parseDurableRunCheckpoint({ ...checkpoint(), state: "unknown" }).ok).toBe(false);
    expect(
      parseDurableRunCheckpoint({
        ...checkpoint(),
        run: { ...checkpoint().run, emptyResponseRetries: -1 },
      }).ok,
    ).toBe(false);
  });
});
