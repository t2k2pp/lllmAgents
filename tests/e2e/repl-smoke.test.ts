/**
 * E2E スモークテスト — アプリ全体を子プロセスとして起動し、主要経路を通す。
 * docs/production-readiness.md PR-08
 *
 * 方式:
 *   - モック LLM サーバー (OpenAI 互換 canned response) を test プロセス内に起動
 *   - HOME/USERPROFILE を一時ディレクトリへ差し替えた config.json でアプリを
 *     非TTY パイプモード起動 (tsx 経由で src/ を直接実行)
 *   - stdin に入力行を先渡し (nonTTYReader が行キューで順次消費する)
 *
 * シナリオ:
 *   1. Q→A 1ターン: ユーザー入力 → テキスト応答 → /quit → exit 0
 *   2. ツール実行+権限確認: file_write のツール呼び出し → 数値応答 "1" (今回のみ許可)
 *      → ファイルが実際に書かれる → 完了報告 → /quit → exit 0
 *   3. /doctor 環境診断: モック LLM への疎通 ✔ と診断表の描画 → /quit → exit 0 (PR-16)
 *   4. --safe-mode: 壊れたplugin/MCPとproject/user customizationを読み込まず起動
 *
 * モデル応答は毎回 response_complete を添えてターンを決定的に終了させる
 * (テキストのみ応答だと自己点検ループ/intent classifier の追加 LLM 呼び出しが発生するため)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MockLLMServer, type ChatMessage } from "./mock-llm.js";
import { resolveGitExecutable } from "../../src/cli/worktree-diff.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = path.join(ROOT, "src", "index.ts");

/** 子プロセスの起動 (tsx の TS 変換込み) を見込んだタイムアウト */
const APP_TIMEOUT_MS = 150_000;
const TEST_TIMEOUT_MS = 180_000;

/** ANSI エスケープを除去してプレーンテキストで比較する */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

let tmpHome: string;
let workspace: string;
let server: MockLLMServer;
let targetFile: string;

/** モックの canned 応答ルーティング (メッセージ内容で決定的に分岐) */
function route(messages: ChatMessage[]): {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const last = messages[messages.length - 1];
  // ツール結果が返ってきた = file_write 実行後 → 完了報告してターン終了
  if (last?.role === "tool") {
    return {
      text: "WRITE-DONE-PLUGH",
      toolCalls: [{ name: "response_complete", args: { summary: "ファイルを作成しました" } }],
    };
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const content = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  if (content.includes("SMOKE2")) {
    return {
      toolCalls: [{ name: "file_write", args: { file_path: targetFile, content: "smoke-content-42\n" } }],
    };
  }
  if (content.includes("SMOKE1")) {
    return {
      text: "SMOKE1-REPLY-XYZZY",
      toolCalls: [{ name: "response_complete", args: { summary: "挨拶に応答しました" } }],
    };
  }
  // 想定外のリクエスト (classifier 等)。ここに来たら chatRequests を見て原因を調べる
  return { text: "MOCK-FALLBACK" };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** アプリを非TTYパイプモードで起動し、入力行を先渡しして終了まで待つ */
function runApp(
  lines: string[],
  args: string[] = ["--no-mcp"],
  home = tmpHome,
  workingDirectory = workspace,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, ENTRY, ...args], {
      cwd: workingDirectory,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, APP_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut });
    });
    child.stdin.write(lines.join("\n") + "\n");
    child.stdin.end();
  });
}

