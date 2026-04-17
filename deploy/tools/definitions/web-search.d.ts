import type { ToolHandler } from "../tool-registry.js";
import type { SearchConfig } from "../../config/types.js";
/**
 * Web search tool.
 * Supports SearXNG (JSON API) and DuckDuckGo HTML (fallback).
 */
export declare function createWebSearchTool(searchConfig?: SearchConfig): ToolHandler;
export declare const webSearchTool: ToolHandler;
//# sourceMappingURL=web-search.d.ts.map