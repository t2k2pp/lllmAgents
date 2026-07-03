import { describe, it, expect } from "vitest";
import { runCheck } from "../../src/goal-loop/check-runner.js";

// check-runner は LLM 非依存の決定的ゲート。exit code を正しく拾えるかを検証する。
// 設計: docs/goal-loop-deterministic-check-design.md §4.3
//
// シェル (git bash) の初回 spawn は、カバレッジ計測や並列実行で CPU が逼迫していると
// 10秒近くかかることが実測されている。テストの検証内容は速度ではないので余裕を持たせる。
const SPAWN_TIMEOUT_MS = 30_000;

describe("runCheck", () => {
  it(
    "exit 0 のコマンドは passed=true",
    async () => {
      const r = await runCheck("exit 0");
      expect(r.passed).toBe(true);
      expect(r.exitCode).toBe(0);
      expect(r.timedOut).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "非 0 終了のコマンドは passed=false で exit code を保持",
    async () => {
      const r = await runCheck("exit 3");
      expect(r.passed).toBe(false);
      expect(r.exitCode).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "stdout / stderr を捕捉する",
    async () => {
      const r = await runCheck("echo hello-out; echo hello-err 1>&2; exit 1");
      expect(r.stdoutTail).toContain("hello-out");
      expect(r.stderrTail).toContain("hello-err");
      expect(r.passed).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "timeout を超えると timedOut=true / exitCode=124",
    async () => {
      const r = await runCheck("sleep 5", { timeoutMs: 200 });
      expect(r.timedOut).toBe(true);
      expect(r.passed).toBe(false);
      expect(r.exitCode).toBe(124);
    },
    SPAWN_TIMEOUT_MS,
  );
});
