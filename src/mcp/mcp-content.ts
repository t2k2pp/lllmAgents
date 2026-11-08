import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { MCPToolCallResult } from "./types.js";
import type { ImageAttachment, ToolExecutionContext } from "../tools/tool-registry.js";
import { imageInputUnavailableNote, isImageMime, prepareImageForModel } from "../tools/image-attachment.js";

/** MCP の結果を会話に入れる形にしたもの: 文字と、 メインのモデルが見る画像 */
export interface RenderedMcpResult {
  text: string;
  images: ImageAttachment[];
}

/**
 * MCP の結果をツール結果にする (docs/in-context-vision-design.md §8)。
 * 画像は検査してから一時ファイルに保存する (退役した後に file_read で読み直せるように)。
 * メインのモデルが画像を見られるとき (context.imageInput.mode === "on") は画像を添付にし、
 * 見られないときは今までどおりファイルのパスと vision_analyze の案内を返す (base64 は文字にしない)。
 */
export async function renderMcpResult(
  result: MCPToolCallResult,
  context?: ToolExecutionContext,
): Promise<RenderedMcpResult> {
  const parts: string[] = [];
  const images: ImageAttachment[] = [];
  const state = context?.imageInput;
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
      if (state?.mode === "on" && isImageMime(block.mimeType)) {
        // 長辺を縮めて小さい形式に書き直す。 1 枚で載せられる量を超えたら載せずに理由を書く (docs/in-context-vision-design.md §3.1)
        const prepared = await prepareImageForModel(bytes, block.mimeType, file, state);
        if (prepared.ok) {
          images.push({ ...prepared.attachment, label: `${file} (${prepared.note})` });
          parts.push(
            `MCP image saved: ${file}\nThe image is attached after this tool result (${prepared.note}). Look at it yourself and check it against the task.`,
          );
        } else {
          parts.push(`MCP image saved: ${file}\n[画像] ${prepared.reason}`);
        }
      } else {
        parts.push(
          `MCP image saved: ${file}\nImage has NOT been visually verified. Use vision_analyze with image_path and a configured vision model. Remove the temporary image when no longer needed.\n${imageInputUnavailableNote(context)}`,
        );
      }
    } else throw new Error(`Unsupported MCP content: ${block.type}. Request text or PNG/JPEG/WebP output.`);
  }
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return { text: parts.join("\n"), images };
}
