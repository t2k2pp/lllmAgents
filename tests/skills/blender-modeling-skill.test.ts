import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSkillFile } from "../../src/skills/skill-loader.js";

// ビルトインスキル blender-modeling の形の確かめ（docs/blender-mcp-integration.md §3）。
// Blender で動かす確かめは手作業（examples を blender -b で実行）。ここでは読み込めることと、リンク・関数名の食い違いを見る。

const DIR = path.resolve(__dirname, "../../src/skills/builtin/blender-modeling");
const skillText = fs.readFileSync(path.join(DIR, "SKILL.md"), "utf8");
const bkit = fs.readFileSync(path.join(DIR, "references", "bkit.py"), "utf8");

describe("blender-modeling skill", () => {
  it("frontmatter を読める", () => {
    const skill = parseSkillFile(skillText, path.join(DIR, "SKILL.md"), true);
    expect(skill?.name).toBe("blender-modeling");
    expect(skill?.trigger).toBe("/blender-modeling");
  });

  it("SKILL.md のリンク先が全部ある", () => {
    const links = [...skillText.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(3);
    for (const rel of links) {
      expect(fs.existsSync(path.join(DIR, rel)), rel).toBe(true);
    }
  });

  it("SKILL.md が挙げる部品箱の関数が bkit.py にある", () => {
    const named = [...skillText.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    const funcs = new Set([...bkit.matchAll(/^def ([a-z_]+)\(/gm)].map((m) => m[1]));
    const used = named.filter((n) =>
      [
        "loft",
        "fuse",
        "paint_by_parts",
        "box",
        "add_bevel",
        "cylinder",
        "prism",
        "hull",
        "gable_roof",
        "shed_roof",
        "cut",
        "repeat",
        "mirror_x",
        "blob",
        "tube",
        "measure",
        "render_views",
        "export",
        "decimate",
        "lowpoly",
        "voxelize",
        "clear_scene",
      ].includes(n),
    );
    expect(used.length).toBeGreaterThan(10);
    for (const n of used) expect(funcs.has(n), n).toBe(true);
  });

  it("見本は bkit から読み込む関数が全部ある", () => {
    for (const file of ["creatures.py", "objects.py", "nature.py"]) {
      const src = fs.readFileSync(path.join(DIR, "references", "examples", file), "utf8");
      const m = /from bkit import ([^\n#]+)/.exec(src);
      expect(m, file).not.toBeNull();
      const funcs = new Set([...bkit.matchAll(/^def ([a-z_]+)\(/gm)].map((x) => x[1]));
      for (const name of (m?.[1] ?? "").split(",").map((s) => s.trim())) {
        expect(funcs.has(name), `${file}: ${name}`).toBe(true);
      }
    }
  });
});
