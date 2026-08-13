import { describe, it, expect } from "vitest";
import type { AgentLoop } from "../../src/agent/agent-loop.js";
import type { SkillRegistry } from "../../src/skills/skill-registry.js";
import {
  buildContextBreakdown,
  formatContextBreakdown,
  formatContextDetail,
  normalizeContextSection,
} from "../../src/cli/context-breakdown.js";
import { MessageHistory } from "../../src/agent/message-history.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

function makeAgent(opts: {
  systemPrompt: string;
  contextWindow?: number;
  model?: string;
  toolDefs?: Array<{ name: string }>;
  userMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}): AgentLoop {
  const history = new MessageHistory(opts.systemPrompt);
  for (const m of opts.userMessages ?? []) {
    if (m.role === "user") history.addUserMessage(m.content);
    else history.addAssistantMessage(m.content);
  }

  const toolRegistry = new ToolRegistry();
  for (const t of opts.toolDefs ?? []) {
    toolRegistry.register({
      name: t.name,
      definition: {
        type: "function",
        function: {
          name: t.name,
          description: `${t.name} description for testing context breakdown`,
          parameters: { type: "object", properties: { x: { type: "string" } } },
        },
      },
      // execute is unused by buildContextBreakdown
      execute: async () => ({ success: true, output: "" }),
    });
  }

  return {
    getHistory: () => history,
    getContextWindow: () => opts.contextWindow ?? 100_000,
    getModel: () => opts.model ?? "test-model",
    getToolRegistry: () => toolRegistry,
    getInputCompressionEnabled: () => false,
    getCompressionState: () => [],
    // docs/context-forgetting.md §6 — /context に縮約手段を出すため
    getReductionMode: () => "hybrid",
  } as unknown as AgentLoop;
}

describe("buildContextBreakdown", () => {
  it("基本構造: System / Tools / Messages / Free space を分解する", () => {
    const sys = `あなたは AI エージェント。 簡単な行動原則のみ。

# 環境
- platform: test
- branch: main`;
    const agent = makeAgent({
      systemPrompt: sys,
      contextWindow: 50_000,
      toolDefs: [{ name: "bash" }, { name: "file_read" }],
      userMessages: [
        { role: "user", content: "hello world" },
        { role: "assistant", content: "Hi there" },
      ],
    });

    const b = buildContextBreakdown(agent, undefined, undefined);
    expect(b.contextWindow).toBe(50_000);
    expect(b.systemPrompt.total).toBeGreaterThan(0);
    expect(b.tools.builtIn.count).toBe(2);
    expect(b.tools.builtIn.tokens).toBeGreaterThan(0);
    expect(b.tools.mcp.count).toBe(0);
    expect(b.messages.count).toBe(2);
    expect(b.messages.total).toBeGreaterThan(0);

    // total = system + tools + messages, and free + total = ctxWindow
    expect(b.totalUsed).toBe(b.systemPrompt.total + b.tools.total + b.messages.total);
    expect(b.totalUsed + b.freeSpace).toBe(b.contextWindow);
  });

  it("system prompt に メモ / プロジェクト指示 / スキル一覧 セクションがあれば内訳を分離する", () => {
    const sys = `本体ルール部分。
たくさんの行動原則。

# 環境
- platform: test

# プロジェクト指示（参考情報）
プロジェクト指示はそこそこ長いのでトークンを消費する。
これは2行目。

# メモ
- メモ1
- メモ2

# 利用可能なスキル一覧（参照用）
ユーザーが明示的にスキルを呼び出した場合に使用する:

- /commit: コミットメッセージ生成
- /review: PR レビュー`;
    const agent = makeAgent({ systemPrompt: sys, contextWindow: 100_000 });
    const b = buildContextBreakdown(agent, undefined, undefined);

    expect(b.memory.projectInstructions).toBeGreaterThan(0);
    expect(b.memory.autoMemory).toBeGreaterThan(0);
    expect(b.memory.total).toBe(b.memory.projectInstructions + b.memory.autoMemory);
    expect(b.skills.total).toBeGreaterThan(0);

    // core = system total - (memory + skills sections)
    const sumOfParts = b.systemPrompt.core + b.memory.total + b.skills.total;
    expect(sumOfParts).toBe(b.systemPrompt.total);
  });

  it("MCP ツールはサーバ別に内訳化される", () => {
    const agent = makeAgent({
      systemPrompt: "core",
      toolDefs: [
        { name: "bash" },
        { name: "mcp__GoogleDrive__list" },
        { name: "mcp__GoogleDrive__read" },
        { name: "mcp__Gmail__send" },
      ],
    });
    const b = buildContextBreakdown(agent, undefined, undefined);
    expect(b.tools.builtIn.count).toBe(1);
    expect(b.tools.mcp.count).toBe(3);
    const serverNames = b.tools.mcp.servers.map((s) => s.name).sort();
    expect(serverNames).toEqual(["Gmail", "GoogleDrive"]);
    const drive = b.tools.mcp.servers.find((s) => s.name === "GoogleDrive");
    expect(drive?.tools).toBe(2);
  });

  it("skill registry を渡すとロード/有効件数を集計する", () => {
    // 軽量に SkillRegistry をスタブ
    const skillRegistry = {
      listAllWithStatus: () => [
        {
          name: "commit",
          trigger: "/commit",
          description: "Generate commit messages",
          content: "",
          filePath: "",
          builtIn: true,
          enabled: true,
          runtimeDisabled: false,
        },
        {
          name: "review",
          trigger: "/review",
          description: "Review pull requests",
          content: "",
          filePath: "",
          builtIn: false,
          enabled: false,
          runtimeDisabled: true,
        },
      ],
    } as unknown as SkillRegistry;

    const agent = makeAgent({ systemPrompt: "core" });
    const b = buildContextBreakdown(agent, skillRegistry, undefined);
    expect(b.skills.loadedCount).toBe(2);
    expect(b.skills.enabledCount).toBe(1);
    expect(b.skills.items.find((s) => s.name === "commit")?.enabled).toBe(true);
    expect(b.skills.items.find((s) => s.name === "review")?.enabled).toBe(false);
  });

  it("freeSpace は contextWindow を超えても 0 でクランプ", () => {
    // 強引に小さい ctxWindow にして使用量を超過させる
    const longSys = "x".repeat(200_000);
    const agent = makeAgent({ systemPrompt: longSys, contextWindow: 1000 });
    const b = buildContextBreakdown(agent, undefined, undefined);
    expect(b.freeSpace).toBe(0);
  });
});

