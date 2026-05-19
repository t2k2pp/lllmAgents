import { describe, it, expect } from "vitest";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../../src/tools/sdk-mcp-bridge.js";

describe("jsonSchemaToZodShape — JSON Schema を SDK 用 Zod shape に変換", () => {
  it("空 / 非 object スキーマは {} を返す", () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
    expect(jsonSchemaToZodShape({})).toEqual({});
    expect(jsonSchemaToZodShape({ type: "string" })).toEqual({});
  });

  it("必須 string / number / boolean を Zod 型に変換", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        name: { type: "string", description: "ファイル名" },
        size: { type: "number" },
        recursive: { type: "boolean" },
      },
      required: ["name", "size", "recursive"],
    });
    expect(z.object(shape).safeParse({ name: "a", size: 1, recursive: true }).success).toBe(true);
    expect(z.object(shape).safeParse({ name: "a", size: "x", recursive: true }).success).toBe(false);
  });

  it("required に無いキーは optional", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    });
    expect(z.object(shape).safeParse({ path: "/x" }).success).toBe(true);
    expect(z.object(shape).safeParse({ path: "/x", limit: 100 }).success).toBe(true);
  });

  it("enum を z.enum に変換 (string 限定)", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["read", "write", "append"] },
      },
      required: ["mode"],
    });
    expect(z.object(shape).safeParse({ mode: "read" }).success).toBe(true);
    expect(z.object(shape).safeParse({ mode: "invalid" }).success).toBe(false);
  });

  it("array<string> を z.array(z.string()) に変換", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["paths"],
    });
    expect(z.object(shape).safeParse({ paths: ["a", "b"] }).success).toBe(true);
    expect(z.object(shape).safeParse({ paths: [1, 2] }).success).toBe(false);
  });

  it("integer は int 制約", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    });
    expect(z.object(shape).safeParse({ n: 5 }).success).toBe(true);
    expect(z.object(shape).safeParse({ n: 5.5 }).success).toBe(false);
  });

  it("ネストした object も再帰的に変換", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "integer" },
          },
          required: ["host"],
        },
      },
      required: ["config"],
    });
    expect(z.object(shape).safeParse({ config: { host: "localhost" } }).success).toBe(true);
    expect(z.object(shape).safeParse({ config: { port: 80 } }).success).toBe(false);
  });

  it("未知の type は z.any() フォールバック", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: { mystery: { type: "anyOf" as never } },
      required: ["mystery"],
    });
    // any なので何でも通る
    expect(z.object(shape).safeParse({ mystery: { a: 1 } }).success).toBe(true);
    expect(z.object(shape).safeParse({ mystery: "x" }).success).toBe(true);
  });
});
