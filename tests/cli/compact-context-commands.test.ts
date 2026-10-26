import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { runChannelCommand } from "../../src/agent/channel-commands.js";
import { computeContextBudget } from "../../src/agent/context-budget.js";
import type {
  LastReductionEvent,
  ReductionEventRecord,
  ReductionEventResult,
  ReductionPreview,
  ReductionStatus,
} from "../../src/agent/reduction-event.js";
import type { RoomManager } from "../../src/agent/room-manager.js";
import { getCommandRegistry, getRegistryCompletions, getRegistryHelpEntries } from "../../src/cli/commands/registry.js";
import type { ReplCommandContext } from "../../src/cli/commands/types.js";
import { createCompleter } from "../../src/cli/completer.js";
import { formatCompactResult, formatReductionStatus } from "../../src/cli/reduction-view.js";
import { BUILTIN_HELP_ENTRIES } from "../../src/cli/renderer.js";
import type { LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

/** /compact と /context の表示 (docs/context-reduction-redesign.md §7。 整理の作り直し タスク 10) */

// biome-ignore lint/suspicious/noControlCharactersInRegex: 色の制御文字を外す
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, "");

afterEach(() => {
  vi.restoreAllMocks();
});

function record(overrides: Partial<ReductionEventRecord> = {}): ReductionEventRecord {
  return {
    id: "r-1-abc",
    trigger: "manual",
    ok: true,
    promptTokensBefore: 150_000,
    promptBasis: "usage",
    targetPromptTokens: 114_560,
    minimumReductionTokens: 40_000,
    growthTokens: 80_000,
    reachedStage: 2,
    freedTokens: { preprocess: 1_200, stage0: 3_400, stage1: 47_000, stage2: 400, stage3: 0, total: 52_000 },
    repaid: { ephemeral: 1, thinking: 2 },
    forgottenCalls: 24,
    clearedCurrentThinking: 0,
    promptTokensAfter: 98_000,
    summary: { status: "nothing-to-summarize" },
    summaryFailurePolicy: "continue",
    continuedWithoutSummary: false,
    prewarm: null,
    durationMs: 10,
    ...overrides,
  };
}

const ok = (r: ReductionEventRecord): ReductionEventResult => ({ ok: true, record: r });
const sentPrewarm = (r: ReductionEventRecord): LastReductionEvent => ({
  record: r,
  finishedAt: Date.now(),
  prewarmSent: true,
});

// ─── /compact の表示 ───

