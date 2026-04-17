import type { ToolHandler } from "../tool-registry.js";
export interface TodoItem {
    content: string;
    status: "pending" | "in_progress" | "completed";
}
export declare function getTodos(): TodoItem[];
export declare function formatTodos(): string;
export declare const todoWriteTool: ToolHandler;
//# sourceMappingURL=todo-write.d.ts.map