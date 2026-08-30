/**
 * config.json の zod スキーマ検証 (PR-03) のテスト。
 * docs/production-readiness.md PR-03
 */
import { describe, it, expect } from "vitest";
import { sanitizeParsedConfig } from "../../src/config/config-schema.js";

describe("sanitizeParsedConfig", () => {
  it("正しい config は無警告でそのまま通る", () => {
    const input = {
      mainLLM: { providerType: "vllm", baseUrl: "http://x:8000", model: "m", contextWindow: 32768 },
      streamingDisplay: true,
      jpyPerUsd: 150,
      security: { autoApproveTools: ["file_read"] },
    };
    const r = sanitizeParsedConfig(input);
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual(input);
  });

  it("未知のトップレベルキーは黙って消さない (将来フィールドの保全)", () => {
    const input = { futureFeature: { anything: 1 }, jpyPerUsd: 150 };
    const r = sanitizeParsedConfig(input);
    expect(r.warnings).toEqual([]);
    expect((r.config as Record<string, unknown>).futureFeature).toEqual({ anything: 1 });
  });

  it("型の合わないスカラーは取り除いて警告する", () => {
    const r = sanitizeParsedConfig({ jpyPerUsd: "150円", streamingDisplay: true });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("jpyPerUsd");
    expect(r.config).toEqual({ streamingDisplay: true });
  });

  it("不正な enum 値 (search.provider) は取り除いて警告する", () => {
    const r = sanitizeParsedConfig({ search: { provider: "google" } });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("search.provider");
    expect(r.config).toEqual({ search: {} });
  });

  it("配列であるべき箇所にスカラーが入っていたら取り除く", () => {
    const r = sanitizeParsedConfig({ security: { autoApproveTools: "file_read" } });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("security.autoApproveTools");
    expect(r.config).toEqual({ security: {} });
  });

  it("配列内の不正な要素だけを取り除き、正しい要素は残す", () => {
    const r = sanitizeParsedConfig({
      disabledSkills: ["a", 123, "b", null, "c"],
    });
    expect(r.config).toEqual({ disabledSkills: ["a", "b", "c"] });
    expect(r.warnings).toHaveLength(2);
  });

  it("pluginDirsは不正要素だけを除き、明示pathを保持する", () => {
    const r = sanitizeParsedConfig({ pluginDirs: ["./plugins/a", 123, "C:/plugins/b"] });
    expect(r.config).toEqual({ pluginDirs: ["./plugins/a", "C:/plugins/b"] });
    expect(r.warnings).toHaveLength(1);
  });

  it("features.computerUse は明示的な on/off だけを受け入れる", () => {
    const valid = sanitizeParsedConfig({ features: { computerUse: "on" } });
    expect(valid.warnings).toEqual([]);
    expect(valid.config).toEqual({ features: { computerUse: "on" } });

    const invalid = sanitizeParsedConfig({ features: { computerUse: true } });
    expect(invalid.warnings).toHaveLength(1);
    expect(invalid.warnings[0]).toContain("features.computerUse");
    expect(invalid.config).toEqual({ features: {} });
  });

  it("roomConfig の不正な binding / autoResume を取り除く (旧 L-4 の統合)", () => {
    const r = sanitizeParsedConfig({
      roomConfig: {
        bindings: { repl: "A", discord: "X" },
        autoResume: { A: false, B: "yes" },
      },
    });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join("\n")).toContain("roomConfig.bindings.discord");
    expect(r.warnings.join("\n")).toContain("roomConfig.autoResume.B");
    expect(r.config).toEqual({
      roomConfig: { bindings: { repl: "A" }, autoResume: { A: false } },
    });
  });

  it("オブジェクトであるべき箇所の型違い (visionLLM: 文字列) は丸ごと取り除く", () => {
    const r = sanitizeParsedConfig({ visionLLM: "llava" });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("visionLLM");
    expect(r.config).toEqual({});
  });

  it("visionLLM: null は正しい値として通る", () => {
    const r = sanitizeParsedConfig({ visionLLM: null });
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual({ visionLLM: null });
  });

  it("ネストの深い不正値 (checkpoints.retention.maxAgeDays) をピンポイントで取り除く", () => {
    const r = sanitizeParsedConfig({
      checkpoints: { enabled: true, retention: { maxSessions: 20, maxAgeDays: "60日" } },
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("checkpoints.retention.maxAgeDays");
    expect(r.config).toEqual({ checkpoints: { enabled: true, retention: { maxSessions: 20 } } });
  });

  it("ルートがオブジェクトでなければ既定値扱いで警告する", () => {
    const r = sanitizeParsedConfig(["not", "an", "object"]);
    expect(r.config).toEqual({});
    expect(r.warnings).toHaveLength(1);
  });

  it("複数の不正フィールドをすべて報告する", () => {
    const r = sanitizeParsedConfig({
      jpyPerUsd: "abc",
      maxParallelTools: "3",
      mainLLM: { providerType: "olama", model: "m" },
    });
    expect(r.warnings).toHaveLength(3);
    expect(r.config).toEqual({ mainLLM: { model: "m" } });
  });
});
