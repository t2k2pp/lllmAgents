import type { ToolHandler, ToolResult } from "../tool-registry.js";
import type { SearchConfig } from "../../config/types.js";

/**
 * Web search tool.
 * Supports explicitly configured SearXNG or DuckDuckGo HTML.
 */
export interface WebSearchRuntimeOptions {
  /** 同じSearXNGへ並列burstを送らないためのrequest開始間隔。テストでは0にできる。 */
  searxngMinIntervalMs?: number;
  /** engine障害下の0件を同じproviderで1回だけ再試行するまでの待機。 */
  degradedRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type SearchProvider = SearchConfig["provider"];

const DEFAULT_SEARXNG_MIN_INTERVAL_MS = 750;
const DEFAULT_DEGRADED_RETRY_DELAY_MS = 1_250;

export function createWebSearchTool(
  searchConfig?: SearchConfig,
  runtimeOptions: WebSearchRuntimeOptions = {},
): ToolHandler {
  const configuredProvider = searchConfig?.provider ?? "duckduckgo";
  const searxngUrl = searchConfig?.searxngUrl ?? "http://localhost:8888";
  const sleep = runtimeOptions.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runSearXNGSerial = createSerialScheduler(
    runtimeOptions.searxngMinIntervalMs ?? DEFAULT_SEARXNG_MIN_INTERVAL_MS,
    sleep,
  );

  return {
    name: "web_search",
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description:
          `Webを検索して結果を返します。設定provider: ${configuredProvider}。` +
          "0件やprovider劣化は情報不存在の証明ではありません。固有名だけの広いquery、別providerの明示override、" +
          "既知URLのweb_fetch/browserを順に試してから結論してください。",
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
            provider: {
              type: "string",
              enum: ["configured", "duckduckgo", "searxng"],
              description:
                "この1回だけ使う検索provider。configured（既定）は設定値を使用。明示overrideは設定を変更せず、自動fallbackもしない",
            },
          },
          required: ["query"],
        },
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const query = params.query as string;
      const maxResults = (params.max_results as number) ?? 5;
      const requestedProvider = params.provider as SearchProvider | "configured" | undefined;
      const activeProvider =
        requestedProvider && requestedProvider !== "configured" ? requestedProvider : configuredProvider;
      const providerLabel =
        requestedProvider && requestedProvider !== "configured"
          ? `Explicit per-call search provider '${activeProvider}'`
          : `Configured search provider '${activeProvider}'`;

      try {
        if (activeProvider === "searxng") {
          return await runSearXNGSerial(async () => {
            try {
              return await searchSearXNG(searxngUrl, query, maxResults);
            } catch (error) {
              if (!(error instanceof SearchCoverageError)) throw error;
              await sleep(runtimeOptions.degradedRetryDelayMs ?? DEFAULT_DEGRADED_RETRY_DELAY_MS);
              return await searchSearXNG(searxngUrl, query, maxResults);
            }
          });
        }
        return await searchDuckDuckGo(query, maxResults);
      } catch (e) {
        return {
          success: false,
          output: "",
          error:
            `${providerLabel} failed: ${String(e)}. ` +
            "This is not evidence that the information does not exist. Retry a broader core-entity query, then explicitly call " +
            `web_search with provider: "${activeProvider === "searxng" ? "duckduckgo" : "searxng"}" for independent coverage. ` +
            "The configured provider was not changed and another provider was not used automatically.",
          errorKind: "transient",
        };
      }
    },
  };
}

function createSerialScheduler(minIntervalMs: number, sleep: (ms: number) => Promise<void>) {
  let tail: Promise<void> = Promise.resolve();
  let nextStartAt = 0;

  return function schedule<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      const waitMs = Math.max(0, nextStartAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      nextStartAt = Date.now() + Math.max(0, minIntervalMs);
      return await operation();
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

class SearchCoverageError extends Error {
  override name = "SearchCoverageError";
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
  const engineIssues = formatEngineIssues(data.unresponsive_engines);

  if (results.length === 0) {
    if (engineIssues) {
      throw new SearchCoverageError(
        `SearXNG returned zero results while upstream engines were unavailable (${engineIssues}). ` +
          "この0件は情報が存在しない根拠にはなりません。",
      );
    }
    return {
      success: true,
      output:
        `No results found for: ${query} (via SearXNG; engines reported healthy). ` +
        "This is query/provider-limited evidence; broaden to the core entity before concluding absence.",
    };
  }

  const output = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content ?? ""}`).join("\n\n");

  return {
    success: true,
    output:
      `Search results for "${query}" (via SearXNG, ${data.number_of_results ?? "?"} total):\n\n${output}` +
      (engineIssues ? `\n\nCoverage warning: some engines were unavailable (${engineIssues}).` : ""),
  };
}

function formatEngineIssues(issues: SearXNGResponse["unresponsive_engines"]): string {
  return (issues ?? [])
    .slice(0, 8)
    .map(([engine, reason]) => `${engine}: ${reason}`)
    .join("; ");
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
  unresponsive_engines?: Array<[engine: string, reason: string]>;
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
    if (/captcha|anomaly|automated requests|bots use duckduckgo/i.test(html)) {
      throw new SearchCoverageError("DuckDuckGo returned a bot-check/CAPTCHA page instead of search results.");
    }
    return {
      success: true,
      output:
        `No results found for: ${query} (via DuckDuckGo). ` +
        "This is query/provider-limited evidence; broaden to the core entity before concluding absence.",
    };
  }

  const output = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");

  return { success: true, output: `Search results for "${query}" (via DuckDuckGo):\n\n${output}` };
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
