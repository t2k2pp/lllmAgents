import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { MCPToolCallResult } from "./types.js";

/** Keep binary payloads out of a local text model's context; expose real image files to vision_analyze. */
export function renderMcpResult(result: MCPToolCallResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text") parts.push(block.text ?? "");
    else if (block.type === "resource" && typeof block.resource?.text === "string") {
      parts.push(`${block.resource.uri}\n${block.resource.text}`);
    } else if (block.type === "image") {
      const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
      const extension = extensions[block.mimeType ?? ""];
      if (!extension || !block.data || block.data.length > 28_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) {
        throw new Error("MCP image is invalid or exceeds 20 MiB. Request a smaller PNG/JPEG/WebP image.");
      }
      const bytes = Buffer.from(block.data, "base64");
      if (bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== block.data)
        throw new Error("Invalid MCP image encoding");
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "localllm-mcp-image-"));
      const file = path.join(directory, `image.${extension}`);
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      parts.push(
        `MCP image saved: ${file}\nImage has NOT been visually verified. Use vision_analyze with image_path and a configured vision model. Remove the temporary image when no longer needed.`,
      );
    } else throw new Error(`Unsupported MCP content: ${block.type}. Request text or PNG/JPEG/WebP output.`);
  }
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}
