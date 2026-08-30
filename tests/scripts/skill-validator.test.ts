import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const VALIDATOR = path.resolve("scripts", "validate-skill.mjs");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeSkill(root: string, name: string, extra: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: validator test\n${extra}---\n# Test\n`,
    "utf8",
  );
}

describe("validate-skill --root", () => {
  it("root配下を列挙し、trigger/context/tools拡張を検証する", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-validator-"));
    tempDirs.push(root);
    makeSkill(root, "one", "trigger: /run-one\n");
    makeSkill(root, "two", "context: fork\ntools: [file_read, grep]\n");

    const result = spawnSync(process.execPath, [VALIDATOR, "--root", root], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("one\\SKILL.md".replace("\\", path.sep));
    expect(result.stdout).toContain("two\\SKILL.md".replace("\\", path.sep));
  });

  it("無効なcontextを成功扱いしない", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-validator-invalid-"));
    tempDirs.push(root);
    makeSkill(root, "bad", "context: inline\n");

    const result = spawnSync(process.execPath, [VALIDATOR, "--root", root], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contextはforkだけ");
  });

  it("禁止例として引用したTODO文字列を未完了placeholderと誤判定しない", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-validator-todo-example-"));
    tempDirs.push(root);
    makeSkill(root, "example", "");
    fs.appendFileSync(path.join(root, "example", "SKILL.md"), "- `// TODO: implement` を残さない\n", "utf8");

    const result = spawnSync(process.execPath, [VALIDATOR, "--root", root], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
  });
});
