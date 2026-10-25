import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { checkContextWindowFits } from "../../src/agent/context-budget.js";
import { MessageHistory } from "../../src/agent/message-history.js";
import { SUMMARY_HEADINGS } from "../../src/agent/reduction-summary.js";
import { estimateMessageTokens, estimateToolDefinitionTokens } from "../../src/agent/token-counter.js";
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

// ─── 整理イベント (docs/context-reduction-redesign.md §6。 整理の作り直し タスク 7) ───

/** 直前の送信をそのまま先頭に含まない送信 (= キャッシュが外れる送信) の位置 */
function prefixBreaks(requests: ChatWithToolsParams[]): number[] {
  const breaks: number[] = [];
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1];
    const next = requests[i];
    const kept =
      JSON.stringify(next.tools) === JSON.stringify(prev.tools) &&
      next.messages.length >= prev.messages.length &&
      prev.messages.every((m, j) => JSON.stringify(next.messages[j]) === JSON.stringify(m));
    if (!kept) breaks.push(i);
  }
  return breaks;
}

/** 要約の指示から区間の数を読み、 型どおりの要約を返す */
function summaryReply(instruction: string): ChatChunk[] {
  const n = Number(/for each of the (\d+) segments/.exec(instruction)?.[1] ?? "0");
  const segs = Array.from({ length: n }, (_, i) => `<segment n="${i + 1}">区間 ${i + 1} でしたこと</segment>`);
  const body = SUMMARY_HEADINGS.map((h) => `## ${h}\nNone`).join("\n\n");
  return textReply(`${segs.join("\n")}\n<summary>\n${body}\n</summary>`);
}

/**
 * 本体呼び出しには台本を順に返し、 要約の依頼 (<context-summary-request>) には要約を返す。
 * 送った内容は順に全部 requests に残す (要約の呼び出しも前方一致の検査に入れる)。
 */
