import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillDefinition, SkillRegistry } from "../skills/skill-registry.js";
import type { ToolExecutionContext, ToolHandler, ToolResult } from "../tools/tool-registry.js";
import { writeFileAtomic } from "../utils/atomic-file.js";

export type WorkflowLearnScope = "browser" | "computer" | "both";

interface Placeholder {
  token: string;
  description: string;
}

interface RecordedStep {
  tool: string;
  params: Record<string, unknown>;
}

interface ActiveRecording {
  name: string;
  description: string;
  scope: WorkflowLearnScope;
  startedAt: string;
  steps: RecordedStep[];
  placeholders: Placeholder[];
  failedTools: string[];
  inFlight: number;
}

export interface WorkflowLearnStatus {
  active: boolean;
  name?: string;
  description?: string;
  scope?: WorkflowLearnScope;
  startedAt?: string;
  successfulSteps: number;
  failedSteps: number;
  supportedScopes: Array<"browser" | "computer">;
}

export interface LearnedWorkflowResult {
  skill: SkillDefinition;
  filePath: string;
  stepCount: number;
  placeholderCount: number;
}

const MAX_STEPS = 50;
const TARGET_PREFIXES = ["browser_", "computer_"] as const;

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeDescription(value: string): string {
  const normalized = value
    .replace(/[\r\n\t]+/g, " ")
    .replaceAll("[", " ")
    .replaceAll("]", " ")
    .replace(/[{}#&*!|>'"%@`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 300);
}

function scopeIncludes(scope: WorkflowLearnScope, toolName: string): boolean {
  if (scope === "both") return TARGET_PREFIXES.some((prefix) => toolName.startsWith(prefix));
  return toolName.startsWith(`${scope}_`);
}

function safeSelector(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return null;
  if (/(password|passwd|secret|token|authorization|bearer|api[-_]?key|\[value\s*=|@)/i.test(value)) return null;
  if (/[A-Za-z0-9_-]{32,}/.test(value)) return null;
  return value;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (
      /(password|passwd|secret|token|authorization|bearer|api[-_]?key|oauth|reset|invite|session|@)/i.test(pathname)
    ) {
      return null;
    }
    if (/[A-Za-z0-9_-]{32,}/.test(pathname)) return null;
    return value;
  } catch {
    return null;
  }
}

function primitive(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

function isLocalMainContext(context?: ToolExecutionContext): boolean {
  if (!context) return true;
  if (context.source && context.source !== "cli") return false;
  if (context.ancestors.size > 0) return false;
  if (context.workspace?.mode === "worktree") return false;
  return true;
}

/**
 * Explicitly records successful browser/computer tool calls and promotes the
 * sanitized trajectory to a project-local, manual-only skill.
 *
 * Tool outputs are never retained. Text entry, URL query data, screenshot
 * paths, and ephemeral window IDs are converted to placeholders before a step
 * enters recorder state.
 */
export class WorkflowLearner {
  private recording: ActiveRecording | null = null;
  private supportedTools = new Set<string>();

  constructor(
    private readonly projectRoot: string = process.cwd(),
    private readonly enabled = true,
  ) {}

  wrapTool(handler: ToolHandler): ToolHandler {
    if (!TARGET_PREFIXES.some((prefix) => handler.name.startsWith(prefix))) return handler;
    this.supportedTools.add(handler.name);
    return {
      ...handler,
      execute: async (params, context): Promise<ToolResult> => {
        const active = this.recording;
        if (!active || !scopeIncludes(active.scope, handler.name)) {
          return handler.execute(params, context);
        }
        if (!isLocalMainContext(context)) {
          active.failedTools.push(handler.name);
          return {
            success: false,
            output: "",
            error:
              "A browser/computer action from a remote or delegated agent was blocked while local workflow recording is active. " +
              "Cancel the recording and repeat the demonstration only in the main local CLI.",
            errorKind: "permanent",
          };
        }
        if (active.steps.length + active.failedTools.length >= MAX_STEPS) {
          active.failedTools.push(handler.name);
          return {
            success: false,
            output: "",
            error: `Workflow recording reached the ${MAX_STEPS}-step limit. Cancel it and teach a smaller workflow.`,
            errorKind: "permanent",
          };
        }
        if (active.inFlight > 0) {
          active.failedTools.push(handler.name);
          return {
            success: false,
            output: "",
            error:
              "Parallel browser/computer actions cannot be learned deterministically. " +
              "Cancel the recording and demonstrate the workflow sequentially.",
            errorKind: "permanent",
          };
        }

        active.inFlight++;
        try {
          const result = await handler.execute(params, context);
          if (result.success) {
            active.steps.push({ tool: handler.name, params: this.sanitizeParams(handler.name, params, active) });
          } else {
            active.failedTools.push(handler.name);
          }
          return result;
        } catch (error) {
          active.failedTools.push(handler.name);
          throw error;
        } finally {
          active.inFlight--;
        }
      },
    };
  }

  start(name: string, description: string, scope: WorkflowLearnScope): WorkflowLearnStatus {
    if (!this.enabled) {
      throw new Error(
        "Workflow learning is unavailable while skills are disabled by safe mode, --no-skills, or configuration. " +
          "Re-enable skills and restart before recording.",
      );
    }
    if (this.recording) {
      throw new Error(
        `Workflow recording '${this.recording.name}' is already active. Finish or cancel it before starting another.`,
      );
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      throw new Error("Workflow name must be 1-64 characters of lowercase letters, digits, and single hyphens.");
    }
    const normalizedDescription = normalizeDescription(description);
    if (!normalizedDescription) throw new Error("Workflow description must contain visible text.");
    if (!(["browser", "computer", "both"] as string[]).includes(scope)) {
      throw new Error("Workflow scope must be browser, computer, or both.");
    }
    for (const required of scope === "both" ? ["browser", "computer"] : [scope]) {
      if (![...this.supportedTools].some((tool) => tool.startsWith(`${required}_`))) {
        const recovery =
          required === "browser"
            ? "Run `localllm --install-browser`, verify with `localllm --check-browser`, and restart."
            : "Restart with `--computer-use` after `localllm --check-computer-use` succeeds.";
        throw new Error(`${required} tools are unavailable, so this workflow cannot be learned. ${recovery}`);
      }
    }

    const skillDir = this.skillDir(name);
    if (fs.existsSync(skillDir)) {
      throw new Error(`Skill '${name}' already exists at ${skillDir}. Existing skills are never overwritten.`);
    }

    this.recording = {
      name,
      description: normalizedDescription,
      scope,
      startedAt: new Date().toISOString(),
      steps: [],
      placeholders: [],
      failedTools: [],
      inFlight: 0,
    };
    return this.status();
  }

  status(): WorkflowLearnStatus {
    const supportedScopes: Array<"browser" | "computer"> = [];
    if ([...this.supportedTools].some((tool) => tool.startsWith("browser_"))) supportedScopes.push("browser");
    if ([...this.supportedTools].some((tool) => tool.startsWith("computer_"))) supportedScopes.push("computer");
    if (!this.recording) {
      return { active: false, successfulSteps: 0, failedSteps: 0, supportedScopes };
    }
    return {
      active: true,
      name: this.recording.name,
      description: this.recording.description,
      scope: this.recording.scope,
      startedAt: this.recording.startedAt,
      successfulSteps: this.recording.steps.length,
      failedSteps: this.recording.failedTools.length,
      supportedScopes,
    };
  }

  cancel(): WorkflowLearnStatus {
    if (!this.recording) throw new Error("No workflow recording is active.");
    this.recording = null;
    return this.status();
  }

  finish(registry: SkillRegistry): LearnedWorkflowResult {
    const active = this.recording;
    if (!active) throw new Error("No workflow recording is active.");
    if (active.inFlight > 0) throw new Error("A recorded operation is still running. Wait for it to finish.");
    if (active.failedTools.length > 0) {
      throw new Error(
        `The demonstration contained ${active.failedTools.length} failed or parallel action(s): ` +
          `${[...new Set(active.failedTools)].join(", ")}. Cancel it and repeat a clean demonstration; failed steps are never silently omitted.`,
      );
    }
    if (active.steps.length === 0) {
      throw new Error("No successful browser/computer action was recorded. Perform the workflow before finishing.");
    }

    const skillsRoot = this.ensureSafeSkillsRoot();
    const skillDir = this.skillDir(active.name);
    if (!isWithin(skillsRoot, skillDir)) throw new Error("Resolved skill path escaped the project skill directory.");
    if (fs.existsSync(skillDir)) {
      throw new Error(`Skill '${active.name}' already exists at ${skillDir}. Existing skills are never overwritten.`);
    }

    const content = this.buildSkill(active);
    const tempDir = path.join(
      skillsRoot,
      `.${active.name}.learning-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(tempDir, { recursive: false });
    const tempFile = path.join(tempDir, "SKILL.md");
    try {
      writeFileAtomic(tempFile, content);
      fs.renameSync(tempDir, skillDir);
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }

    const filePath = path.join(skillDir, "SKILL.md");
    const skill: SkillDefinition = {
      name: active.name,
      description: active.description,
      trigger: `/${active.name}`,
      content: content.replace(/^---\n[\s\S]*?\n---\n/, "").trim(),
      filePath,
      builtIn: false,
      disableModelInvocation: true,
      tools: [...new Set(active.steps.map((step) => step.tool))],
    };
    registry.register(skill);
    this.recording = null;
    return {
      skill,
      filePath,
      stepCount: active.steps.length,
      placeholderCount: active.placeholders.length,
    };
  }

  private skillDir(name: string): string {
    return path.resolve(this.projectRoot, ".localllm", "skills", name);
  }

  private ensureSafeSkillsRoot(): string {
    fs.mkdirSync(this.projectRoot, { recursive: true });
    const projectReal = fs.realpathSync(this.projectRoot);
    const localDir = path.join(this.projectRoot, ".localllm");
    const skillsRoot = path.join(localDir, "skills");
    for (const dir of [localDir, skillsRoot]) {
      if (fs.existsSync(dir)) {
        const real = fs.realpathSync(dir);
        if (!isWithin(projectReal, real)) {
          throw new Error(`Workflow skill directory escapes the project through a link: ${dir}`);
        }
      } else {
        fs.mkdirSync(dir, { recursive: false });
      }
    }
    const realSkillsRoot = fs.realpathSync(skillsRoot);
    if (!isWithin(projectReal, realSkillsRoot)) {
      throw new Error(`Workflow skill directory escapes the project: ${skillsRoot}`);
    }
    return realSkillsRoot;
  }

  private placeholder(active: ActiveRecording, kind: "INPUT" | "URL" | "SELECTOR", description: string): string {
    const token = `<${kind}_${active.placeholders.length + 1}>`;
    active.placeholders.push({ token, description });
    return token;
  }

  private sanitizeParams(
    toolName: string,
    params: Record<string, unknown>,
    active: ActiveRecording,
  ): Record<string, unknown> {
    const windowId = "<WINDOW_ID_FROM_COMPUTER_WINDOWS>";
    switch (toolName) {
      case "browser_navigate": {
        const safeUrl = safeHttpUrl(params.url);
        if (safeUrl) return { url: safeUrl };
        return {
          url: this.placeholder(active, "URL", "実行時に指定するURL。query、fragment、資格情報は記録しません。"),
        };
      }
      case "browser_click": {
        return {
          selector:
            safeSelector(params.selector) ??
            this.placeholder(active, "SELECTOR", "実行時に現在のDOMから確認するclick対象selector。"),
        };
      }
      case "browser_type":
        return {
          selector:
            safeSelector(params.selector) ??
            this.placeholder(active, "SELECTOR", "実行時に現在のDOMから確認する入力対象selector。"),
          text: this.placeholder(active, "INPUT", "実行時にユーザーから受け取る入力。記録した文字列は保存しません。"),
        };
      case "browser_snapshot":
      case "browser_screenshot":
      case "computer_windows":
        return {};
      case "computer_screenshot":
        return { window_id: windowId };
      case "computer_click":
        return this.pickParams(params, { window_id: windowId }, ["x", "y", "button", "clicks"]);
      case "computer_type":
        return {
          window_id: windowId,
          text: this.placeholder(active, "INPUT", "実行時にユーザーから受け取る入力。記録した文字列は保存しません。"),
        };
      case "computer_key":
        return { window_id: windowId, keys: Array.isArray(params.keys) ? [...params.keys] : [] };
      case "computer_scroll":
        return this.pickParams(params, { window_id: windowId }, ["x", "y", "delta_y"]);
      default:
        return this.sanitizeUnknown(params, active);
    }
  }

  private pickParams(
    params: Record<string, unknown>,
    initial: Record<string, unknown>,
    names: string[],
  ): Record<string, unknown> {
    const result = { ...initial };
    for (const name of names) {
      const value = primitive(params[name]);
      if (value !== undefined) result[name] = value;
    }
    return result;
  }

  private sanitizeUnknown(params: Record<string, unknown>, active: ActiveRecording): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      const simple = primitive(value);
      if (simple !== undefined) result[key] = simple;
      else if (typeof value === "string") {
        result[key] = this.placeholder(active, "INPUT", `実行時に指定する ${key}。記録した値は保存しません。`);
      } else if (Array.isArray(value) && value.every((item) => primitive(item) !== undefined)) {
        result[key] = [...value];
      }
    }
    return result;
  }

  private buildSkill(active: ActiveRecording): string {
    const tools = [...new Set(active.steps.map((step) => step.tool))];
    const lines = [
      "---",
      `name: ${active.name}`,
      `description: ${active.description}`,
      `trigger: /${active.name}`,
      "disable-model-invocation: true",
      `tools: [${tools.join(", ")}]`,
      "---",
      "",
      `# ${active.description}`,
      "",
      "このskillは、ユーザーが明示的に記録した成功操作から生成した手動起動workflowです。",
      `記録日時: ${active.startedAt}。tool出力、入力文字列、URL query、screenshot保存先、一時window IDは保存していません。`,
      "",
      "## 安全契約",
      "",
      `- ユーザーが \`/${active.name}\` を直接実行したときだけ開始する。自動実行しない。`,
      "- placeholderの値を推測しない。不足値はユーザーへ確認する。",
      "- browserは現在のDOMを確認し、selectorが同じ対象を指すことを確かめてから操作する。",
      "- computerは毎回 `computer_windows` で対象を選び直し、一時window IDを再利用しない。座標は現在のwindow寸法で再確認する。",
      "- 通常のpermission確認を省略しない。skillの存在を操作許可と解釈しない。",
      "- 各stepが失敗したら停止し、別操作へ黙って置き換えない。",
      "",
    ];
    if (active.placeholders.length > 0) {
      lines.push("## 実行時入力", "");
      for (const item of active.placeholders) lines.push(`- \`${item.token}\`: ${item.description}`);
      lines.push("");
    }
    lines.push("## 記録済み手順", "");
    active.steps.forEach((step, index) => {
      lines.push(`${index + 1}. \`${step.tool}\` を次の引数で実行する。`, "");
      lines.push(
        "   ```json",
        ...JSON.stringify(step.params, null, 2)
          .split("\n")
          .map((line) => `   ${line}`),
        "   ```",
        "",
      );
    });
    lines.push(
      "## 完了確認",
      "",
      "最後の操作後に `browser_snapshot` または対象windowの `computer_screenshot` など、対象surfaceに合う読み取り操作で結果を確認する。観測できない成功を主張しない。",
      "",
    );
    return `${lines.join("\n")}\n`;
  }
}
