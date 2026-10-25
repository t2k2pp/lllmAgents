import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../src/discord/slash-commands.js", () => ({
  registerAskCommand: vi.fn(async () => ({ success: true, commandId: "cmd-1" })),
}));
vi.mock("../../src/utils/discord.js", async (orig) => {
  const actual = await orig<typeof import("../../src/utils/discord.js")>();
  return { ...actual, sendDiscordNotification: vi.fn(async () => ({ success: true })) };
});
vi.mock("../../src/utils/slack.js", async (orig) => {
  const actual = await orig<typeof import("../../src/utils/slack.js")>();
  return { ...actual, sendSlackNotification: vi.fn(async () => ({ success: true })) };
});

import { getDefaultConfig } from "../../src/config/types.js";
import type { ChatLogger } from "../../src/agent/chat-logger.js";
import { registerAskCommand } from "../../src/discord/slash-commands.js";
import { sendDiscordNotification } from "../../src/utils/discord.js";
import { sendSlackNotification } from "../../src/utils/slack.js";
import {
  addDiscordUser,
  addSlackUser,
  approveDiscordPending,
  nonInteractiveSettingsNotice,
  registerDiscordAsk,
  rejectDiscordPending,
  removeDiscordUser,
  removeSlackUser,
  sendDiscordTest,
  sendSlackTest,
  setChatlogEnabled,
  setChatlogVault,
  setDiscordApplicationId,
  setDiscordAttachImages,
  setDiscordBotToken,
  setDiscordEnabled,
  setDiscordListenAutoStart,
  setDiscordWebhookUrl,
  setSlackAppToken,
  setSlackBotToken,
  setSlackEnabled,
  setSlackWebhookUrl,
  useDuckDuckGo,
  useSearxng,
} from "../../src/cli/integrations-settings.js";

/**
 * /integrations 画面が呼ぶ設定関数 (docs/todo-legacy-ways-cleanup.md T3)。
 * 直接コマンド /discord /slack /chatlog /search を削除したため、 画面からの変更はすべてここを通る。
 */
function makeCtx() {
  const config = getDefaultConfig();
  config.discord = undefined;
  config.slack = undefined;
  config.chatLog = undefined;
  config.search = undefined;
  return { config, save: vi.fn() };
}

const DISCORD_URL = "https://discord.com/api/webhooks/123456/abcdef";
const SLACK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Discord", () => {
  it("通知オン/オフ・Webhook URL・ID・トークン・自動開始・画像添付を保存する", () => {
    const ctx = makeCtx();
    setDiscordEnabled(ctx, true);
    expect(ctx.config.discord?.enabled).toBe(true);
    expect(setDiscordWebhookUrl(ctx, DISCORD_URL)).toBe(true);
    setDiscordApplicationId(ctx, "app-1");
    setDiscordBotToken(ctx, "tok");
    setDiscordListenAutoStart(ctx, true);
    setDiscordAttachImages(ctx, false);
    setDiscordEnabled(ctx, false);
    expect(ctx.config.discord).toMatchObject({
      enabled: false,
      webhookUrl: DISCORD_URL,
      applicationId: "app-1",
      botToken: "tok",
      listenEnabled: true,
      attachGeneratedImages: false,
    });
    expect(ctx.save).toHaveBeenCalledTimes(7);
  });

  it("不正な Webhook URL は保存しない", () => {
    const ctx = makeCtx();
    expect(setDiscordWebhookUrl(ctx, "https://example.com/x")).toBe(false);
    expect(ctx.config.discord?.webhookUrl ?? "").toBe("");
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it("許可ユーザーの追加は待機リストから外し、 承認/却下は待機リストを更新する", () => {
    const ctx = makeCtx();
    const now = new Date().toISOString();
    ctx.config.discord = {
      enabled: false,
      webhookUrl: "",
      pendingUsers: [
        { id: "111111111111111111", firstSeen: now, lastSeen: now, attempts: 1 },
        { id: "222222222222222222", firstSeen: now, lastSeen: now, attempts: 1 },
        { id: "333333333333333333", firstSeen: now, lastSeen: now, attempts: 1 },
      ],
    };
    addDiscordUser(ctx, "111111111111111111");
    approveDiscordPending(ctx, "222222222222222222");
    rejectDiscordPending(ctx, "333333333333333333");
    expect(ctx.config.discord.allowedUserIds).toEqual(["111111111111111111", "222222222222222222"]);
    expect(ctx.config.discord.pendingUsers).toEqual([]);
    removeDiscordUser(ctx, "111111111111111111");
    expect(ctx.config.discord.allowedUserIds).toEqual(["222222222222222222"]);
  });

  it("テスト通知と /ask 登録は設定済みのときだけ送る", async () => {
    const ctx = makeCtx();
    await sendDiscordTest(ctx.config);
    await registerDiscordAsk(ctx.config);
    expect(sendDiscordNotification).not.toHaveBeenCalled();
    expect(registerAskCommand).not.toHaveBeenCalled();

    ctx.config.discord = { enabled: true, webhookUrl: DISCORD_URL, applicationId: "app", botToken: "tok" };
    await sendDiscordTest(ctx.config);
    await registerDiscordAsk(ctx.config, "guild-1");
    expect(sendDiscordNotification).toHaveBeenCalledWith(DISCORD_URL, expect.any(String));
    expect(registerAskCommand).toHaveBeenCalledWith("app", "tok", "guild-1");
  });
});

