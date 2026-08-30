/**
 * lllmAgent の ToolHandler 群を Claude Agent SDK の in-process MCP tool に橋渡しする。
 *
 * 設計: docs/claude-agent-sdk-provider-design.md §3.3
 *
 * - 既存 ToolHandler の JSON Schema を Zod shape に変換し、 SDK の `tool()` でラップする
 * - tool 実行は SDK 内部で起き、 handler は lllmAgent の ToolExecutor.execute を呼ぶ
 * - 失敗は `isError: true` で返して SDK のループを継続させる (uncaught throw は loop を殺す)
 */

import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { ToolHandler } from "./tool-registry.js";
import type { ToolExecutor } from "./tool-executor.js";
import type { ToolCall } from "../providers/base-provider.js";
import type { RequestSource } from "../security/permission-manager.js";

interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  default?: unknown;
}

/**
 * JSON Schema (lllmAgent の ToolDefinition.function.parameters) を Zod の ZodRawShape に変換。
 *
 * 対応する JSON Schema 構造:
 *  - type: object/string/number/integer/boolean/array
 *  - properties / required (object)
 *  - enum (string|number|integer)
 *  - items (array)
 *  - description (description 注入)
 *
 * 非対応:
 *  - anyOf/oneOf/allOf等は登録時にfail-fast（未知型をz.any()で通さない）
 *  - additionalProperties → 無視 (Zod default は strict)
 *  - nested object の深い構造 → 再帰対応するが過剰検証は避ける
 */
export function jsonSchemaToZodShape(schema: JsonSchemaNode | undefined): ZodRawShape {
  if (!schema) return {};
  if (schema.type !== "object")
    throw new Error(`MCP tool schema root must be object (received: ${String(schema.type)})`);
  if (!schema.properties) return {};
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    let zod: ZodTypeAny = jsonPropToZod(propSchema);
    if (propSchema.description) zod = zod.describe(propSchema.description);
    if (!required.has(key)) zod = zod.optional();
    shape[key] = zod;
  }
  return shape as ZodRawShape;
}

function jsonPropToZod(prop: JsonSchemaNode): ZodTypeAny {
  const typeRaw = prop.type;
  const type = Array.isArray(typeRaw) ? typeRaw[0] : typeRaw;

  if (prop.enum && Array.isArray(prop.enum)) {
    const strs = prop.enum.filter((v): v is string => typeof v === "string");
    if (strs.length === prop.enum.length && strs.length > 0) {
      // z.enum requires non-empty tuple; cast as required by zod type signature
      return z.enum(strs as [string, ...string[]]);
    }
    return z.union(prop.enum.map((v) => z.literal(v as never))) as ZodTypeAny;
  }

  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array": {
      if (!prop.items) throw new Error("MCP tool array schema requires items");
      return z.array(jsonPropToZod(prop.items));
    }
    case "object": {
      const nested = jsonSchemaToZodShape(prop);
      return Object.keys(nested).length > 0 ? z.object(nested) : z.record(z.string(), z.any());
    }
    default:
      throw new Error(`Unsupported MCP tool schema type: ${String(type)}`);
  }
}

/**
 * ToolHandler[] を SDK の in-process MCP server にまとめてラップする。
 *
 * @param handlers - lllmAgent の ToolRegistry から取り出したハンドラ一覧
 * @param executor - ToolExecutor (permission / hook を含む実行責任)
 * @param source - 権限チェック用の RequestSource (デフォルト "cli")
 * @returns createSdkMcpServer の戻り値 (Options.mcpServers にそのまま渡せる形)
 */
export function buildLllmAgentsMcpServer(
  handlers: ToolHandler[],
  executor: ToolExecutor,
  source: RequestSource = "cli",
) {
  const sdkTools = handlers.map((handler) => {
    const schema = handler.definition.function.parameters as JsonSchemaNode | undefined;
    const zodShape = jsonSchemaToZodShape(schema);

    return tool(
      handler.name,
      handler.definition.function.description,
      zodShape,
      async (args: Record<string, unknown>) => {
        const toolCall: ToolCall = {
          id: `sdk-mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: "function",
          function: {
            name: handler.name,
            arguments: JSON.stringify(args ?? {}),
          },
        };
        const result = await executor.execute(toolCall, source);
        const text = result.success ? result.output || "" : result.error || result.output || "Tool execution failed";
        return {
          content: [{ type: "text" as const, text }],
          isError: !result.success,
        };
      },
    );
  });

  return createSdkMcpServer({
    name: "lllmagents",
    version: "1.0.0",
    tools: sdkTools,
  });
}
