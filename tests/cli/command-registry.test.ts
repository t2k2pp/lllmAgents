import { describe, it, expect, vi } from "vitest";
import { getCommandRegistry, getRegistryCompletions, getRegistryHelpEntries } from "../../src/cli/commands/registry.js";
import type { ReplCommandContext } from "../../src/cli/commands/types.js";
import { getDefaultConfig } from "../../src/config/types.js";
import type { Config } from "../../src/config/types.js";

/** /parallel と /autorun が使う範囲だけ実装したフェイク agent */
function makeContext(): { ctx: ReplCommandContext; config: Config; saveConfig: ReturnType<typeof vi.fn> } {
  const config = getDefaultConfig();
  const saveConfig = vi.fn();
  let maxParallel = 3;
  let autorun = false;
  const agent = {
    getMaxParallelTools: () => maxParallel,
    setMaxParallelTools: (n: number) => {
      maxParallel = n;
    },
    getPermissions: () => ({
      isAutorunMode: () => autorun,
      setAutorunMode: (on: boolean) => {
        autorun = on;
      },
    }),
  };
  const ctx = { agent, config, saveConfig } as unknown as ReplCommandContext;
  return { ctx, config, saveConfig };
}

describe("コマンドレジストリ (PR-10)", () => {
  it("登録コマンドを名前で引ける (小文字キー)", () => {
    const registry = getCommandRegistry();
    expect(registry.get("/parallel")).toBeDefined();
    expect(registry.get("/autorun")).toBeDefined();
    expect(registry.get("/loglevel")).toBeDefined();
    expect(registry.get("/no-such-command")).toBeUndefined();
  });

  it("補完候補とヘルプ項目が全登録コマンド分自動生成される", () => {
    const completions = getRegistryCompletions();
    const helpEntries = getRegistryHelpEntries();
    for (const name of ["/parallel", "/autorun", "/loglevel"]) {
      expect(completions.some((c) => c.command === name)).toBe(true);
      expect(helpEntries.some((e) => e.name === name)).toBe(true);
    }
    for (const e of helpEntries) {
      expect(e.summary.length).toBeGreaterThan(0);
    }
  });

  it("/parallel <n> は agent と config を更新して保存する", async () => {
    const { ctx, config, saveConfig } = makeContext();
    await getCommandRegistry().get("/parallel")!.handler(ctx, ["5"]);
    expect(ctx.agent.getMaxParallelTools()).toBe(5);
    expect(config.maxParallelTools).toBe(5);
    expect(saveConfig).toHaveBeenCalledOnce();
  });

  it("/parallel (引数なし) は表示のみで保存しない", async () => {
    const { ctx, saveConfig } = makeContext();
    await getCommandRegistry().get("/parallel")!.handler(ctx, []);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("/autorun は引数なしで toggle し config へ永続化する", async () => {
    const { ctx, config, saveConfig } = makeContext();
    const def = getCommandRegistry().get("/autorun")!;
    await def.handler(ctx, []);
    expect(ctx.agent.getPermissions().isAutorunMode()).toBe(true);
    expect(config.autorunMode).toBe(true);
    await def.handler(ctx, []);
    expect(ctx.agent.getPermissions().isAutorunMode()).toBe(false);
    expect(config.autorunMode).toBe(false);
    expect(saveConfig).toHaveBeenCalledTimes(2);
  });

  it("/autorun on / off は明示指定どおりに設定する", async () => {
    const { ctx, config } = makeContext();
    const def = getCommandRegistry().get("/autorun")!;
    await def.handler(ctx, ["on"]);
    expect(config.autorunMode).toBe(true);
    await def.handler(ctx, ["off"]);
    expect(config.autorunMode).toBe(false);
  });

  it("/loglevel の不正引数はエラー案内のみで例外を出さない", async () => {
    const { ctx } = makeContext();
    await expect(
      Promise.resolve(getCommandRegistry().get("/loglevel")!.handler(ctx, ["bogus"])),
    ).resolves.toBeUndefined();
  });
});
