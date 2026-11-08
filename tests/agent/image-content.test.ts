import { describe, expect, it } from "vitest";
import {
  buildToolImageNote,
  contentToText,
  countLiveImages,
  formatImageInputLine,
  IMAGE_TOKEN_ESTIMATE,
  isToolImageNote,
  resolveImageInput,
  retireImagesInMessage,
  retireOldImages,
  type ToolImage,
} from "../../src/agent/image-content.js";
import { buildTranscript } from "../../src/agent/handoff.js";
import { sanitizeLogValue } from "../../src/agent/llm-logger.js";
import { MessageHistory } from "../../src/agent/message-history.js";
import { buildRecentSummary } from "../../src/agent/progress-judge.js";
import { applyReductionStages } from "../../src/agent/reduction-stages.js";
import { estimateMessageTokens } from "../../src/agent/token-counter.js";
import type { Message } from "../../src/providers/base-provider.js";

/** 長い base64 (漏れたらすぐ分かる長さ) */
const BIG_B64 = "QUJD".repeat(50_000);

function img(label: string, toolName = "file_read"): ToolImage {
  return { toolName, image: { mimeType: "image/png", data: BIG_B64, label } };
}

function note(...labels: string[]): Message {
  return { role: "user", content: buildToolImageNote(labels.map((l) => img(l))), ephemeral: true };
}

describe("画像の運び役 (docs/in-context-vision-design.md §4)", () => {
  it("先頭の文字で利用者の発言ではないと示し、 各画像の前に見出しを置く", () => {
    const parts = buildToolImageNote([img("C:/r/a.png"), img("C:/r/b.png", "mcp_blender_render")]);
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("利用者の発言ではありません");
    expect(parts[0].text).toContain("画像 2: mcp_blender_render — C:/r/b.png");
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2);
    expect(parts[1]).toEqual({ type: "text", text: "[画像 1] C:/r/a.png" });
    expect(parts[2].image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(isToolImageNote({ role: "user", content: parts })).toBe(true);
    expect(isToolImageNote({ role: "user", content: "[ハーネス] 画像の添付" })).toBe(false);
  });

  it("載せきれない画像は名前を挙げて載せていないと書く", () => {
    const parts = buildToolImageNote([img("a")], [img("z1"), img("z2")]);
    expect(parts[0].text).toContain("次の 2 枚は載せていません");
    expect(parts[0].text).toContain("z2");
  });
});

describe("推定トークン数 (§5)", () => {
  it("画像 1 枚を決まった数で数え、 base64 の長さで数えない", () => {
    const withImage = estimateMessageTokens([note("a.png")]);
    const textOnly = estimateMessageTokens([
      { role: "user", content: [{ type: "text", text: (note("a.png").content as { text?: string }[])[0].text }] },
    ]);
    expect(withImage - textOnly).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
    expect(withImage).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 1_000);
    // base64 の長さ (20 万文字) なら 5 万トークン以上になる
    expect(BIG_B64.length / 4).toBeGreaterThan(40_000);
  });
});

describe("本文を文字にする所で base64 を出さない (§4)", () => {
  const history: Message[] = [
    { role: "user", content: "狼を作って" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "file_read", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "[file_read] 画像" },
    note("C:/r/wolf.png"),
  ];

  it("contentToText は画像を置き換え文にする", () => {
    const text = contentToText(history[3].content);
    expect(text).not.toContain(BIG_B64.slice(0, 100));
    expect(text).toMatch(/\[画像: image\/png \d+B\]/);
  });

  it("引き継ぎのダイジェスト・意図分類の文脈・進み具合の要約・ログに base64 が入らない", () => {
    const h = new MessageHistory("sys");
    for (const m of history) {
      if (m.role === "user") h.addUserMessage(m.content, { ephemeral: m.ephemeral });
      else if (m.role === "assistant") h.addAssistantMessage(m.content as string, m.tool_calls);
      else h.addToolResult(m.tool_call_id ?? "", m.content as string);
    }
    const leaks = [
      buildTranscript(history),
      h.getRecentContext(4),
      h.getFullText(),
      buildRecentSummary(history),
      JSON.stringify(sanitizeLogValue({ messages: history })),
    ];
    for (const text of leaks) expect(text).not.toContain(BIG_B64.slice(0, 100));
    expect(JSON.stringify(sanitizeLogValue({ messages: history }))).toMatch(/\[image image\/png \d+B\]/);
    // 進み具合の要約は「[ハーネス」 で始まる発言を除く
    expect(buildRecentSummary(history)).not.toContain("画像の添付");
  });
});

