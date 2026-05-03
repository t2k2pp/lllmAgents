import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { OpsLogger, parseOpsLogLevel, maskHeaders } from "../../src/utils/ops-logger.js";

describe("OpsLogger", () => {
  let tmpFile: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-logger-"));
    tmpFile = path.join(dir, "test.jsonl");
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function readEntries(): Array<Record<string, unknown>> {
    if (!fs.existsSync(tmpFile)) return [];
    return fs.readFileSync(tmpFile, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("level=info で INFO/WARN/ERROR は記録、TRACE/DEBUG は捨てる", () => {
    const log = new OpsLogger({ sessionId: "test", level: "info", pathOverride: tmpFile });
    log.trace("c", "trace msg");
    log.debug("c", "debug msg");
    log.info("c", "info msg");
    log.warn("c", "warn msg");
    log.error("c", "error msg");
    const entries = readEntries();
    expect(entries.map((e) => e.level)).toEqual(["info", "warn", "error"]);
  });

  it("level=trace で全レベル記録", () => {
    const log = new OpsLogger({ sessionId: "test", level: "trace", pathOverride: tmpFile });
    log.trace("c", "t");
    log.debug("c", "d");
    log.info("c", "i");
    log.warn("c", "w");
    log.error("c", "e");
    expect(readEntries().map((e) => e.level)).toEqual(["trace", "debug", "info", "warn", "error"]);
  });

  it("level=error は ERROR のみ記録", () => {
    const log = new OpsLogger({ sessionId: "test", level: "error", pathOverride: tmpFile });
    log.info("c", "i");
    log.warn("c", "w");
    log.error("c", "e");
    expect(readEntries().map((e) => e.level)).toEqual(["error"]);
  });

  it("setLevel() で動的に変更できる", () => {
    const log = new OpsLogger({ sessionId: "test", level: "warn", pathOverride: tmpFile });
    log.info("c", "捨てられる"); // warn 未満
    log.setLevel("debug");
    log.info("c", "記録される");
    log.debug("c", "記録される");
    const entries = readEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe("記録される");
    expect(entries[1].level).toBe("debug");
  });

  it("data フィールドが構造化情報として記録される", () => {
    const log = new OpsLogger({ sessionId: "test", level: "info", pathOverride: tmpFile });
    log.error("http", "HTTP 500", { url: "https://x", status: 500 });
    const entry = readEntries()[0];
    expect(entry.category).toBe("http");
    expect(entry.message).toBe("HTTP 500");
    expect(entry.data).toEqual({ url: "https://x", status: 500 });
  });

  it("enabled=false なら何も書かない", () => {
    const log = new OpsLogger({ sessionId: "test", level: "trace", enabled: false, pathOverride: tmpFile });
    log.error("c", "ignored");
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it("forAgent() で sub-agent 用に agentId を切り替え (ファイルは共有)", () => {
    const log = new OpsLogger({ sessionId: "test", agentId: "main", level: "info", pathOverride: tmpFile });
    log.info("c", "from main");
    const sub = log.forAgent("second-llm-consult");
    sub.info("c", "from sub");
    const entries = readEntries();
    expect(entries[0].agentId).toBe("main");
    expect(entries[1].agentId).toBe("second-llm-consult");
  });

  it("ログ書き込み失敗は本体処理を止めない (例外を投げない)", () => {
    // 存在しないディレクトリへのパスを指定
    const log = new OpsLogger({ sessionId: "test", level: "info", pathOverride: "/nonexistent/dir/x.jsonl" });
    expect(() => log.error("c", "won't throw")).not.toThrow();
  });
});

describe("parseOpsLogLevel", () => {
  it("有効な level 文字列をパース (大文字小文字無視)", () => {
    expect(parseOpsLogLevel("trace")).toBe("trace");
    expect(parseOpsLogLevel("DEBUG")).toBe("debug");
    expect(parseOpsLogLevel("Info")).toBe("info");
    expect(parseOpsLogLevel(" warn ")).toBe("warn");
    expect(parseOpsLogLevel("ERROR")).toBe("error");
  });

  it("無効な文字列は null", () => {
    expect(parseOpsLogLevel("verbose")).toBeNull();
    expect(parseOpsLogLevel("")).toBeNull();
    expect(parseOpsLogLevel("notify")).toBeNull();
  });
});

describe("maskHeaders", () => {
  it("認証ヘッダをマスク (大文字小文字混在に対応)", () => {
    const masked = maskHeaders({
      "Content-Type": "application/json",
      "x-api-key": "secret-key",
      "Authorization": "Bearer xxx",
      "API-Key": "another",
    });
    expect(masked["Content-Type"]).toBe("application/json");
    expect(masked["x-api-key"]).toBe("***");
    expect(masked["Authorization"]).toBe("***");
    expect(masked["API-Key"]).toBe("***");
  });
});
