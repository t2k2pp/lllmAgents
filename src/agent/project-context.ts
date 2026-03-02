import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Looks for project-level instruction files (like CLAUDE.md) in the CWD
 * and parent directories. Returns concatenated instructions.
 */

const INSTRUCTION_FILES = [
  "CLAUDE.md",
  ".claude/instructions.md",
  "AGENTS.md",
  ".clauderc",
  "LOCALLLM.md",
  ".localllm/instructions.md",
];

export function loadProjectInstructions(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const parts: string[] = [];

  for (const filename of INSTRUCTION_FILES) {
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        if (content.trim()) {
          parts.push(`# ${filename}\n\n${content.trim()}`);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Also check parent directory
  const parentDir = path.dirname(dir);
  if (parentDir !== dir) {
    for (const filename of INSTRUCTION_FILES) {
      const filePath = path.join(parentDir, filename);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          if (content.trim()) {
            parts.push(`# ${filename} (parent)\n\n${content.trim()}`);
          }
        } catch {
          // Skip
        }
      }
    }
  }

  return parts.join("\n\n---\n\n");
}

/**
 * Detect if the CWD is a git repository and return basic info.
 */
export function getGitInfo(cwd?: string): { isGitRepo: boolean; branch?: string } {
  const dir = cwd ?? process.cwd();

  // Walk up to find .git
  let current = dir;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      // Read current branch
      const headPath = path.join(current, ".git", "HEAD");
      if (fs.existsSync(headPath)) {
        const head = fs.readFileSync(headPath, "utf-8").trim();
        const match = head.match(/^ref: refs\/heads\/(.+)$/);
        return { isGitRepo: true, branch: match?.[1] };
      }
      return { isGitRepo: true };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { isGitRepo: false };
}