describe("画像の退役 (§6)", () => {
  it("新しい N 枚を残し、 古い画像を file_read で読み直せる置き換え文にする", () => {
    const msgs = [note("old1.png", "old2.png"), note("mid.png"), note("new1.png", "new2.png")];
    const out = retireOldImages(msgs, 3, "整理");
    expect(out.retired).toBe(2);
    expect(countLiveImages(out.messages)).toBe(3);
    expect(out.messages[1]).toBe(msgs[1]); // 変えないメッセージは同じ参照
    expect(out.messages[2]).toBe(msgs[2]);
    const retiredText = contentToText(out.messages[0].content);
    expect(retiredText).toContain("old1.png");
    expect(retiredText).toContain("file_read");
    expect(isToolImageNote(out.messages[0])).toBe(true);
  });

  it("1 件の中では古い (前の) 画像から外す", () => {
    const out = retireOldImages([note("a.png", "b.png", "c.png")], 1, "x");
    expect(out.retired).toBe(2);
    const text = contentToText(out.messages[0].content);
    expect(text).toContain("文脈から外しました (x): a.png");
    expect(text).toContain("文脈から外しました (x): b.png");
    expect(text).not.toContain("文脈から外しました (x): c.png");
  });

  it("整理の前処理は古い画像を退役させ、 枚数を返す (今の依頼の中でも)", () => {
    const messages: Message[] = [{ role: "user", content: "狼" }];
    for (let i = 0; i < 5; i++) messages.push(note(`r${i}.png`));
    const result = applyReductionStages({
      messages,
      currentRequestStart: 0,
      keepRecentToolUses: 1,
      promptTokens: 50_000,
      goal: { targetPromptTokens: 100_000, minimumReductionTokens: 1 },
    });
    expect(result.retiredImages).toBe(2);
    expect(countLiveImages(result.messages)).toBe(3);
    expect(result.freedTokens.preprocess).toBeGreaterThan(2 * 1000);
  });

  it("保存用に全部の画像を置き換え文にできる", () => {
    const m = retireImagesInMessage(note("a.png"), "セッションの保存");
    expect(countLiveImages([m])).toBe(0);
    expect(contentToText(m.content)).toContain("セッションの保存");
  });
});

describe("メインのモデルが画像を見られるかの判定 (§2)", () => {
  const provider = (answer: boolean | Error) => ({
    providerType: "gufo" as const,
    supportsVision: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });

  it("config の on/off は provider に問わずに決める", async () => {
    expect((await resolveImageInput(provider(new Error("x")), "m", "on")).mode).toBe("on");
    const off = await resolveImageInput(provider(true), "m", "off");
    expect(off).toMatchObject({ mode: "off", source: "config" });
  });

  it("auto は provider の答えを使い、 失敗は unknown (理由つき) にする", async () => {
    expect(await resolveImageInput(provider(true), "m", "auto")).toMatchObject({ mode: "on", source: "provider" });
    expect(await resolveImageInput(provider(false), "m", undefined)).toMatchObject({ mode: "off" });
    const unknown = await resolveImageInput(provider(new Error("503 loading")), "m", "auto");
    expect(unknown.mode).toBe("unknown");
    expect(unknown.detail).toContain("503 loading");
    expect(formatImageInputLine(unknown)).toContain("判定できず");
  });
});

describe("vision_analyze の問い (§9)", () => {
  it("いまのタスクの依頼の原文を前置きにする (無ければ問いだけ)", async () => {
    const { buildVisionPrompt } = await import("../../src/tools/definitions/vision.js");
    expect(buildVisionPrompt("目は頭の高さの何割か", undefined)).toBe("目は頭の高さの何割か");
    const withTask = buildVisionPrompt("目は頭の高さの何割か", "Blender で狼を作って");
    expect(withTask.indexOf("Blender で狼を作って")).toBeLessThan(withTask.indexOf("目は頭の高さの何割か"));
  });
});
