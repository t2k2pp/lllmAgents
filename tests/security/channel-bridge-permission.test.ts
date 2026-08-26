import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SecurityConfig } from "../../src/config/types.js";
import { PermissionManager } from "../../src/security/permission-manager.js";

// 5.3 / proposal §2.5: 背景面 bash autorun は OS 封じ込めゲートを持つ。 封じ込め判定をモックして
// 「封じ込め下のみ自動許可 / 未確立なら正直拒否」を検証する。 既定は false (非 macOS CI と同じ)。
vi.mock("../../src/security/containment.js", () => ({
  isBashNetworkContained: vi.fn(() => false),
}));
import { isBashNetworkContained } from "../../src/security/containment.js";

import {
  setInteractionBridge,
  getInteractionBridge,
  clearInteractionBridges,
} from "../../src/agent/interaction-bridge-registry.js";
import type { InteractionBridge, PermissionRequest, PermissionDecision } from "../../src/agent/agent-events.js";

// A-2: チャネル権限のブリッジフロー (docs/channel-interaction-bridge-design.md §3)

function mkConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    allowedDirectories: [process.cwd()],
    autoApproveTools: [],
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
    ...overrides,
  } as unknown as SecurityConfig;
}

function mkBridge(decision: PermissionDecision | (() => Promise<PermissionDecision>)): {
  bridge: InteractionBridge;
  calls: PermissionRequest[];
} {
  const calls: PermissionRequest[] = [];
  const bridge: InteractionBridge = {
    async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
      calls.push(req);
      return typeof decision === "function" ? decision() : decision;
    },
  };
  return { bridge, calls };
}

beforeEach(() => {
  clearInteractionBridges();
  vi.mocked(isBashNetworkContained).mockReturnValue(false); // 既定: 封じ込め無し
});

describe("interaction-bridge-registry", () => {
  it("set/get/clear が機能する", () => {
    const { bridge } = mkBridge("deny");
    expect(getInteractionBridge("slack")).toBeNull();
    setInteractionBridge("slack", bridge);
    expect(getInteractionBridge("slack")).toBe(bridge);
    expect(getInteractionBridge("discord")).toBeNull();
    setInteractionBridge("slack", null);
    expect(getInteractionBridge("slack")).toBeNull();
  });
});

