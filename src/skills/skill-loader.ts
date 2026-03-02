import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SkillDefinition } from "./skill-registry.js";

/** Parse skill markdown with YAML frontmatter */
function parseSkillFile(content: string, filePath: string, builtIn: boolean): SkillDefinition | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2];

  // Simple YAML-like parsing
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    meta[key] = value;
  }

  if (!meta.name || !meta.description || !meta.trigger) return null;

  return {
    name: meta.name,
    description: meta.description,
    trigger: meta.trigger,
    content: body.trim(),
    filePath,
    builtIn,
  };
}

/** Load skills from a directory */
function loadSkillsFromDir(dir: string, builtIn: boolean): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  if (!fs.existsSync(dir)) return skills;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const skill = parseSkillFile(content, filePath, builtIn);
      if (skill) {
        skills.push(skill);
      }
    } catch {
      // Skip invalid files
    }
  }

  return skills;
}

/** Load all skills from all sources */
export function loadAllSkills(): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  // 1. Built-in skills (bundled with the app)
  const builtinDir = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
    "builtin",
  );
  skills.push(...loadSkillsFromDir(builtinDir, true));

  // 2. User-global skills (~/.localllm/skills/)
  const userSkillsDir = path.join(os.homedir(), ".localllm", "skills");
  skills.push(...loadSkillsFromDir(userSkillsDir, false));

  // 3. Project skills (.claude/skills/ in CWD)
  const projectSkillsDir = path.join(process.cwd(), ".claude", "skills");
  skills.push(...loadSkillsFromDir(projectSkillsDir, false));

  // 4. Project skills (LOCALLLM_SKILLS/ in CWD)
  const localSkillsDir = path.join(process.cwd(), ".localllm", "skills");
  skills.push(...loadSkillsFromDir(localSkillsDir, false));

  return skills;
}
