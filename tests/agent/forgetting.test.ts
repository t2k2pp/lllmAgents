import { describe, it, expect, vi } from "vitest";
import type { ChatChunk, LLMProvider, Message } from "../../src/providers/base-provider.js";
import { MessageHistory } from "../../src/agent/message-history.js";
import {
  ForgettingEngine,
  TOMBSTONE_MARKER,
  THINNED_MARKER,
  applyPlanToMessages,
  buildManifest,
  buildSegments,
  buildTombstoneText,
  insertTombstone,
  parseForgetResponse,
  validateChoice,
} from "../../src/agent/forgetting.js";

// ─── テスト用の道具 ───

function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

/** 固定文字列を返すだけの LLMProvider スタブ */
function stubProvider(responses: string[]): LLMProvider {
  let call = 0;
  const chat = async function* (): AsyncGenerator<ChatChunk> {
    const text = responses[Math.min(call, responses.length - 1)];
    call++;
    yield { type: "text", text } as ChatChunk;
    yield { type: "done", finishReason: "stop" } as ChatChunk;
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}) as never,
    chat,
    chatWithTools: chat,
    supportsVision: async () => false,
    chatWithVision: chat,
  } as unknown as LLMProvider;
}

/** user → assistant(tool_calls) → tool → assistant の並びを作る */
function sampleMessages(): Message[] {
  return [
    { role: "user", content: "Discord Gateway の受信を WS 方式に切り替えたい。" },
    { role: "assistant", content: "調べます", tool_calls: [toolCall("c1", "file_read", { file_path: "src/a.ts" })] },
    { role: "tool", content: "X".repeat(4000), tool_call_id: "c1" },
    { role: "assistant", content: "読みました。" },
    {
      role: "assistant",
      content: "続けます",
      tool_calls: [toolCall("c2", "grep", { pattern: "foo" }), toolCall("c3", "bash", { command: "ls" })],
    },
    { role: "tool", content: "Y".repeat(3000), tool_call_id: "c2" },
    { role: "tool", content: "Z".repeat(3000), tool_call_id: "c3" },
    { role: "user", content: "テストして" },
  ];
}

// ─── セグメント化 ───

describe("buildSegments — tool ペアが分断され得ない単位に束ねる", () => {
  it("assistant(tool_calls) と続く tool 結果が 1 つの tool_batch になる", () => {
    const segs = buildSegments(sampleMessages(), 0);
    expect(segs.map((s) => s.kind)).toEqual(["user", "tool_batch", "assistant_text", "tool_batch", "user"]);
    // 2 番目の tool_batch は assistant + tool×2 の 3 メッセージ
    expect(segs[3].range).toEqual([4, 7]);
    expect(segs[3].toolNames).toEqual(["grep", "bash"]);
  });

  it("index は 1 始まりの通し番号で、 range は全メッセージを隙間なく覆う", () => {
    const messages = sampleMessages();
    const segs = buildSegments(messages, 0);
    expect(segs.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    expect(segs[0].range[0]).toBe(0);
    expect(segs[segs.length - 1].range[1]).toBe(messages.length);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].range[0]).toBe(segs[i - 1].range[1]);
    }
  });

  it("system は system_note として常に保護される (直近保護 0 でも)", () => {
    const segs = buildSegments(
      [
        { role: "system", content: "[会話履歴の要約] ..." },
        { role: "user", content: "u" },
      ],
      0,
    );
    expect(segs[0].kind).toBe("system_note");
    expect(segs[0].protected).toBe(true);
    expect(segs[1].protected).toBe(false);
  });

  it("直近 keepRecentSegments 個が保護される", () => {
    const segs = buildSegments(sampleMessages(), 2);
    const flags = segs.map((s) => s.protected);
    expect(flags).toEqual([false, false, false, true, true]);
  });

  it("tool_batch の digest はツール名×回数 + 代表引数になる", () => {
    const segs = buildSegments(sampleMessages(), 0);
    expect(segs[1].digest).toContain("file_read×1");
    expect(segs[1].digest).toContain("src/a.ts");
    expect(segs[3].digest).toContain("grep×1");
    expect(segs[3].digest).toContain("bash×1");
  });

  it("孤立した tool 結果は保護され忘却対象にならない", () => {
    const segs = buildSegments([{ role: "tool", content: "orphan", tool_call_id: "zz" }], 0);
    expect(segs[0].protected).toBe(true);
  });
});

