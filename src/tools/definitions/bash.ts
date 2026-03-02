import { spawn } from "node:child_process";
import { isWindows } from "../../utils/platform.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes

export const bashTool: ToolHandler = {
  name: "bash",
  definition: {
    type: "function",
    function: {
      name: "bash",
      description: "シェルコマンドを実行します。コマンドの結果（stdout/stderr）を返します。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "実行するシェルコマンド",
          },
          timeout: {
            type: "number",
            description: "タイムアウト（ミリ秒）。デフォルト: 120000",
          },
        },
        required: ["command"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT;

    return new Promise((resolve) => {
      const shell = isWindows ? "cmd.exe" : "/bin/sh";
      const shellArgs = isWindows ? ["/c", command] : ["-c", command];

      const proc = spawn(shell, shellArgs, {
        cwd: process.cwd(),
        timeout,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        const output = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim();
        const truncated = output.length > 30000 ? output.slice(0, 30000) + "\n... (truncated)" : output;

        if (code === 0) {
          resolve({ success: true, output: truncated });
        } else {
          resolve({ success: false, output: truncated, error: `Exit code: ${code}` });
        }
      });

      proc.on("error", (err) => {
        resolve({ success: false, output: "", error: err.message });
      });
    });
  },
};
