import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT_ANCESTORS } from "../../src/agent/delegation-context.js";
import { renderMcpResult } from "../../src/mcp/mcp-content.js";

describe("MCP local model content", () => {
  it("preserves structured and embedded text", () => {
    expect(
      renderMcpResult({
        content: [
          { type: "text", text: "done" },
          { type: "resource", resource: { uri: "unity://scene", text: "Cube" } },
        ],
        structuredContent: { saved: true },
      }).text,
    ).toBe('done\nunity://scene\nCube\n{"saved":true}');
  });
  it("saves image bytes without putting base64 into the model context", () => {
    const bytes = Buffer.from("image fixture bytes");
    const rendered = renderMcpResult({
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
  it("attaches MCP images when the main model can see images (and still saves the file for re-reading)", () => {
    const bytes = Buffer.from("png fixture bytes");
    const rendered = renderMcpResult(
      { content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] },
      { ancestors: ROOT_ANCESTORS, imageInput: { mode: "on", source: "config", detail: "test" } },
    );
    const file = rendered.text.split("\n")[0].slice("MCP image saved: ".length);
    try {
      expect(rendered.images).toHaveLength(1);
      expect(rendered.images[0]).toEqual({ mimeType: "image/png", data: bytes.toString("base64"), label: file });
      expect(rendered.text).toContain("attached after this tool result");
      expect(rendered.text).not.toContain(bytes.toString("base64"));
      expect(fs.readFileSync(file)).toEqual(bytes);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true });
    }
  });
  it("explains why images are not shown when the main model cannot see them", () => {
    const bytes = Buffer.from("png fixture bytes");
    const rendered = renderMcpResult(
      { content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] },
      { ancestors: ROOT_ANCESTORS, imageInput: { mode: "off", source: "provider", detail: "m: 非対応" } },
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
  it("fails loudly for unusable content", () => {
    expect(() => renderMcpResult({ content: [{ type: "image", data: "?", mimeType: "image/png" }] })).toThrow(
      "invalid",
    );
    expect(() => renderMcpResult({ content: [{ type: "resource" }] })).toThrow("Unsupported");
  });
});
