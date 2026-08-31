import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSkillFileUtf8, loadSkillsFromDir, parseSkillFile } from "../../src/skills/skill-loader.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-loader-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("skill-loader UTF-8 handling", () => {
  it("BOM・CRLFを含む日本語スキルを正しく読む", () => {
    const source =
      "\uFEFF---\r\nname: quality\r\ndescription: 商品品質を確認する\r\n---\r\n# 手順\r\n文字化けさせない。\r\n";
    const decoded = decodeSkillFileUtf8(Buffer.from(source, "utf8"), "C:/skills/quality/SKILL.md");
    const skill = parseSkillFile(decoded, "C:/skills/quality/SKILL.md", true);

    expect(skill).toMatchObject({
      name: "quality",
      description: "商品品質を確認する",
      content: "# 手順\n文字化けさせない。",
      builtIn: true,
    });
  });

  it("不正UTF-8を置換文字へ化けさせず、対象パス付きで警告してskipする", () => {
    const root = makeTempDir();
    const skillDir = path.join(root, "broken");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), Buffer.from([0x82, 0xa0, 0x82, 0xa2]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadSkillsFromDir(root, false)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(path.join(skillDir, "SKILL.md"));
    expect(warn.mock.calls[0][0]).toContain("UTF-8");
  });

  it("frontmatter不正をエンコーディングエラーと区別して警告する", () => {
    const root = makeTempDir();
    const skillDir = path.join(root, "invalid-frontmatter");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# frontmatterなし\n", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadSkillsFromDir(root, false)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("frontmatter");
    expect(warn.mock.calls[0][0]).not.toContain("UTF-8で保存");
  });

  it("lllmAgents拡張frontmatterとClaude互換allowed-toolsを同じ実行契約へ変換する", () => {
    const source = [
      "---",
      "name: review",
      "description: 差分をレビューする",
      "trigger: /review-diff",
      "context: fork",
      "allowed-tools: [file_read, grep]",
      "---",
      "# Review",
    ].join("\n");

    expect(parseSkillFile(source, "C:/skills/review/SKILL.md", false)).toMatchObject({
      name: "review",
      trigger: "/review-diff",
      context: "fork",
      tools: ["file_read", "grep"],
    });
  });

  it("無効なtrigger/context/toolsを通常skillとして黙って読み替えない", () => {
    const base = "---\nname: bad\ndescription: bad skill\n%s\n---\nbody";
    for (const field of ["trigger: review", "context: inline", "tools: [file_read, ../bash]"]) {
      expect(parseSkillFile(base.replace("%s", field), "C:/skills/bad/SKILL.md", false)).toBeNull();
    }
  });

  it("Claude互換disable-model-invocationをmanual-only契約として読む", () => {
    const source = [
      "---",
      "name: learned",
      "description: 明示起動だけを許す",
      "disable-model-invocation: true",
      "---",
      "manual workflow",
    ].join("\n");
    expect(parseSkillFile(source, "C:/skills/learned/SKILL.md", false)).toMatchObject({
      name: "learned",
      disableModelInvocation: true,
    });
    expect(
      parseSkillFile(source.replace("disable-model-invocation: true", "disable-model-invocation: yes"), "bad", false),
    ).toBeNull();
    expect(
      parseSkillFile(source.replace("disable-model-invocation: true", "disable-model-invocation:"), "empty", false),
    ).toBeNull();
  });
});