describe("/compact の結果の表示", () => {
  it("成功 (要約なし): 前後の P、 段階ごとの減った量、 要約しなかったこと、 先読みを送ったこと", () => {
    const r = record();
    const out = plain(formatCompactResult(ok(r), sentPrewarm(r)));
    expect(out).toContain("/compact の結果 (r-1-abc)");
    expect(out).toContain("整理前: 約 150,000 トークン (サーバが返した実数をもとにした値)");
    expect(out).toContain("整理後: 約 98,000 トークン (推定)");
    expect(out).toContain("減った量: 約 52,000 トークン");
    expect(out).toMatch(/前の依頼の片付け.*約 1,200/);
    expect(out).toMatch(/段階 0 .*約 3,400/);
    expect(out).toMatch(/段階 1 \(古いツール結果\).*約 47,000/);
    expect(out).toMatch(/段階 2 \(古い思考\).*約 400/);
    expect(out).toMatch(/段階 3 \(要約\).*約 0/);
    expect(out).toContain("要約: しませんでした (要約してよい範囲がありません");
    expect(out).toContain("先読み: 送りました");
  });

  it("成功 (要約あり): 要約した区間の数と段階 3 の量", () => {
    const r = record({
      reachedStage: 3,
      freedTokens: { preprocess: 0, stage0: 0, stage1: 10_000, stage2: 0, stage3: 30_000, total: 39_500 },
      promptTokensAfter: 110_500,
      summary: { status: "done", segments: 3, attempts: 1 },
    });
    const out = plain(formatCompactResult(ok(r), sentPrewarm(r)));
    expect(out).toContain("要約: 3 区間を要約しました");
    expect(out).toMatch(/段階 3 \(要約\).*約 30,000/);
  });

  it("要約に失敗し、 設定 continue に従って段階 0〜2 だけで整理したとき", () => {
    const r = record({
      reachedStage: 3,
      summary: {
        status: "failed",
        failureReason: "format",
        failureDetail: "要約を得られませんでした (format): 見出しが足りません",
      },
      continuedWithoutSummary: true,
    });
    const out = plain(formatCompactResult(ok(r), sentPrewarm(r)));
    expect(out).toContain("設定 context.summaryFailure が continue なので、 段階 0〜2 の分だけで整理しました");
    expect(out).toContain("見出しが足りません");
    expect(out).toContain("整理後: 約 98,000");
  });

  it("要約に失敗し、 設定 stop に従って取りやめたとき: 履歴は変えず、 先読みも送らない", () => {
    const r = record({
      ok: false,
      failureReason: "summary-failed",
      reachedStage: 3,
      summary: {
        status: "failed",
        failureReason: "tool-call",
        failureDetail: "要約を得られませんでした (tool-call): ツールを呼びました",
      },
      summaryFailurePolicy: "stop",
    });
    const result: ReductionEventResult = {
      ok: false,
      reason: "summary-failed",
      detail: "要約を得られませんでした",
      record: r,
    };
    const out = plain(formatCompactResult(result, { record: r, finishedAt: Date.now(), prewarmSent: false }));
    expect(out).toContain("結果: 要約を得られませんでした。 履歴は変えていません");
    expect(out).toContain("設定 context.summaryFailure が stop なので、 整理を取りやめました");
    expect(out).toContain("ツールを呼びました");
    expect(out).toContain("先読み: 送っていません (履歴を変えていないので");
    expect(out).not.toContain("整理後");
  });

  it("減らせるものが無いとき", () => {
    const r = record({
      ok: false,
      failureReason: "nothing-to-reduce",
      promptBasis: "estimate",
      promptTokensBefore: 3_000,
    });
    const result: ReductionEventResult = {
      ok: false,
      reason: "nothing-to-reduce",
      detail: "減らせるものがありませんでした (段階 0〜2 で 0 トークン、 要約: nothing-to-summarize)",
      record: r,
    };
    const out = plain(formatCompactResult(result, null));
    expect(out).toContain("結果: 減らせるものがありませんでした。 履歴は変えていません");
    expect(out).toContain("いまの量: 約 3,000 トークン (文字数からの推定)");
    expect(out).toContain("段階 0〜2 で 0 トークン");
  });

  it("先読みを送らなかったときは理由を出す", () => {
    const r = record({
      prewarm: {
        status: "skipped",
        reason: "not-local-server",
        detail: "provider anthropic は自分のサーバで動かすものではないため先読みしません",
      },
    });
    const out = plain(formatCompactResult(ok(r), { record: r, finishedAt: Date.now(), prewarmSent: false }));
    expect(out).toContain(
      "先読み: 送っていません (provider anthropic は自分のサーバで動かすものではないため先読みしません)",
    );
  });
});

// ─── /context の整理の状態 ───

function preview(overrides: Partial<Extract<ReductionPreview, { ok: true }>> = {}): ReductionPreview {
  return {
    ok: true,
    goal: { targetPromptTokens: 114_560, minimumReductionTokens: 40_000 },
    freedTokens: { preprocess: 100, stage0: 200, stage1: 50_000, stage2: 300, total: 50_600 },
    repaid: { ephemeral: 0, thinking: 0 },
    forgottenCalls: 10,
    clearedCurrentThinking: 0,
    promptTokensAfterStages: 99_400,
    needsSummary: false,
    shortfall: { toTarget: 0, toMinimum: 0 },
    summary: { status: "would-summarize", segments: 2, estimatedFreedTokens: 12_000 },
    ...overrides,
  };
}

