import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "../../src/tools/definitions/web-search.js";

afterEach(() => vi.unstubAllGlobals());

describe("web_search provider failure policy", () => {
  it("明示したSearXNGが失敗してもDuckDuckGoへ自動置換しない", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("searxng offline"));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createWebSearchTool({ provider: "searxng", searxngUrl: "http://127.0.0.1:8888" });

    const result = await tool.execute({ query: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Configured search provider 'searxng' failed");
    expect(result.error).toContain("another provider was not used automatically");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
