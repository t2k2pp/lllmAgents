import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * コンテキスト整理の旧設定キーの 1 回だけの削除 (docs/context-reduction-redesign.md §11.1 / §11.2)。
 * loadConfig は import 時に os.homedir() から config.json の場所を決めるので、 import より前に一時ホームへ差し替える。
 * (利用者の実際の ~/.localllm には触れない)
 */
const tmpHome = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodePath = require("node:path") as typeof import("node:path");
  const nodeOs = require("node:os") as typeof import("node:os");
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "localllm-context-keys-"));
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});

const { removeLegacyContextKeys, contextKeysRemovalNotice, contextKeysRemoval } = await import(
  "../../src/config/context-keys-removal.js"
);
const { applyOneTimeMigrations, finishOneTimeMigrations } = await import("../../src/config/one-time-migration.js");
const { loadConfig, getConfigPath } = await import("../../src/config/config-manager.js");

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("removeLegacyContextKeys (削除そのもの)", () => {
  it("旧キーが無ければ何もしない", () => {
    const raw = {
      context: { summaryFailure: "stop" },
      modelCapabilities: { m: { tier: "T2", contextWindow: 65536 } },
    };
    const before = structuredClone(raw);
    expect(removeLegacyContextKeys(raw)).toEqual([]);
    expect(raw).toEqual(before);
    expect(removeLegacyContextKeys({})).toEqual([]);
    expect(removeLegacyContextKeys(null)).toEqual([]);
  });

  it("context の旧キーを全部消し、 新しいキーは残す。 入れ物は中のキーを並べる", () => {
    const raw = {
      context: {
        reduction: "hybrid",
        forgetting: { keepRecentSegments: 6, targetMarginRatio: 0.15, sufficiencyRatio: 0.6, minIntervalTurns: 3 },
        strategy: { mode: "auto", minIntervalTurns: 3 },
        compressionThreshold: 0.8,
        maxHistoryMessages: 100,
        summaryFailure: "stop",
      },
    };
    expect(removeLegacyContextKeys(raw)).toEqual([
      "context.reduction",
      "context.forgetting.keepRecentSegments",
      "context.forgetting.targetMarginRatio",
      "context.forgetting.sufficiencyRatio",
      "context.forgetting.minIntervalTurns",
      "context.strategy.mode",
      "context.strategy.minIntervalTurns",
      "context.compressionThreshold",
      "context.maxHistoryMessages",
    ]);
    expect(raw).toEqual({ context: { summaryFailure: "stop" } });
  });

  it("空の入れ物・オブジェクトでない入れ物は入れ物の名前で並べて消す", () => {
    const raw = { context: { forgetting: {}, strategy: "auto" } };
    expect(removeLegacyContextKeys(raw)).toEqual(["context.forgetting", "context.strategy"]);
    expect(raw).toEqual({ context: {} });
  });

  it("modelCapabilities.<id> の旧欄だけを消し、 他の欄と項目は残す", () => {
    const raw = {
      modelCapabilities: {
        "qwen-a": { tier: "T2", compressionThreshold: 0.5, keepRecentMessages: 8 },
        "qwen-b": { keepRecentMessages: 4 },
        "qwen-c": { contextWindow: 32768 },
      },
    };
    expect(removeLegacyContextKeys(raw)).toEqual([
      "modelCapabilities.qwen-a.compressionThreshold",
      "modelCapabilities.qwen-a.keepRecentMessages",
      "modelCapabilities.qwen-b.keepRecentMessages",
    ]);
    expect(raw).toEqual({
      modelCapabilities: { "qwen-a": { tier: "T2" }, "qwen-b": {}, "qwen-c": { contextWindow: 32768 } },
    });
  });

  it("告知は削除したキーを並べ、 contextWindow を小さくする案内とバックアップの場所を含む", () => {
    const text = contextKeysRemovalNotice("/home/u/.localllm/config.json.before-context-keys-removal.bak", [
      "context.reduction",
      "context.strategy.mode",
    ]);
    expect(text).toBe(
      "コンテキスト整理の方式を 1 つにしたため、 次の設定を削除しました: context.reduction, context.strategy.mode。" +
        " 整理を早めたい場合は contextWindow を小さくしてください (元の設定: /home/u/.localllm/config.json.before-context-keys-removal.bak)。",
    );
  });
});

