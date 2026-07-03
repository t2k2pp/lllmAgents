import { describe, it, expect } from "vitest";
import { validateAgainstSchema, formatValidationError } from "../../src/tools/schema-validator.js";

describe("validateAgainstSchema — required", () => {
  it("必須フィールドあり → valid", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    expect(validateAgainstSchema(schema, { name: "foo" }).valid).toBe(true);
  });

  it("必須フィールド欠如 → invalid", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const r = validateAgainstSchema(schema, {});
    expect(r.valid).toBe(false);
    expect(r.errors[0].kind).toBe("missing");
    expect(r.errors[0].field).toBe("name");
  });

  it("複数の必須フィールド欠如 → 全部報告", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
    };
    const r = validateAgainstSchema(schema, {});
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(2);
  });

  it("required = null も missing 扱い", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    };
    expect(validateAgainstSchema(schema, { x: null }).valid).toBe(false);
  });
});

describe("validateAgainstSchema — type", () => {
  it("string 期待 → string なら valid", () => {
    const r = validateAgainstSchema({ properties: { x: { type: "string" } } }, { x: "foo" });
    expect(r.valid).toBe(true);
  });

  it("string 期待 → number なら invalid", () => {
    const r = validateAgainstSchema({ properties: { x: { type: "string" } } }, { x: 42 });
    expect(r.valid).toBe(false);
    expect(r.errors[0].kind).toBe("type-mismatch");
    expect(r.errors[0].expected).toBe("string");
    expect(r.errors[0].actual).toBe("number");
  });

  it("array 期待 → array なら valid", () => {
    const r = validateAgainstSchema({ properties: { items: { type: "array" } } }, { items: [1, 2, 3] });
    expect(r.valid).toBe(true);
  });

  it("array 期待 → object なら invalid", () => {
    const r = validateAgainstSchema({ properties: { items: { type: "array" } } }, { items: { a: 1 } });
    expect(r.valid).toBe(false);
    expect(r.errors[0].actual).toBe("object");
  });

  it("integer 期待 → number でも valid (柔軟性)", () => {
    const r = validateAgainstSchema({ properties: { n: { type: "integer" } } }, { n: 42 });
    expect(r.valid).toBe(true);
  });

  it("boolean 期待 → 文字列なら invalid (strict)", () => {
    const r = validateAgainstSchema({ properties: { flag: { type: "boolean" } } }, { flag: "true" });
    expect(r.valid).toBe(false);
  });
});

describe("validateAgainstSchema — enum", () => {
  it("enum 値一致 → valid", () => {
    const r = validateAgainstSchema(
      { properties: { reason: { type: "string", enum: ["a", "b", "c"] } } },
      { reason: "b" },
    );
    expect(r.valid).toBe(true);
  });

  it("enum 値外 → invalid", () => {
    const r = validateAgainstSchema(
      { properties: { reason: { type: "string", enum: ["a", "b", "c"] } } },
      { reason: "x" },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].kind).toBe("enum-mismatch");
  });

  it("型違反のときは enum チェックを skip", () => {
    const r = validateAgainstSchema({ properties: { reason: { type: "string", enum: ["a", "b"] } } }, { reason: 42 });
    // 型エラーだけで enum エラーは出さない
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].kind).toBe("type-mismatch");
  });
});

describe("validateAgainstSchema — 任意フィールド (required にない)", () => {
  it("任意フィールドが無くても valid", () => {
    const schema = {
      properties: { name: { type: "string" }, optional: { type: "number" } },
      required: ["name"],
    };
    expect(validateAgainstSchema(schema, { name: "foo" }).valid).toBe(true);
  });

  it("任意フィールドが型違反なら invalid", () => {
    const schema = {
      properties: { name: { type: "string" }, optional: { type: "number" } },
      required: ["name"],
    };
    const r = validateAgainstSchema(schema, { name: "foo", optional: "bar" });
    expect(r.valid).toBe(false);
  });
});

describe("validateAgainstSchema — 余分な field", () => {
  it("schema に無い余分な field は warning にしない (前方互換)", () => {
    const schema = {
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const r = validateAgainstSchema(schema, { a: "x", extra: "ignored" });
    expect(r.valid).toBe(true);
  });
});

describe("formatValidationError", () => {
  it("missing / type-mismatch / enum-mismatch を行ごとに整形", () => {
    const errors = [
      { field: "name", kind: "missing" as const, expected: "string", actual: "undefined" },
      { field: "age", kind: "type-mismatch" as const, expected: "number", actual: "string" },
      { field: "color", kind: "enum-mismatch" as const, expected: '"red" | "blue"', actual: '"green"' },
    ];
    const msg = formatValidationError("test_tool", errors);
    expect(msg).toContain("test_tool");
    expect(msg).toContain("name");
    expect(msg).toContain("age");
    expect(msg).toContain("color");
    expect(msg).toContain("contract 違反");
  });
});
