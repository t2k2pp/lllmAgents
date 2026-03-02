import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const webFetchTool: ToolHandler = {
  name: "web_fetch",
  definition: {
    type: "function",
    function: {
      name: "web_fetch",
      description: "URLからWebページの内容を取得し、テキストとして返します。HTMLはプレーンテキストに変換されます。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "取得するURL",
          },
          prompt: {
            type: "string",
            description: "取得したコンテンツに対する質問や指示（省略可）",
          },
        },
        required: ["url"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params.url as string;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "LocalLLM-Agent/0.1 (CLI Agent)",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json",
        },
      });
      clearTimeout(timer);

      if (!res.ok) {
        return { success: false, output: "", error: `HTTP ${res.status}: ${res.statusText}` };
      }

      const contentType = res.headers.get("content-type") ?? "";
      let text: string;

      if (contentType.includes("application/json")) {
        const json = await res.json();
        text = JSON.stringify(json, null, 2);
      } else {
        const html = await res.text();
        text = stripHtml(html);
      }

      // Truncate if too large
      const maxLen = 30000;
      if (text.length > maxLen) {
        text = text.slice(0, maxLen) + "\n... (truncated)";
      }

      const prompt = params.prompt as string | undefined;
      const output = prompt
        ? `[URL: ${url}]\n[Prompt: ${prompt}]\n\n${text}`
        : `[URL: ${url}]\n\n${text}`;

      return { success: true, output };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};

function stripHtml(html: string): string {
  // Remove scripts, styles, and non-visible elements
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");

  // Convert block elements to newlines
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<(hr)\s*\/?>/gi, "\n---\n");

  // Convert links to markdown-ish format
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
