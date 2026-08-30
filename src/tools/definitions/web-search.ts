import type { ToolHandler, ToolResult } from "../tool-registry.js";
import type { SearchConfig } from "../../config/types.js";

/**
 * Web search tool.
 * Supports explicitly configured SearXNG or DuckDuckGo HTML.
 */
export function createWebSearchTool(searchConfig?: SearchConfig): ToolHandler {
  const provider = searchConfig?.provider ?? "duckduckgo";
  const searxngUrl = searchConfig?.searxngUrl ?? "http://localhost:8888";

  return {
    name: "web_search",
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description: `Webを検索して結果を返します。プロバイダー: ${provider}`,
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
        if (provider === "searxng") {
          return await searchSearXNG(searxngUrl, query, maxResults);
        }
        return await searchDuckDuckGo(query, maxResults);
      } catch (e) {
        return {
          success: false,
          output: "",
          error:
            `Configured search provider '${provider}' failed: ${String(e)}. ` +
            "Check that provider, or explicitly change search.provider in config; another provider was not used automatically.",
          errorKind: "transient",
        };
      }
    },
  };
}

// 後方互換: 既存の名前付きエクスポート (DuckDuckGoデフォルト)
export const webSearchTool = createWebSearchTool();

// ── SearXNG ──────────────────────────────────────────────

async function searchSearXNG(baseUrl: string, query: string, maxResults: number): Promise<ToolResult> {
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`SearXNG API error: HTTP ${res.status}`);
  }

  const data = (await res.json()) as SearXNGResponse;
  const results = (data.results ?? []).slice(0, maxResults);

  if (results.length === 0) {
    return { success: true, output: `No results found for: ${query}` };
  }

  const output = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content ?? ""}`).join("\n\n");

  return {
    success: true,
    output: `Search results for "${query}" (via SearXNG, ${data.number_of_results ?? "?"} total):\n\n${output}`,
  };
}

interface SearXNGResponse {
  query: string;
  number_of_results?: number;
  results: Array<{
    title: string;
    url: string;
    content?: string;
    engine: string;
  }>;
}

// ── DuckDuckGo (既存) ────────────────────────────────────

async function searchDuckDuckGo(query: string, maxResults: number): Promise<ToolResult> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "LocalLLM-Agent/0.1 (CLI Agent)",
        Accept: "text/html",
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return { success: false, output: "", error: `Search failed: HTTP ${res.status}` };
  }

  const html = await res.text();
  const results = parseSearchResults(html, maxResults);

  if (results.length === 0) {
    return { success: true, output: `No results found for: ${query}` };
  }

  const output = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");

  return { success: true, output: `Search results for "${query}":\n\n${output}` };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseSearchResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const titleMatches = [...html.matchAll(resultPattern)];
  const snippetMatches = [...html.matchAll(snippetPattern)];

  for (let i = 0; i < Math.min(titleMatches.length, max); i++) {
    const titleMatch = titleMatches[i];
    const snippetMatch = snippetMatches[i];

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
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}
