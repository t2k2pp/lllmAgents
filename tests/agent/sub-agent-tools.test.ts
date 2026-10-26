import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SubAgent } from "../../src/agent/sub-agent.js";
import { AgentDefinitionLoader } from "../../src/agents/agent-loader.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { bashTool } from "../../src/tools/definitions/bash.js";
import { fileEditTool } from "../../src/tools/definitions/file-edit.js";
import { fileReadTool } from "../../src/tools/definitions/file-read.js";
import { fileWriteTool } from "../../src/tools/definitions/file-write.js";
import { globTool } from "../../src/tools/definitions/glob.js";
import { grepTool } from "../../src/tools/definitions/grep.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

/**
 * サブエージェントの道具の一覧 (docs/internal_design.md §8「種類ごとの道具」)。 src/agents/builtin/*.md の定義そのものを読み、
 * task ツールで起動したサブエージェントがモデルに渡す道具の定義を確かめる。
 */

let home: string;
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;

beforeAll(() => {
  // 利用者の ~/.localllm/agents を読まない (一時ホーム)
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sub-agent-tools-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterAll(() => {
  process.env.HOME = realHome;
  process.env.USERPROFILE = realUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

function securityConfig(deny: string[] = []): SecurityConfig {
  // 一時ホームだけを読める場所にする (deny の試験が「場所の外」 ではなく規則で止まったことを確かめるため)
  return { allowedDirectories: [home], blockedCommands: [], rules: { allow: ["file_read"], deny, ask: [] } };
}

/** replies を順に返す (尽きたら "done")。 送った内容を sent に深く写して残す */
function captureProvider(sent: ChatWithToolsParams[], replies: ChatChunk[][] = []): LLMProvider {
  let i = 0;
  const run = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    sent.push(JSON.parse(JSON.stringify({ ...params, signal: undefined })));
    const reply = replies[i++];
    if (reply) {
      for (const c of reply) yield c;
      return;
    }
    yield { type: "text", text: "done" };
    yield { type: "done", finishReason: "stop" };
  };
  return {
    providerType: "openai-compat",
    chat: run,
    chatWithTools: run,
  } as unknown as LLMProvider;
}

function mainRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [fileReadTool, fileWriteTool, fileEditTool, globTool, grepTool, bashTool]) registry.register(tool);
  return registry;
}

function makeAgent(type: string, provider: LLMProvider, deny: string[] = []): SubAgent {
  const loader = new AgentDefinitionLoader([], { includeCustomizations: false });
  loader.loadAll();
  return new SubAgent(
    provider,
    "m",
    mainRegistry(),
    new PermissionManager(securityConfig(deny)),
    type,
    "test",
    undefined,
    undefined,
    "subagent",
    undefined,
    loader,
  );
}

async function toolsSentBy(type: string): Promise<string[]> {
  const sent: ChatWithToolsParams[] = [];
  await makeAgent(type, captureProvider(sent)).run("調べて");
  return (sent[0]?.tools ?? []).map((t) => t.function.name).sort();
}

function readCall(id: string, filePath: string): ChatChunk[] {
  return [
    {
      type: "tool_call",
      toolCall: {
        id,
        type: "function",
        function: { name: "file_read", arguments: JSON.stringify({ file_path: filePath }) },
      },
    },
    { type: "done", finishReason: "tool_calls" },
  ];
}

describe("サブエージェントの道具の一覧", () => {
  it.each([
    "bash",
    "code-reviewer",
    "explore",
    "plan",
    "general-purpose",
  ])("%s には読み取りの道具 (file_read / glob / grep) がある", async (type) => {
    const names = await toolsSentBy(type);
    expect(names).toEqual(expect.arrayContaining(["file_read", "glob", "grep"]));
  });

  it("種類ごとの意図どおり: 読み取り専用 (explore / plan / code-reviewer) は書き込みを持たず、 general-purpose だけが書ける", async () => {
    // この試験の登録は file_read / file_write / file_edit / glob / grep / bash だけ (web_* などは登録していない)
    expect(await toolsSentBy("explore")).toEqual(["file_read", "glob", "grep"]);
    expect(await toolsSentBy("plan")).toEqual(["file_read", "glob", "grep"]);
    expect(await toolsSentBy("code-reviewer")).toEqual(["bash", "file_read", "glob", "grep"]);
    expect(await toolsSentBy("bash")).toEqual(["bash", "file_read", "glob", "grep"]);
    expect(await toolsSentBy("general-purpose")).toEqual([
      "bash",
      "file_edit",
      "file_read",
      "file_write",
      "glob",
      "grep",
    ]);
  });

  it("file_read は読めて、 1 回の起動の中で道具の一覧が変わらない (プロンプトの先頭を保つ)", async () => {
    const file = path.join(home, "memo.txt");
    fs.writeFileSync(file, "サブエージェントが読む中身");
    const sent: ChatWithToolsParams[] = [];
    const result = await makeAgent("bash", captureProvider(sent, [readCall("r1", file), readCall("r2", file)])).run(
      "読んで",
    );
    expect(result.success).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const toolMessage = sent[1].messages.find((m) => m.role === "tool");
    expect(String(toolMessage?.content)).toContain("サブエージェントが読む中身");
    for (const s of sent.slice(1)) expect(s.tools).toEqual(sent[0].tools);
  });

  it("権限の規則 (deny) はサブエージェントの file_read にも効く", async () => {
    const file = path.join(home, "secret.txt");
    fs.writeFileSync(file, "読ませない中身");
    const sent: ChatWithToolsParams[] = [];
    await makeAgent("explore", captureProvider(sent, [readCall("r1", file)]), ["file_read"]).run("読んで");
    const toolMessage = sent[1].messages.find((m) => m.role === "tool");
    expect(String(toolMessage?.content)).not.toContain("読ませない中身");
    expect(String(toolMessage?.content)).toMatch(/^Error: /);
    // 規則で止まった (場所の外ではない。 同じ場所の memo.txt は上の試験で読めている)
    expect(String(toolMessage?.content)).toContain("ルール");
  });
});
