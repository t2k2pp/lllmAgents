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
});
