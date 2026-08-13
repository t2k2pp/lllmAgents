/**
 * モデル設定の「設定値」 と「実行中」 のズレ検出 (docs/model-apply-immediacy.md §3)。
 *
 * ここで守りたいのは「画面が嘘をつかないこと」 なので、
 *  - 反映されていないときに必ずズレとして出ること
 *  - サンプリング値のような反映不要な差分でズレ扱いしないこと
 *  - 判定材料が無いとき (liveBinding=null) は誤警告しないこと
 * の 3 点を固定する。
 */
import { describe, it, expect } from "vitest";
import type { LLMEndpoint } from "../../src/config/types.js";
import {
  detectModelDrift,
  describeEndpoint,
  formatApplyFailureLines,
  formatBindingLines,
  formatDriftWarningLine,
  makeLiveBinding,
} from "../../src/agent/model-drift.js";

const azureOld: LLMEndpoint = {
  providerType: "azure-anthropic",
  model: "claude-sonnet-4-5",
  endpoint: "https://my-resource.services.ai.azure.com",
  apiKey: "encrypted:abc",
};

const azureNew: LLMEndpoint = {
  ...azureOld,
  model: "claude-opus-4-6",
};

describe("detectModelDrift", () => {
  it("設定値と実行中が同じならズレなし", () => {
    expect(detectModelDrift(azureOld, makeLiveBinding(azureOld))).toBeNull();
  });

  it("モデルを変えたのに反映されていなければズレとして検出する", () => {
    const drift = detectModelDrift(azureNew, makeLiveBinding(azureOld));
    expect(drift).not.toBeNull();
    expect(drift?.wantLabel).toContain("claude-opus-4-6");
    expect(drift?.liveLabel).toContain("claude-sonnet-4-5");
    expect(drift?.wantSignature).not.toBe(drift?.liveSignature);
  });

  it("接続先 (endpoint) の変更もズレとして検出する", () => {
    const moved: LLMEndpoint = { ...azureOld, endpoint: "https://other-resource.services.ai.azure.com" };
    expect(detectModelDrift(moved, makeLiveBinding(azureOld))).not.toBeNull();
  });

  it("apiKey の保存形式が変われば (平文 → 暗号化) ズレとして検出する", () => {
    const plain: LLMEndpoint = { ...azureOld, apiKey: "sk-plain" };
    expect(detectModelDrift(plain, makeLiveBinding(azureOld))).not.toBeNull();
  });

  it("サンプリング値や description だけの差分はズレにしない (反映不要なため)", () => {
    const tweaked: LLMEndpoint = { ...azureOld, temperature: 0.2, description: "説明を足しただけ" };
    expect(detectModelDrift(tweaked, makeLiveBinding(azureOld))).toBeNull();
  });

  it("実行中バインディングが未記録なら誤警告しない (設計書 §6 の安全側)", () => {
    expect(detectModelDrift(azureNew, null)).toBeNull();
    expect(detectModelDrift(azureNew, undefined)).toBeNull();
  });

  it("設定値が無ければズレなし", () => {
    expect(detectModelDrift(null, makeLiveBinding(azureOld))).toBeNull();
  });
});

describe("makeLiveBinding", () => {
  it("providerType / model / 接続先を含むラベルを作る", () => {
    const live = makeLiveBinding(azureOld);
    expect(live.model).toBe("claude-sonnet-4-5");
    expect(live.providerType).toBe("azure-anthropic");
    expect(live.label).toBe("azure-anthropic:claude-sonnet-4-5 @ my-resource.services.ai.azure.com");
    expect(live.signature).toContain("azure-anthropic");
  });

  it("model 引数を渡せばそちらを採用する", () => {
    expect(makeLiveBinding(azureOld, "override-model").model).toBe("override-model");
  });
});

describe("formatBindingLines", () => {
  it("一致していても 2 行出す (どちらを見せているか分かるように)", () => {
    const lines = formatBindingLines("メインLLM", azureOld, makeLiveBinding(azureOld));
    expect(lines.drifted).toBe(false);
    expect(lines.configured).toContain("(設定)");
    expect(lines.live).toContain("(実行中)");
    expect(lines.live).not.toContain("一致していません");
    expect(lines.hint).toBeUndefined();
  });

  it("ズレていれば実行中の行に注意書きと導線が付く", () => {
    const lines = formatBindingLines("メインLLM", azureNew, makeLiveBinding(azureOld));
    expect(lines.drifted).toBe(true);
    expect(lines.configured).toContain("claude-opus-4-6");
    expect(lines.live).toContain("claude-sonnet-4-5");
    expect(lines.live).toContain("一致していません");
    expect(lines.hint).toContain("/model apply");
  });

  it("実行中が未記録なら (不明) と出す (ズレ扱いにはしない)", () => {
    const lines = formatBindingLines("メインLLM", azureNew, null);
    expect(lines.drifted).toBe(false);
    expect(lines.live).toContain("(不明)");
  });
});

describe("formatDriftWarningLine", () => {
  it("設定・実行中・対処コマンドが 1 行に揃う", () => {
    const drift = detectModelDrift(azureNew, makeLiveBinding(azureOld));
    expect(drift).not.toBeNull();
    const line = formatDriftWarningLine(drift as NonNullable<typeof drift>);
    expect(line).toContain("claude-opus-4-6");
    expect(line).toContain("claude-sonnet-4-5");
    expect(line).toContain("/model apply");
    expect(line.split("\n")).toHaveLength(1);
  });
});

describe("formatApplyFailureLines", () => {
  it("いま動いているものを必ず併記する", () => {
    const lines = formatApplyFailureLines("接続テストに失敗 (401 Unauthorized)", makeLiveBinding(azureOld));
    expect(lines.join("\n")).toContain("401 Unauthorized");
    expect(lines.join("\n")).toContain("claude-sonnet-4-5");
    expect(lines.join("\n")).toContain("/model apply");
    // 「再起動してください」 で終わらせないのが本件の主眼
    expect(lines.join("\n")).not.toContain("再起動");
  });

  it("実行中が未記録でも起動時のまま動いていることを伝える", () => {
    const lines = formatApplyFailureLines("Provider 生成に失敗", null);
    expect(lines.join("\n")).toContain("起動時の設定のまま");
  });
});

describe("describeEndpoint", () => {
  it("未設定は (未設定)", () => {
    expect(describeEndpoint(null)).toBe("(未設定)");
    expect(describeEndpoint(undefined)).toBe("(未設定)");
  });

  it("ローカル系は host 部で表す", () => {
    const local: LLMEndpoint = { providerType: "ollama", model: "qwen3-32b", baseUrl: "http://192.168.1.33:11434" };
    expect(describeEndpoint(local)).toBe("ollama:qwen3-32b @ 192.168.1.33:11434");
  });
});