function status(overrides: Partial<ReductionStatus> = {}): ReductionStatus {
  const budget = computeContextBudget(262_144, "T2"); // R = 67,584
  return {
    budget,
    keepRecentToolUses: 5,
    toolResultLimitTokens: 5_120,
    promptSize: { tokens: 150_000, basis: "usage" },
    growth: { tokens: 80_000, source: "default", capped: false, capTokens: 97_280 },
    recentGrowths: [],
    forcedLimitTokens: 262_144 - 67_584,
    boundaryLimitTokens: 262_144 - 67_584 - 80_000,
    summaryFailurePolicy: "continue",
    preview: preview(),
    lastEvent: null,
    ...overrides,
  };
}

describe("/context の整理の状態", () => {
  it("P が実数か推定か", () => {
    expect(plain(formatReductionStatus(status()))).toContain(
      "次に送る量 P: 約 150,000 トークン (サーバが返した実数をもとにした値)",
    );
    expect(plain(formatReductionStatus(status({ promptSize: { tokens: 4_000, basis: "estimate" } })))).toContain(
      "次に送る量 P: 約 4,000 トークン (文字数からの推定)",
    );
  });

  it("R の内訳と規則 1・2 の発火点 (いまの P との距離)", () => {
    const out = plain(formatReductionStatus(status()));
    expect(out).toContain(
      "予約 R: 67,584 = 出力の上限 O 32,768 + ツール結果の合計 T 24,576 + 推定の余白 M 4,096 + 整理の余白 S 6,144",
    );
    expect(out).toMatch(/規則 1.*194,560.*あと 44,560/);
    expect(out).toMatch(/規則 2.*114,560.*いま 35,440 超えています/);
  });

  it("G と直近の依頼 (既定値 / 直近 3 件の最大・頭打ち)", () => {
    const def = plain(formatReductionStatus(status()));
    expect(def).toContain("ひと仕事の増分 G: 80,000 (既定値。 直近の依頼が 3 件そろうまで)");
    expect(def).toContain("直近の依頼で増えた量: まだ記録がありません");
    const recent = plain(
      formatReductionStatus(
        status({
          growth: { tokens: 97_280, source: "recent-max", capped: true, capTokens: 97_280 },
          recentGrowths: [12_000, 150_000, 8_000],
        }),
      ),
    );
    expect(recent).toContain(
      "ひと仕事の増分 G: 97,280 (直近 3 件の依頼で増えた量の最大。 (W − R) ÷ 2 = 97,280 で頭打ち)",
    );
    expect(recent).toContain("直近の依頼で増えた量: 12,000 / 150,000 / 8,000");
  });

  it("直近の整理イベント", () => {
    expect(plain(formatReductionStatus(status()))).toContain("直近の整理: この会話ではまだ整理していません");
    const r = record({ trigger: "boundary:request-end", summary: { status: "done", segments: 2 } });
    const out = plain(
      formatReductionStatus(status({ lastEvent: { record: r, finishedAt: Date.now(), prewarmSent: true } })),
    );
    expect(out).toContain("直近の整理: r-1-abc (依頼の区切り、");
    expect(out).toContain("約 52,000 トークン減 (150,000 → 98,000)、 要約 2 区間");
    const failed = record({
      ok: false,
      failureReason: "nothing-to-reduce",
      failureDetail: "減らせるものがありませんでした",
    });
    expect(
      plain(
        formatReductionStatus(status({ lastEvent: { record: failed, finishedAt: Date.now(), prewarmSent: false } })),
      ),
    ).toContain("減らせるものがありませんでした。 履歴は変えていません");
  });

  it("今 /compact した場合の見込み: 段階ごとの量と、 段階 3 は要るかどうかと不足量だけ", () => {
    const out = plain(formatReductionStatus(status()));
    expect(out).toContain("今 /compact した場合の見込み (要約は呼ばずに数えた値)");
    expect(out).toMatch(/段階 1 \(古いツール結果\).*約 50,000/);
    expect(out).toContain("段階 0〜2 の後: 約 99,400 トークン (目標は 114,560 以下、 最低 40,000 減らす)");
    expect(out).toContain("段階 0〜2 だけで目標と最低量に届きます");
    expect(out).toContain("/compact では 2 区間を要約します (LLM を呼びます。 見込み 約 12,000 減)");
    expect(out).toContain("段階 0〜2 の分だけで整理 (continue)");

    const short = plain(
      formatReductionStatus(
        status({
          summaryFailurePolicy: "stop",
          preview: preview({
            needsSummary: true,
            shortfall: { toTarget: 5_000, toMinimum: 20_000 },
            summary: { status: "nothing-to-summarize", detail: "見込み 0 トークン" },
          }),
        }),
      ),
    );
    expect(short).toContain("目標まで 5,000、 最低量まで 20,000 不足");
    expect(short).toContain("段階 3 (要約): 要約してよい範囲がありません (見込み 0 トークン)");
    expect(short).toContain("整理を取りやめる (stop)");

    const broken = plain(formatReductionStatus(status({ preview: { ok: false, error: "対が壊れています" } })));
    expect(broken).toContain("見込みを出せませんでした: 対が壊れています");
  });
});

