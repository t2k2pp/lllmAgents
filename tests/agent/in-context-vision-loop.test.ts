import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, describeRequestTooLarge } from "../../src/agent/agent-loop.js";
import { countLiveImages, isToolImageNote, liveImageBytes } from "../../src/agent/image-content.js";
import { findToolPairingError, MessageHistory } from "../../src/agent/message-history.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider, Message } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { fileReadTool } from "../../src/tools/definitions/file-read.js";
import { clearTodos } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

/**
 * メインのモデルがツール結果の画像を自分で見る (docs/in-context-vision-design.md §4・§6)。
 * AgentLoop を実際に回し、 送った並びに画像の運び役が正しい位置に 1 件入ること、 対の検証が通ること、
 * 上限を超えたときの退役が書き換え理由を申告することを確かめる。
 */

vi.mock("../../src/agent/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/session-manager.js")>();
  return { ...actual, saveSession: vi.fn() };
});

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function scriptedProvider(replies: ChatChunk[][], requests: ChatWithToolsParams[], vision: boolean): LLMProvider {
  let call = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    requests.push(JSON.parse(JSON.stringify(params)));
    const current = call++;
    for (const chunk of replies[Math.min(current, replies.length - 1)] ?? []) yield chunk;
  };
  return {
    providerType: "gufo",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: chatWithTools,
    chatWithTools,
    supportsVision: async () => vision,
    chatWithVision: chatWithTools,
  } as unknown as LLMProvider;
}

