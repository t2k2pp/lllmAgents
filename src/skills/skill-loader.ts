import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SkillDefinition } from "./skill-registry.js";

/** SKILL.md は UTF-8 を正規形式とし、不正バイトを置換文字へ黙って変換しない。 */
export function decodeSkillFileUtf8(bytes: Uint8Array, filePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`[skills] 読み込みをスキップしました: ${filePath} は有効なUTF-8で保存されていません`);
  }
}

/** Parse skill markdown with YAML frontmatter */
export function parseSkillFile(content: string, filePath: string, builtIn: boolean): SkillDefinition | null {
  // CRLF/BOMを正規化してから frontmatter を抽出する
  // （Windowsで編集されたSKILL.mdがCRLFでも正しくパースされるように）
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
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
  if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trigger)) return null;

  // context: "fork" のみ有効値として受け付ける
  if (meta.context && meta.context !== "fork") return null;
  const context = meta.context === "fork" ? ("fork" as const) : undefined;

  // tools / Claude互換allowed-tools: "[bash, file_read]" or "bash, file_read" 形式をパース
  const toolsRaw = meta.tools ?? meta["allowed-tools"];
  const tools = toolsRaw
    ? toolsRaw
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;
  if (tools?.some((tool) => !/^[a-zA-Z0-9_-]+$/.test(tool))) return null;

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
export function loadSkillsFromDir(dir: string, builtIn: boolean): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  if (!fs.existsSync(dir)) return skills;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      // Standalone .md files (legacy format)
      const skill = loadSkillFile(path.join(dir, entry.name), builtIn);
      if (skill) skills.push(skill);
    } else if (entry.isDirectory()) {
      // Subdirectory containing SKILL.md (Anthropic standard format)
      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (fs.existsSync(skillMdPath)) {
        const skill = loadSkillFile(skillMdPath, builtIn);
        if (skill) skills.push(skill);
      }
    }
  }

  return skills;
}

function loadSkillFile(filePath: string, builtIn: boolean): SkillDefinition | null {
  try {
    const content = decodeSkillFileUtf8(fs.readFileSync(filePath), filePath);
    const skill = parseSkillFile(content, filePath, builtIn);
    if (!skill) {
      console.warn(`[skills] 読み込みをスキップしました: ${filePath} のfrontmatterが不正です`);
    }
    return skill;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(message.startsWith("[skills]") ? message : `[skills] 読み込み失敗: ${filePath}: ${message}`);
    return null;
  }
}

/** Load all skills from all sources
 *  設計: docs/workspace-separation.md
 *  - ビルトインとユーザー追加は ~/.localllm/skills/ に同居（install 時に展開）
 *  - 開発時は scripts/sync-skills.js が src/skills/builtin/ → ~/.localllm/skills/ を同期
 *  - exe 化後も同じパスを参照するため、selfDir 相対の検索は廃止
 */
export function loadAllSkills(): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  // 1. ~/.localllm/skills/ — ビルトイン＋ユーザー同居
  const userSkillsDir = path.join(os.homedir(), ".localllm", "skills");
  skills.push(...loadSkillsFromDir(userSkillsDir, true));

  // 2. CWD .claude/skills/ — プロジェクト拡張（Claude Code プラグイン互換）
  const projectClaudeSkillsDir = path.join(process.cwd(), ".claude", "skills");
  skills.push(...loadSkillsFromDir(projectClaudeSkillsDir, false));

  // 3. CWD .localllm/skills/ — プロジェクト拡張（アプリ独自）
  const projectLocalSkillsDir = path.join(process.cwd(), ".localllm", "skills");
  skills.push(...loadSkillsFromDir(projectLocalSkillsDir, false));

  return skills;
}
