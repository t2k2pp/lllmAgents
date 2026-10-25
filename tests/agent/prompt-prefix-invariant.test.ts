import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { clearTodos, setTodos } from "../../src/tools/definitions/todo-write.js";

/**
 * プロンプト前方一致の不変条件 (docs/prompt-prefix-stability.md §7)。
 *
 * ローカル LLM (llama.cpp / vLLM) の KV キャッシュも、 クラウドのプロンプトキャッシュも、
 * 「前回送った列が次の送信でもそのまま先頭に残っている」 ことでしか効かない。
 * 毎ターン変わる値 (日時・ToDo・Goal 等) を履歴の前方に置く変更が入ると、
 * 1 呼び出しごとに全履歴の再計算になる (2026-10 myppt で 1 呼び出し 17〜44 分)。
 * このテストは AgentLoop を実際に回し、 その退行を CI で止める。
 */

vi.mock("../../src/agent/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/session-manager.js")>();
  return { ...actual, saveSession: vi.fn() };
});

function securityConfig(allowedTools: string[]): SecurityConfig {
  return {
    allowedDirectories: [],
    blockedCommands: [],
    rules: { allow: [...allowedTools], deny: [], ask: [] },
  };
}

function scriptedProvider(replies: ChatChunk[][], requests: ChatWithToolsParams[]): LLMProvider {
  let call = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    // 送った瞬間の内容を固定して保存する (後からの書き換えを検出するため deep copy)
    requests.push(JSON.parse(JSON.stringify(params)));
    const current = call++;
    for (const chunk of replies[Math.min(current, replies.length - 1)] ?? []) yield chunk;
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: chatWithTools,
    chatWithTools,
    supportsVision: async () => false,
    chatWithVision: chatWithTools,
  } as unknown as LLMProvider;
}

function toolCall(id: string, name: string): ChatChunk[] {
  return [
    // 引数を呼び出しごとに変える (同じ引数の繰り返しはハーネスの反復検出で止められる)
    {
      type: "tool_call",
      toolCall: { id, type: "function", function: { name, arguments: JSON.stringify({ tag: id }) } },
    },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function textReply(text: string): ChatChunk[] {
  return [
    { type: "text", text },
    { type: "done", finishReason: "stop" },
  ];
}

/**
 * 状態 (ToDo) を書き換えるツール。 実行のたびに ToDo に項目が 1 つ増える。
 * 完了は作らない (完了は「ToDo 区切り」 の整理 = 正当な書き換えを起こすので、 このテストの対象外)。
 */
function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  let n = 0;
  registry.register({
    name: "state_probe",
    definition: {
      type: "function",
      function: { name: "state_probe", description: "test probe", parameters: { type: "object", properties: {} } },
    },
    execute: async () => {
      n++;
      setTodos(
        Array.from({ length: n }, (_, i) => ({
          content: `step ${i + 1}`,
          status: i === 0 ? ("in_progress" as const) : ("pending" as const),
        })),
      );
      return { success: true, output: `probe ${n}` };
    },
  });
  // 終わる前に ToDo を片付ける (未完了の ToDo を残して文章だけ返すと、 ハーネスが続行を促し続ける)
  registry.register({
    name: "finish_probe",
    definition: {
      type: "function",
      function: { name: "finish_probe", description: "test finish", parameters: { type: "object", properties: {} } },
    },
    execute: async () => {
      clearTodos();
      return { success: true, output: "finished" };
    },
  });
  return registry;
}

function makeLoop(provider: LLMProvider, registry: ToolRegistry): AgentLoop {
  return new AgentLoop(
    provider,
    "test-model-7b",
    registry,
    new PermissionManager(securityConfig(registry.getToolNames())),
    128_000,
  );
}

/** 各送信が、 直前の送信をそのまま先頭に含むこと (tools も不変)。 壊れた位置を返して原因を示す。 */
function expectPrefixExtension(requests: ChatWithToolsParams[]): void {
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1];
    const next = requests[i];
    expect(next.tools, `request ${i}: tools が変わった`).toEqual(prev.tools);
    expect(next.messages.length, `request ${i}: 履歴が縮んだ`).toBeGreaterThanOrEqual(prev.messages.length);
    for (let j = 0; j < prev.messages.length; j++) {
      expect(next.messages[j], `request ${i}: messages[${j}] (${prev.messages[j].role}) が書き換わった`).toEqual(
        prev.messages[j],
      );
    }
  }
}

describe("プロンプト前方一致の不変条件 (KV キャッシュ)", () => {
  afterEach(() => clearTodos());

  it("1 回の依頼の中で、 ToDo が変わっても前に送った部分は書き換わらない", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [
        toolCall("c1", "state_probe"),
        toolCall("c2", "state_probe"),
        toolCall("c3", "state_probe"),
        toolCall("f1", "finish_probe"),
        textReply("状況を確認しました。"),
      ],
      requests,
    );
    await makeLoop(provider, makeRegistry()).run("状況を教えてください？");

    expect(requests.length).toBeGreaterThanOrEqual(4);
    expectPrefixExtension(requests);
    // 状態通知は届いている (末尾追記で渡す)
    const last = requests
      .at(-1)
      ?.messages.map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(last).toContain("step 3");
    expect(requests.length).toBeLessThan(10); // 台本どおりに終わっている (促しのループに入っていない)
  });

  it("system はリクエスト間で 1 文字も変わらず、 日時・ToDo を含まない", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [toolCall("c1", "state_probe"), toolCall("f1", "finish_probe"), textReply("状況を確認しました。")],
      requests,
    );
    await makeLoop(provider, makeRegistry()).run("状況を教えてください？");

    const systems = requests.map((r) => r.messages.filter((m) => m.role === "system"));
    for (const s of systems) expect(s).toEqual(systems[0]);
    const sysText = JSON.stringify(systems[0]);
    expect(sysText).not.toContain("Current datetime");
    expect(sysText).not.toContain("step 1");
  });

  it("依頼をまたいでも (2 回目の run)、 前の依頼までに送った部分は書き換わらない", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [
        toolCall("c1", "state_probe"),
        toolCall("f1", "finish_probe"),
        textReply("1 件目を確認しました。"),
        toolCall("c2", "state_probe"),
        toolCall("f2", "finish_probe"),
        textReply("2 件目を確認しました。"),
      ],
      requests,
    );
    const loop = makeLoop(provider, makeRegistry());
    await loop.run("1 件目の状況を教えてください？");
    await loop.run("2 件目の状況を教えてください？");

    expect(requests.length).toBeGreaterThanOrEqual(4);
    expectPrefixExtension(requests);
  });
});