/** 失敗時に子プロセスの出力を丸ごと見えるようにする */
const diag = (r: RunResult): string =>
  `exit=${r.code} timedOut=${r.timedOut}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-work-"));
  targetFile = path.join(workspace, "smoke-output.txt");
  server = new MockLLMServer(route);
  const baseUrl = await server.listen();
  fs.mkdirSync(path.join(tmpHome, ".localllm"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, ".localllm", "config.json"),
    JSON.stringify(
      {
        mainLLM: {
          providerType: "vllm",
          baseUrl,
          model: "mock-model",
          contextWindow: 32768,
        },
        modelCapabilities: {
          "mock-model": { tier: "T2", contextWindow: 32768 },
        },
      },
      null,
      2,
    ),
  );
});

afterAll(async () => {
  await server.close();
  for (const dir of [tmpHome, workspace]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows でハンドルが残っていても無視 */
    }
  }
});

describe("E2E smoke — 非TTYパイプモード起動", () => {
  it(
    "シナリオ1: 1ターン会話して /quit で正常終了する",
    async () => {
      const r = await runApp(["こんにちは SMOKE1", "/quit"]);

      expect(r.timedOut, diag(r)).toBe(false);
      expect(r.code, diag(r)).toBe(0);
      // モックの canned 応答がユーザーに表示されている
      expect(r.stdout, diag(r)).toContain("SMOKE1-REPLY-XYZZY");
      // 想定外の LLM 呼び出し (classifier 等) が発生していない
      expect(r.stdout, diag(r)).not.toContain("MOCK-FALLBACK");
      // セッションが永続化されている (resume 可能な状態)
      const sessionsDir = path.join(tmpHome, ".localllm", "sessions");
      const sessions = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json")) : [];
      expect(sessions.length, diag(r)).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "シナリオ2: file_write ツール実行 → 権限確認に数値応答 → ファイルが書かれる",
    async () => {
      const r = await runApp(["SMOKE2 ファイルを作成して", "1", "/quit"]);

      expect(r.timedOut, diag(r)).toBe(false);
      expect(r.code, diag(r)).toBe(0);
      // 非TTY 権限確認メニューが表示され、"1" (今回のみ許可) で通過した
      expect(r.stdout, diag(r)).toContain("選択 [1-5]");
      // ツールが実際に実行されてファイルが書かれた
      expect(fs.existsSync(targetFile), diag(r)).toBe(true);
      expect(fs.readFileSync(targetFile, "utf-8")).toBe("smoke-content-42\n");
      // ツール結果を受けた完了報告が表示された
      expect(r.stdout, diag(r)).toContain("WRITE-DONE-PLUGH");
      expect(r.stdout, diag(r)).not.toContain("MOCK-FALLBACK");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "シナリオ3: /doctor が診断表を表示して正常終了する",
    async () => {
      const r = await runApp(["/doctor", "/quit"]);

      expect(r.timedOut, diag(r)).toBe(false);
      expect(r.code, diag(r)).toBe(0);
      expect(r.stdout, diag(r)).toContain("環境診断 (/doctor):");
      // モック LLM への疎通が ✔ になる (メインLLM は生きた provider で検証)
      expect(r.stdout, diag(r)).toMatch(/✔ メインLLM\s+mock-model/);
      // 未設定の統合は − (skip) で表示される
      expect(r.stdout, diag(r)).toContain("Discord");
      expect(r.stdout, diag(r)).toContain("Slack");
      expect(r.stdout, diag(r)).toContain("ディスク使用量");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "シナリオ4: --safe-mode は壊れたcustomizationを読まずbuilt-in機能で起動する",
    async () => {
      const projectMarker = "SAFE-MODE-PROJECT-MARKER-7X";
      const memoryMarker = "SAFE-MODE-MEMORY-MARKER-8Y";
      const ruleMarker = "SAFE-MODE-RULE-MARKER-9Z";
      fs.writeFileSync(path.join(workspace, "AGENTS.md"), projectMarker);
      fs.mkdirSync(path.join(workspace, ".localllm", "rules"), { recursive: true });
      fs.writeFileSync(path.join(workspace, ".localllm", "rules", "custom.md"), ruleMarker);
      fs.writeFileSync(path.join(workspace, ".localllm", "mcp-servers.json"), "{ broken json");
      fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, ".claude", "hooks.json"),
        JSON.stringify({
          hooks: [
            {
              type: "SessionStart",
              command: `node -e "require('node:fs').writeFileSync('safe-mode-hook-ran.txt','yes')"`,
            },
          ],
        }),
      );
      fs.mkdirSync(path.join(tmpHome, ".localllm", "memory"), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, ".localllm", "memory", "MEMORY.md"), memoryMarker);

      const requestStart = server.chatRequests.length;
      const missingPlugin = path.join(workspace, "missing-plugin");
      const r = await runApp(["/mcp on", "こんにちは SMOKE1", "/quit"], ["--safe-mode", "--plugin-dir", missingPlugin]);

      expect(r.timedOut, diag(r)).toBe(false);
      expect(r.code, diag(r)).toBe(0);
      expect(r.stdout, diag(r)).toContain("Safe mode: customizations are disabled");
      expect(r.stdout, diag(r)).toContain("MCP is disabled for this session by --safe-mode");
      expect(r.stdout, diag(r)).toContain("SMOKE1-REPLY-XYZZY");
      const configAfter = JSON.parse(fs.readFileSync(path.join(tmpHome, ".localllm", "config.json"), "utf-8"));
      expect(configAfter.mcpEnabled).toBeUndefined();
      expect(fs.existsSync(path.join(workspace, "safe-mode-hook-ran.txt")), diag(r)).toBe(false);
      const safeModeRequests = server.chatRequests.slice(requestStart);
      const serializedMessages = JSON.stringify(safeModeRequests.flatMap((request) => request.messages));
      expect(serializedMessages).not.toContain(projectMarker);
      expect(serializedMessages).not.toContain(memoryMarker);
      expect(serializedMessages).not.toContain(ruleMarker);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "シナリオ5: --help は初期化や外部接続を行わず終了する",
    async () => {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "localllm-help-e2e-"));
      try {
        const r = await runApp([], ["--help"], emptyHome);

        expect(r.timedOut, diag(r)).toBe(false);
        expect(r.code, diag(r)).toBe(0);
        expect(r.stdout, diag(r)).toContain("Usage:");
        expect(r.stdout, diag(r)).toContain("--no-alt-screen");
        expect(r.stdout, diag(r)).toContain("--computer-use");
        expect(r.stdout, diag(r)).toContain("--check-computer-use");
        expect(r.stdout, diag(r)).not.toContain("Discord");
        expect(fs.existsSync(path.join(emptyHome, ".localllm")), diag(r)).toBe(false);
      } finally {
        fs.rmSync(emptyHome, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "シナリオ5b: --check-computer-use は設定を作らず診断結果だけを返す",
    async () => {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "localllm-computer-check-e2e-"));
      try {
        const r = await runApp([], ["--check-computer-use"], emptyHome);

        expect(r.timedOut, diag(r)).toBe(false);
        expect([0, 1], diag(r)).toContain(r.code);
        expect(`${r.stdout}\n${r.stderr}`, diag(r)).toContain("[check-computer-use]");
        expect(fs.existsSync(path.join(emptyHome, ".localllm")), diag(r)).toBe(false);
      } finally {
        fs.rmSync(emptyHome, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "シナリオ6: /diff・/tasksを実行し、/renameがsession一覧へ残る",
    async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "localllm-diff-e2e-"));
      try {
        const git = resolveGitExecutable();
        execFileSync(git, ["init", "--quiet"], { cwd: repo });
        execFileSync(git, ["config", "user.name", "E2E"], { cwd: repo });
        execFileSync(git, ["config", "user.email", "e2e@example.invalid"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n", "utf8");
        execFileSync(git, ["add", "tracked.txt"], { cwd: repo });
        execFileSync(git, ["commit", "--quiet", "-m", "initial"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n", "utf8");
        fs.writeFileSync(path.join(repo, "untracked.txt"), "new body\n", "utf8");

        const r = await runApp(
          ["/diff", "/tasks", "/rename cycle 9 release", "/resume list", "/quit"],
          ["--no-mcp"],
          tmpHome,
          repo,
        );

        expect(r.timedOut, diag(r)).toBe(false);
        expect(r.code, diag(r)).toBe(0);
        expect(r.stdout, diag(r)).toContain("-before");
        expect(r.stdout, diag(r)).toContain("+after");
        expect(r.stdout, diag(r)).toContain("untracked.txt");
        expect(r.stdout, diag(r)).toContain("+new body");
        expect(r.stdout, diag(r)).toContain("task/worktreeなし");
        expect(r.stdout, diag(r)).toContain("session名を変更しました: cycle 9 release");
        expect(r.stdout, diag(r)).toContain("cycle 9 release");
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