describe("formatContextBreakdown", () => {
  it("出力に主要カテゴリのラベルが含まれる", () => {
    const agent = makeAgent({
      systemPrompt: "test",
      toolDefs: [{ name: "bash" }],
      userMessages: [{ role: "user", content: "hi" }],
    });
    const b = buildContextBreakdown(agent, undefined, undefined);
    const out = formatContextBreakdown(b);
    expect(out).toContain("System prompt");
    expect(out).toContain("Memory files");
    expect(out).toContain("Skills");
    expect(out).toContain("System tools");
    expect(out).toContain("Messages");
    expect(out).toContain("Free space");
  });
});

describe("normalizeContextSection", () => {
  it("既知の section とエイリアスを正規化する", () => {
    expect(normalizeContextSection("system")).toBe("system");
    expect(normalizeContextSection("SYS")).toBe("system");
    expect(normalizeContextSection("mem")).toBe("memory");
    expect(normalizeContextSection("skill")).toBe("skills");
    expect(normalizeContextSection("tool")).toBe("tools");
    expect(normalizeContextSection("msg")).toBe("messages");
    expect(normalizeContextSection("history")).toBe("messages");
  });

  it("未知や空は undefined", () => {
    expect(normalizeContextSection("nope")).toBeUndefined();
    expect(normalizeContextSection("")).toBeUndefined();
    expect(normalizeContextSection(undefined)).toBeUndefined();
  });
});

