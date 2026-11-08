import * as fs from "node:fs";
import * as path from "node:path";
import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";
import { ROOT_ANCESTORS } from "../../src/agent/delegation-context.js";
import { renderMcpResult } from "../../src/mcp/mcp-content.js";
import type { ImageInputState } from "../../src/tools/tool-registry.js";

const ON: ImageInputState = {
  mode: "on",
  source: "config",
  detail: "test",
  maxLongSide: 1280,
  budgetBytes: 4 * 1024 * 1024,
};

describe("MCP local model content", () => {
  it("preserves structured and embedded text", async () => {
    const rendered = await renderMcpResult({
      content: [
        { type: "text", text: "done" },
        { type: "resource", resource: { uri: "unity://scene", text: "Cube" } },
      ],
      structuredContent: { saved: true },
    });
    expect(rendered.text).toBe('done\nunity://scene\nCube\n{"saved":true}');
  });
  it("saves image bytes without putting base64 into the model context", async () => {
    const bytes = Buffer.from("image fixture bytes");
    const rendered = await renderMcpResult({
      content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" }],
    });
    const output = rendered.text;
    expect(rendered.images).toEqual([]);
    const file = output.split("\n")[0].slice("MCP image saved: ".length);
    try {
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect(path.extname(file)).toBe(".jpg");
      expect(output).toContain("NOT been visually verified");
      expect(output).not.toContain(bytes.toString("base64"));
      // 見られない経路 (状態の無い context) はそのことを名指しで書く
      expect(output).toContain("画像を会話に載せません");
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true });
    }
  });
  it("attaches MCP images (downscaled) when the main model can see images, and still saves the file", async () => {
    const big = await new Jimp({ width: 2000, height: 1000, color: 0x88aaccff }).getBuffer("image/png");
    const rendered = await renderMcpResult(
      { content: [{ type: "image", data: big.toString("base64"), mimeType: "image/png" }] },
      { ancestors: ROOT_ANCESTORS, imageInput: ON },
    );
    const file = rendered.text.split("\n")[0].slice("MCP image saved: ".length);
    try {
      expect(rendered.images).toHaveLength(1);
      expect(rendered.images[0].label.startsWith(file)).toBe(true);
      expect(rendered.images[0].label).toContain("元 2000×1000 PNG");
      expect(rendered.images[0].label).toContain("送る 1280×640");
      const sent = await Jimp.read(Buffer.from(rendered.images[0].data, "base64"));
      expect(Math.max(sent.width, sent.height)).toBe(1280);
      expect(rendered.text).toContain("attached after this tool result");
      expect(rendered.text).not.toContain(rendered.images[0].data);
      expect(fs.readFileSync(file)).toEqual(big);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true });
    }
  });
  it("names the reason when one image is over the budget even after re-encoding", async () => {
    const png = await new Jimp({ width: 64, height: 64, color: 0x112233ff }).getBuffer("image/png");
    const rendered = await renderMcpResult(
      { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] },
      { ancestors: ROOT_ANCESTORS, imageInput: { ...ON, budgetBytes: 10 } },
    );
    const file = rendered.text.split("\n")[0].slice("MCP image saved: ".length);
    try {
      expect(rendered.images).toEqual([]);
      expect(rendered.text).toContain("mainLLM.visionImageBudgetBytes");
      expect(rendered.text).toContain("載せていません");
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true });
    }
  });
  it("explains why images are not shown when the main model cannot see them", async () => {
    const bytes = Buffer.from("png fixture bytes");
    const rendered = await renderMcpResult(
      { content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] },
      { ancestors: ROOT_ANCESTORS, imageInput: { ...ON, mode: "off", source: "provider", detail: "m: 非対応" } },
    );
    const file = rendered.text.split("\n")[0].slice("MCP image saved: ".length);
    try {
      expect(rendered.images).toEqual([]);
      expect(rendered.text).toContain("メインのモデルは画像を見られない設定です (m: 非対応)");
      expect(rendered.text).toContain("vision_analyze");
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true });
    }
  });
  it("fails loudly for unusable content", async () => {
    await expect(renderMcpResult({ content: [{ type: "image", data: "?", mimeType: "image/png" }] })).rejects.toThrow(
      "invalid",
    );
    await expect(renderMcpResult({ content: [{ type: "resource" }] })).rejects.toThrow("Unsupported");
  });
});