describe("loadConfig での削除 (ファイル)", () => {
  const configPath = (): string => getConfigPath();
  const backupPath = (): string => `${configPath()}.before-context-keys-removal.bak`;
  const noticesOf = (log: ReturnType<typeof vi.spyOn>): string[] =>
    log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("コンテキスト整理の方式"));

  beforeEach(() => {
    fs.rmSync(path.dirname(configPath()), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  });

  it("バックアップを書いてから旧キーを消して保存し、 告知を 1 回出す。 2 回目の読み込みでは何もしない", () => {
    const original = {
      mainLLM: { providerType: "vllm", baseUrl: "http://x:8000", model: "m", contextWindow: 262144 },
      jpyPerUsd: 150,
      security: { rules: { allow: ["grep"], deny: [], ask: [] } },
      context: { reduction: "hybrid", strategy: { mode: "auto" }, forgetting: { minIntervalTurns: 3 } },
      modelCapabilities: { m: { tier: "T2", compressionThreshold: 0.5, keepRecentMessages: 8 } },
    };
    const originalText = JSON.stringify(original, null, 2);
    fs.writeFileSync(configPath(), originalText);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const config = loadConfig();
    // 読み込んだ設定に旧キーが無く、 他の値は変わらない
    expect(config.context).toEqual({ summaryFailure: "continue" });
    expect(config.modelCapabilities).toEqual({ m: { tier: "T2" } });
    expect(config.mainLLM).toEqual(original.mainLLM);
    expect(config.jpyPerUsd).toBe(150);
    expect(config.security.rules).toEqual({ allow: ["grep"], deny: [], ask: [] });

    // バックアップは書き換え前の内容そのもの。 保存した内容から旧キーが消え、 他の値は残る
    expect(fs.readFileSync(backupPath(), "utf-8")).toBe(originalText);
    const saved = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    expect(saved.context).toEqual({ summaryFailure: "continue" });
    expect(saved.modelCapabilities).toEqual({ m: { tier: "T2" } });
    expect(saved.mainLLM).toEqual(original.mainLLM);
    expect(saved.jpyPerUsd).toBe(150);
    expect(saved.security.rules).toEqual({ allow: ["grep"], deny: [], ask: [] });

    const notices = noticesOf(log);
    expect(notices).toHaveLength(1);
    for (const key of [
      "context.reduction",
      "context.strategy.mode",
      "context.forgetting.minIntervalTurns",
      "modelCapabilities.m.compressionThreshold",
      "modelCapabilities.m.keepRecentMessages",
    ]) {
      expect(notices[0]).toContain(key);
    }
    expect(notices[0]).toContain("contextWindow を小さくしてください");
    expect(notices[0]).toContain(backupPath());
    // 未知のキーとしての警告は出ない (検証より前に消している)
    expect(err).not.toHaveBeenCalled();

    // 2 回目: 旧キーが無いので削除も保存も告知もしない
    log.mockClear();
    const savedText = fs.readFileSync(configPath(), "utf-8");
    const again = loadConfig();
    expect(again.context).toEqual(config.context);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(savedText);
    expect(noticesOf(log)).toHaveLength(0);
    expect(
      fs.readdirSync(path.dirname(configPath())).filter((f) => f.includes("before-context-keys-removal")),
    ).toHaveLength(1);
    log.mockRestore();
    err.mockRestore();
  });

  it("旧キーが無い config は何もしない (バックアップ・保存・告知なし)", () => {
    const text = JSON.stringify({ context: { summaryFailure: "stop" }, modelCapabilities: { m: { tier: "T1" } } });
    fs.writeFileSync(configPath(), text);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const config = loadConfig();
    expect(config.context).toEqual({ summaryFailure: "stop" });
    expect(fs.existsSync(backupPath())).toBe(false);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(text);
    expect(noticesOf(log)).toHaveLength(0);
    log.mockRestore();
  });

  it("権限の移行と同時にあれば、 それぞれのバックアップ (どちらも書き換え前の内容) と告知を出して 1 回で保存する", () => {
    const original = {
      security: { autoApproveTools: ["file_read", "bash"] },
      context: { reduction: "forget" },
    };
    const originalText = JSON.stringify(original, null, 2);
    fs.writeFileSync(configPath(), originalText);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    loadConfig();
    expect(fs.readFileSync(backupPath(), "utf-8")).toBe(originalText);
    expect(fs.readFileSync(`${configPath()}.before-rules-migration.bak`, "utf-8")).toBe(originalText);
    const saved = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    expect("autoApproveTools" in saved.security).toBe(false);
    expect("reduction" in saved.context).toBe(false);
    const messages = log.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes("security.rules"))).toHaveLength(1);
    expect(noticesOf(log)).toHaveLength(1);
    log.mockRestore();
  });
});

describe("共通の仕組み (one-time-migration.ts)", () => {
  it("バックアップを書けないときは保存も告知もせず、 書き換え後の内容だけが残る", () => {
    // 存在しないフォルダの config.json: 元ファイルが無いので内容を書こうとして失敗する
    const missing = path.join(tmpHome, "no-such-dir", "config.json");
    const raw = { context: { reduction: "hybrid", summaryFailure: "stop" } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const applied = applyOneTimeMigrations(raw, missing, [contextKeysRemoval]);
    expect(applied).toHaveLength(1);
    expect(applied[0].backupPath).toBeNull();
    expect(raw).toEqual({ context: { summaryFailure: "stop" } });
    expect(err.mock.calls.some((c) => String(c[0]).includes("バックアップに失敗しました"))).toBe(true);
    const save = vi.fn();
    finishOneTimeMigrations(applied, save);
    expect(save).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    err.mockRestore();
    log.mockRestore();
  });

  it("保存に失敗したときは告知を出さず、 失敗を表示する", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    finishOneTimeMigrations([{ migration: contextKeysRemoval, notice: () => "告知", backupPath: "/b.bak" }], () => {
      throw new Error("書き込めません");
    });
    expect(log).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
      "コンテキスト整理の旧設定の削除を保存できませんでした: 書き込めません",
    ]);
    err.mockRestore();
    log.mockRestore();
  });
});
