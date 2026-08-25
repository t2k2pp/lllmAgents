import { describe, it, expect } from "vitest";
import {
  ROOT_ANCESTORS,
  extendAncestors,
  excludedToolsFor,
  filterRegistryForAncestors,
} from "../../src/agent/delegation-context.js";
import { ToolRegistry, type ToolHandler } from "../../src/tools/tool-registry.js";

/** テスト用のダミーツールハンドラを作る */
function makeHandler(name: string): ToolHandler {
  return {
    name,
    definition: {
      type: "function",
      function: { name, description: "", parameters: { type: "object", properties: {} } },
    },
    execute: async () => ({ success: true, output: "" }),
  };
}

function makeFullRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of [
    "task",
    "task_output",
    "task_list",
    "task_cancel",
    "second_llm_agent",
    "enter_plan_mode",
    "exit_plan_mode",
    "file_read",
    "file_write",
    "bash",
  ]) {
    reg.register(makeHandler(name));
  }
  return reg;
}

describe("delegation-context: extendAncestors", () => {
  it("ROOT_ANCESTORS は空集合", () => {
    expect(ROOT_ANCESTORS.size).toBe(0);
  });

  it("extendAncestors はオリジナルを変更せず新しいセットを返す (immutable)", () => {
    const initial = ROOT_ANCESTORS;
    const next = extendAncestors(initial, "sub");
    expect(initial.size).toBe(0);
    expect(next.size).toBe(1);
    expect(next.has("sub")).toBe(true);
  });

  it("既存の origin を再追加しても重複しない (Set のセマンティクス)", () => {
    const a = extendAncestors(ROOT_ANCESTORS, "sub");
    const b = extendAncestors(a, "sub");
    expect(b.size).toBe(1);
  });

  it("異なる origin を順次追加できる", () => {
    const a = extendAncestors(ROOT_ANCESTORS, "sub");
    const b = extendAncestors(a, "second");
    expect(b.size).toBe(2);
    expect(b.has("sub")).toBe(true);
    expect(b.has("second")).toBe(true);
  });
});

describe("delegation-context: excludedToolsFor", () => {
  it("ROOT (空) でも plan_mode 系は子では常に除外", () => {
    const ex = excludedToolsFor(ROOT_ANCESTORS);
    expect(ex.has("enter_plan_mode")).toBe(true);
    expect(ex.has("exit_plan_mode")).toBe(true);
    expect(ex.has("task")).toBe(false);
    expect(ex.has("second_llm_agent")).toBe(false);
  });

  it("祖先に sub があれば task / task_output を除外 (sub 同種再帰禁止)", () => {
    const ex = excludedToolsFor(extendAncestors(ROOT_ANCESTORS, "sub"));
    expect(ex.has("task")).toBe(true);
    expect(ex.has("task_output")).toBe(true);
    expect(ex.has("task_list")).toBe(true);
    expect(ex.has("task_cancel")).toBe(true);
    // second_llm_agent は呼べる (sub → second の異種 1 段は許可)
    expect(ex.has("second_llm_agent")).toBe(false);
  });

  it("祖先に second があれば second_llm_* を除外 (second 同種再帰禁止)", () => {
    const ex = excludedToolsFor(extendAncestors(ROOT_ANCESTORS, "second"));
    expect(ex.has("second_llm_agent")).toBe(true);
    // task は呼べる (second → sub の異種 1 段は許可)
    expect(ex.has("task")).toBe(false);
  });

  it("祖先に sub と second の両方があれば全委任系統を除外 (孫世代の異種起動禁止)", () => {
    const both = extendAncestors(extendAncestors(ROOT_ANCESTORS, "sub"), "second");
    const ex = excludedToolsFor(both);
    expect(ex.has("task")).toBe(true);
    expect(ex.has("task_output")).toBe(true);
    expect(ex.has("second_llm_agent")).toBe(true);
  });
});

describe("delegation-context: filterRegistryForAncestors", () => {
  it("子エージェントではmain会話へ注入するschedule操作を除外する", () => {
    const registry = new ToolRegistry();
    for (const name of ["file_read", "schedule_create", "schedule_list", "schedule_delete"]) {
      registry.register(makeHandler(name));
    }
    const filtered = filterRegistryForAncestors(registry, new Set(["sub"]));

    expect(filtered.get("file_read")).toBeDefined();
    expect(filtered.get("schedule_create")).toBeUndefined();
    expect(filtered.get("schedule_list")).toBeUndefined();
    expect(filtered.get("schedule_delete")).toBeUndefined();
  });

  it("メイン (ROOT) → sub では task が除外される", () => {
    const reg = makeFullRegistry();
    const subAncestors = extendAncestors(ROOT_ANCESTORS, "sub");
    const filtered = filterRegistryForAncestors(reg, subAncestors);
    expect(filtered.get("task")).toBeUndefined();
    expect(filtered.get("second_llm_agent")).toBeDefined(); // sub → second は OK
    expect(filtered.get("file_read")).toBeDefined();
  });

  it("メイン (ROOT) → second では second_llm_* が除外される", () => {
    const reg = makeFullRegistry();
    const secondAncestors = extendAncestors(ROOT_ANCESTORS, "second");
    const filtered = filterRegistryForAncestors(reg, secondAncestors);
    expect(filtered.get("second_llm_agent")).toBeUndefined();
    expect(filtered.get("task")).toBeDefined(); // second → sub は OK
    expect(filtered.get("task_list")).toBeUndefined(); // lifecycle管理はmain専権
    expect(filtered.get("task_cancel")).toBeUndefined();
    expect(filtered.get("bash")).toBeDefined();
  });

  it("sub → second の孫では task も second_llm_* も全部除外される (孫世代封じ)", () => {
    const reg = makeFullRegistry();
    // 孫: 親の ancestors = {sub, second}
    const grandchild = extendAncestors(extendAncestors(ROOT_ANCESTORS, "sub"), "second");
    const filtered = filterRegistryForAncestors(reg, grandchild);
    expect(filtered.get("task")).toBeUndefined();
    expect(filtered.get("task_output")).toBeUndefined();
    expect(filtered.get("second_llm_agent")).toBeUndefined();
    // 通常ツールは残る
    expect(filtered.get("file_read")).toBeDefined();
    expect(filtered.get("file_write")).toBeDefined();
    expect(filtered.get("bash")).toBeDefined();
  });

  it("allowedTools を指定するとホワイトリスト ∩ 非除外で交差する", () => {
    const reg = makeFullRegistry();
    const subAncestors = extendAncestors(ROOT_ANCESTORS, "sub");
    // allowed に task が入っていても、 ancestors に sub があれば除外される
    const filtered = filterRegistryForAncestors(reg, subAncestors, ["task", "file_read", "bash"]);
    expect(filtered.get("task")).toBeUndefined(); // allowed に入っていても sub 同種再帰で除外
    expect(filtered.get("file_read")).toBeDefined();
    expect(filtered.get("bash")).toBeDefined();
    // allowed に無いツールは除外
    expect(filtered.get("file_write")).toBeUndefined();
  });
});
