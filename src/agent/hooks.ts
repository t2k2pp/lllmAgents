import type { ToolCall } from "../providers/base-provider.js";
import type { ToolResult } from "../tools/tool-registry.js";

export type HookEvent =
  | "session_start"
  | "session_end"
  | "pre_tool_use"
  | "post_tool_use"
  | "pre_compact";

export type HookHandler = (context: HookContext) => Promise<HookAction>;

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolResult?: ToolResult;
  toolCall?: ToolCall;
}

export type HookAction = "continue" | "block" | "warn";

export class HookManager {
  private hooks = new Map<HookEvent, HookHandler[]>();

  register(event: HookEvent, handler: HookHandler): void {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    this.hooks.get(event)!.push(handler);
  }

  async emit(context: HookContext): Promise<HookAction> {
    const handlers = this.hooks.get(context.event) ?? [];
    for (const handler of handlers) {
      const action = await handler(context);
      if (action === "block") return "block";
      if (action === "warn") return "warn";
    }
    return "continue";
  }

  hasHooks(event: HookEvent): boolean {
    return (this.hooks.get(event)?.length ?? 0) > 0;
  }
}

// Global hook manager instance
export const hookManager = new HookManager();
