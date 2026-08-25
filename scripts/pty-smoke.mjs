#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, output });
    });
    child.stdin.end("/quit\n");
  });
  if (result.code !== 0 || !/LocalLLM/i.test(result.output)) {
    console.error(result.output);
    throw new Error(`PTY smoke failed (exit ${result.code})`);
  }
  console.log("real PTY smoke passed");
} finally {
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempWork, { recursive: true, force: true });
}