// ─── 登録と、 削除したコマンド ───

describe("/compact と /context の登録 (レジストリ方式)", () => {
  it("レジストリに登録され、 補完とヘルプに出る", () => {
    expect(getCommandRegistry().get("/compact")).toBeDefined();
    expect(getCommandRegistry().get("/context")).toBeDefined();
    const completions = getRegistryCompletions().map((c) => c.command);
    for (const c of ["/compact", "/context", "/context system", "/context tools", "/context messages"]) {
      expect(completions).toContain(c);
    }
    const help = getRegistryHelpEntries().map((e) => e.name);
    expect(help).toContain("/compact");
    expect(help).toContain("/context");
    // 旧 switch 方式の一覧には残さない (二重に載せない)
    expect(BUILTIN_HELP_ENTRIES.some((e) => e.usage.startsWith("/context") || e.usage === "/compact")).toBe(false);
  });

  it("/forget 一式と /context strategy は登録されず、 補完・ヘルプにも無い", () => {
    const registry = getCommandRegistry();
    expect(registry.get("/forget")).toBeUndefined();
    const [all] = createCompleter({})("/");
    const [contextSubs] = createCompleter({})("/context ");
    const texts = [
      ...all,
      ...contextSubs,
      ...getRegistryCompletions().map((c) => `${c.command} ${c.description}`),
      ...getRegistryHelpEntries().map((e) => `${e.name} ${e.summary}`),
      ...BUILTIN_HELP_ENTRIES.map((e) => `${e.usage} ${e.summary}`),
    ];
    expect(texts.some((t) => t.startsWith("/forget"))).toBe(false);
    expect(texts.some((t) => /strategy/.test(t))).toBe(false);
  });
});

// ─── ハンドラ ───

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    chunks.push(`${args.join(" ")}\n`);
  });
  return { text: () => plain(chunks.join("")) };
}

describe("/compact のハンドラ", () => {
  it("整理イベント (manual) を行い、 内訳を出す", async () => {
    const r = record();
    const runReductionEvent = vi.fn(async () => ok(r));
    const agent = { runReductionEvent, getLastReductionEvent: () => sentPrewarm(r) };
    const out = captureStdout();
    await getCommandRegistry()
      .get("/compact")
      ?.handler({ agent } as unknown as ReplCommandContext, []);
    expect(runReductionEvent).toHaveBeenCalledWith("manual");
    expect(out.text()).toContain("/compact の結果 (r-1-abc)");
    expect(out.text()).toContain("先読み: 送りました");
  });

  it("引数は受け付けない (/compact dry は無い。 見込みは /context)", async () => {
    const runReductionEvent = vi.fn();
    const out = captureStdout();
    await getCommandRegistry()
      .get("/compact")
      ?.handler({ agent: { runReductionEvent } } as unknown as ReplCommandContext, ["dry"]);
    expect(runReductionEvent).not.toHaveBeenCalled();
    expect(out.text()).toContain("/compact は引数を取りません");
    expect(out.text()).toContain("/context");
  });
});

