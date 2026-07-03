import { describe, it, expect } from "vitest";
import { maskSecret, maskWebhookUrl } from "../../src/utils/mask.js";

describe("maskSecret", () => {
  it("空文字はそのまま", () => {
    expect(maskSecret("")).toBe("");
  });

  it("短い値は全部伏せる", () => {
    expect(maskSecret("abcd1234")).toBe("****");
  });

  it("長い値は末尾4文字だけ残す", () => {
    expect(maskSecret("xoxb-1234567890-abcdefgh")).toBe("****efgh");
  });
});

describe("maskWebhookUrl", () => {
  it("最終セグメント (トークン) を伏せてホスト・パス構造は残す", () => {
    const url = "https://discord.com/api/webhooks/123456789/AbCdEfGhIjKlMnOp";
    expect(maskWebhookUrl(url)).toBe("https://discord.com/api/webhooks/123456789/****MnOp");
  });

  it("Slack webhook も同様に伏せる", () => {
    const url = "https://hooks.slack.com/services/T000/B000/XXXXsecretXXXX1234";
    expect(maskWebhookUrl(url)).toBe("https://hooks.slack.com/services/T000/B000/****1234");
  });

  it("空文字はそのまま", () => {
    expect(maskWebhookUrl("")).toBe("");
  });

  it("スラッシュの無い値は汎用マスクに落ちる", () => {
    expect(maskWebhookUrl("plain-token-value")).toBe("****alue");
  });
});