describe("checkToolPermission (channel + bridge)", () => {
  it("autorun 無効 + ブリッジ未登録なら headless 拒否", async () => {
    const pm = new PermissionManager(mkConfig({ slackAutorun: false }));
    const r = await pm.checkToolPermission(
      "file_write",
      { file_path: `${process.cwd()}/a.txt`, content: "x" },
      "slack",
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Slack経由では");
  });

  // 5.3: 背景面 autorun (既定 ON)
  it("autorun(既定) は安全ガード通過の未許可ツールをブリッジ無しで自動許可", async () => {
    const { bridge, calls } = mkBridge("deny");
    setInteractionBridge("slack", bridge);
    const pm = new PermissionManager(mkConfig()); // autorun 未指定=true
    const r = await pm.checkToolPermission(
      "file_write",
      { file_path: `${process.cwd()}/a.txt`, content: "x" },
      "slack",
    );
    expect(r.allowed).toBe(true);
    expect(calls.length).toBe(0); // 同期ボタン確認を呼ばない (失効トークンに依存しない)
  });

  it("autorun でも deny ルール / サンドボックス外 / 危険block は覆せない", async () => {
    const pmDeny = new PermissionManager(mkConfig({ rules: { allow: [], deny: ["bash(rm *)"], ask: [] } }));
    expect((await pmDeny.checkToolPermission("bash", { command: "rm -rf /tmp/x" }, "slack")).allowed).toBe(false);

    const pm = new PermissionManager(mkConfig());
    const outside = process.platform === "win32" ? "C:\\Windows\\evil.txt" : "/etc/evil.txt";
    expect((await pm.checkToolPermission("file_write", { file_path: outside, content: "x" }, "slack")).allowed).toBe(
      false,
    );
    expect((await pm.checkToolPermission("bash", { command: "rm -rf /" }, "slack")).allowed).toBe(false);
  });

  it("INHERENTLY_SAFE はブリッジ無しでも許可", async () => {
    const pm = new PermissionManager(mkConfig());
    const r = await pm.checkToolPermission("todo_append", { items: [] }, "slack");
    expect(r.allowed).toBe(true);
  });

  it("task_send はsession内管理操作として常に許可", async () => {
    const pm = new PermissionManager(mkConfig());
    const r = await pm.checkToolPermission("task_send", { agent_id: "sub-1", message: "redirect" }, "cli");
    expect(r.allowed).toBe(true);
  });

  it("channel autoApprove のツールはブリッジを呼ばず許可", async () => {
    const { bridge, calls } = mkBridge("deny");
    setInteractionBridge("slack", bridge);
    const pm = new PermissionManager(mkConfig({ slackAutoApproveTools: ["web_search"] }));
    const r = await pm.checkToolPermission("web_search", { query: "x" }, "slack");
    expect(r.allowed).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("allow_once: 許可され、同一パラメータの再実行は確認なし", async () => {
    const { bridge, calls } = mkBridge("allow_once");
    setInteractionBridge("slack", bridge);
    const pm = new PermissionManager(mkConfig({ slackAutorun: false }));
    const params = { file_path: `${process.cwd()}/a.txt`, content: "x" };

    const r1 = await pm.checkToolPermission("file_write", params, "slack");
    expect(r1.allowed).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].toolName).toBe("file_write");
    expect(calls[0].source).toBe("slack");

    const r2 = await pm.checkToolPermission("file_write", params, "slack");
    expect(r2.allowed).toBe(true);
    expect(calls.length).toBe(1); // キャッシュヒットで再確認なし

    // 別パラメータは再確認
    const r3 = await pm.checkToolPermission("file_write", { ...params, content: "y" }, "slack");
    expect(r3.allowed).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("allow_session: 同ツールは以後確認なし (チャネル別)", async () => {
    const { bridge, calls } = mkBridge("allow_session");
    setInteractionBridge("slack", bridge);
    const pm = new PermissionManager(mkConfig({ slackAutorun: false, discordAutorun: false }));
    const r1 = await pm.checkToolPermission("bash", { command: "echo a" }, "slack");
    expect(r1.allowed).toBe(true);
    expect(calls.length).toBe(1);

    const r2 = await pm.checkToolPermission("bash", { command: "echo b" }, "slack");
    expect(r2.allowed).toBe(true);
    expect(calls.length).toBe(1); // セッション許可済み

    // discord 側には波及しない (ブリッジ未登録 → headless 拒否)
    const r3 = await pm.checkToolPermission("bash", { command: "echo c" }, "discord");
    expect(r3.allowed).toBe(false);
  });

  it("deny: 拒否され、対話を促す理由文が返る", async () => {
    const { bridge } = mkBridge("deny");
    setInteractionBridge("slack", bridge);
    const pm = new PermissionManager(mkConfig({ slackAutorun: false }));
    const r = await pm.checkToolPermission("bash", { command: "echo a" }, "slack");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("拒否しました");
    expect(r.reason).toContain("ask_user");
  });

  it("ブリッジのタイムアウト (throw) は拒否に倒す", async () => {
    const { bridge } = mkBridge(async () => {
      throw new Error("権限確認がタイムアウトしました (300s)");
    });
    setInteractionBridge("slack", bridge);
    const pm = new PermissionManager(mkConfig({ slackAutorun: false }));
    const r = await pm.checkToolPermission("bash", { command: "echo a" }, "slack");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("タイムアウト");
  });

  it("deny ルールはブリッジより優先 (確認自体しない)", async () => {
    const { bridge, calls } = mkBridge("allow_once");
    setInteractionBridge("slack", bridge);
    const pm = new PermissionManager(mkConfig({ rules: { allow: [], deny: ["bash(rm *)"], ask: [] } }));
    const r = await pm.checkToolPermission("bash", { command: "rm -rf /tmp/x" }, "slack");
    expect(r.allowed).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("block レベルの危険コマンドはブリッジ確認なしで拒否", async () => {
    const { bridge, calls } = mkBridge("allow_once");
    setInteractionBridge("slack", bridge);
    const pm = new PermissionManager(mkConfig());
    const r = await pm.checkToolPermission("bash", { command: "rm -rf /" }, "slack");
    expect(r.allowed).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("サンドボックス外の file_write はブリッジ確認なしで拒否", async () => {
    const { bridge, calls } = mkBridge("allow_once");
    setInteractionBridge("slack", bridge);
    const pm = new PermissionManager(mkConfig());
    const outside = process.platform === "win32" ? "C:\\Windows\\evil.txt" : "/etc/evil.txt";
    const r = await pm.checkToolPermission("file_write", { file_path: outside, content: "x" }, "slack");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("サンドボックス外");
    expect(calls.length).toBe(0);
  });

  it("warn レベルの危険コマンドは確認文に警告を併記してブリッジへ", async () => {
    const { bridge, calls } = mkBridge("allow_once");
    setInteractionBridge("discord", bridge);
    const pm = new PermissionManager(mkConfig({ discordAutorun: false }));
    // git push --force は warn 想定 (block ではない)。 ルール定義に依存するため
    // 「ブリッジに到達して許可された」ことだけを検証する
    const r = await pm.checkToolPermission("bash", { command: "git push --force origin feature-x" }, "discord");
    expect(calls.length).toBe(1);
    expect(r.allowed).toBe(true);
  });

  // 5.3 / proposal §2.5: bash autorun は OS 封じ込めゲートを持つ
  it("autorun(既定) でも bash は封じ込め未確立なら自動実行せず正直拒否", async () => {
    vi.mocked(isBashNetworkContained).mockReturnValue(false);
    const pm = new PermissionManager(mkConfig()); // autorun 未指定=true
    const r = await pm.checkToolPermission("bash", { command: "echo hi" }, "discord");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("封じ込め");
    expect(r.reason).toContain("/permission discord-add bash");
  });

  it("封じ込め下なら安全な bash は autorun 自動許可", async () => {
    vi.mocked(isBashNetworkContained).mockReturnValue(true);
    const pm = new PermissionManager(mkConfig());
    const r = await pm.checkToolPermission("bash", { command: "echo hi" }, "discord");
    expect(r.allowed).toBe(true);
  });

  it("封じ込め下でも破壊的 bash (force push) は autorun 拒否", async () => {
    vi.mocked(isBashNetworkContained).mockReturnValue(true);
    const pm = new PermissionManager(mkConfig());
    // feature ブランチへの force push は warn (block ではない) が破壊的 = autorun スコープ外。
    const r = await pm.checkToolPermission("bash", { command: "git push --force origin feature-x" }, "discord");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("自動実行できません");
  });

  it("エスケープハッチ: autoApproveTools に bash を明示追加すれば封じ込め無しでも許可", async () => {
    vi.mocked(isBashNetworkContained).mockReturnValue(false);
    const pm = new PermissionManager(mkConfig({ discordAutoApproveTools: ["bash"] }));
    const r = await pm.checkToolPermission("bash", { command: "echo hi" }, "discord");
    expect(r.allowed).toBe(true);
  });

  it("autorun(既定) の sandbox 内 file_write は封じ込め非依存で許可 (bash 以外はゲートしない)", async () => {
    vi.mocked(isBashNetworkContained).mockReturnValue(false);
    const pm = new PermissionManager(mkConfig());
    const r = await pm.checkToolPermission(
      "file_write",
      { file_path: `${process.cwd()}/a.txt`, content: "x" },
      "discord",
    );
    expect(r.allowed).toBe(true);
  });
});

describe("ask_user のチャネルブリッジ (A-3)", () => {
  it("source=slack で bridge.askUser に委譲される", async () => {
    const askCalls: string[] = [];
    setInteractionBridge("slack", {
      async askUser(req) {
        askCalls.push(req.question);
        return { answer: "はい" };
      },
    });
    const { askUserTool } = await import("../../src/tools/definitions/ask-user.js");
    const result = await askUserTool.execute(
      { question: "続行しますか？", options: [{ label: "はい", description: "続行する" }] },
      { ancestors: new Set(), source: "slack" },
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe("はい");
    expect(askCalls.length).toBe(1);
    expect(askCalls[0]).toContain("続行しますか？");
    expect(askCalls[0]).toContain("はい: 続行する"); // description が質問文に併記される
  });

  it("ブリッジ未登録のチャネルではエラーを返す (ハングしない)", async () => {
    const { askUserTool } = await import("../../src/tools/definitions/ask-user.js");
    const result = await askUserTool.execute({ question: "Q?" }, { ancestors: new Set(), source: "discord" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("対話ブリッジ");
  });

  it("タイムアウト (throw) はツール失敗として返る", async () => {
    setInteractionBridge("slack", {
      async askUser() {
        throw new Error("ユーザー応答がタイムアウトしました");
      },
    });
    const { askUserTool } = await import("../../src/tools/definitions/ask-user.js");
    const result = await askUserTool.execute({ question: "Q?" }, { ancestors: new Set(), source: "slack" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("タイムアウト");
  });
});