describe("formatContextDetail", () => {
  const sys = `本体のコアアイデンティティ。

# 環境
- platform: test

# プロジェクト指示（参考情報）
プロジェクト固有のルール本文。

# メモ
- メモ1
- メモ2

# 利用可能なスキル一覧（参照用）
- /commit: コミットメッセージ生成`;

  it("system: コアアイデンティティと環境セクションの本文が出る", () => {
    const agent = makeAgent({ systemPrompt: sys });
    const out = formatContextDetail(agent, undefined, "system");
    expect(out).toContain("System prompt");
    expect(out).toContain("# 環境");
    expect(out).toContain("platform: test");
    // memory / skills は専用ビュー誘導で本文は出さない
    expect(out).toContain("/context memory");
    expect(out).toContain("/context skills");
  });

  it("memory: プロジェクト指示とメモ本文が出る", () => {
    const agent = makeAgent({ systemPrompt: sys });
    const out = formatContextDetail(agent, undefined, "memory");
    expect(out).toContain("Memory files");
    expect(out).toContain("プロジェクト固有のルール本文");
    expect(out).toContain("メモ1");
    // 入力圧縮 OFF が明示される
    expect(out).toContain("入力圧縮モード");
    expect(out).toContain("OFF");
  });

  it("memory: 入力圧縮 ON 時は before/after と原文保持を可視化する", () => {
    const agent = makeAgent({ systemPrompt: sys });
    // 圧縮状態を返すよう差し替え
    (agent as unknown as { getInputCompressionEnabled: () => boolean }).getInputCompressionEnabled = () => true;
    (agent as unknown as { getCompressionState: () => unknown[] }).getCompressionState = () => [
      { label: "メモ", original: "x".repeat(4000), beforeTokens: 2000, afterTokens: 800, applied: true },
    ];
    const out = formatContextDetail(agent, undefined, "memory");
    expect(out).toContain("入力圧縮モード");
    expect(out).toContain("ON");
    expect(out).toContain("2000 → 800");
    expect(out).toContain("原文"); // 原文保持が明示される
  });

  it("skills: registry の有効/無効状態が出る", () => {
    const skillRegistry = {
      listAllWithStatus: () => [
        {
          name: "commit",
          trigger: "/commit",
          description: "Generate commit messages",
          content: "",
          filePath: "",
          builtIn: true,
          enabled: true,
          runtimeDisabled: false,
        },
        {
          name: "review",
          trigger: "/review",
          description: "Review pull requests",
          content: "",
          filePath: "",
          builtIn: false,
          enabled: false,
          runtimeDisabled: true,
        },
      ],
    } as unknown as SkillRegistry;
    const agent = makeAgent({ systemPrompt: "core" });
    const out = formatContextDetail(agent, skillRegistry, "skills");
    expect(out).toContain("/commit");
    expect(out).toContain("/review");
    expect(out).toContain("Generate commit messages");
  });

  it("tools: ツール名と説明が出る", () => {
    const agent = makeAgent({
      systemPrompt: "core",
      toolDefs: [{ name: "bash" }, { name: "file_read" }],
    });
    const out = formatContextDetail(agent, undefined, "tools");
    expect(out).toContain("System tools");
    expect(out).toContain("bash");
    expect(out).toContain("file_read");
  });

  it("tools <name>: 指定ツールの parameters スキーマ全文を送信形のJSONで出す", () => {
    const agent = makeAgent({
      systemPrompt: "core",
      toolDefs: [{ name: "bash" }, { name: "file_read" }],
    });
    const out = formatContextDetail(agent, undefined, "tools", process.cwd(), "file_read");
    expect(out).toContain("file_read");
    expect(out).toContain("body.tools");
    // parameters スキーマ (型・required・引数説明) が JSON として含まれる
    expect(out).toContain('"parameters"');
    expect(out).toContain('"properties"');
    expect(out).toContain('"x"'); // makeAgent が regist(x: string) で作る引数
    expect(out).toContain("description for testing context breakdown");
  });

  it("tools <name>: 未知ツールは登録一覧を返す", () => {
    const agent = makeAgent({
      systemPrompt: "core",
      toolDefs: [{ name: "bash" }],
    });
    const out = formatContextDetail(agent, undefined, "tools", process.cwd(), "nope");
    expect(out).toContain("見つかりません");
    expect(out).toContain("bash");
  });

  it("messages: メッセージ単位の役割とプレビューが出る", () => {
    const agent = makeAgent({
      systemPrompt: "core",
      userMessages: [
        { role: "user", content: "プレビューされるユーザー発話" },
        { role: "assistant", content: "アシスタントの返信" },
      ],
    });
    const out = formatContextDetail(agent, undefined, "messages");
    expect(out).toContain("Messages");
    expect(out).toContain("user");
    expect(out).toContain("assistant");
    expect(out).toContain("プレビューされるユーザー発話");
  });

  it("未知 section はガイダンスを返す", () => {
    const agent = makeAgent({ systemPrompt: "core" });
    const out = formatContextDetail(agent, undefined, "bogus");
    expect(out).toContain("不明な section");
  });
});
