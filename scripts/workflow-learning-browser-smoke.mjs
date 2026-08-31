import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlaywrightManager } from "../dist/browser/playwright-manager.js";
import { SkillRegistry } from "../dist/skills/skill-registry.js";
import { createBrowserTools } from "../dist/tools/definitions/browser.js";
import { WorkflowLearner } from "../dist/workflow-learning/workflow-learner.js";

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lllm-workflow-learning-smoke-"));
const manager = new PlaywrightManager();
const learner = new WorkflowLearner(projectRoot);
const registry = new SkillRegistry();
const secret = "SMOKE-SECRET-42";

try {
  const tools = new Map(createBrowserTools(manager).map((tool) => [tool.name, learner.wrapTool(tool)]));
  const execute = async (name, params) => {
    const tool = tools.get(name);
    assert.ok(tool, `Missing browser tool: ${name}`);
    const result = await tool.execute(params);
    assert.equal(result.success, true, `${name} failed: ${result.error ?? result.output}`);
    return result;
  };

  learner.start("save-browser-note", "ブラウザの入力内容を保存して結果を確認する", "browser");
  const page = [
    "<!doctype html><meta charset=utf-8>",
    "<label>Note <input id=note></label>",
    "<button id=save onclick=\"document.querySelector('#result').textContent='saved:'+document.querySelector('#note').value\">Save</button>",
    "<output id=result>idle</output>",
  ].join("");
  await execute("browser_navigate", { url: `data:text/html,${encodeURIComponent(page)}?token=${secret}` });
  await execute("browser_type", { selector: "#note", text: secret });
  await execute("browser_click", { selector: "#save" });
  await execute("browser_snapshot", {});

  const observed = await manager.evaluate("document.querySelector('#result').textContent");
  assert.equal(observed, `saved:${secret}`, "The browser workflow did not produce the expected visible result.");

  const learned = learner.finish(registry);
  const skillText = fs.readFileSync(learned.filePath, "utf8");
  assert.equal(learned.stepCount, 4);
  assert.equal(learned.skill.disableModelInvocation, true);
  assert.ok(skillText.includes("disable-model-invocation: true"));
  assert.ok(skillText.includes("<URL_1>"));
  assert.ok(skillText.includes("<INPUT_2>"));
  assert.ok(!skillText.includes(secret), "The entered secret leaked into the learned skill.");
  assert.ok(!skillText.includes("data:text/html"), "The demonstrated URL leaked into the learned skill.");
  assert.equal(registry.get("save-browser-note")?.filePath, learned.filePath);

  console.log(
    JSON.stringify({
      status: "pass",
      browserResult: observed.replace(secret, "<redacted>"),
      recordedSteps: learned.stepCount,
      placeholders: learned.placeholderCount,
      manualOnly: learned.skill.disableModelInvocation,
      secretPersisted: skillText.includes(secret),
    }),
  );
} finally {
  await manager.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