describe("buildManifest — 1 セグメント 1 行", () => {
  it("行数はセグメント数 + 保護区切り 1 行", () => {
    const segs = buildSegments(sampleMessages(), 2);
    const lines = buildManifest(segs).split("\n");
    expect(lines.length).toBe(segs.length + 1);
    expect(lines.some((l) => l.startsWith("--- 以下は保護"))).toBe(true);
    expect(lines[0]).toMatch(/^#1\s+user/);
  });
});

// ─── モデル出力のパース・検証 ───

describe("parseForgetResponse", () => {
  it("素の JSON を読める", () => {
    expect(parseForgetResponse('{"thin":[2,4],"drop":[3],"reason":"r"}')).toEqual({
      thin: [2, 4],
      drop: [3],
      reason: "r",
    });
  });

  it("前置き文や ```json フェンスが付いていても最外の JSON を拾える", () => {
    const raw = 'はい。\n```json\n{"thin": [1], "drop": [], "reason": "x"}\n```\n以上です。';
    expect(parseForgetResponse(raw)).toEqual({ thin: [1], drop: [], reason: "x" });
  });

  it('"#2" のような文字列 index も数値化する', () => {
    expect(parseForgetResponse('{"thin":["#2","3"],"drop":[]}')?.thin).toEqual([2, 3]);
  });

  it("JSON が無ければ null (呼び出し側が再試行 → 圧縮フォールバック)", () => {
    expect(parseForgetResponse("わかりません")).toBeNull();
    expect(parseForgetResponse("{壊れた JSON")).toBeNull();
  });
});

describe("validateChoice — モデルの出力をそのまま信じない", () => {
  const segs = buildSegments(sampleMessages(), 2); // #4,#5 が保護

  it("存在しない index は無視され警告が残る", () => {
    const r = validateChoice(segs, { thin: [99], drop: [], reason: "" });
    expect(r.thin).toEqual([]);
    expect(r.warnings.join()).toContain("#99");
  });

  it("protected セグメントの指定は無視され警告が残る", () => {
    const r = validateChoice(segs, { thin: [4], drop: [5], reason: "" });
    expect(r.thin).toEqual([]);
    expect(r.drop).toEqual([]);
    expect(r.warnings.length).toBe(2);
  });

  it("user セグメントの drop は thin に格下げされる (ユーザーの言葉を完全消去させない)", () => {
    const long = sampleMessages();
    long[0] = { role: "user", content: "あ".repeat(1000) };
    const r = validateChoice(buildSegments(long, 2), { thin: [], drop: [1], reason: "" });
    expect(r.drop).toEqual([]);
    expect(r.thin).toEqual([1]);
    expect(r.warnings.join()).toContain("格下げ");
  });

  it("thin しても縮まらないセグメント (短文・thin 済み) の指定は無視される", () => {
    // #1 は短い user なので格下げ後の thin でも減らない
    const r = validateChoice(segs, { thin: [], drop: [1], reason: "" });
    expect(r.thin).toEqual([]);
    expect(r.warnings.join()).toContain("削減できない");

    const once = applyPlanToMessages(sampleMessages(), buildSegments(sampleMessages(), 2), [2], []).next;
    const again = buildSegments(once, 2);
    expect(again[1].thinGain).toBe(0);
    expect(buildManifest(again)).toContain("thin済");
    expect(validateChoice(again, { thin: [2], drop: [], reason: "" }).thin).toEqual([]);
  });

  it("thin は tool_call 引数の本文も縮め、 パスは残す (書込系セッションで減らない問題)", () => {
    const content = "const x = 1;\n".repeat(2000);
    const messages: Message[] = [
      { role: "user", content: "書いて" },
      {
        role: "assistant",
        content: "",
        tool_calls: [toolCall("w1", "file_write", { file_path: "src/app.js", content })],
      },
      { role: "tool", content: `${THINNED_MARKER} file_write の結果は履歴から削除しました。`, tool_call_id: "w1" },
      { role: "user", content: "次" },
    ];
    const segs2 = buildSegments(messages, 1);
    expect(segs2[1].thinGain).toBeGreaterThan(1000);

    const { next, thinnedTools } = applyPlanToMessages(messages, segs2, [2], []);
    const args = JSON.parse(next[1].tool_calls![0].function.arguments) as Record<string, string>;
    expect(args.file_path).toBe("src/app.js");
    expect(args.content).toContain(THINNED_MARKER);
    expect(args.content.length).toBeLessThan(400);
    expect(thinnedTools).toEqual(["file_write"]);
    // 2 回目は縮まない
    expect(buildSegments(next, 1)[1].thinGain).toBe(0);
  });

  it("thin と drop の両方に出たら drop が勝つ", () => {
    const r = validateChoice(segs, { thin: [2], drop: [2], reason: "" });
    expect(r.drop).toEqual([2]);
    expect(r.thin).toEqual([]);
  });
});

// ─── 適用 ───

describe("applyPlanToMessages — thin / drop の変換", () => {
  it("tool_batch の thin は tool_call を残し、 結果本文だけ差し替える", () => {
    const messages = sampleMessages();
    const segs = buildSegments(messages, 0);
    const { next, thinnedTools } = applyPlanToMessages(messages, segs, [2], []);

    // assistant(tool_calls) は原形のまま残る = 「読んだ」 という行動の記録が消えない
    const assistant = next.find((m) => m.role === "assistant" && m.tool_calls?.[0]?.id === "c1");
    expect(assistant).toBeTruthy();
    const tool = next.find((m) => m.role === "tool" && m.tool_call_id === "c1");
    expect(String(tool?.content)).toContain(THINNED_MARKER);
    expect(String(tool?.content)).toContain("file_read src/a.ts");
    expect(String(tool?.content).length).toBeLessThan(400);
    expect(thinnedTools).toEqual(["file_read"]);
  });

  it("drop は tool_batch をまるごと消すので tool ペアが分断されない", () => {
    const messages = sampleMessages();
    const segs = buildSegments(messages, 0);
    const { next, droppedDigests } = applyPlanToMessages(messages, segs, [], [4]);
    expect(next.some((m) => m.tool_call_id === "c2")).toBe(false);
    expect(next.some((m) => m.tool_calls?.some((c) => c.id === "c2"))).toBe(false);
    expect(droppedDigests.length).toBe(1);
    // 検証を通るはず (ペアが壊れていない)
    expect(() => new MessageHistory("sys").replaceMessages(next)).not.toThrow();
  });

  it("長い assistant_text の thin は先頭 200 文字 + 省略注記になる", () => {
    const messages: Message[] = [{ role: "assistant", content: "あ".repeat(1000) }];
    const segs = buildSegments(messages, 0);
    const { next } = applyPlanToMessages(messages, segs, [1], []);
    const text = String(next[0].content);
    expect(text.startsWith("あ".repeat(200))).toBe(true);
    expect(text).toContain(THINNED_MARKER);
    expect(text.length).toBeLessThan(300);
  });

  it("短いテキストの thin は元のまま (無意味な注記を増やさない)", () => {
    const messages: Message[] = [{ role: "assistant", content: "短い" }];
    const segs = buildSegments(messages, 0);
    const { next } = applyPlanToMessages(messages, segs, [1], []);
    expect(next[0].content).toBe("短い");
  });

  it("指定しなかったセグメントは同一オブジェクトのまま残る (無劣化)", () => {
    const messages = sampleMessages();
    const segs = buildSegments(messages, 0);
    const { next } = applyPlanToMessages(messages, segs, [2], []);
    expect(next).toContain(messages[0]);
    expect(next).toContain(messages[7]);
  });
});

describe("トゥームストーン — silent な欠損を作らない", () => {
  it("thin / drop の内訳と削減トークンが本文に載る", () => {
    const text = buildTombstoneText({
      segmentCount: 3,
      freedTokens: 52300,
      thinnedTools: ["file_read", "file_read", "bash"],
      droppedDigests: ["tools: grep×1"],
    });
    expect(text.startsWith(TOMBSTONE_MARKER)).toBe(true);
    expect(text).toContain("52,300");
    expect(text).toContain("file_read×2");
    expect(text).toContain("bash×1");
    expect(text).toContain("完全削除");
  });

  it("既存トゥームストーンがあれば追記統合され、 履歴中に散乱しない", () => {
    const base: Message[] = [
      { role: "system", content: `${TOMBSTONE_MARKER} 1 回目` },
      { role: "user", content: "u" },
    ];
    const merged = insertTombstone(base, `${TOMBSTONE_MARKER} 2 回目`, 1);
    expect(merged.filter((m) => String(m.content).startsWith(TOMBSTONE_MARKER)).length).toBe(1);
    expect(String(merged[0].content)).toContain("1 回目");
    expect(String(merged[0].content)).toContain("2 回目");
    expect(merged.length).toBe(2);
  });

  it("無ければ指定位置に 1 件挿入される", () => {
    const base: Message[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    const out = insertTombstone(base, "T", 1);
    expect(out.map((m) => m.content)).toEqual(["a", "T", "b"]);
  });
});

// ─── MessageHistory.replaceMessages のペア整合検証 ───

describe("MessageHistory.replaceMessages — ペア整合を検証して壊れた履歴を弾く", () => {
  it("整合していれば置き換わる", () => {
    const h = new MessageHistory("sys");
    h.replaceMessages(sampleMessages());
    expect(h.getRawMessages().length).toBe(8);
  });

  it("tool_calls に対応する tool_result が欠けていたら throw", () => {
    const h = new MessageHistory("sys");
    expect(() =>
      h.replaceMessages([
        { role: "assistant", content: "x", tool_calls: [toolCall("c1", "f")] },
        { role: "user", content: "u" },
      ]),
    ).toThrow(/tool_result が欠落/);
  });

  it("孤立した tool_result は throw", () => {
    const h = new MessageHistory("sys");
    expect(() => h.replaceMessages([{ role: "tool", content: "r", tool_call_id: "c1" }])).toThrow(/孤立/);
  });

  it("tool_call_id が対応しない tool_result は throw", () => {
    const h = new MessageHistory("sys");
    expect(() =>
      h.replaceMessages([
        { role: "assistant", content: "x", tool_calls: [toolCall("c1", "f")] },
        { role: "tool", content: "r", tool_call_id: "別の id" },
      ]),
    ).toThrow(/対応する tool_call の無い/);
  });

  it("throw した場合、 履歴は書き換わらない (呼び出し側がロールバックできる)", () => {
    const h = new MessageHistory("sys");
    h.replaceMessages(sampleMessages());
    const before = h.getRawMessages();
    expect(() => h.replaceMessages([{ role: "tool", content: "orphan", tool_call_id: "zz" }])).toThrow();
    expect(h.getRawMessages()).toEqual(before);
  });
});

// ─── エンジン (エンドツーエンド) ───

function historyWith(messages: Message[]): MessageHistory {
  const h = new MessageHistory("sys");
  h.replaceMessages(messages);
  return h;
}

describe("ForgettingEngine", () => {

  it("忘却を適用し、 トゥームストーンを 1 件残し、 履歴の整合を保つ", async () => {
    const engine = new ForgettingEngine(stubProvider(['{"thin":[2],"drop":[],"reason":"巨大な読込を落とした"}']), "m", {
      keepRecentSegments: 1,
    });
    const history = historyWith(sampleMessages());
    const result = await engine.forget(history, 500);

    expect(result.applied).toBe(true);
    expect(result.thinnedSegments).toBe(1);
    expect(result.freedTokens).toBeGreaterThan(0);
    const raw = history.getRawMessages();
    expect(raw.filter((m) => String(m.content).startsWith(TOMBSTONE_MARKER)).length).toBe(1);
    // 適用後も整合している
    expect(() => new MessageHistory("sys").replaceMessages(raw)).not.toThrow();
  });

  it("JSON パース失敗は同じ経路で 1 回だけ再試行し、それでもだめなら忘却不成立", async () => {
    const provider = stubProvider(["わかりません", "やっぱりわかりません"]);
    const chatSpy = vi.spyOn(provider, "chat");
    const engine = new ForgettingEngine(provider, "m", { keepRecentSegments: 1 });
    const history = historyWith(sampleMessages());
    const before = history.getRawMessages();

    const result = await engine.forget(history, 500);
    expect(result.applied).toBe(false);
    expect(chatSpy).toHaveBeenCalledTimes(2);
    // 履歴は一切変わらない
    expect(history.getRawMessages()).toEqual(before);
  });

  it("thin/drop が 0 件なら忘却は不成立 (何も指定しない = 何も忘れないが縮約にならない)", async () => {
    const engine = new ForgettingEngine(stubProvider(['{"thin":[],"drop":[],"reason":"全部要る"}']), "m", {
      keepRecentSegments: 1,
    });
    const history = historyWith(sampleMessages());
    const result = await engine.forget(history, 500);
    expect(result.applied).toBe(false);
    expect(result.plan).toBeNull();
  });

  it("すべて保護なら LLM を呼ばずに不成立", async () => {
    const provider = stubProvider(['{"thin":[1],"drop":[]}']);
    const chatSpy = vi.spyOn(provider, "chat");
    const engine = new ForgettingEngine(provider, "m", { keepRecentSegments: 100 });
    const result = await engine.forget(historyWith(sampleMessages()), 500);
    expect(result.applied).toBe(false);
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("dryRun は履歴を変更せずプランだけ返す", async () => {
    const engine = new ForgettingEngine(stubProvider(['{"thin":[2],"drop":[3],"reason":"r"}']), "m", {
      keepRecentSegments: 1,
    });
    const history = historyWith(sampleMessages());
    const before = history.getRawMessages();

    const report = await engine.dryRun(history, 500);
    expect(report.plan?.thin).toEqual([2]);
    expect(report.plan?.drop).toEqual([3]);
    expect(report.plan?.estimatedFreedTokens).toBeGreaterThan(0);
    expect(report.manifest).toContain("#1");
    expect(history.getRawMessages()).toEqual(before);
  });

  it("2 回忘却してもトゥームストーンは 1 件に統合される", async () => {
    // 1 回目は #2 (file_read の batch)、 2 回目は挿入された note の分ずれて #5 (grep/bash の batch)
    const engine = new ForgettingEngine(
      stubProvider(['{"thin":[2],"drop":[],"reason":"1"}', '{"thin":[5],"drop":[],"reason":"2"}']),
      "m",
      { keepRecentSegments: 1 },
    );
    const history = historyWith(sampleMessages());
    expect((await engine.forget(history, 500)).applied).toBe(true);
    expect((await engine.forget(history, 500)).applied).toBe(true);
    const tombstones = history.getRawMessages().filter((m) => String(m.content).startsWith(TOMBSTONE_MARKER));
    expect(tombstones.length).toBe(1);
    expect(String(tombstones[0].content)).toContain("file_read");
    expect(String(tombstones[0].content)).toContain("grep");
  });

  it("実質削減が無いプランは適用せず履歴を戻す (情報だけ失うのを防ぐ)", async () => {
    // 短い assistant_text を thin しても縮まらない → トゥームストーン分だけ増えてしまう
    const engine = new ForgettingEngine(stubProvider(['{"thin":[3],"drop":[],"reason":"r"}']), "m", {
      keepRecentSegments: 1,
    });
    const history = historyWith(sampleMessages());
    const before = history.getRawMessages();
    const result = await engine.forget(history, 500);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("削減できない");
    expect(history.getRawMessages()).toEqual(before);
  });

  it("getLastResult で直近の実績が取れる (/forget status)", async () => {
    const engine = new ForgettingEngine(stubProvider(['{"thin":[2],"drop":[],"reason":"r"}']), "m", {
      keepRecentSegments: 1,
    });
    expect(engine.getLastResult()).toBeNull();
    await engine.forget(historyWith(sampleMessages()), 500);
    expect(engine.getLastResult()?.result.applied).toBe(true);
  });
});

it("忘却LLMのレート制限は再試行せず呼出元へ返す", async () => {
  let calls = 0;
  const provider = {
    async *chat(): AsyncGenerator<ChatChunk> {
      calls++;
      yield { type: "error", error: "[azure-gpt] rate_limit_exceeded" };
    },
  } as unknown as LLMProvider;
  const engine = new ForgettingEngine(provider, "test", { keepRecentSegments: 1 });
  const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "ordinary work " + i,
  }));
  await expect(engine.plan(messages, 100)).rejects.toThrow("rate_limit_exceeded");
  expect(calls).toBe(1);
});

it("LLMの応答が空文字（0文字）の場合はパースを行わずnullを返す", async () => {
  const engine = new ForgettingEngine(stubProvider(["", "   "]), "m", { keepRecentSegments: 1 });
  const plan = await engine.plan(sampleMessages(), 500);
  expect(plan).toBeNull();
});

// ─── 2026-10-15: 思考モデルが上限を思考で使い切って本文が空になる件 (docs §4.2 / §4.5) ───

describe("忘却選択の呼び出し: 思考オフ / 不成立理由の区別", () => {
  it("忘却選択の LLM 呼び出しは disableThinking=true で送る", async () => {
    const provider = stubProvider(['{"thin":[2],"drop":[],"reason":"r"}']);
    const chatSpy = vi.spyOn(provider, "chat");
    const engine = new ForgettingEngine(provider, "m", { keepRecentSegments: 1 });
    await engine.plan(sampleMessages(), 500);
    expect(chatSpy.mock.calls[0][0].disableThinking).toBe(true);
  });

  it("思考で上限到達して本文が空なら、 理由に finishReason=length と上限到達を出す", async () => {
    const provider = {
      async *chat(): AsyncGenerator<ChatChunk> {
        yield { type: "thinking", text: "考え中..." } as ChatChunk;
        yield { type: "done", finishReason: "length", usage: { promptTokens: 3000, completionTokens: 1500 } } as ChatChunk;
      },
    } as unknown as LLMProvider;
    const engine = new ForgettingEngine(provider, "m", { keepRecentSegments: 1 });
    const result = await engine.forget(historyWith(sampleMessages()), 500);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("finishReason=length");
    expect(result.reason).toContain("思考だけで使い切った");
    expect(result.reason).toContain("1500");
  });

  it("JSON が読めないときは応答の先頭を理由に含める", async () => {
    const engine = new ForgettingEngine(stubProvider(["すみません、 判断できません"]), "m", { keepRecentSegments: 1 });
    const report = await engine.dryRun(historyWith(sampleMessages()), 500);
    expect(report.plan).toBeNull();
    expect(report.reason).toContain("JSON として読めません");
    expect(report.reason).toContain("判断できません");
  });

  it("選択 0 件と対象なしは別の理由になる", async () => {
    const zero = new ForgettingEngine(stubProvider(['{"thin":[],"drop":[],"reason":"r"}']), "m", {
      keepRecentSegments: 1,
    });
    expect((await zero.forget(historyWith(sampleMessages()), 500)).reason).toContain("1 件も選びませんでした");

    const none = new ForgettingEngine(stubProvider(['{"thin":[1]}']), "m", { keepRecentSegments: 100 });
    expect((await none.forget(historyWith(sampleMessages()), 500)).reason).toContain("忘却できるセグメントがありません");
  });
});

describe("buildSegments digest: パスは末尾を見せる", () => {
  it("長いパスはファイル名側を残して切る", () => {
    const long = "C:\Users\osia3\GitProjects\acecomb\src\game\campaign.js";
    const messages: Message[] = [
      { role: "assistant", content: "", tool_calls: [toolCall("c1", "file_edit", { file_path: long })] },
      { role: "tool", content: "ok", tool_call_id: "c1" },
    ];
    const digest = buildSegments(messages, 0)[0].digest;
    expect(digest).toContain("campaign.js");
    expect(digest).toContain("…");
  });

  it("コマンドは従来どおり先頭を見せる", () => {
    const messages: Message[] = [
      { role: "assistant", content: "", tool_calls: [toolCall("c1", "bash", { command: "cd C:/x && node test/logic.test.js --very-long-flag-value" })] },
      { role: "tool", content: "ok", tool_call_id: "c1" },
    ];
    expect(buildSegments(messages, 0)[0].digest).toContain("cd C:/x");
  });
});
