import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { buildBwrapArgs } from "../../src/security/process-sandbox.js";

/**
 * Linux: buildBwrapArgs が生成した引数で bwrap が実際に起動し、 FS 書込隔離が効くかを
 * 実ランタイムで検証する（引き継ぎレビュー: 「緑が macOS ローカルだけ」対策）。
 *
 * bwrap がある環境（Linux/WSL2・CI の Linux runner）でのみ実行。macOS では skip。
 * ※ socat ブリッジ/ネット allowlist(2b-2) の検証は別途 WSL2 実機が必要（ここでは FS 隔離のみ）。
 */
const BWRAP = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find((p) => existsSync(p));
const canRun = process.platform === "linux" && !!BWRAP;

function runUnderBwrap(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(BWRAP!, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8000,
    });
    return { ok: true, out };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe.skipIf(!canRun)("bwrap FS 隔離（Linux 実ランタイム・integration）", () => {
  it("生成引数で bwrap が起動し基本コマンドが動く", () => {
    const args = buildBwrapArgs("echo ok", [], /* unshareNet */ false, []);
    const r = runUnderBwrap(args);
    expect(r.ok).toBe(true);
    expect(r.out.trim()).toBe("ok");
  });

  it("書込は writeDir 内のみ・外(HOME 直下)は拒否される", () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "lllm-bwrap-")));
    const outside = join(homedir(), "lllm-bwrap-should-not-write");
    try {
      const args = buildBwrapArgs(
        `echo x > '${work}/ok' && echo WROTE_IN; echo y > '${outside}' && echo WROTE_OUT || echo BLOCKED_OUT`,
        [work],
        false,
        [],
      );
      const r = runUnderBwrap(args);
      expect(r.out).toContain("WROTE_IN"); // writeDir 内は書ける
      expect(r.out).toContain("BLOCKED_OUT"); // ro-bind の root 配下は書けない
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  it("maskDirs は空 tmpfs で覆われ中身が読めない", () => {
    const secret = realpathSync(mkdtempSync(join(tmpdir(), "lllm-bwrap-secret-")));
    writeFileSync(join(secret, "key"), "REALSECRET", "utf-8");
    try {
      const args = buildBwrapArgs(`cat '${secret}/key' 2>&1 || echo MASKED`, [], false, [secret]);
      const r = runUnderBwrap(args);
      expect(r.out).not.toContain("REALSECRET"); // tmpfs マスクで空
    } finally {
      rmSync(secret, { recursive: true, force: true });
    }
  });
});
