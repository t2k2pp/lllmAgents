import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { debug } from "../utils/logger.js";

export interface Rule {
  name: string;
  content: string;
  source: string;
}

/** Load rule markdown files from a directory */
function loadRulesFromDir(dir: string, source: string): Rule[] {
  const rules: Rule[] = [];

  if (!fs.existsSync(dir)) return rules;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) {
        const name = path.basename(file, ".md");
        rules.push({ name, content, source });
        debug(`Loaded rule: ${name} from ${source}`);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return rules;
}

export class RuleLoader {
  /** Load all rules from built-in, user-global, and project directories */
  loadAllRules(): Rule[] {
    const rules: Rule[] = [];

    // 1. Built-in rules (bundled with the app)
    const builtinDir = path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
      "builtin",
    );
    rules.push(...loadRulesFromDir(builtinDir, "builtin"));

    // 2. User-global rules (~/.localllm/rules/)
    const userRulesDir = path.join(os.homedir(), ".localllm", "rules");
    rules.push(...loadRulesFromDir(userRulesDir, "user"));

    // 3. Project rules (.claude/rules/ in CWD)
    const claudeRulesDir = path.join(process.cwd(), ".claude", "rules");
    rules.push(...loadRulesFromDir(claudeRulesDir, "project"));

    // 4. Project rules (.localllm/rules/ in CWD)
    const localRulesDir = path.join(process.cwd(), ".localllm", "rules");
    rules.push(...loadRulesFromDir(localRulesDir, "project"));

    return rules;
  }

  /** Format all loaded rules into a string suitable for system prompt injection */
  formatForSystemPrompt(): string {
    const rules = this.loadAllRules();
    if (rules.length === 0) return "";

    const sections = rules.map((rule) => rule.content);
    return `\n# ルール\n以下のルールに常に従ってください。\n\n${sections.join("\n\n")}`;
  }
}
