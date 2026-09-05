import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "../../src/tools/definitions/web-search.js";

afterEach(() => vi.unstubAllGlobals());

const searchConfig = { provider: "searxng" as const, searxngUrl: "http://127.0.0.1:8888" };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("web_search provider failure policy", () => {
  it("明示したSearXNGが失敗してもDuckDuckGoへ自動置換しない", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("searxng offline"));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createWebSearchTool(searchConfig);

    const result = await tool.execute({ query: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Configured search provider 'searxng' failed");
    expect(result.error).toContain("another provider was not used automatically");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SearXNGがengine障害下で0件なら同providerを1回再試行し、情報不存在の成功にしない", async () => {
    const degraded = {
      query: "OpenAI Astra",
      results: [],
      unresponsive_engines: [
        ["brave", "too many requests"],
        ["duckduckgo", "CAPTCHA"],
      ],
    };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(degraded)));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createWebSearchTool(searchConfig, { searxngMinIntervalMs: 0, degradedRetryDelayMs: 0 });

    const result = await tool.execute({ query: "OpenAI Astra" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.errorKind).toBe("transient");
    expect(result.error).toContain("brave: too many requests");
    expect(result.error).toContain("情報が存在しない根拠にはなりません");
    expect(result.error).toContain('provider: "duckduckgo"');
  });

  it("並列のSearXNG検索を直列化して同一instanceへのburstを防ぐ", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(jsonResponse({ query: "first", results: [] }));
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(jsonResponse({ query: "second", results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createWebSearchTool(searchConfig, { searxngMinIntervalMs: 0, degradedRetryDelayMs: 0 });

    const first = tool.execute({ query: "first" });
    const second = tool.execute({ query: "second" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("設定を変更せず1回の検索だけDuckDuckGoへ明示overrideできる", async () => {
    const html = `
      <a class="result__a" href="https://example.com/astra">Astra result</a>
      <a class="result__snippet">Latest Astra report</a>`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(html, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createWebSearchTool(searchConfig, { searxngMinIntervalMs: 0, degradedRetryDelayMs: 0 });
    const providerSchema = tool.definition.function.parameters.properties.provider as { enum?: string[] };

    const result = await tool.execute({ query: "OpenAI Astra", provider: "duckduckgo" });

    expect(providerSchema.enum).toEqual(["configured", "duckduckgo", "searxng"]);
    expect(tool.definition.function.description).toContain("0件やprovider劣化は情報不存在の証明ではありません");
    expect(result.success).toBe(true);
    expect(result.output).toContain("via DuckDuckGo");
    expect(result.output).toContain("Astra result");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("html.duckduckgo.com");
  });
});
