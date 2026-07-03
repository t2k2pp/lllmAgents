import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  splitSecrets,
  mergeCredentials,
  hasInlineSecrets,
  loadCredentialsFile,
  saveCredentialsFile,
} from "../../src/config/credentials.js";
import { getDefaultConfig } from "../../src/config/types.js";
import type { Config } from "../../src/config/types.js";

function configWithSecrets(): Config {
  const config = getDefaultConfig();
  config.mainLLM.apiKey = "sk-main-secret";
  config.discord = {
    enabled: true,
    webhookUrl: "https://discord.com/api/webhooks/123/abc",
    botToken: "bot-token-xyz",
    listenEnabled: false,
  };
  config.slack = {
    enabled: true,
    webhookUrl: "https://hooks.slack.com/services/T/B/x",
    botToken: "xoxb-secret",
    appToken: "xapp-secret",
  };
  config.imageGen = {
    enabled: true,
    active: "azure",
    profiles: [
      { name: "azure", providerType: "azure-image", apiKey: "img-key-1" },
      { name: "sd", providerType: "sd-webui" },
    ],
  };
  return config;
}

describe("splitSecrets", () => {
  it("シークレットを config から取り除き credentials に移す", () => {
    const { sanitized, credentials } = splitSecrets(configWithSecrets());

    expect(sanitized.mainLLM.apiKey).toBeUndefined();
    expect(sanitized.discord?.botToken).toBeUndefined();
    expect(sanitized.discord?.webhookUrl).toBeUndefined();
    expect(sanitized.slack?.botToken).toBeUndefined();
    expect(sanitized.slack?.appToken).toBeUndefined();
    expect(sanitized.imageGen?.profiles?.[0]?.apiKey).toBeUndefined();

    const creds = credentials as {
      mainLLM: { apiKey?: string };
      discord: { botToken?: string; webhookUrl?: string };
      slack: { appToken?: string };
      imageGen: { profiles: Array<{ apiKey?: string }> };
    };
    expect(creds.mainLLM.apiKey).toBe("sk-main-secret");
    expect(creds.discord.botToken).toBe("bot-token-xyz");
    expect(creds.discord.webhookUrl).toBe("https://discord.com/api/webhooks/123/abc");
    expect(creds.slack.appToken).toBe("xapp-secret");
    expect(creds.imageGen.profiles[0].apiKey).toBe("img-key-1");
  });

  it("非シークレットのフィールドは config 側に残る", () => {
    const { sanitized } = splitSecrets(configWithSecrets());
    expect(sanitized.discord?.enabled).toBe(true);
    expect(sanitized.slack?.enabled).toBe(true);
    expect(sanitized.imageGen?.profiles?.[0]?.name).toBe("azure");
    expect(sanitized.mainLLM.model).toBeDefined();
  });

  it("空文字のシークレットは credentials に移さない (未設定扱い)", () => {
    const config = getDefaultConfig(); // discord.webhookUrl = ""
    const { sanitized, credentials } = splitSecrets(config);
    expect(sanitized.discord?.webhookUrl).toBeUndefined();
    expect(credentials).toEqual({});
  });

  it("往復 (split → merge) で元のシークレットが復元される", () => {
    const original = configWithSecrets();
    const { sanitized, credentials } = splitSecrets(original);
    const restored = structuredClone(sanitized) as unknown as Record<string, unknown>;
    mergeCredentials(restored, credentials);

    const r = restored as unknown as Config;
    expect(r.mainLLM.apiKey).toBe("sk-main-secret");
    expect(r.discord?.botToken).toBe("bot-token-xyz");
    expect(r.slack?.appToken).toBe("xapp-secret");
    expect(r.imageGen?.profiles?.[0]?.apiKey).toBe("img-key-1");
    expect(r.imageGen?.profiles?.[1]?.apiKey).toBeUndefined();
  });
});

describe("mergeCredentials", () => {
  it("config 側に非空の値がある場合は config を優先する (手編集の尊重)", () => {
    const parsed: Record<string, unknown> = { mainLLM: { apiKey: "hand-edited" } };
    mergeCredentials(parsed, { mainLLM: { apiKey: "from-credentials" } });
    expect((parsed.mainLLM as { apiKey?: string }).apiKey).toBe("hand-edited");
  });

  it("マージ先の親が存在しないシークレットは捨てる", () => {
    const parsed: Record<string, unknown> = { visionLLM: null };
    mergeCredentials(parsed, { visionLLM: { apiKey: "orphan" } });
    expect(parsed.visionLLM).toBeNull();
  });

  it("credentials がオブジェクトでない場合は何もしない", () => {
    const parsed: Record<string, unknown> = { mainLLM: {} };
    mergeCredentials(parsed, "broken");
    mergeCredentials(parsed, undefined);
    expect(parsed).toEqual({ mainLLM: {} });
  });
});

describe("hasInlineSecrets", () => {
  it("config.json 内のシークレットを検出する", () => {
    expect(hasInlineSecrets({ slack: { botToken: "xoxb-1" } })).toBe(true);
    expect(hasInlineSecrets({ imageGen: { profiles: [{ apiKey: "k" }] } })).toBe(true);
  });

  it("シークレットが無ければ false (空文字も未設定扱い)", () => {
    expect(hasInlineSecrets({})).toBe(false);
    expect(hasInlineSecrets({ discord: { webhookUrl: "", enabled: true } })).toBe(false);
    expect(hasInlineSecrets({ mainLLM: { model: "qwen" } })).toBe(false);
  });
});

describe("loadCredentialsFile / saveCredentialsFile", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-test-"));
    filePath = path.join(dir, "credentials.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("保存して読み戻せる", () => {
    saveCredentialsFile({ slack: { botToken: "xoxb-1" } }, filePath);
    const loaded = loadCredentialsFile(filePath) as { slack: { botToken?: string } };
    expect(loaded.slack.botToken).toBe("xoxb-1");
  });

  it("ファイルが無ければ undefined", () => {
    expect(loadCredentialsFile(filePath)).toBeUndefined();
  });

  it("壊れたファイルは .broken-<ts> に退避して undefined を返す", () => {
    fs.writeFileSync(filePath, "{ broken json", "utf-8");
    expect(loadCredentialsFile(filePath)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith("credentials.json.broken-"));
    expect(backups.length).toBe(1);
  });
});
