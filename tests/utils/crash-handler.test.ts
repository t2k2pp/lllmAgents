import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { formatCrashReport, writeCrashLog, setCrashContext } from "../../src/utils/crash-handler.js";
import { APP_VERSION } from "../../src/version.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-handler-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setCrashContext({ sessionId: undefined, saveSession: undefined });
});

describe("formatCrashReport", () => {
  it("バージョン・種別・スタックトレースを含む", () => {
    const err = new Error("boom");
    const report = formatCrashReport("uncaughtException", err);
    expect(report).toContain(`version: ${APP_VERSION}`);
    expect(report).toContain("kind: uncaughtException");
    expect(report).toContain("boom");
    expect(report).toContain("crash-handler.test"); // スタックにテストファイル名
  });

  it("Error 以外 (rejection の reason 等) も文字列化する", () => {
    const report = formatCrashReport("unhandledRejection", "string reason");
    expect(report).toContain("string reason");
  });

  it("sessionId があれば運用ログへの手がかりを含む", () => {
    const report = formatCrashReport("uncaughtException", new Error("x"), { sessionId: "s-123" });
    expect(report).toContain("sessionId: s-123");
    expect(report).toContain("logs/ops/s-123.jsonl");
  });
});

describe("writeCrashLog", () => {
  it("クラッシュログファイルを作成しパスを返す", () => {
    const logPath = writeCrashLog("uncaughtException", new Error("boom"), dir);
    expect(logPath).not.toBeNull();
    const content = fs.readFileSync(logPath!, "utf-8");
    expect(content).toContain("boom");
    expect(path.basename(logPath!)).toMatch(/^crash-.*\.log$/);
  });
});
