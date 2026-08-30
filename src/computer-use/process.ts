import { execFile } from "node:child_process";

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<string>;

export const runCommand: CommandRunner = async (command, args, options = {}) => {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        env: options.env,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: options.maxBufferBytes ?? 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || stdout.trim() || error.message;
          reject(new Error(`${command} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
};