function provider(): LLMProvider {
  const chatWithTools = async function* () {
    yield { type: "done", finishReason: "stop" };
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

function realAgent(): AgentLoop {
  const loop = new AgentLoop(
    provider(),
    "test-model-7b",
    new ToolRegistry(),
    new PermissionManager({ allowedDirectories: [], blockedCommands: [], rules: { allow: [], deny: [], ask: [] } }),
    128_000,
  );
  loop.getHistory().addUserMessage("こんにちは");
  loop.getHistory().addAssistantMessage("こんにちは。 何をしましょう");
  return loop;
}

describe("/context のハンドラと AgentLoop.getReductionStatus", () => {
  it("内訳の後に整理の状態を出す。 実数が無いうちは P は推定", async () => {
    const agent = realAgent();
    const s = agent.getReductionStatus();
    expect(s.promptSize.basis).toBe("estimate");
    expect(s.forcedLimitTokens).toBe(128_000 - s.budget.reserveTokens);
    expect(s.boundaryLimitTokens).toBe(s.forcedLimitTokens - s.growth.tokens);
    expect(s.preview.ok).toBe(true);
    expect(s.lastEvent).toBeNull();

    const out = captureStdout();
    await getCommandRegistry()
      .get("/context")
      ?.handler({ agent } as unknown as ReplCommandContext, []);
    expect(out.text()).toContain("Context Usage");
    expect(out.text()).toContain("コンテキストの整理");
    expect(out.text()).toContain("(文字数からの推定)");
    expect(out.text()).toContain("今 /compact した場合の見込み");
  });

  it("/context strategy は不明な section として扱う (名残を残さない)", async () => {
    const out = captureStdout();
    await getCommandRegistry()
      .get("/context")
      ?.handler({ agent: realAgent() } as unknown as ReplCommandContext, ["strategy"]);
    expect(out.text()).toContain("不明な section: strategy");
  });

  it("/compact の後は直近の整理として出る。 表示は履歴に入らない", async () => {
    const agent = realAgent();
    const before = agent.getHistory().getRawMessages();
    const out = captureStdout();
    await getCommandRegistry()
      .get("/compact")
      ?.handler({ agent } as unknown as ReplCommandContext, []);
    expect(out.text()).toContain("結果: 減らせるものがありませんでした。 履歴は変えていません");
    const last = agent.getLastReductionEvent();
    expect(last?.record).toMatchObject({ trigger: "manual", ok: false, failureReason: "nothing-to-reduce" });
    await getCommandRegistry()
      .get("/context")
      ?.handler({ agent } as unknown as ReplCommandContext, []);
    expect(out.text()).toContain(`直近の整理: ${last?.record.id} (手動、`);
    expect(agent.getHistory().getRawMessages()).toEqual(before);
  });

  it("会話を載せ替えたら、 前の会話の整理は出さない", async () => {
    const agent = realAgent();
    captureStdout();
    await agent.runReductionEvent("manual");
    expect(agent.getLastReductionEvent()).not.toBeNull();
    agent.importConversation(null);
    expect(agent.getLastReductionEvent()).toBeNull();
  });

  it("チャネル (Slack / Discord) の /context も同じ整理の状態を返し、 履歴には入れない", async () => {
    const agent = realAgent();
    const before = agent.getHistory().getRawMessages();
    const roomManager = { runInRoom: async (_room: string, fn: () => Promise<string>) => fn() };
    const text = await runChannelCommand("/context", {
      roomManager: roomManager as unknown as RoomManager,
      agent,
      room: "B",
    });
    expect(text).toContain("コンテキストの整理");
    expect(text).toContain("今 /compact した場合の見込み");
    expect(agent.getHistory().getRawMessages()).toEqual(before);
  });
});
