import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { bashTool, killProcessTree } from "../../src/tools/definitions/bash.js";

describe("bashTool execution and non-interactive environment", () => {
  it("子プロセスに非対話環境変数（GIT_TERMINAL_PROMPT, CI等）が正しく注入される", async () => {
    const result = await bashTool.execute({
      command:
        "echo GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT CI=$CI DEBIAN_FRONTEND=$DEBIAN_FRONTEND NPM_CONFIG_YES=$NPM_CONFIG_YES PIP_NO_INPUT=$PIP_NO_INPUT",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("GIT_TERMINAL_PROMPT=0");
    expect(result.output).toContain("CI=1");
    expect(result.output).toContain("DEBIAN_FRONTEND=noninteractive");
    expect(result.output).toContain("NPM_CONFIG_YES=true");
    expect(result.output).toContain("PIP_NO_INPUT=1");
  });

  it("標準的なコマンドが正常に実行され結果を返す", async () => {
    const result = await bashTool.execute({
      command: "echo 'hello from detached process'",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello from detached process");
  });

  it.skipIf(process.platform === "win32")(
    "killProcessTreeでプロセスグループ全体（孫プロセス含む）が終了する",
    async () => {
      // 孫プロセスとして sleep を起動するシェル
      const child = spawn("/bin/sh", ["-c", "sleep 100 & sleep 100"], {
        detached: true,
        stdio: "ignore",
      });

      expect(child.pid).toBeDefined();
      const pid = child.pid!;

      // killProcessTree を実行
      killProcessTree(child);

      // プロセスグループが終了したことを確認 (ESRCH になるかシグナル送信不可)
      await new Promise((resolve) => setTimeout(resolve, 100));
      let alive = true;
      try {
        // シグナル 0 でプロセスの存在確認
        process.kill(-pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
  );

  it("無通信状態が続くとidleTimeoutで終了し、明確なエラーを返す", async () => {
    const result = await bashTool.execute({
      command: "sleep 2",
      idleTimeout: 200, // 200ms 無通信でタイムアウト
      timeout: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("IdleTimeout: no output received for 200ms");
    expect(result.error).toContain("waiting for interactive input");
  });

  it("出力が継続している間はidleTimeoutにならず正常完了する", async () => {
    // 100ms ごとに 3 回出力（合計約 300ms）。idleTimeout は 250ms。
    // 出力が出るたびにアイドルタイマーがリセットされるため、完走できるはず
    const result = await bashTool.execute({
      command: "for i in 1 2 3; do echo step$i; sleep 0.1; done",
      idleTimeout: 250,
      timeout: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("step1");
    expect(result.output).toContain("step2");
    expect(result.output).toContain("step3");
  });

  it("ハードタイムアウトに達した場合はハードタイムアウトエラーを返す", async () => {
    const result = await bashTool.execute({
      command: "while true; do echo ping; sleep 0.05; done",
      idleTimeout: 1000,
      timeout: 300, // 300ms でハードタイムアウト
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout: command exceeded hard limit of 300ms");
  });
});