function toolCalls(...calls: Array<[string, string, Record<string, unknown>]>): ChatChunk[] {
  return [
    ...calls.map(
      ([id, name, args]): ChatChunk => ({
        type: "tool_call",
        toolCall: { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      }),
    ),
    { type: "done", finishReason: "tool_calls" },
  ];
}

function textReply(text: string): ChatChunk[] {
  return [
    { type: "text", text },
    { type: "done", finishReason: "stop" },
  ];
}

function makeLoop(provider: LLMProvider, registry: ToolRegistry, allowedDir: string): AgentLoop {
  return new AgentLoop(
    provider,
    "test-model-7b",
    registry,
    new PermissionManager({
      allowedDirectories: [allowedDir],
      blockedCommands: [],
      rules: { allow: registry.getToolNames(), deny: [], ask: [] },
    }),
    128_000,
  );
}

describe("ツール結果の画像を会話に載せる (in-context vision)", () => {
  let dir: string;
  let pngA: string;
  let pngB: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "in-context-vision-"));
    pngA = path.join(dir, "front.png");
    pngB = path.join(dir, "side.png");
    fs.writeFileSync(pngA, pngHeader(1200, 900));
    fs.writeFileSync(pngB, pngHeader(800, 600));
  });
  afterEach(() => {
    clearTodos();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("同じ応答の結果を全部入れた後に、 画像の運び役を 1 件だけ足す (対の検証が通る)", async () => {
    const requests: ChatWithToolsParams[] = [];
    const registry = new ToolRegistry();
    registry.register(fileReadTool);
    const provider = scriptedProvider(
      [
        toolCalls(["c1", "file_read", { file_path: pngA }], ["c2", "file_read", { file_path: pngB }]),
        textReply("目の位置を確認しました。"),
      ],
      requests,
      true,
    );
    const loop = makeLoop(provider, registry, dir);
    expect((await loop.refreshImageInput()).mode).toBe("on");
    await loop.run("描画した画像を見て目の位置を確かめてください？");

    expect(requests.length).toBeGreaterThanOrEqual(2);
    const sent = requests[1].messages as Message[];
    expect(findToolPairingError(sent.filter((m) => m.role !== "system"))).toBeNull();
    const callIdx = sent.findIndex((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) === 2);
    expect(sent[callIdx + 1]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(sent[callIdx + 2]).toMatchObject({ role: "tool", tool_call_id: "c2" });
    const carrier = sent[callIdx + 3];
    expect(carrier.role).toBe("user");
    expect(Array.isArray(carrier.content)).toBe(true);
    const parts = carrier.content as Exclude<Message["content"], string>;
    expect(parts[0].text).toContain("利用者の発言ではありません");
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2);
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toBe(
      `data:image/png;base64,${fs.readFileSync(pngA).toString("base64")}`,
    );
    // 運び役は 1 件だけ
    expect(sent.filter((m) => m.role === "user" && Array.isArray(m.content))).toHaveLength(1);
    // ツール結果の本文に base64 は入らない
    expect(String(sent[callIdx + 1].content)).not.toContain(fs.readFileSync(pngA).toString("base64"));
  });

  it("見られない provider なら画像を載せず、 結果の文でそのことを伝える", async () => {
    const requests: ChatWithToolsParams[] = [];
    const registry = new ToolRegistry();
    registry.register(fileReadTool);
    const provider = scriptedProvider(
      [toolCalls(["c1", "file_read", { file_path: pngA }]), textReply("確認しました。")],
      requests,
      false,
    );
    const loop = makeLoop(provider, registry, dir);
    expect((await loop.refreshImageInput()).mode).toBe("off");
    await loop.run("描画した画像を確かめてください？");

    const sent = requests[1].messages as Message[];
    expect(sent.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"))).toBe(false);
    const result = sent.find((m) => m.role === "tool");
    expect(String(result?.content)).toContain("メインのモデルは画像を見られない設定です");
  });

  it("生きている画像が上限を超えたら古い画像を退役させ、 書き換え理由 image-retire を申告する", async () => {
    const requests: ChatWithToolsParams[] = [];
    const registry = new ToolRegistry();
    let n = 0;
    registry.register({
      name: "render_many",
      definition: {
        type: "function",
        function: { name: "render_many", description: "test", parameters: { type: "object", properties: {} } },
      },
      execute: async (_params, context) => {
        expect(context?.imageInput?.mode).toBe("on");
        const count = n === 0 ? 6 : 3;
        const images = Array.from({ length: count }, (_, i) => ({
          mimeType: "image/png" as const,
          data: pngHeader(10 + n, 10 + i).toString("base64"),
          label: `${dir}/r${n}-${i}.png`,
        }));
        n++;
        return { success: true, output: `rendered ${count}`, images };
      },
    });
    const reasons: string[] = [];
    const original = MessageHistory.prototype.replaceMessages;
    vi.spyOn(MessageHistory.prototype, "replaceMessages").mockImplementation(function (
      this: MessageHistory,
      next: Message[],
      reason?: string,
    ) {
      reasons.push(reason ?? "replace");
      return original.call(this, next, reason);
    });
    const provider = scriptedProvider(
      [
        toolCalls(["c1", "render_many", { tag: 1 }]),
        toolCalls(["c2", "render_many", { tag: 2 }]),
        textReply("確認しました。"),
      ],
      requests,
      true,
    );
    const loop = makeLoop(provider, registry, dir);
    await loop.refreshImageInput();
    await loop.run("描画を確かめてください？");

    expect(reasons).toContain("image-retire");
    const last = requests.at(-1)?.messages as Message[];
    expect(countLiveImages(last)).toBe(3);
    // 最初の運び役は残り (対は保つ)、 画像だけ置き換え文になっている
    const carriers = last.filter(isToolImageNote);
    expect(carriers).toHaveLength(2);
    expect(JSON.stringify(carriers[0].content)).toContain("文脈から外しました");
    expect(findToolPairingError(last.filter((m) => m.role !== "system"))).toBeNull();
  });

  it("載せている画像の合計が容量の上限を超えたら、 古い画像を 1 回の書き換えで外し、 image-retire を申告する", async () => {
    const requests: ChatWithToolsParams[] = [];
    const registry = new ToolRegistry();
    // 1 枚 約 40KB (base64) の画像を 1 回に 2 枚返す。 上限 100KB なら 2 回目で 4 枚 = 160KB になり超える
    const oneImage = Buffer.alloc(30_000, 7).toString("base64");
    let n = 0;
    registry.register({
      name: "render_pair",
      definition: {
        type: "function",
        function: { name: "render_pair", description: "test", parameters: { type: "object", properties: {} } },
      },
      execute: async (_params, context) => {
        expect(context?.imageInput?.budgetBytes).toBe(100_000);
        const images = [0, 1].map((i) => ({
          mimeType: "image/png" as const,
          data: oneImage,
          label: `${dir}/p${n}-${i}.png`,
        }));
        n++;
        return { success: true, output: "rendered 2", images };
      },
    });
    const reasons: string[] = [];
    const original = MessageHistory.prototype.replaceMessages;
    vi.spyOn(MessageHistory.prototype, "replaceMessages").mockImplementation(function (
      this: MessageHistory,
      next: Message[],
      reason?: string,
    ) {
      reasons.push(reason ?? "replace");
      return original.call(this, next, reason);
    });
    const provider = scriptedProvider(
      [
        toolCalls(["c1", "render_pair", { tag: 1 }]),
        toolCalls(["c2", "render_pair", { tag: 2 }]),
        textReply("確認しました。"),
      ],
      requests,
      true,
    );
    const loop = makeLoop(provider, registry, dir);
    loop.setLiveBinding({ providerType: "gufo", model: "test-model-7b", visionImageBudgetBytes: 100_000 });
    expect((await loop.refreshImageInput()).budgetBytes).toBe(100_000);
    await loop.run("描画を確かめてください？");

    expect(reasons).toContain("image-retire");
    const last = requests.at(-1)?.messages as Message[];
    expect(liveImageBytes(last)).toBeLessThanOrEqual(100_000);
    expect(countLiveImages(last)).toBe(2);
    const carriers = last.filter(isToolImageNote);
    expect(JSON.stringify(carriers[0].content)).toContain("載せている画像の合計が");
    expect(JSON.stringify(carriers[0].content)).toContain("p0-0.png");
    expect(findToolPairingError(last.filter((m) => m.role !== "system"))).toBeNull();
  });

  it("413 (本文が大きすぎる) は、 原因と送った大きさと直し方を示す", () => {
    const hint = describeRequestTooLarge(
      new Error('HTTP 413 {"error":{"message":"request body is too large","code":"payload_too_large"}}'),
      8_500_000,
    );
    expect(hint).toContain("8.1MB");
    expect(hint).toContain("画像");
    expect(hint).toContain("/compact");
    expect(hint).toContain("mainLLM.visionImageBudgetBytes");
    // 本文が大きいときに接続が切れた (fetch failed) ときも大きさを疑わせる。 小さければ何も足さない
    expect(describeRequestTooLarge(new Error("TypeError: fetch failed"), 7 * 1024 * 1024)).toContain("接続を切った");
    expect(describeRequestTooLarge(new Error("TypeError: fetch failed"), 100_000)).toBeNull();
    expect(describeRequestTooLarge(new Error("HTTP 500 boom"), 9_000_000)).toBeNull();
  });
});
