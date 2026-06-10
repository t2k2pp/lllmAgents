import { describe, it, expect } from "vitest";
import { ImageService } from "../../src/image/image-service.js";
import { parseSize } from "../../src/image/image-provider.js";
import type { Config, ImageGenConfig } from "../../src/config/types.js";

/** ImageService の profile 解決ロジック用に最小限の Config を作る */
function makeConfig(imageGen?: ImageGenConfig): Config {
  return {
    mainLLM: { providerType: "ollama", baseUrl: "http://localhost:11434", model: "test" },
    visionLLM: null,
    secondLLM: null,
    security: {
      allowedDirectories: [],
      blockedCommands: [],
      autoApproveTools: [],
      requireApprovalTools: [],
      discordAutoApproveTools: [],
      slackAutoApproveTools: [],
    },
    context: { compressionThreshold: 0.8, maxHistoryMessages: 100 },
    imageGen,
  } as Config;
}

describe("ImageService", () => {
  it("imageGen 未設定なら無効・プロファイルなし", () => {
    const svc = new ImageService(makeConfig());
    expect(svc.isEnabled()).toBe(false);
    expect(svc.getActiveProfile()).toBeNull();
  });

  it("enabled=true でも active が無ければ無効 (ツール非登録)", () => {
    const svc = new ImageService(makeConfig({
      enabled: true,
      profiles: [{ name: "a", providerType: "sd-webui", baseUrl: "http://localhost:7860" }],
    }));
    expect(svc.getActiveProfile()).toBeNull();
    expect(svc.isEnabled()).toBe(false);
  });

  it("active が profiles に存在すれば有効", () => {
    const svc = new ImageService(makeConfig({
      enabled: true,
      active: "a",
      profiles: [{ name: "a", providerType: "sd-webui", baseUrl: "http://localhost:7860" }],
    }));
    expect(svc.getActiveProfile()?.name).toBe("a");
    expect(svc.isEnabled()).toBe(true);
  });

  it("active が存在しない名前を指していたら null (削除後の整合)", () => {
    const svc = new ImageService(makeConfig({
      enabled: true,
      active: "gone",
      profiles: [{ name: "a", providerType: "sd-webui", baseUrl: "http://localhost:7860" }],
    }));
    expect(svc.getActiveProfile()).toBeNull();
  });

  it("enabled=false ならアクティブがあっても無効", () => {
    const svc = new ImageService(makeConfig({
      enabled: false,
      active: "a",
      profiles: [{ name: "a", providerType: "sd-webui", baseUrl: "http://localhost:7860" }],
    }));
    expect(svc.isEnabled()).toBe(false);
  });

  it("generateAndSave は相対パスを拒否する (アプリ内ルール: 絶対パス必須)", async () => {
    const svc = new ImageService(makeConfig({
      enabled: true,
      active: "a",
      profiles: [{ name: "a", providerType: "sd-webui", baseUrl: "http://localhost:7860" }],
    }));
    await expect(svc.generateAndSave({ prompt: "x" }, "relative/out.png")).rejects.toThrow(/絶対パス/);
  });
});

describe("parseSize", () => {
  it('"1024x1024" をパースする', () => {
    expect(parseSize("1024x1024")).toEqual({ width: 1024, height: 1024 });
  });
  it("大文字 X / 全角 × も受理", () => {
    expect(parseSize("1536X1024")).toEqual({ width: 1536, height: 1024 });
    expect(parseSize("1024×768")).toEqual({ width: 1024, height: 768 });
  });
  it("不正な形式は null", () => {
    expect(parseSize("square")).toBeNull();
    expect(parseSize("1024")).toBeNull();
    expect(parseSize("0x100")).toBeNull();
  });
});
