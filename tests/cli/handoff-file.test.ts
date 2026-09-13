import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handoffCommand } from "../../src/cli/commands/handoff.js";
import type { ReplCommandContext } from "../../src/cli/commands/types.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it("空白入りパスを読む。UTF-8不正・巨大ファイルはagentを呼ばない", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "handoff "));
  roots.push(root);
  const file = path.join(root, "note file.md");
  fs.writeFileSync(file, "制約を保持して制作を続ける");
  const runHandoffNow = vi.fn(async () => ({ applied: false, note: "test" }));
  const ctx = { agent: { runHandoffNow } } as unknown as ReplCommandContext;
  await handoffCommand.handler(ctx, ["from-file", `"${file}"`]);
  expect(runHandoffNow).toHaveBeenCalledWith("制約を保持して制作を続ける");
  runHandoffNow.mockClear();
  fs.writeFileSync(file, Buffer.from([0xff]));
  await handoffCommand.handler(ctx, ["from-file", file]);
  fs.writeFileSync(file, "x".repeat(64_001));
  await handoffCommand.handler(ctx, ["from-file", file]);
  await handoffCommand.handler(ctx, ["from-file", root]);
  expect(runHandoffNow).not.toHaveBeenCalled();
});
