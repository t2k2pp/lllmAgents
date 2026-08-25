#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { submitPtyLine } from "./pty-input.js";

if (process.platform === "win32") {
  console.error("Windows CIには対話console hostが無いため、このsmokeはLinux/macOSで実行します。");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = mkdtempSync(join(tmpdir(), "localllm-pty-home-"));
const tempWork = mkdtempSync(join(tmpdir(), "localllm-pty-work-"));
const configDir = join(tempHome, ".localllm");
mkdirSync(configDir, { recursive: true });
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    mainLLM: { providerType: "vllm", baseUrl: "http://127.0.0.1:9", model: "pty-smoke", contextWindow: 8192 },
    updateCheck: { enabled: false },
    mcpEnabled: false,
  }),
  "utf8",
);

const node = process.execPath;
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const entry = join(root, "src", "index.ts");
const args =
  process.platform === "darwin"
    ? ["-q", "/dev/null", node, tsx, entry, "--no-mcp"]
    : ["-qec", [node, tsx, entry, "--no-mcp"].map((part) => JSON.stringify(part)).join(" "), "/dev/null"];

try {
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn("script", args, {
      cwd: tempWork,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let sentQuit = false;
    let timedOut = false;
    const capture = (chunk) => {
      output += chunk.toString();
      if (!sentQuit && /LocalLLM Agent/i.test(output)) {
        sentQuit = true;
        // PTYのLFはinteractive-inputでCtrl+J（改行挿入）になる。CRでEnter確定する。
        child.stdin.write(submitPtyLine("/quit"));
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, output, sentQuit, timedOut });
    });
  });
  if (result.code !== 0 || result.timedOut || !result.sentQuit || !/Goodbye!/i.test(result.output)) {
    console.error(result.output);
    throw new Error(
      `PTY smoke failed (exit ${result.code}, signal ${result.signal ?? "none"}, ` +
        `quitSent ${result.sentQuit}, timedOut ${result.timedOut})`,
    );
  }
  console.log("real PTY smoke passed");
} finally {
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempWork, { recursive: true, force: true });
}