describe("Slack", () => {
  it("通知・Webhook URL・トークン・許可ユーザーを保存する", async () => {
    const ctx = makeCtx();
    setSlackEnabled(ctx, true);
    expect(setSlackWebhookUrl(ctx, "bad")).toBe(false);
    expect(setSlackWebhookUrl(ctx, SLACK_URL)).toBe(true);
    setSlackBotToken(ctx, "xoxb-1");
    setSlackAppToken(ctx, "xapp-1");
    addSlackUser(ctx, "U1");
    addSlackUser(ctx, "U2");
    removeSlackUser(ctx, "U1");
    expect(ctx.config.slack).toMatchObject({
      enabled: true,
      webhookUrl: SLACK_URL,
      botToken: "xoxb-1",
      appToken: "xapp-1",
      allowedUserIds: ["U2"],
    });
    await sendSlackTest(ctx.config);
    expect(sendSlackNotification).toHaveBeenCalledWith(SLACK_URL, expect.any(String));
  });
});

describe("会話ログ", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-settings-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("保存先未設定ではオンにできず、 設定後はオン/オフできる", async () => {
    const ctx = makeCtx();
    let logger: ChatLogger | null = null;
    const host = {
      getChatLogger: () => logger,
      setChatLogger: (cl: ChatLogger | null) => {
        logger = cl;
      },
    };
    expect(await setChatlogEnabled(ctx, host, true)).toBe(false);
    expect(await setChatlogVault(ctx, host, path.join(tmp, "missing"))).toBe(false);
    expect(await setChatlogVault(ctx, host, tmp)).toBe(true);
    expect(ctx.config.chatLog?.vaultPath).toBe(path.resolve(tmp));
    expect(logger).not.toBeNull();
    expect(await setChatlogEnabled(ctx, host, false)).toBe(true);
    expect(ctx.config.chatLog?.enabled).toBe(false);
    expect(await setChatlogEnabled(ctx, host, true)).toBe(true);
    expect(ctx.config.chatLog?.enabled).toBe(true);
  });
});

describe("Web検索", () => {
  it("DuckDuckGo / SearXNG を切り替え、 URL 省略時は今の URL か既定を使う", () => {
    const ctx = makeCtx();
    useSearxng(ctx, "");
    expect(ctx.config.search).toEqual({ provider: "searxng", searxngUrl: "http://localhost:8888" });
    useSearxng(ctx, "http://s:1");
    useDuckDuckGo(ctx);
    expect(ctx.config.search).toEqual({ provider: "duckduckgo", searxngUrl: "http://s:1" });
    useSearxng(ctx);
    expect(ctx.config.search).toEqual({ provider: "searxng", searxngUrl: "http://s:1" });
  });
});

describe("非TTY の案内", () => {
  it("/permission は端末が必要なことと config.json の権限キーを示す", () => {
    const text = nonInteractiveSettingsNotice("/permission").join("\n");
    expect(text).toContain("TTY");
    expect(text).toContain("~/.localllm/config.json");
    expect(text).toContain("security.rules");
    expect(text).toContain("discord:");
    expect(text).not.toContain("AutoApproveTools");
    expect(text).not.toContain("autoApproveTools");
    expect(text).not.toContain("requireApprovalTools");
  });

  it("/integrations は端末が必要なことと config.json の連携キーを示す", () => {
    const text = nonInteractiveSettingsNotice("/integrations").join("\n");
    expect(text).toContain("TTY");
    expect(text).toContain("~/.localllm/config.json");
    for (const key of ["discord.", "slack.", "chatLog.", "search.provider"]) expect(text).toContain(key);
  });
});
