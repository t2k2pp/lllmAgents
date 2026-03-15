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

  if (!meta.name || !meta.description) return null;
  const trigger = meta.trigger || `/${meta.name}`;

  // context: "fork" のみ有効値として受け付ける
  const context = meta.context === "fork" ? "fork" as const : undefined;

  // tools: "[bash, file_read]" or "bash, file_read" 形式をパース
  const toolsRaw = meta.tools;
  const tools = toolsRaw
    ? toolsRaw.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  return {
    name: meta.name,
    description: meta.description,
    trigger: trigger,
    content: body.trim(),
    filePath,
    builtIn,
    context,
    tools,
  };
}

/** Load skills from a directory */
function loadSkillsFromDir(dir: string, builtIn: boolean): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  if (!fs.existsSync(dir)) return skills;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      // Standalone .md files (legacy format)
      try {
        const filePath = path.join(dir, entry.name);
        const content = fs.readFileSync(filePath, "utf-8");
        const skill = parseSkillFile(content, filePath, builtIn);
        if (skill) {
          skills.push(skill);
        }
      } catch {
        // Skip invalid files
      }
    } else if (entry.isDirectory()) {
      // Subdirectory containing SKILL.md (Anthropic standard format)
      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (fs.existsSync(skillMdPath)) {
        try {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          const skill = parseSkillFile(content, skillMdPath, builtIn);
          if (skill) {
            skills.push(skill);
          }
        } catch {
          // Skip invalid files
        }
      }
    }
  }

  return skills;
}

/** Load all skills from all sources */
export function loadAllSkills(): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  const selfDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));

  // 1. Source built-in skills (src/skills/builtin/ in dev, dist/skills/builtin/ in prod)
  //    新しいスキルをソースツリーに追加すれば即座に有効化される
  const srcBuiltinDir = path.join(selfDir, "builtin");
  skills.push(...loadSkillsFromDir(srcBuiltinDir, true));

  // 2. Root built-in skills (builtin/ at project root)
  //    .skill パッケージとして外部からインストールされたスキルの格納場所
  //    src/skills/builtin/ と同名のスキルがある場合はこちらが優先される
  const rootBuiltinDir = path.join(selfDir, "..", "..", "builtin");
  skills.push(...loadSkillsFromDir(rootBuiltinDir, true));

  // 3. User-global skills (~/.localllm/skills/)
  const userSkillsDir = path.join(os.homedir(), ".localllm", "skills");
  skills.push(...loadSkillsFromDir(userSkillsDir, false));

  // 4. Project skills (.claude/skills/ in CWD)
  const projectSkillsDir = path.join(process.cwd(), ".claude", "skills");
  skills.push(...loadSkillsFromDir(projectSkillsDir, false));

  // 5. Project skills (.localllm/skills/ in CWD)
  const localSkillsDir = path.join(process.cwd(), ".localllm", "skills");
  skills.push(...loadSkillsFromDir(localSkillsDir, false));

  return skills;
}
