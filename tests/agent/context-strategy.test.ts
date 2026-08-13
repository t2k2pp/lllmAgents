import { describe, it, expect } from "vitest";
import type { ChatChunk, LLMProvider, Message } from "../../src/providers/base-provider.js";
import { MessageHistory } from "../../src/agent/message-history.js";
import {
  BREAK_SIGNALS,
  ContextStrategy,
  applyGuards,
  decideAction,
  formatDowngradeNotice,
  formatStrategyReport,
  needsConfirmation,
  pickStrongest,
  type GuardInput,
  type StrategyAction,
} from "../../src/agent/context-strategy.js";
import { forgetThinking, selectThinkingTargets, buildSegments, THINNED_MARKER } from "../../src/agent/forgetting.js";
import {
  buildTranscript,
  buildHandoffMessage,
  generateHandoffNote,
  runHandoff,
  validateHandoffNote,
  HANDOFF_MARKER,
} from "../../src/agent/handoff.js";

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

/** 途中で接続が切れる provider (生成失敗の経路を踏む) */
function failingProvider(): LLMProvider {
  const chat = async function* (): AsyncGenerator<ChatChunk> {
    yield { type: "text", text: "## これま" } as ChatChunk;
    throw new Error("connection refused");
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

const GOOD_NOTE = [
  "## これまでにやったこと",
  "- Gateway クライアントを実装した",
  "",
  "## 次にやること",
  "- 実機で /ask を検証する",
  "",
  "## 守るべき制約・決定事項",
  "- 公開URL・トンネルは使わない",
  "",
  "## 関係するファイル",
  "- src/discord/gateway.ts — WS 接続",
].join("\n");

const guardBase: GuardInput = {
  mode: "auto",
  turnsSinceLastAction: 99,
  hasInProgressTodo: false,
  goalActive: false,
  canConfirm: true,
  midSpan: false,
};

// ─── 決定表 (docs/context-strategy.md §4.1) ───

describe("decideAction — 決定表", () => {
  it("40% 未満は何もしない (削る必要が無いのに削ると損)", () => {
    for (const kind of ["weak", "strong", "peak"] as const) {
      expect(decideAction(0.0, kind)).toBe("none");
      expect(decideAction(0.39, kind)).toBe("none");
    }
  });

  it("40〜60% はどの区切りでも forget-thinking (第一選択)", () => {
    for (const kind of ["weak", "strong", "peak"] as const) {
      expect(decideAction(0.4, kind)).toBe("forget-thinking");
      expect(decideAction(0.59, kind)).toBe("forget-thinking");
    }
  });

  it("60〜75% は弱い区切りだけ forget-thinking、 強い区切り・山場は forget", () => {
    expect(decideAction(0.6, "weak")).toBe("forget-thinking");
    expect(decideAction(0.74, "weak")).toBe("forget-thinking");
    expect(decideAction(0.6, "strong")).toBe("forget");
    expect(decideAction(0.74, "peak")).toBe("forget");
  });

  it("75% 以上は 弱い=forget / 強い=clear / 山場=compress", () => {
    expect(decideAction(0.75, "weak")).toBe("forget");
    expect(decideAction(0.75, "strong")).toBe("clear");
    expect(decideAction(0.99, "strong")).toBe("clear");
    // 山場では「これから大量に読む」 ので clear せず要約で枠を確保する
    expect(decideAction(0.75, "peak")).toBe("compress");
  });

  it("使用率が数値でない場合は安全側 (none) に倒す", () => {
    expect(decideAction(Number.NaN, "strong")).toBe("none");
  });
});

// ─── ガード (§4.3) ───

describe("applyGuards — 実行しない条件と格下げ", () => {
  it("直前の整理から 3 ターン未満なら見送る", () => {
    const r = applyGuards("forget-thinking", { ...guardBase, turnsSinceLastAction: 2 });
    expect(r.skipped).toBe(true);
    expect(r.action).toBe("none");
  });

  it("3 ターン経っていれば実行する", () => {
    const r = applyGuards("forget-thinking", { ...guardBase, turnsSinceLastAction: 3 });
    expect(r.skipped).toBe(false);
    expect(r.action).toBe("forget-thinking");
  });

  it("in_progress の ToDo があれば clear を forget に格下げする", () => {
    const r = applyGuards("clear", { ...guardBase, hasInProgressTodo: true });
    expect(r.action).toBe("forget");
    expect(r.downgrades).toHaveLength(1);
    expect(r.downgrades[0]).toContain("clear → forget");
  });

  it("Goal Seek 実行中なら clear を forget に格下げする", () => {
    const r = applyGuards("clear", { ...guardBase, goalActive: true });
    expect(r.action).toBe("forget");
    expect(r.downgrades[0]).toContain("Goal Seek");
  });

  it("span の途中では clear を forget に格下げする (作業中に履歴を消さない)", () => {
    const r = applyGuards("clear", { ...guardBase, midSpan: true });
    expect(r.action).toBe("forget");
    expect(r.downgrades[0]).toContain("作業の途中");
  });

  it("auto かつ確認を取れない経路なら clear を compress に格下げする", () => {
    const r = applyGuards("clear", { ...guardBase, canConfirm: false });
    expect(r.action).toBe("compress");
    expect(r.downgrades[0]).toContain("clear → compress");
  });

  it("aggressive なら確認不要なので非 TTY でも clear のまま", () => {
    const r = applyGuards("clear", { ...guardBase, mode: "aggressive", canConfirm: false });
    expect(r.action).toBe("clear");
    expect(r.downgrades).toHaveLength(0);
  });

  it("格下げは黙って起こさない (通知文が作れる)", () => {
    const r = applyGuards("clear", { ...guardBase, hasInProgressTodo: true });
    const decision = {
      at: Date.now(),
      signal: "B1" as const,
      signalLabel: BREAK_SIGNALS.B1.label,
      kind: BREAK_SIGNALS.B1.kind,
      usageRatio: 0.8,
      proposed: "clear" as StrategyAction,
      action: r.action,
      downgrades: r.downgrades,
      skipped: false,
    };
    expect(formatDowngradeNotice(decision)).toContain("格下げ");
  });

  it("none はガードを通しても none のまま", () => {
    const r = applyGuards("none", { ...guardBase, turnsSinceLastAction: 0 });
    expect(r.action).toBe("none");
    expect(r.skipped).toBe(false);
  });
});

describe("needsConfirmation", () => {
  it("auto の clear だけ確認が要る", () => {
    expect(needsConfirmation("clear", "auto")).toBe(true);
    expect(needsConfirmation("clear", "aggressive")).toBe(false);
    expect(needsConfirmation("forget", "auto")).toBe(false);
    expect(needsConfirmation("compress", "auto")).toBe(false);
  });
});

describe("pickStrongest — 同時成立時はより強いシグナルを採る", () => {
  it("strong > peak > weak", () => {
    const picked = pickStrongest([
      { signal: "B5", fingerprint: "a" },
      { signal: "P1", fingerprint: "b" },
      { signal: "B1", fingerprint: "c" },
    ]);
    expect(picked?.signal).toBe("B1");
  });

  it("山場のみなら山場が選ばれる", () => {
    const picked = pickStrongest([
      { signal: "B6", fingerprint: "a" },
      { signal: "P3", fingerprint: "b" },
    ]);
    expect(picked?.signal).toBe("P3");
  });

  it("空なら null", () => {
    expect(pickStrongest([])).toBeNull();
  });
});

// ─── ContextStrategy ───

describe("ContextStrategy", () => {
  function ready(mode: "off" | "auto" | "aggressive" = "auto"): ContextStrategy {
    const s = new ContextStrategy({ mode });
    // 最短間隔を満たすまでターンを進める
    for (let i = 0; i < 5; i++) s.noteTurn();
    return s;
  }

  const input = {
    signal: "B1" as const,
    fingerprint: "fp-1",
    usageRatio: 0.8,
    hasInProgressTodo: false,
    goalActive: false,
    canConfirm: true,
    midSpan: false,
  };

  it("off なら何も判断しない", () => {
    const s = ready("off");
    const d = s.decide(input);
    expect(d.skipped).toBe(true);
    expect(d.action).toBe("none");
    expect(d.note).toBe("mode=off");
  });

  it("強い区切り + 高使用率で clear を選ぶ", () => {
    const d = ready().decide(input);
    expect(d.proposed).toBe("clear");
    expect(d.action).toBe("clear");
  });

  it("実行直後は最短間隔で見送る", () => {
    const s = ready();
    const first = s.decide(input);
    expect(first.action).toBe("clear");
    s.noteApplied();
    s.noteTurn();
    const second = s.decide({ ...input, fingerprint: "fp-2" });
    expect(second.skipped).toBe(true);
  });

  it("見送りを選ばれた区切りでは clear を再提案しない", () => {
    const s = ready();
    s.decline(input.fingerprint);
    const d = s.decide(input);
    expect(d.action).toBe("forget");
    expect(d.downgrades.join()).toContain("既に見送りを選択済み");
  });

  it("判断は必ずログに残る", () => {
    const s = ready();
    s.decide(input);
    s.decide({ ...input, signal: "B4", fingerprint: "fp-2", usageRatio: 0.1 });
    const log = s.getDecisions();
    expect(log).toHaveLength(2);
    expect(log[0].signal).toBe("B1");
    expect(log[1].action).toBe("none");
  });

  it("使用率が低ければ何もしない", () => {
    const d = ready().decide({ ...input, usageRatio: 0.2 });
    expect(d.action).toBe("none");
    expect(d.skipped).toBe(false);
  });
});

describe("formatStrategyReport — §6 の 1 行報告", () => {
  it("シグナル・アクション・削減量・使用率の変化を含む", () => {
    const line = formatStrategyReport({
      signalLabel: "git commit",
      action: "forget-thinking",
      freedTokens: 38_200,
      beforeRatio: 0.71,
      afterRatio: 0.32,
    });
    expect(line).toContain("区切りを検出 (git commit)");
    expect(line).toContain("38,200");
    expect(line).toContain("71%");
    expect(line).toContain("32%");
  });
});

// ─── forget-thinking (§2.1) ───

describe("forgetThinking — 決定論的な忘却", () => {
  /** 読取系だけの batch と 書込を含む batch を並べた履歴 */
  function messages(): Message[] {
    const out: Message[] = [
      { role: "user", content: "Gateway の受信方式を調べて実装して" },
      { role: "assistant", content: "調べます", tool_calls: [toolCall("c1", "file_read", { file_path: "src/a.ts" })] },
      { role: "tool", content: "A".repeat(8000), tool_call_id: "c1" },
      { role: "assistant", content: "読みました" },
      {
        role: "assistant",
        content: "書きます",
        tool_calls: [toolCall("c2", "file_write", { file_path: "src/b.ts" })],
      },
      { role: "tool", content: "B".repeat(8000), tool_call_id: "c2" },
      { role: "assistant", content: "検索します", tool_calls: [toolCall("c3", "grep", { pattern: "foo" })] },
      { role: "tool", content: "C".repeat(8000), tool_call_id: "c3" },
    ];
    // 直近保護に入らないよう後ろに軽いセグメントを足す
    for (let i = 0; i < 6; i++) out.push({ role: "assistant", content: `ok${i}` });
    return out;
  }

  it("読取系のみの tool_batch を選び、 書込を含む batch は選ばない", () => {
    const segments = buildSegments(messages());
    const targets = selectThinkingTargets(segments);
    const kinds = targets.map((i) => segments.find((s) => s.index === i)?.toolNames);
    expect(kinds).toEqual([["file_read"], ["grep"]]);
  });

  it("LLM を呼ばずに読取系の結果本文だけ落とす (メインストーリは無劣化)", () => {
    const history = new MessageHistory("sys");
    history.replaceMessages(messages());
    const result = forgetThinking(history);

    expect(result.applied).toBe(true);
    expect(result.thinnedSegments).toBe(2);
    expect(result.freedTokens).toBeGreaterThan(0);

    const raw = history.getRawMessages();
    // user / assistant のテキストは無劣化で残る
    expect(raw.some((m) => m.role === "user" && m.content === "Gateway の受信方式を調べて実装して")).toBe(true);
    expect(raw.some((m) => m.role === "assistant" && m.content === "読みました")).toBe(true);
    // 書込系の結果本文は残る (どう変更したかは履歴にしか残らない)
    expect(raw.some((m) => m.role === "tool" && String(m.content).startsWith("B"))).toBe(true);
    // 読取系の結果本文は消えて、 呼び出し記録は残る
    expect(raw.some((m) => m.role === "tool" && String(m.content).startsWith("A"))).toBe(false);
    expect(raw.filter((m) => String(m.content).includes(THINNED_MARKER)).length).toBeGreaterThan(0);
    expect(raw.some((m) => m.tool_calls?.some((c) => c.function.name === "file_read"))).toBe(true);
  });

  it("忘却できるものが無ければ適用しない", () => {
    const history = new MessageHistory("sys");
    history.replaceMessages([
      { role: "user", content: "こんにちは" },
      { role: "assistant", content: "こんにちは" },
    ]);
    const result = forgetThinking(history);
    expect(result.applied).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(history.getRawMessages()).toHaveLength(2);
  });

  it("thinking も削除する", () => {
    const history = new MessageHistory("sys");
    history.addUserMessage("やって");
    history.addAssistantMessage("やりました", undefined, { thinking: "X".repeat(4000) });
    const result = forgetThinking(history);
    expect(result.clearedThinking).toBe(1);
    expect(result.freedTokens).toBeGreaterThan(0);
    expect(history.getRawMessages()[1].thinking).toBeUndefined();
  });

  it("適用後もツールのペア整合が保たれる (壊れた履歴を作らない)", () => {
    const history = new MessageHistory("sys");
    history.replaceMessages(messages());
    forgetThinking(history);
    // replaceMessages はペア整合を検証するので、 通れば整合している
    expect(() => history.replaceMessages(history.getRawMessages())).not.toThrow();
  });
});

// ─── 引き継ぎメモ (§2.2) ───

describe("validateHandoffNote", () => {
  it("テンプレートの節が揃っていれば受理する", () => {
    expect(validateHandoffNote(GOOD_NOTE)).toContain("## 守るべき制約・決定事項");
  });

  it("コードフェンスを剥がす", () => {
    expect(validateHandoffNote("```markdown\n" + GOOD_NOTE + "\n```")).toContain("## 次にやること");
  });

  it("前置きがあっても最初の見出しから採る", () => {
    const note = validateHandoffNote("承知しました。以下がメモです。\n\n" + GOOD_NOTE);
    expect(note?.startsWith("## これまでにやったこと")).toBe(true);
  });

  it("節が足りなければ受理しない", () => {
    expect(validateHandoffNote("## これまでにやったこと\n- 色々やりました")).toBeNull();
  });

  it("空・短すぎるものは受理しない", () => {
    expect(validateHandoffNote("")).toBeNull();
    expect(validateHandoffNote("できました")).toBeNull();
  });
});

describe("buildTranscript", () => {
  it("ツール呼び出しは名前だけ、 結果は短く切る", () => {
    const text = buildTranscript([
      { role: "user", content: "やって" },
      { role: "assistant", content: "はい", tool_calls: [toolCall("c1", "file_read", { file_path: "a.ts" })] },
      { role: "tool", content: "X".repeat(5000), tool_call_id: "c1" },
    ]);
    expect(text).toContain("(tool: file_read)");
    expect(text.length).toBeLessThan(1000);
  });

  it("上限を超えたら古い側から落とし、 落とした事実を明記する", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 200; i++) messages.push({ role: "user", content: `メッセージ${i} ` + "あ".repeat(300) });
    const text = buildTranscript(messages, 2000);
    expect(text).toContain("長さの都合で省略");
    expect(text).toContain("メッセージ199");
  });
});

