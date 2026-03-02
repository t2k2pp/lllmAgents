import type { ToolDefinition } from "../providers/base-provider.js";

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ToolHandler {
  name: string;
  definition: ToolDefinition;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.tools.set(handler.name, handler);
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
