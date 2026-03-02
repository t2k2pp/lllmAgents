import type { ToolHandler, ToolResult } from "../tool-registry.js";

/**
 * Web search using DuckDuckGo HTML (no API key required).
 * Falls back to a simple scrape of search results.
 */
export const webSearchTool: ToolHandler = {
  name: "web_search",
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description: "Webを検索して結果を返します。DuckDuckGoを使用します。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "検索クエリ",
          },
          max_results: {
            type: "number",
            description: "最大結果数（デフォルト: 5）",
          },
        },
        required: ["query"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = params.query as string;
    const maxResults = (params.max_results as number) ?? 5;

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "LocalLLM-Agent/0.1 (CLI Agent)",
          Accept: "text/html",
        },
      });
      clearTimeout(timer);

      if (!res.ok) {
        return { success: false, output: "", error: `Search failed: HTTP ${res.status}` };
      }

      const html = await res.text();
      const results = parseSearchResults(html, maxResults);

      if (results.length === 0) {
        return { success: true, output: `No results found for: ${query}` };
      }

      const output = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      return { success: true, output: `Search results for "${query}":\n\n${output}` };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseSearchResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results pattern
  const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const titleMatches = [...html.matchAll(resultPattern)];
  const snippetMatches = [...html.matchAll(snippetPattern)];

  for (let i = 0; i < Math.min(titleMatches.length, max); i++) {
    const titleMatch = titleMatches[i];
    const snippetMatch = snippetMatches[i];

    // Extract URL from DuckDuckGo redirect
    let url = titleMatch[1];
    const udParam = url.match(/uddg=([^&]*)/);
    if (udParam) {
      url = decodeURIComponent(udParam[1]);
    }

    results.push({
      title: stripTags(titleMatch[2]).trim(),
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]).trim() : "",
    });
  }

  return results;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
}
