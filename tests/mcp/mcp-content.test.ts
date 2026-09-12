import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
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
      }),
    ).toBe('done\nunity://scene\nCube\n{"saved":true}');
  });
  it("saves image bytes without putting base64 into the model context", () => {
    const bytes = Buffer.from("image fixture bytes");
    const output = renderMcpResult({
      content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" }],
    });
    const file = output.split("\n")[0].slice("MCP image saved: ".length);
    try {
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect(path.extname(file)).toBe(".jpg");
      expect(output).toContain("NOT been visually verified");
      expect(output).not.toContain(bytes.toString("base64"));
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
