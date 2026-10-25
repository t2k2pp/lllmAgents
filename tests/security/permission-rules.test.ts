import { afterEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../src/security/containment.js", () => ({ isBashNetworkContained: vi.fn(() => false) }));

import type { SecurityConfig } from "../../src/config/types.js";
import { getDefaultConfig } from "../../src/config/types.js";
import { migrateLegacyPermissionLists } from "../../src/config/permission-migration.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { evaluateRules, isToolAllowedByRule, parseRule } from "../../src/security/rule-engine.js";
import { nonTTYReader } from "../../src/utils/non-tty-reader.js";

/**
 * 権限をルール (security.rules) に一本化した後の判定 (docs/todo-legacy-ways-cleanup.md T4)。
 * 旧ツール名一覧で下していた判定と同じになることを代表例で確かめる。
 * 確認ダイアログは非TTY (テキストメニュー) を通るので nonTTYReader.readLine を差し替えて答える。
 */
const inCwd = (name: string): string => path.join(process.cwd(), name);
const outside = path.join(os.tmpdir(), "outside-sandbox", "x.txt");

function mkConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return { allowedDirectories: [], blockedCommands: [], rules: { allow: [], deny: [], ask: [] }, ...overrides };
}

/** 確認ダイアログに answer で答え、 呼ばれたかどうかも返す */
function answer(choice: string) {
  return vi.spyOn(nonTTYReader, "readLine").mockResolvedValue(choice);
}

afterEach(() => vi.restoreAllMocks());

describe("ルールの書き方 (面の指定)", () => {
  it("先頭の cli: / discord: / slack: を面として読み、 無ければすべての面", () => {
    expect(parseRule("discord:Bash(npm *)")).toEqual({ surface: "discord", toolName: "bash", argPattern: "npm *" });
    expect(parseRule("file_read")).toEqual({ surface: null, toolName: "file_read", argPattern: null });
    expect(parseRule("web_fetch(domain:github.com)").surface).toBeNull();
  });

  it("面の指定はその面だけに効く", () => {
    const rules = { allow: ["discord:grep"], deny: ["slack:bash"], ask: [] };
    expect(isToolAllowedByRule(rules, "grep", "discord")).toBe(true);
    expect(isToolAllowedByRule(rules, "grep", "cli")).toBe(false);
    expect(evaluateRules(rules, "bash", {}, "slack")).toBe("deny");
    expect(evaluateRules(rules, "bash", {}, "cli")).toBeNull();
  });

  it("ツール名だけの allow は evaluateRules に出ず (ask より弱い)、 引数パターン付きは出る", () => {
    const rules = { allow: ["bash", "bash(npm test)"], deny: [], ask: ["bash(git push *)"] };
    expect(evaluateRules(rules, "bash", { command: "npm test" })).toBe("allow");
    expect(evaluateRules(rules, "bash", { command: "git push origin main" })).toBe("ask");
    expect(evaluateRules(rules, "bash", { command: "ls" })).toBeNull();
    expect(isToolAllowedByRule(rules, "bash", "cli")).toBe(true);
  });
});

