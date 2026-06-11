import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatStatsLine,
  formatReportFooter,
  formatTaskReport,
} from "../../src/agent/task-reporter.js";
import type { AgentEventMap } from "../../src/agent/agent-events.js";

type E = AgentEventMap["task_complete"];

function mkEvent(overrides: Partial<E> = {}): E {
  return {
    source: "slack",
    outcome: "completed",
    finalResponse: "やりました",
    iterations: 5,
    durationMs: 154000,
    toolsExecuted: 12,
    filesChanged: ["sandbox/a.html", "sandbox/b.css"],
    tokensIn: 12300,
    tokensOut: 4500,
    costUsd: 0.0123,
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("秒・分・時間を整形する", () => {
    expect(formatDuration(45_000)).toBe("45秒");
    expect(formatDuration(154_000)).toBe("2分34秒");
    expect(formatDuration(120_000)).toBe("2分");
    expect(formatDuration(3_900_000)).toBe("1時間5分");
  });
});

describe("formatStatsLine", () => {
  it("所要時間・ツール数・ファイル数・トークンを 1 行にまとめる", () => {
    const line = formatStatsLine(mkEvent());
    expect(line).toContain("2分34秒");
    expect(line).toContain("12 tools");
    expect(line).toContain("2 files");
    expect(line).toContain("in 12.3K/out 4.5K");
    expect(line).toContain("$0.0123");
  });

  it("ローカルLLM (コスト0) では $ 表示を省略する", () => {
    const line = formatStatsLine(mkEvent({ costUsd: 0 }));
    expect(line).not.toContain("$");
    expect(line).toContain("in 12.3K");
  });
});

describe("formatReportFooter", () => {
  it("ツールを使ったタスクにはフッターを返す", () => {
    const footer = formatReportFooter(mkEvent());
    expect(footer).not.toBeNull();
    expect(footer).toContain("12 tools");
    expect(footer).toContain("sandbox/a.html");
  });

  it("会話的応答 (ツール0回・completed) では null", () => {
    expect(formatReportFooter(mkEvent({ toolsExecuted: 0, filesChanged: [] }))).toBeNull();
  });

  it("completed 以外は outcome を明示する (ツール0回でも)", () => {
    const footer = formatReportFooter(mkEvent({ toolsExecuted: 0, filesChanged: [], outcome: "error" }));
    expect(footer).not.toBeNull();
    expect(footer).toContain("エラー");
  });

  it("6 ファイル以上は一覧を省略する (件数のみ)", () => {
    const files = ["a", "b", "c", "d", "e", "f"];
    const footer = formatReportFooter(mkEvent({ filesChanged: files }))!;
    expect(footer).toContain("6 files");
    expect(footer).not.toContain("- a");
  });
});

describe("formatTaskReport", () => {
  it("outcome + 最終応答 + 統計 + ファイル一覧を含む", () => {
    const report = formatTaskReport(mkEvent());
    expect(report).toContain("✅ 完了");
    expect(report).toContain("やりました");
    expect(report).toContain("12 tools");
    expect(report).toContain("- sandbox/a.html");
  });

  it("中断は中断と報告する (完了と偽らない)", () => {
    const report = formatTaskReport(mkEvent({ outcome: "aborted", finalResponse: "" }));
    expect(report).toContain("中断");
    expect(report).not.toContain("✅");
    expect(report).toContain("最終応答はありません");
  });

  it("長い最終応答は省略マーカー付きで切り詰める", () => {
    const report = formatTaskReport(mkEvent({ finalResponse: "あ".repeat(2000) }));
    expect(report).toContain("…(以下省略)");
    expect(report.length).toBeLessThan(1500);
  });

  it("11 ファイル以上は「他 N ファイル」と表示", () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
    const report = formatTaskReport(mkEvent({ filesChanged: files }));
    expect(report).toContain("- f9.txt");
    expect(report).toContain("他 2 ファイル");
  });
});
