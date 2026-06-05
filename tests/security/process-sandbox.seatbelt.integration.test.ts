import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// macOS の /tmp→/private/tmp, /var→/private/var symlink を解決した実パスを使う。
// Seatbelt は正規化後パスで照合するため、ルール文字列も正規化しておかないと一致しない
// （= writeDir/denyDir に symlink を渡すと封じ込めが効かない、という実コードの注意点でもある）。
function mkRealTemp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
import { buildSeatbeltProfile } from "../../src/security/process-sandbox.js";

/**
 * Seatbelt プロファイルを「文字列一致」でなく **実際に sandbox-exec へロードして**検証する統合テスト。
 *
 * 背景: `(remote ip "127.0.0.1:port")` は文字列上は妥当に見えるが macOS の sandbox-exec は
 * ホストに数値IPを受け付けず exit 65 でプロファイルをロードせず全滅する。ユニットの toContain
 * だけでは捕まらなかった（docs/wsl-sandbox-design.md §7.1 実機検証で発覚）。本テストは生成物が
 * 本当に sandbox-d に受理されるか・FS 書込封じ込めが効くかを実機で確認し、回帰を防ぐ。
 *
 * darwin かつ /usr/bin/sandbox-exec がある環境でのみ実行（他 OS / CI ではスキップ）。
 */
const SBX = "/usr/bin/sandbox-exec";
const canRun = process.platform === "darwin" && existsSync(SBX);

/** プロファイルをファイル化して sandbox-exec 下でコマンド実行。{ ok, out } を返す。 */
function runUnderProfile(profile: string, command: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "lllm-sbtest-"));
  const pf = join(dir, "p.sb");
  writeFileSync(pf, profile, "utf-8");
  try {
    const out = execFileSync(SBX, ["-f", pf, "/bin/sh", "-c", command], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8000,
    });
    return { ok: true, out };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: (err.stdout ?? "") + (err.stderr ?? "") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!canRun)("Seatbelt profile loads into sandbox-exec (integration)", () => {
  it("fs + proxyPort のプロファイルがロードでき基本コマンドが動く (127.0.0.1 数値IPだとここで exit65)", () => {
    const profile = buildSeatbeltProfile(["/private/tmp/work"], "fs", [], 54999);
    const r = runUnderProfile(profile, "echo ok");
    expect(r.ok).toBe(true);
    expect(r.out.trim()).toBe("ok");
  });

  it("fs(proxyなし) / network / full もすべてロードできる", () => {
    for (const profile of [
      buildSeatbeltProfile(["/private/tmp/work"], "fs"),
      buildSeatbeltProfile(["/private/tmp/work"], "network"),
      buildSeatbeltProfile(["/private/tmp/work"], "full"),
    ]) {
      const r = runUnderProfile(profile, "echo ok");
      expect(r.ok).toBe(true);
    }
  });

  it("書込は writeDir 内のみ許可・外は Operation not permitted", () => {
    const work = mkRealTemp("lllm-work-");
    const outsidePath = join(homedir(), "lllm-should-not-write-test");
    try {
      const profile = buildSeatbeltProfile([work], "fs", [], 54999);
      const inside = runUnderProfile(profile, `echo x > '${work}/ok' && echo WROTE`);
      expect(inside.ok).toBe(true);
      expect(inside.out).toContain("WROTE");

      // writeDir 外（HOME 直下・実パス）への書込は拒否される
      const outside = runUnderProfile(profile, `echo x > '${outsidePath}' && echo WROTE || echo BLOCKED`);
      expect(outside.out).toContain("BLOCKED");
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(outsidePath, { force: true });
    }
  });

  it("denyReadDirs に渡した機密ディレクトリ(実パス)は読めない", () => {
    const secret = mkRealTemp("lllm-secret-");
    const work = mkRealTemp("lllm-work-");
    writeFileSync(join(secret, "key"), "REALSECRET", "utf-8");
    try {
      const profile = buildSeatbeltProfile([work], "fs", [secret], 54999);
      const r = runUnderProfile(profile, `cat '${secret}/key'`);
      expect(r.out).not.toContain("REALSECRET");
      expect(r.out).toContain("Operation not permitted");
    } finally {
      rmSync(secret, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("allowReadDirs で skills だけ読取を戻す（~/.localllm 親は遮断・skills は許可。 R-3）", () => {
    const appDir = mkRealTemp("lllm-app-");
    const work = mkRealTemp("lllm-work-");
    writeFileSync(join(appDir, "config.json"), "APIKEY-SECRET", "utf-8");
    const skillsDir = join(appDir, "skills");
    mkdirSync(skillsDir);
    writeFileSync(join(skillsDir, "s.txt"), "SKILLDATA", "utf-8");
    try {
      // ~/.localllm 相当を deny、 skills を allow-back
      const profile = buildSeatbeltProfile([work], "fs", [appDir], 54999, [skillsDir]);
      // 親(config.json=APIキー)は読めない
      const rSecret = runUnderProfile(profile, `cat '${appDir}/config.json'`);
      expect(rSecret.out).not.toContain("APIKEY-SECRET");
      expect(rSecret.out).toContain("Operation not permitted");
      // skills 配下は読める（allow-back が last-match-wins で効く）
      const rSkill = runUnderProfile(profile, `cat '${skillsDir}/s.txt'`);
      expect(rSkill.out).toContain("SKILLDATA");
    } finally {
      rmSync(appDir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