describe("CLI の判定 (既定設定 = 旧既定の一覧と同じ)", () => {
  it("既定ルールの読み取り系は確認なし、 サンドボックス外は拒否 (旧 autoApproveTools と同じ安全確認)", async () => {
    const pm = new PermissionManager(getDefaultConfig().security);
    const ask = answer("4");
    expect((await pm.checkToolPermission("file_read", { file_path: inCwd("a.txt") })).allowed).toBe(true);
    expect((await pm.checkToolPermission("web_fetch", { url: "https://example.com" })).allowed).toBe(true);
    const r = await pm.checkToolPermission("file_read", { file_path: outside });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("サンドボックス外");
    expect(ask).not.toHaveBeenCalled();
  });

  it("既定ルールに無いツール (file_write / bash) は確認する", async () => {
    const pm = new PermissionManager(getDefaultConfig().security);
    const ask = answer("4");
    expect((await pm.checkToolPermission("file_write", { file_path: inCwd("a.txt"), content: "x" })).allowed).toBe(
      false,
    );
    expect((await pm.checkToolPermission("bash", { command: "echo hi" })).allowed).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("autorun: 作業フォルダ内の file_write は確認なし、 破壊的な bash は確認", async () => {
    const pm = new PermissionManager(getDefaultConfig().security);
    pm.setAutorunMode(true);
    const ask = answer("4");
    expect((await pm.checkToolPermission("file_write", { file_path: inCwd("a.txt"), content: "x" })).allowed).toBe(
      true,
    );
    expect(ask).not.toHaveBeenCalled();
    expect((await pm.checkToolPermission("bash", { command: "rm -rf build" })).allowed).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("ツール全体の allow (bash) でも CWD 外参照は確認を挟む (旧 autoApproveTools と同じ)", async () => {
    const pm = new PermissionManager(mkConfig({ rules: { allow: ["bash"], deny: [], ask: [] } }));
    const ask = answer("4");
    expect((await pm.checkToolPermission("bash", { command: "echo hi" })).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect((await pm.checkToolPermission("bash", { command: `cat ${outside}` })).allowed).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("deny ルールは allow より優先、 ask ルールはツール全体の allow より優先", async () => {
    const pm = new PermissionManager(
      mkConfig({ rules: { allow: ["bash"], deny: ["bash(rm *)"], ask: ["bash(git push *)"] } }),
    );
    const ask = answer("4");
    const denied = await pm.checkToolPermission("bash", { command: "rm a.txt" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("ルールにより");
    expect((await pm.checkToolPermission("bash", { command: "git push origin main" })).allowed).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("引数パターン付き allow はその形だけ確認なしで通す", async () => {
    const pm = new PermissionManager(mkConfig({ rules: { allow: ["bash(npm test)"], deny: [], ask: [] } }));
    const ask = answer("4");
    expect((await pm.checkToolPermission("bash", { command: "npm test" })).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("Discord/Slack だけのルールは CLI に効かない", async () => {
    const pm = new PermissionManager(mkConfig({ rules: { allow: ["discord:file_write"], deny: [], ask: [] } }));
    const ask = answer("4");
    await pm.checkToolPermission("file_write", { file_path: inCwd("a.txt"), content: "x" });
    expect(ask).toHaveBeenCalledOnce();
  });
});

describe("確認ダイアログの選択肢", () => {
  it("2 (セッション中常に許可): 以後このツールは確認なし。 設定は変えない", async () => {
    const config = mkConfig();
    const onPermanent = vi.fn();
    const pm = new PermissionManager(config, onPermanent);
    const ask = answer("2");
    expect((await pm.checkToolPermission("file_write", { file_path: inCwd("a.txt"), content: "1" })).allowed).toBe(
      true,
    );
    expect((await pm.checkToolPermission("file_write", { file_path: inCwd("b.txt"), content: "2" })).allowed).toBe(
      true,
    );
    expect(ask).toHaveBeenCalledOnce();
    expect(onPermanent).not.toHaveBeenCalled();
    expect(config.rules?.allow).toEqual([]);
  });

  it("3 (設定に保存して常に許可): CLI だけに効く allow ルール cli:<tool> を書き、 保存コールバックを呼ぶ", async () => {
    const config = mkConfig();
    const onPermanent = vi.fn();
    const pm = new PermissionManager(config, onPermanent);
    vi.spyOn(console, "log").mockImplementation(() => {});
    answer("3");
    expect((await pm.checkToolPermission("image_generate", { prompt: "x" })).allowed).toBe(true);
    expect(onPermanent).toHaveBeenCalledWith("cli:image_generate");
    expect(config.rules?.allow).toEqual(["cli:image_generate"]); // config のルールと共有している
    expect(pm.getPermissionLevel("image_generate")).toBe("auto");
    expect(pm.getAllowedToolNames("discord").has("image_generate")).toBe(false);
  });
});

describe("Discord / Slack の判定 (確認手段なし = headless)", () => {
  it("既定ルールの読み取り系は許可、 封じ込めの無い bash は拒否 (autorun 既定)", async () => {
    const pm = new PermissionManager(getDefaultConfig().security);
    expect((await pm.checkToolPermission("file_read", { file_path: inCwd("a.txt") }, "discord")).allowed).toBe(true);
    const r = await pm.checkToolPermission("bash", { command: "echo hi" }, "slack");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("slack:bash");
  });

  it("autorun 無効: allow ルールに無いツールは拒否、 あるツールは許可", async () => {
    const pm = new PermissionManager(
      mkConfig({ discordAutorun: false, rules: { allow: ["discord:web_search"], deny: [], ask: [] } }),
    );
    expect((await pm.checkToolPermission("web_search", { query: "x" }, "discord")).allowed).toBe(true);
    const r = await pm.checkToolPermission("file_write", { file_path: inCwd("a.txt"), content: "x" }, "discord");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("discord:file_write");
  });

  it("deny ルール (面の指定なし) はチャネルでも強制、 cli: の deny はチャネルに効かない", async () => {
    const pm = new PermissionManager(
      mkConfig({ rules: { allow: ["grep"], deny: ["cli:grep", "web_fetch"], ask: [] } }),
    );
    expect((await pm.checkToolPermission("grep", { pattern: "x" }, "discord")).allowed).toBe(true);
    expect((await pm.checkToolPermission("web_fetch", { url: "https://x" }, "slack")).allowed).toBe(false);
  });

  it("モデルへ見せるツール = 本質的に安全なツール + その面に効く allow ルール", () => {
    const pm = new PermissionManager(mkConfig({ rules: { allow: ["grep", "slack:bash(npm *)"], deny: [], ask: [] } }));
    const discord = pm.getAllowedToolNames("discord");
    const slack = pm.getAllowedToolNames("slack");
    expect(discord.has("grep")).toBe(true);
    expect(discord.has("ask_user")).toBe(true);
    expect(discord.has("bash")).toBe(false);
    expect(slack.has("bash")).toBe(true);
  });
});

describe("移行前後で判定が変わらない (旧一覧 → ルール)", () => {
  it("CLI だけ / Discord だけに許可していたツールは、 移行後もその面だけで許可", async () => {
    const raw = {
      security: {
        allowedDirectories: [],
        blockedCommands: [],
        autoApproveTools: ["file_write"],
        requireApprovalTools: ["file_write"],
        discordAutoApproveTools: ["image_generate"],
        discordAutorun: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    };
    migrateLegacyPermissionLists(raw);
    const pm = new PermissionManager(raw.security as unknown as SecurityConfig);
    const ask = answer("4");
    // CLI: autoApproveTools (requireApprovalTools にもあるが旧コードでは autoApproveTools が勝つ) → 確認なし
    expect((await pm.checkToolPermission("file_write", { file_path: inCwd("a.txt"), content: "x" })).allowed).toBe(
      true,
    );
    // CLI: discord の一覧にだけあったツールは確認
    await pm.checkToolPermission("image_generate", { prompt: "x" });
    expect(ask).toHaveBeenCalledOnce();
    // Discord: discord の一覧のツールは許可、 CLI の一覧だけのツールは拒否 (autorun 無効・確認手段なし)
    expect((await pm.checkToolPermission("image_generate", { prompt: "x" }, "discord")).allowed).toBe(true);
    expect(
      (await pm.checkToolPermission("file_write", { file_path: inCwd("a.txt"), content: "x" }, "discord")).allowed,
    ).toBe(false);
    // 既定の読み取り系はどの面でも許可のまま
    expect((await pm.checkToolPermission("grep", { pattern: "x" }, "slack")).allowed).toBe(true);
  });

  it("旧 rules.ask (CLI でだけ評価されていた) は移行後も Discord の autorun を止めない", async () => {
    const raw = {
      security: {
        allowedDirectories: [],
        autoApproveTools: [],
        rules: { allow: [], deny: [], ask: ["file_write"] },
      },
    };
    migrateLegacyPermissionLists(raw);
    const pm = new PermissionManager(raw.security as unknown as SecurityConfig);
    expect(
      (await pm.checkToolPermission("file_write", { file_path: inCwd("a.txt"), content: "x" }, "discord")).allowed,
    ).toBe(true);
  });
});