describe("runHandoff — 生成成功を確認してから clear する (§8)", () => {
  function seeded(): MessageHistory {
    const history = new MessageHistory("sys");
    history.addUserMessage("Gateway を実装して");
    history.addAssistantMessage("実装しました。" + "詳細".repeat(500));
    return history;
  }

  it("メモを作れたら履歴をリセットしてメモを再投入する", async () => {
    const history = seeded();
    const before = history.getRawMessages().length;
    const result = await runHandoff(stubProvider([GOOD_NOTE]), "m", history);

    expect(result.applied).toBe(true);
    expect(result.note).toContain("## 守るべき制約・決定事項");
    expect(result.freedTokens).toBeGreaterThan(0);
    const raw = history.getRawMessages();
    expect(raw).toHaveLength(1);
    expect(before).toBeGreaterThan(1);
    expect(raw[0].role).toBe("user");
    expect(String(raw[0].content)).toContain(HANDOFF_MARKER);
    expect(String(raw[0].content)).toContain("## 次にやること");
  });

  it("メモを作れなかったら履歴に一切触れない", async () => {
    const history = seeded();
    const snapshot = history.getRawMessages();
    const result = await runHandoff(failingProvider(), "m", history);

    expect(result.applied).toBe(false);
    expect(result.note).toBeNull();
    expect(result.reason).toBeTruthy();
    expect(history.getRawMessages()).toEqual(snapshot);
  });

  it("節が揃わない応答でも履歴は消さない", async () => {
    const history = seeded();
    const snapshot = history.getRawMessages();
    const result = await runHandoff(stubProvider(["やっておきました"]), "m", history);
    expect(result.applied).toBe(false);
    expect(history.getRawMessages()).toEqual(snapshot);
  });

  it("clear の前にセッションを保存する (/resume で完全復元できる状態を作る)", async () => {
    const history = seeded();
    let saved = 0;
    const result = await runHandoff(stubProvider([GOOD_NOTE]), "m", history, {
      saveSession: () => {
        saved++;
        return "sess-123";
      },
    });
    expect(saved).toBe(1);
    expect(result.savedSessionId).toBe("sess-123");
    expect(String(history.getRawMessages()[0].content)).toContain("sess-123");
  });

  it("履歴が空なら生成しない", async () => {
    const history = new MessageHistory("sys");
    const result = await runHandoff(stubProvider([GOOD_NOTE]), "m", history);
    expect(result.applied).toBe(false);
  });
});

describe("generateHandoffNote — 検証失敗は 1 回だけ再試行する", () => {
  it("2 回目で正しい形式が返れば受理する", async () => {
    const provider = stubProvider(["だめな応答", GOOD_NOTE]);
    const result = await generateHandoffNote(provider, "m", [{ role: "user", content: "やって" }]);
    expect(result.note).toContain("## 関係するファイル");
  });
});

describe("buildHandoffMessage", () => {
  it("リセットされた事実とメモ本文を含む", () => {
    const text = buildHandoffMessage(GOOD_NOTE);
    expect(text).toContain(HANDOFF_MARKER);
    expect(text).toContain("リセット");
    expect(text).toContain("## これまでにやったこと");
  });
});
