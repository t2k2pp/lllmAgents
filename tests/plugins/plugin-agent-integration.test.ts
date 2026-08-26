import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDefinitionLoader } from "../../src/agents/agent-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("plugin agent integration", () => {
  it("agent名と未修飾preload skillをplugin名で名前空間化する", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-agent-test-"));
    tempDirs.push(root);
    const agentsDir = path.join(root, "agents");
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(
      path.join(agentsDir, "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Plugin reviewer",
        "tools: [file_read, grep]",
        "skills: [review, shared:format]",
        "---",
        "Review carefully.",
      ].join("\n"),
      "utf8",
    );

    const loader = new AgentDefinitionLoader([{ pluginName: "quality-tools", pluginRoot: root, path: agentsDir }]);
    const agent = loader.get("quality-tools:reviewer");

    expect(agent).toMatchObject({
      name: "quality-tools:reviewer",
      skills: ["quality-tools:review", "shared:format"],
      source: path.join(agentsDir, "reviewer.md"),
    });
  });
});
