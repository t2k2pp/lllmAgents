import type { ToolHandler, ToolResult } from "../tool-registry.js";
import { requestPublicText } from "../../security/public-http.js";

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
      const res = await requestPublicText(url);
      if (res.status < 200 || res.status >= 300) {
        return { success: false, output: "", error: `HTTP ${res.status}: ${res.statusText}` };
      }

      const contentType = res.headers["content-type"] ?? "";
      let text: string;

      if (contentType.includes("application/json")) {
        const json = JSON.parse(res.body);
        text = JSON.stringify(json, null, 2);
      } else {
        text = stripHtml(res.body, res.finalUrl);
      }

      // Truncate if too large
      const maxLen = 30000;
      const truncated = text.length > maxLen;
      if (truncated) {
        text = text.slice(0, maxLen) + "\n... (truncated)";
      }

      const prompt = params.prompt as string | undefined;
      const output = prompt ? `[URL: ${url}]\n[Prompt: ${prompt}]\n\n${text}` : `[URL: ${url}]\n\n${text}`;

      return { success: true, output };
    } catch (e) {
      return { success: false, output: "", error: `セキュリティ/取得エラー: ${String(e)}` };
    }
  },
};

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function stripHtml(html: string, baseUrl?: string): string {
  // Remove non-content elements (scripts, styles, SVG, JSON-LD)
  // Note: <header>, <nav>, <footer> are intentionally NOT removed,
  // as they may contain important content on some sites (e.g. NHK News).
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, "");

  // Resolve relative URLs to absolute before converting links to text
  if (baseUrl) {
    text = text.replace(/<a([^>]*)\shref="([^"]*)"([^>]*)>/gi, (_match, before, href, after) => {
      const resolved = resolveUrl(href, baseUrl);
      return `<a${before} href="${resolved}"${after}>`;
    });
    text = text.replace(/<img([^>]*)\ssrc="([^"]*)"([^>]*)>/gi, (_match, before, src, after) => {
      const resolved = resolveUrl(src, baseUrl);
      return `<img${before} src="${resolved}"${after}>`;
    });
  }

  // Convert block elements to newlines
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|header|footer|nav|section|article|main)>/gi, "\n")
    .replace(/<(hr)\s*\/?>/gi, "\n---\n");

  // Convert links: "text [→URL]" format (avoids duplication)
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href, linkText) => {
    const cleanText = linkText.replace(/<[^>]+>/g, "").trim();
    if (!cleanText || cleanText === href) return href;
    return `${cleanText} [→${href}]`;
  });

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
