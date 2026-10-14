import { describe, it, expect } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { ToolRegistry, type ToolHandler } from "../../src/tools/tool-registry.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, LLMProvider } from "../../src/providers/base-provider.js";

/**
 * salvage 実行到達の回帰テスト (docs/tool-call-salvage-pipe-format-design.md §6.5)。
 *
 * バグ: thinking/text から正規化抽出した tool 呼び出しが、 ツール実行ブロックの「後」 に
 * 置かれていたため一度も実行されず空応答でターンが終わっていた (session mq34du2c)。
 *
 * このテストは「ループ内のブロック順序」 を検証する。 `normalizeToolCalls` 単体テストでは
 * 抽出器の正しさしか見られず、 抽出物が実行経路に到達するか (= 配線) は捕捉できない。
 * salvage ブロックを実行ブロックの後ろへ戻すと、 このテストは赤になる。
 *
 * 終了制御: probe tool の execute が loop.abort() を呼ぶ。 ツール実行後 `continue` した
 * 次イテレーション冒頭の `_aborted` チェック (agent-loop.ts ~478) で run() が return するため、
 * 2 回目の LLM 呼び出しを待たずに決定的に終わる。
 */

function makeSecurityConfig(autoApprove: string[]): SecurityConfig {
  return {
    allowedDirectories: [],
    blockedCommands: [],
    autoApproveTools: autoApprove,
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
}

/** 各 LLM 呼び出しで `scripts[n]` のチャンク列を流すモック provider。 */
function makeProvider(scripts: ChatChunk[][]): LLMProvider {
  let call = 0;
  const gen = async function* (): AsyncGenerator<ChatChunk> {
    const script = scripts[Math.min(call, scripts.length - 1)] ?? [{ type: "done", finishReason: "stop" }];
    call++;
    for (const chunk of script) yield chunk;
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: gen,
    chatWithTools: gen,
    supportsVision: async () => false,
    chatWithVision: gen,
  } as unknown as LLMProvider;
}

/**
 * 実行されたら名前を記録し、 ループを abort して run() を決定的に終わらせる probe tool。
 * `loopRef` は new AgentLoop の後に代入する (循環参照のための遅延束縛)。
 */
function makeProbeTool(name: string, executed: string[], loopRef: { loop?: AgentLoop }): ToolHandler {
  return {
    name,
    definition: {
      type: "function",
      function: { name, description: "test probe", parameters: { type: "object", properties: {} } },
    },
    execute: async () => {
      executed.push(name);
      loopRef.loop?.abort();
      return { success: true, output: "ok" };
    },
  };
}

async function runWith(firstResponse: ChatChunk[]): Promise<string[]> {
  const executed: string[] = [];
  const ref: { loop?: AgentLoop } = {};
  const registry = new ToolRegistry();
  registry.register(makeProbeTool("salvage_probe", executed, ref));
  const permissions = new PermissionManager(makeSecurityConfig(["salvage_probe"]));
  const provider = makeProvider([firstResponse, [{ type: "done", finishReason: "stop" }]]);
  const loop = new AgentLoop(provider, "test-model-7b", registry, permissions, 128_000, 0.8);
  ref.loop = loop;
  await loop.run("テスト依頼");
  return executed;
}

describe("AgentLoop: salvage したツール呼び出しの実行到達 (§6.5 回帰防止)", () => {
  it("thinking チャネルに ChatML ツール呼び出しを書いたら実行される (本バグの直接再現)", async () => {
    // native tool_calls は空、 reasoning_content (thinking) にのみツール呼び出しがある状態。
    const executed = await runWith([
      { type: "thinking", text: '<tool_call>{"name":"salvage_probe","arguments":{}}</tool_call>' },
      { type: "done", finishReason: "stop" },
    ]);
    expect(executed).toEqual(["salvage_probe"]);
  });

  it("thinking チャネルに Anthropic XML ツール呼び出しを書いても実行される (実セッションの形式)", async () => {
    // session mq34du2c で Qwen3.6 が実際に出した形式。
    const executed = await runWith([
      {
        type: "thinking",
        text: "<tool_call><function=salvage_probe><parameter=note>x</parameter></function></tool_call>",
      },
      { type: "done", finishReason: "stop" },
    ]);
    expect(executed).toEqual(["salvage_probe"]);
  });

  it("本文テキストにツール呼び出しを書いた場合も実行される (text-source salvage)", async () => {
    const executed = await runWith([
      { type: "text", text: '<tool_call>{"name":"salvage_probe","arguments":{}}</tool_call>' },
      { type: "done", finishReason: "stop" },
    ]);
    expect(executed).toEqual(["salvage_probe"]);
  });

  it("thinking に紛れた </thinking> の後ろの <invoke> 呼び出しだけが実行される (goemon ログの形式)", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const ref: { loop?: AgentLoop } = {};
    const registry = new ToolRegistry();
    registry.register({
      name: "salvage_probe",
      definition: {
        type: "function",
        function: {
          name: "salvage_probe",
          description: "test probe",
          parameters: { type: "object", properties: { note: { type: "string" } } },
        },
      },
      execute: async (args) => {
        calls.push({ name: "salvage_probe", args });
        ref.loop?.abort();
        return { success: true, output: "ok" };
      },
    });
    const permissions = new PermissionManager(makeSecurityConfig(["salvage_probe"]));
    const provider = makeProvider([
      [
        {
          type: "thinking",
          text:
            '下書き: <invoke name="salvage_probe"><parameter name="note">draft</parameter></invoke>\n' +
            "</thinking>\n原因特定！修正します。\n" +
            '<invoke name="salvage_probe">\n<parameter name="note">123</parameter>\n</invoke>',
        },
        { type: "done", finishReason: "stop" },
      ],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const loop = new AgentLoop(provider, "test-model-7b", registry, permissions, 128_000, 0.8);
    ref.loop = loop;
    await loop.run("テスト依頼");
    // 下書きは実行しない / string 型の引数は数字の字面でも文字列のまま
    expect(calls).toEqual([{ name: "salvage_probe", args: { note: "123" } }]);
  });

  it("空応答が作業の途中で散発しても、 連続しない限り打ち切らない", async () => {
    // 旧実装は run 累計で 3 回を超えると打ち切っていた。 空応答 → ツール を 4 回繰り返しても最後まで進むこと。
    const executed: string[] = [];
    const ref: { loop?: AgentLoop } = {};
    const registry = new ToolRegistry();
    registry.register({
      name: "salvage_probe",
      definition: {
        type: "function",
        function: { name: "salvage_probe", description: "test probe", parameters: { type: "object", properties: {} } },
      },
      execute: async () => {
        executed.push("salvage_probe");
        if (executed.length >= 4) ref.loop?.abort();
        return { success: true, output: "ok" };
      },
    });
    const permissions = new PermissionManager(makeSecurityConfig(["salvage_probe"]));
    const empty: ChatChunk[] = [
      { type: "thinking", text: "考え中" },
      { type: "done", finishReason: "stop" },
    ];
    const tool: ChatChunk[] = [
      {
        type: "tool_call",
        toolCall: { id: "c", type: "function", function: { name: "salvage_probe", arguments: "{}" } },
      },
      { type: "done", finishReason: "stop" },
    ];
    const provider = makeProvider([empty, tool, empty, tool, empty, tool, empty, tool]);
    const loop = new AgentLoop(provider, "test-model-7b", registry, permissions, 128_000, 0.8);
    ref.loop = loop;
    await loop.run("テスト依頼");
    expect(executed).toHaveLength(4);
  });

  it("ネイティブ tool_call チャンクは従来どおり実行される (アサート機構の健全性確認)", async () => {
    const executed = await runWith([
      {
        type: "tool_call",
        toolCall: {
          id: "call_1",
          type: "function",
          function: { name: "salvage_probe", arguments: "{}" },
        },
      },
      { type: "done", finishReason: "stop" },
    ]);
    expect(executed).toEqual(["salvage_probe"]);
  });
});
