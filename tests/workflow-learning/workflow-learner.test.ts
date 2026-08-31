import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSkillFile } from "../../src/skills/skill-loader.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import type { ToolHandler, ToolResult } from "../../src/tools/tool-registry.js";
import { WorkflowLearner } from "../../src/workflow-learning/workflow-learner.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-learner-test-"));
  tempDirs.push(dir);
  return dir;
}

function handler(name: string, execute?: (params: Record<string, unknown>) => Promise<ToolResult>): ToolHandler {
  return {
    name,
    definition: {
      type: "function",
      function: { name, description: name, parameters: { type: "object", properties: {} } },
    },
    execute: execute ?? (async () => ({ success: true, output: "untrusted output must not be recorded" })),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("WorkflowLearner", () => {
  it("成功したbrowser操作をproject-localのmanual-only skillへ保存し即時登録する", async () => {
    const project = tempProject();
    const learner = new WorkflowLearner(project);
    const registry = new SkillRegistry();
    const navigate = learner.wrapTool(handler("browser_navigate"));
    const click = learner.wrapTool(handler("browser_click"));
    const type = learner.wrapTool(handler("browser_type"));
    const snapshot = learner.wrapTool(handler("browser_snapshot"));

    learner.start("submit-report", "週次レポートをフォームへ送る", "browser");
    await navigate.execute({ url: "https://example.test/report" });
    await click.execute({ selector: "#title" });
    await type.execute({ selector: "#title", text: "TOP-SECRET-REPORT" });
    await snapshot.execute({});
    const result = learner.finish(registry);

    expect(result.stepCount).toBe(4);
    expect(result.placeholderCount).toBe(1);
    expect(registry.get("submit-report")).toMatchObject({
      trigger: "/submit-report",
      disableModelInvocation: true,
      tools: ["browser_navigate", "browser_click", "browser_type", "browser_snapshot"],
    });
    const content = fs.readFileSync(result.filePath, "utf8");
    expect(content).toContain("disable-model-invocation: true");
    expect(content).toContain("https://example.test/report");
    expect(content).toContain('"text": "<INPUT_1>"');
    expect(content).not.toContain("TOP-SECRET-REPORT");
    expect(content).not.toContain("untrusted output must not be recorded");
    expect(parseSkillFile(content, result.filePath, false)).toMatchObject({
      name: "submit-report",
      disableModelInvocation: true,
    });
    expect(learner.status().active).toBe(false);
  });

  it("URL query・fragment・資格情報を保存せずURL placeholderへ置換する", async () => {
    const project = tempProject();
    const learner = new WorkflowLearner(project);
    const navigate = learner.wrapTool(handler("browser_navigate"));
    learner.start("private-page", "秘密付きURLを開く", "browser");
    const raw = "https://alice:password@example.test/path?token=abc#account";
    await navigate.execute({ url: raw });
    const result = learner.finish(new SkillRegistry());
    const content = fs.readFileSync(result.filePath, "utf8");
    expect(content).toContain('"url": "<URL_1>"');
    expect(content).not.toContain("alice");
    expect(content).not.toContain("password");
    expect(content).not.toContain("token=abc");
  });

  it("secretらしいURL pathとselectorを保存しない", async () => {
    const project = tempProject();
    const learner = new WorkflowLearner(project);
    const navigate = learner.wrapTool(handler("browser_navigate"));
    const click = learner.wrapTool(handler("browser_click"));
    learner.start("reset-account", "account recovery操作", "browser");
    await navigate.execute({ url: "https://example.test/reset/abcdefghijklmnopqrstuvwxyz123456" });
    await click.execute({ selector: "#account-user@example.test" });
    const result = learner.finish(new SkillRegistry());
    const content = fs.readFileSync(result.filePath, "utf8");
    expect(content).toContain('"url": "<URL_1>"');
    expect(content).toContain('"selector": "<SELECTOR_2>"');
    expect(content).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(content).not.toContain("user@example.test");
  });

  it("computerの一時window ID・入力文字列・screenshot保存先を永続化しない", async () => {
    const project = tempProject();
    const learner = new WorkflowLearner(project);
    const windows = learner.wrapTool(handler("computer_windows"));
    const click = learner.wrapTool(handler("computer_click"));
    const type = learner.wrapTool(handler("computer_type"));
    const screenshot = learner.wrapTool(handler("computer_screenshot"));
    learner.start("desktop-entry", "デスクトップアプリへ入力する", "computer");
    await windows.execute({});
    await click.execute({ window_id: "ephemeral-secret-id", x: 12, y: 34, clicks: 1 });
    await type.execute({ window_id: "ephemeral-secret-id", text: "PRIVATE-TEXT" });
    await screenshot.execute({ window_id: "ephemeral-secret-id", save_path: "C:/secret/capture.png" });
    const result = learner.finish(new SkillRegistry());
    const content = fs.readFileSync(result.filePath, "utf8");
    expect(content).toContain("<WINDOW_ID_FROM_COMPUTER_WINDOWS>");
    expect(content).toContain("<INPUT_1>");
    expect(content).not.toContain("ephemeral-secret-id");
    expect(content).not.toContain("PRIVATE-TEXT");
    expect(content).not.toContain("C:/secret/capture.png");
  });

  it("失敗した実演を成功stepだけのskillへ黙って変換しない", async () => {
    const project = tempProject();
    const learner = new WorkflowLearner(project);
    const click = learner.wrapTool(
      handler("browser_click", async () => ({ success: false, output: "", error: "selector missing" })),
    );
    learner.start("broken-demo", "失敗する操作", "browser");
    await click.execute({ selector: "#missing" });
    expect(() => learner.finish(new SkillRegistry())).toThrow("failed or parallel action");
    expect(fs.existsSync(path.join(project, ".localllm", "skills", "broken-demo"))).toBe(false);
    expect(learner.status()).toMatchObject({ active: true, successfulSteps: 0, failedSteps: 1 });
    learner.cancel();
  });

  it("並列実演を副作用前に拒否し、決定的なsequenceとして保存しない", async () => {
    const project = tempProject();
    const learner = new WorkflowLearner(project);
    let release!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    const click = learner.wrapTool(
      handler("browser_click", async () => {
        executions++;
        await firstDone;
        return { success: true, output: "ok" };
      }),
    );
    learner.start("parallel-demo", "並列操作", "browser");
    const first = click.execute({ selector: "#first" });
    const second = await click.execute({ selector: "#second" });
    expect(second).toMatchObject({ success: false, errorKind: "permanent" });
    expect(executions).toBe(1);
    release();
    await first;
    expect(() => learner.finish(new SkillRegistry())).toThrow("failed or parallel action");
  });

  it("利用不能scopeと既存skillへの上書きをfail-fastする", async () => {
    const project = tempProject();
    const learner = new WorkflowLearner(project);
    learner.wrapTool(handler("browser_click"));
    expect(() => learner.start("desktop-only", "desktop操作", "computer")).toThrow("computer tools are unavailable");

    const existing = path.join(project, ".localllm", "skills", "existing");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "SKILL.md"), "existing", "utf8");
    expect(() => learner.start("existing", "既存skill", "browser")).toThrow("never overwritten");
    expect(fs.readFileSync(path.join(existing, "SKILL.md"), "utf8")).toBe("existing");
  });

  it("skill無効modeとproject外へ向くskill directoryをfail-fastする", async () => {
    const disabledProject = tempProject();
    const disabled = new WorkflowLearner(disabledProject, false);
    disabled.wrapTool(handler("browser_click"));
    expect(() => disabled.start("disabled-demo", "無効mode", "browser")).toThrow("skills are disabled");

    const project = tempProject();
    const outside = tempProject();
    fs.symlinkSync(outside, path.join(project, ".localllm"), process.platform === "win32" ? "junction" : "dir");
    const learner = new WorkflowLearner(project);
    const click = learner.wrapTool(handler("browser_click"));
    learner.start("escape-demo", "path escape", "browser");
    await click.execute({ selector: "#safe" });
    expect(() => learner.finish(new SkillRegistry())).toThrow("escapes the project through a link");
    expect(fs.existsSync(path.join(outside, "skills", "escape-demo"))).toBe(false);
  });

  it("対象外scopeの操作は記録せず、cancelは永続物を作らない", async () => {
    const project = tempProject();
    const learner = new WorkflowLearner(project);
    const browser = learner.wrapTool(handler("browser_click"));
    const computer = learner.wrapTool(handler("computer_click"));
    learner.start("browser-only", "browserだけを学ぶ", "browser");
    await computer.execute({ window_id: "w", x: 1, y: 2 });
    expect(learner.status().successfulSteps).toBe(0);
    await browser.execute({ selector: "#ok" });
    expect(learner.status().successfulSteps).toBe(1);
    learner.cancel();
    expect(fs.existsSync(path.join(project, ".localllm", "skills", "browser-only"))).toBe(false);
  });

  it("記録中のremote・delegated操作を副作用前に拒否して記録をtaintする", async () => {
    const project = tempProject();
    const learner = new WorkflowLearner(project);
    let executions = 0;
    const click = learner.wrapTool(
      handler("browser_click", async () => {
        executions++;
        return { success: true, output: "ok" };
      }),
    );
    learner.start("local-only", "local mainだけの操作", "browser");
    const result = await click.execute(
      { selector: "#remote" },
      { ancestors: new Set(["general-purpose"]), source: "slack", workspace: { mode: "shared", root: project } },
    );
    expect(result).toMatchObject({ success: false, errorKind: "permanent" });
    expect(executions).toBe(0);
    expect(() => learner.finish(new SkillRegistry())).toThrow("failed or parallel action");
  });
});
