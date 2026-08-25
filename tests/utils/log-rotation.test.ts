import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyLogRetention } from "../../src/utils/log-rotation.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let baseDir: string;

function writeFileWithAge(relPath: string, ageDays: number): string {
  const filePath = path.join(baseDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x", "utf-8");
  const mtime = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotation-test-"));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe("applyLogRetention", () => {
  it("保持日数を超えた ops / LLM I/O ログを削除し、新しいものは残す", () => {
    const oldOps = writeFileWithAge("logs/ops/old.jsonl", 40);
    const newOps = writeFileWithAge("logs/ops/new.jsonl", 1);
    const oldLlm = writeFileWithAge("logs/sessions/old_main.jsonl", 40);
    const newLlm = writeFileWithAge("logs/sessions/new_main.jsonl", 1);

    const result = applyLogRetention({ logMaxAgeDays: 30, sessionMaxCount: 0 }, baseDir);

    expect(result.deletedLogs).toBe(2);
    expect(fs.existsSync(oldOps)).toBe(false);
    expect(fs.existsSync(oldLlm)).toBe(false);
    expect(fs.existsSync(newOps)).toBe(true);
    expect(fs.existsSync(newLlm)).toBe(true);
    expect(result.notices.length).toBe(1);
    expect(result.notices[0]).toContain("2 件削除");
  });

  it("logMaxAgeDays: 0 でログの削除を行わない", () => {
    const oldOps = writeFileWithAge("logs/ops/old.jsonl", 400);

    const result = applyLogRetention({ logMaxAgeDays: 0, sessionMaxCount: 0 }, baseDir);

    expect(result.deletedLogs).toBe(0);
    expect(fs.existsSync(oldOps)).toBe(true);
    expect(result.notices).toEqual([]);
  });

  it("ログ合計容量を超えた場合はops/session横断で古い順に削除する", () => {
    const oldest = writeFileWithAge("logs/ops/old.jsonl", 3);
    const middle = writeFileWithAge("logs/sessions/middle.jsonl", 2);
    const newest = writeFileWithAge("logs/ops/new.jsonl", 1);
    fs.writeFileSync(oldest, "a".repeat(700_000));
    fs.writeFileSync(middle, "b".repeat(700_000));
    fs.writeFileSync(newest, "c".repeat(100_000));

    const result = applyLogRetention({ logMaxAgeDays: 0, logMaxTotalMb: 1, sessionMaxCount: 0 }, baseDir);

    expect(result.deletedLogs).toBe(1);
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
    expect(result.notices.some((notice) => notice.includes("1 MiB"))).toBe(true);
  });

  it("セッションは新しい順に保持件数を超えた分だけ削除する", () => {
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      // i が小さいほど新しい
      files.push(writeFileWithAge(`sessions/session-${i}.json`, i));
    }

    const result = applyLogRetention({ logMaxAgeDays: 0, sessionMaxCount: 3 }, baseDir);

    expect(result.deletedSessions).toBe(2);
    expect(fs.existsSync(files[0])).toBe(true);
    expect(fs.existsSync(files[1])).toBe(true);
    expect(fs.existsSync(files[2])).toBe(true);
    expect(fs.existsSync(files[3])).toBe(false);
    expect(fs.existsSync(files[4])).toBe(false);
    expect(result.notices[0]).toContain("直近3件を保持");
  });

  it("対象拡張子以外のファイルは削除しない", () => {
    const broken = writeFileWithAge("sessions/session-x.json.broken-123", 100);
    writeFileWithAge("sessions/keep.json", 0);

    const result = applyLogRetention({ logMaxAgeDays: 30, sessionMaxCount: 1 }, baseDir);

    expect(result.deletedSessions).toBe(0);
    expect(fs.existsSync(broken)).toBe(true);
  });

  it("ディレクトリが存在しなくてもエラーにならない", () => {
    const result = applyLogRetention(undefined, path.join(baseDir, "no-such-dir"));
    expect(result.deletedLogs).toBe(0);
    expect(result.deletedSessions).toBe(0);
    expect(result.notices).toEqual([]);
  });

  it("既定値 (30日 / 100件) が適用される", () => {
    const oldOps = writeFileWithAge("logs/ops/old.jsonl", 31);
    const newOps = writeFileWithAge("logs/ops/new.jsonl", 29);

    const result = applyLogRetention(undefined, baseDir);

    expect(fs.existsSync(oldOps)).toBe(false);
    expect(fs.existsSync(newOps)).toBe(true);
    expect(result.deletedLogs).toBe(1);
  });
});
