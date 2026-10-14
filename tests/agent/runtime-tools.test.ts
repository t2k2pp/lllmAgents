import { describe, expect, it, vi } from "vitest";

// docs/env-info-and-app-basics.md §2.1 — 実際に起動できる Python だけを「ある」 とし、
// Windows では git bash のパスの落とし穴を環境情報に入れる。

vi.mock("../../src/agent/project-context.js", () => ({
  loadProjectInstructions: vi.fn(() => ""),
  getGitInfo: vi.fn(() => ({ isGitRepo: false })),
}));
vi.mock("../../src/agent/memory.js", () => ({
  loadMemory: vi.fn(() => ""),
}));

const { detectPython, describePython } = await import("../../src/agent/runtime-tools.js");
const { buildSystemPrompt, WINDOWS_PATH_NOTE } = await import("../../src/agent/system-prompt.js");
const { isWindows } = await import("../../src/utils/platform.js");

describe("detectPython", () => {
  it("起動に失敗する候補 (Store のエイリアス等) は飛ばし、 次の候補を使う", () => {
    const probe = (cmd: string) => (cmd === "python3" ? null : cmd === "python" ? "Python 3.12.4\n" : null);
    expect(detectPython(probe)).toEqual({ command: "python", version: "Python 3.12.4" });
  });

  it("起動はできても Python の版が出ないものは「無い」 扱い", () => {
    const probe = () => "Python was not found; run without arguments to install from the Microsoft Store";
    expect(detectPython(probe)).toBeNull();
  });

  it("無い場合は node を使うよう伝える", () => {
    expect(describePython(null)).toContain("not installed");
    expect(describePython(null)).toContain("use node");
    expect(describePython({ command: "python3", version: "Python 3.11.2" })).toBe(
      "- Python: `python3` (Python 3.11.2)",
    );
  });
});

describe("# Environment", () => {
  it("Python の行が入る", () => {
    const prompt = buildSystemPrompt();
    const env = prompt.slice(prompt.indexOf("\n# Environment\n"));
    expect(env).toMatch(/\n- Python: /);
  });

  it.runIf(isWindows)("Windows ではスクリプト内のパスの落とし穴を伝える", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(WINDOWS_PATH_NOTE);
    expect(WINDOWS_PATH_NOTE).toContain(String.raw`as ` + "`" + String.raw`C:\tmp\x` + "`");
  });
});