function reductionAwareProvider(replies: ChatChunk[][], requests: ChatWithToolsParams[]): LLMProvider {
  let main = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    requests.push(JSON.parse(JSON.stringify(params)));
    const last = String(params.messages.at(-1)?.content ?? "");
    const reply = last.includes("<context-summary-request>")
      ? summaryReply(last)
      : (replies[Math.min(main++, replies.length - 1)] ?? []);
    for (const chunk of reply) yield chunk;
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

/** 思考付きでツールを呼ぶ応答 */
function thinkingToolCall(id: string, name: string): ChatChunk[] {
  return [{ type: "thinking", text: `${id} について考える` }, ...toolCall(id, name)];
}

/**
 * 1 件の依頼の台本: 思考付きで大きな結果のツールを probes 回呼び、 ToDo を片付けてから、 出力上限で切れた応答
 * (= 揮発の「続きを出力」 の促しが入る) と続きの応答で終える。 依頼の境目には揮発メッセージと思考が残る。
 */
function requestScript(tag: string, probes: number, finalPadding = ""): ChatChunk[][] {
  const script: ChatChunk[][] = [];
  for (let i = 0; i < probes; i++) script.push(thinkingToolCall(`${tag}-${i}`, "big_probe"));
  script.push(thinkingToolCall(`${tag}-f`, "finish_probe"));
  script.push([
    { type: "thinking", text: `${tag} のまとめを考える` },
    { type: "text", text: `${tag} の前半` },
    { type: "done", finishReason: "length" },
  ]);
  script.push(textReply(`${tag} の後半 ${finalPadding} です。`));
  return script;
}

describe("前方一致の不変条件: 整理イベント (規則 1) と依頼の境目", () => {
  afterEach(() => clearTodos());

  // 要約あり: 最後の応答の本文を長くする (段階 1 では消えないモデルの発言が溜まり、 段階 3 の要約の範囲ができる)
  it.each([
    { label: "要約なし", finalPadding: "", summaryCalls: 0 },
    { label: "要約あり", finalPadding: "y".repeat(12_000), summaryCalls: 1 },
  ])("キャッシュが外れる送信は整理イベントごとにちょうど 1 回で、 揮発メッセージ・思考がある依頼の境目では 0 回 ($label)", async ({
    finalPadding,
    summaryCalls,
  }) => {
    const registry = makeRegistry();
    // 1 件の上限 (T3 = 2,048 トークン) に収まる大きな結果。 古いものは段階 1 で本文が消える
    registry.register({
      name: "big_probe",
      definition: {
        type: "function",
        function: { name: "big_probe", description: "big", parameters: { type: "object", properties: {} } },
      },
      execute: async () => ({ success: true, output: "x".repeat(7_000) }),
    });
    const requests: ChatWithToolsParams[] = [];
    const replies = [
      ...requestScript("q1", 5, finalPadding),
      ...requestScript("q2", 5, finalPadding),
      ...requestScript("q3", 5, finalPadding),
      ...requestScript("q4", 5, finalPadding),
    ];
    const provider = reductionAwareProvider(replies, requests);
    const loop = makeLoop(provider, registry);
    const outcomes: string[] = [];
    loop.events.on("task_complete", (e) => outcomes.push(e.outcome));
    // 起動時の検査に通る最小の W + 2,000 (利用者の入力の分) にする (T3: 固定部分 + 直近 3 回のツール結果 +
    // 会話の最小限 + 予約 R)。 規則 1 は会話が約 24.5k トークンを超えたところで起きる
    const fixed =
      estimateMessageTokens([loop.getHistory().getMessages()[0]]) +
      estimateToolDefinitionTokens(registry.getDefinitions());
    const fit = checkContextWindowFits({ contextWindow: 0, tier: "T3", fixedTokens: fixed });
    loop.setContextWindow(fit.requiredTokens + 2_000);

    // 整理イベントの差し替えが起きた時点 (それまでに送った件数) を控える
    const reductionsAt: number[] = [];
    const boundariesAt: number[] = [];
    const realReplace = MessageHistory.prototype.replaceMessages;
    const replace = vi.spyOn(MessageHistory.prototype, "replaceMessages");
    replace.mockImplementation(function (this: MessageHistory, next, reason) {
      if (String(reason).startsWith("reduction:")) reductionsAt.push(requests.length);
      realReplace.call(this, next, reason);
    });
    try {
      for (const q of ["1 件目", "2 件目", "3 件目", "4 件目"]) {
        await loop.run(`${q}を調べてください？`);
        boundariesAt.push(requests.length);
        // 依頼の境目には揮発メッセージと思考が残っている (応答の終わりで消していない)
        const raw = loop.getHistory().getRawMessages();
        expect(raw.some((m) => m.ephemeral === true)).toBe(true);
        expect(raw.some((m) => m.role === "assistant" && m.thinking)).toBe(true);
      }
    } finally {
      replace.mockRestore();
    }

    expect(reductionsAt.length).toBeGreaterThanOrEqual(1);
    const summaryRequests = requests.filter((r) =>
      String(r.messages.at(-1)?.content ?? "").includes("<context-summary-request>"),
    );
    if (summaryCalls === 0) expect(summaryRequests).toHaveLength(0);
    else expect(summaryRequests.length).toBeGreaterThanOrEqual(summaryCalls);
    // 外れるのは整理イベントの直後の送信だけ。 要約の呼び出しは書き換え前の並びに指示を足すだけなので外れない
    expect(prefixBreaks(requests)).toEqual(reductionsAt);
    // 依頼の境目 (次の依頼の最初の送信) では外れない
    for (const b of boundariesAt.slice(0, -1)) expect(prefixBreaks(requests)).not.toContain(b);
    // 台本どおり 4 件とも正常に終わっている (本体呼び出しは台本の数ちょうど)
    expect(outcomes).toEqual(["completed", "completed", "completed", "completed"]);
    expect(requests.length - summaryRequests.length).toBe(replies.length);
  });
});
