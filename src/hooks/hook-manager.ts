import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { getHomedir, getShell, isWindows } from "../utils/platform.js";
import * as logger from "../utils/logger.js";
import type { ToolResult } from "../tools/tool-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookType = "PreToolUse" | "PostToolUse" | "SessionStart" | "SessionStop";

export interface HookMatcher {
  tool?: string;
  filePattern?: string;
}

export interface HookDefinition {
  type: HookType;
  matcher?: HookMatcher;
  command: string;
  description?: string;
}

export interface HooksFile {
  hooks: HookDefinition[];
}

export interface PreHookResult {
  proceed: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple glob-style match supporting `*` and `**` patterns. */
function matchGlob(pattern: string, value: string): boolean {
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}

/** Run a shell command with environment variables, returning stdout. */
function runCommand(
  command: string,
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const shell = isWindows ? undefined : getShell();
    const child = exec(
      command,
      {
        env: { ...process.env, ...env },
        shell,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          code: error?.code ?? (child.exitCode ?? 0),
        });
      },
    );
  });
}

/** Safely parse a JSON file, returning null on failure. */
function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (e) {
    logger.warn(`Failed to parse hooks file: ${filePath}`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HookManager
// ---------------------------------------------------------------------------

export class HookManager {
  private hooks: HookDefinition[] = [];
  private loaded = false;

  /**
   * Load hooks from all sources (project-local and user-global).
   * Later sources are appended; all matching hooks run in order.
   */
  loadHooks(projectDir?: string): void {
    this.hooks = [];

    // 1. Project-level hooks
    if (projectDir) {
      const projectSources = [
        path.join(projectDir, ".claude", "hooks.json"),
        path.join(projectDir, ".localllm", "hooks.json"),
      ];
      for (const src of projectSources) {
        this.loadFromFile(src);
      }
    }

    // 2. User-global hooks
    const globalPath = path.join(getHomedir(), ".localllm", "hooks.json");
    this.loadFromFile(globalPath);

    this.loaded = true;
    logger.debug(`Loaded ${this.hooks.length} hook(s)`);
  }

  /**
   * Run all matching PreToolUse hooks.
   * If any hook command exits with a non-zero code, execution is blocked.
   */
  async runPreToolHooks(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<PreHookResult> {
    const matching = this.getMatching("PreToolUse", toolName, params);
    if (matching.length === 0) return { proceed: true };

    const env = this.buildEnv(toolName, params);

    for (const hook of matching) {
      logger.debug(`Running pre-hook: ${hook.description ?? hook.command}`);
      const result = await runCommand(hook.command, env);

      if (result.code !== 0) {
        const message =
          result.stderr.trim() ||
          result.stdout.trim() ||
          `Pre-hook blocked execution: ${hook.description ?? hook.command}`;
        logger.info(`Pre-hook blocked ${toolName}: ${message}`);
        return { proceed: false, message };
      }
    }

    return { proceed: true };
  }

  /**
   * Run all matching PostToolUse hooks.
   */
  async runPostToolHooks(
    toolName: string,
    params: Record<string, unknown>,
    result: ToolResult,
  ): Promise<void> {
    const matching = this.getMatching("PostToolUse", toolName, params);
    if (matching.length === 0) return;

    const env = this.buildEnv(toolName, params, result);

    for (const hook of matching) {
      logger.debug(`Running post-hook: ${hook.description ?? hook.command}`);
      const out = await runCommand(hook.command, env);

      if (out.code !== 0) {
        logger.warn(
          `Post-hook failed: ${hook.description ?? hook.command}`,
          out.stderr || out.stdout,
        );
      }
    }
  }

  /**
   * Run SessionStart or SessionStop hooks.
   */
  async runSessionHooks(type: "start" | "stop"): Promise<void> {
    const hookType: HookType = type === "start" ? "SessionStart" : "SessionStop";
    const matching = this.hooks.filter((h) => h.type === hookType);
    if (matching.length === 0) return;

    const env: Record<string, string> = {
      HOOK_TYPE: hookType,
    };

    for (const hook of matching) {
      logger.debug(`Running session hook (${type}): ${hook.description ?? hook.command}`);
      const out = await runCommand(hook.command, env);

      if (out.code !== 0) {
        logger.warn(
          `Session hook failed: ${hook.description ?? hook.command}`,
          out.stderr || out.stdout,
        );
      }
    }
  }

  /** Return the number of loaded hooks. */
  get count(): number {
    return this.hooks.length;
  }

  /** Whether hooks have been loaded at least once. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private loadFromFile(filePath: string): void {
    const data = readJsonFile<HooksFile>(filePath);
    if (!data?.hooks || !Array.isArray(data.hooks)) return;

    for (const hook of data.hooks) {
      if (!hook.type || !hook.command) {
        logger.warn(`Skipping invalid hook in ${filePath}:`, hook);
        continue;
      }
      this.hooks.push(hook);
    }

    logger.debug(`Loaded ${data.hooks.length} hook(s) from ${filePath}`);
  }

  /** Get hooks matching a given type, tool name, and params. */
  private getMatching(
    type: HookType,
    toolName: string,
    params: Record<string, unknown>,
  ): HookDefinition[] {
    return this.hooks.filter((hook) => {
      if (hook.type !== type) return false;

      const matcher = hook.matcher;
      if (!matcher) return true; // No matcher means match everything of this type

      // Match tool name
      if (matcher.tool && matcher.tool !== toolName) return false;

      // Match file pattern
      if (matcher.filePattern) {
        const filePath = this.extractFilePath(params);
        if (!filePath) return false;
        if (!matchGlob(matcher.filePattern, filePath)) return false;
      }

      return true;
    });
  }

  /** Build environment variables for hook commands. */
  private buildEnv(
    toolName: string,
    params: Record<string, unknown>,
    result?: ToolResult,
  ): Record<string, string> {
    const env: Record<string, string> = {
      TOOL_NAME: toolName,
    };

    const filePath = this.extractFilePath(params);
    if (filePath) {
      env.FILE_PATH = filePath;
    }

    if (result) {
      env.TOOL_OUTPUT = result.output;
      env.TOOL_SUCCESS = result.success ? "true" : "false";
      if (result.error) {
        env.TOOL_ERROR = result.error;
      }
    }

    return env;
  }

  /** Extract a file path from tool params (best effort). */
  private extractFilePath(params: Record<string, unknown>): string | undefined {
    const candidate = params.file_path ?? params.path ?? params.pattern ?? params.command;
    return typeof candidate === "string" ? candidate : undefined;
  }
}
