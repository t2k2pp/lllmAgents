import type { ToolDefinition } from "../providers/base-provider.js";
export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
    abortExecution?: boolean;
    /** ユーザー向け表示データ（LLMには送らない）。file_edit/file_writeのdiff表示等に使用 */
    userDisplay?: {
        type: "edit-diff" | "write-diff";
        filePath: string;
        oldString?: string;
        newString?: string;
        oldContent?: string | null;
        newContent?: string;
        occurrences?: number;
    };
}
export interface ToolHandler {
    name: string;
    definition: ToolDefinition;
    execute(params: Record<string, unknown>): Promise<ToolResult>;
}
export declare class ToolRegistry {
    private tools;
    register(handler: ToolHandler): void;
    get(name: string): ToolHandler | undefined;
    getDefinitions(): ToolDefinition[];
    getToolNames(): string[];
}
//# sourceMappingURL=tool-registry.d.ts.map