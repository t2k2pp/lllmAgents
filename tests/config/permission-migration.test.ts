import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 旧ツール名一覧 → security.rules の 1 回だけの移行 (docs/todo-legacy-ways-cleanup.md T4)。
 * loadConfig は import 時に os.homedir() から config.json の場所を決めるので、 import より前に一時ホームへ差し替える。
 * (利用者の実際の ~/.localllm には触れない)
 */
const tmpHome = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodePath = require("node:path") as typeof import("node:path");
  const nodeOs = require("node:os") as typeof import("node:os");
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "localllm-rules-migration-"));
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});

const { migrateLegacyPermissionLists, hasLegacyPermissionKeys } = await import(
  "../../src/config/permission-migration.js"
);
const { loadConfig, getConfigPath } = await import("../../src/config/config-manager.js");
const { DEFAULT_ALLOW_RULES } = await import("../../src/config/types.js");

const OLD_DEFAULT_RULES = [...DEFAULT_ALLOW_RULES];

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("migrateLegacyPermissionLists (変換そのもの)", () => {
  it("旧キーが無ければ何もしない (rules だけの config)", () => {
    const raw = { security: { rules: { allow: ["bash(npm *)"], deny: [], ask: [] } } };
    const before = structuredClone(raw);
    const r = migrateLegacyPermissionLists(raw);
    expect(r.migrated).toBe(false);
    expect(raw).toEqual(before);
    expect(migrateLegacyPermissionLists({}).migrated).toBe(false);
  });

  it("旧既定値だけの一覧は、 新しい既定ルールと同じ 7 本 (面の指定なし) になる", () => {
    const raw: Record<string, unknown> = {
      security: {
        autoApproveTools: ["file_read", "ask_user", "todo_append"],
        requireApprovalTools: ["file_write", "bash"],
        discordAutoApproveTools: ["file_read", "current_datetime"],
        slackAutoApproveTools: [],
        rules: { allow: [], deny: [], ask: [] },
      },
    };
    const r = migrateLegacyPermissionLists(raw);
    expect(r.migrated).toBe(true);
    expect(r.droppedRequireApproval).toEqual(["file_write", "bash"]);
    const sec = raw.security as Record<string, unknown>;
    expect(sec.rules).toEqual({ allow: OLD_DEFAULT_RULES, deny: [], ask: [] });
    expect(hasLegacyPermissionKeys(raw)).toBe(false);
    for (const k of ["autoApproveTools", "requireApprovalTools", "discordAutoApproveTools", "slackAutoApproveTools"]) {
      expect(k in sec).toBe(false);
    }
  });

  it("面ごとの一覧: 3 面すべてなら指定なし、 一部の面だけならその面の指定付き", () => {
    const raw = {
      security: {
        autoApproveTools: ["bash", "image_generate"],
        discordAutoApproveTools: ["bash", "image_generate"],
        slackAutoApproveTools: ["image_generate", "file_write"],
      },
    };
    migrateLegacyPermissionLists(raw);
    const allow = (raw.security as unknown as { rules: { allow: string[] } }).rules.allow;
    expect(allow).toEqual([...OLD_DEFAULT_RULES, "cli:bash", "discord:bash", "image_generate", "slack:file_write"]);
  });

  it("一覧と既存ルールの両方: 既存の allow/ask は CLI 限定にし、 deny はそのまま (旧コードの評価範囲)", () => {
    const raw = {
      security: {
        autoApproveTools: ["bash"],
        // 両方に入っているツールは旧コードでは autoApproveTools が勝っていた (requireApprovalTools は判定に未使用)
        requireApprovalTools: ["bash"],
        rules: {
          allow: ["file_write(./src/**)", "cli:already"],
          deny: ["bash(rm -rf *)"],
          ask: ["bash(git push *)"],
        },
      },
    };
    migrateLegacyPermissionLists(raw);
    expect((raw.security as unknown as { rules: unknown }).rules).toEqual({
      allow: [...OLD_DEFAULT_RULES, "cli:bash", "cli:file_write(./src/**)", "cli:already"],
      deny: ["bash(rm -rf *)"],
      ask: ["cli:bash(git push *)"],
    });
  });

  it("配列でない旧キーは旧コードと同じく無視して既定値で判定していたものとして扱う", () => {
    const raw = { security: { autoApproveTools: "bash", discordAutoApproveTools: [1, "grep"] } };
    migrateLegacyPermissionLists(raw);
    expect((raw.security as unknown as { rules: { allow: string[] } }).rules.allow).toEqual(OLD_DEFAULT_RULES);
  });
});

describe("loadConfig での移行 (ファイル)", () => {
  const configPath = (): string => getConfigPath();
  const backupPath = (): string => `${configPath()}.before-rules-migration.bak`;

  beforeEach(() => {
    fs.rmSync(path.dirname(configPath()), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  });

  it("バックアップを書いてから移行後の内容を保存し、 告知を 1 回出す。 2 回目の読み込みでは何もしない", () => {
    const original = {
      mainLLM: { providerType: "vllm", baseUrl: "http://x:8000", model: "m" },
      security: {
        allowedDirectories: [],
        blockedCommands: [],
        autoApproveTools: ["file_read", "bash"],
        requireApprovalTools: ["file_write"],
        discordAutoApproveTools: ["file_read"],
        slackAutoApproveTools: ["file_read"],
        rules: { allow: [], deny: ["bash(rm *)"], ask: [] },
      },
    };
    const originalText = JSON.stringify(original, null, 2);
    fs.writeFileSync(configPath(), originalText);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const config = loadConfig();
    expect(config.security.rules).toEqual({ allow: [...OLD_DEFAULT_RULES, "cli:bash"], deny: ["bash(rm *)"], ask: [] });
    expect(fs.readFileSync(backupPath(), "utf-8")).toBe(originalText);
    const saved = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    expect(saved.security.rules).toEqual(config.security.rules);
    expect("autoApproveTools" in saved.security).toBe(false);
    expect("requireApprovalTools" in saved.security).toBe(false);
    const notices = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("security.rules"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(backupPath());

    // 2 回目: 旧キーが無いので移行も保存も告知もしない
    log.mockClear();
    const savedText = fs.readFileSync(configPath(), "utf-8");
    const again = loadConfig();
    expect(again.security.rules).toEqual(config.security.rules);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(savedText);
    expect(log.mock.calls.filter((c) => String(c[0]).includes("security.rules"))).toHaveLength(0);
    expect(fs.readdirSync(path.dirname(configPath())).filter((f) => f.includes("before-rules-migration"))).toHaveLength(
      1,
    );
    log.mockRestore();
  });

  it("rules だけの config は移行しない。 保存されたルールは既定ルールと混ぜない (外した既定ルールが戻らない)", () => {
    fs.writeFileSync(configPath(), JSON.stringify({ security: { rules: { allow: ["grep"] } } }));
    const config = loadConfig();
    expect(config.security.rules).toEqual({ allow: ["grep"], deny: [], ask: [] });
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  it("rules が無い config は既定ルール", () => {
    fs.writeFileSync(configPath(), JSON.stringify({ mainLLM: { providerType: "ollama", model: "x" } }));
    expect(loadConfig().security.rules).toEqual({ allow: OLD_DEFAULT_RULES, deny: [], ask: [] });
  });
});
