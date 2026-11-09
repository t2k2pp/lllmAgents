import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const INSTALL_SH_SRC = resolve(import.meta.dirname, "../../scripts/deploy-assets/install.sh");
const BUILD_DEPLOY_SRC = resolve(import.meta.dirname, "../../scripts/build-deploy.js");

describe("deploy install.sh", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("build-deploy.js は install.sh を sh ではなく bash で起動する", () => {
    const content = readFileSync(BUILD_DEPLOY_SRC, "utf8");
    expect(content).toContain('spawnSync("bash", [script]');
    expect(content).not.toContain('spawnSync("sh", [script]');
  });

  it.skipIf(process.platform === "win32")(
    "POSIX sh (/bin/sh) と bash のどちらで起動しても localllm・skills・agents を配置し更新日時を保つ",
    () => {
      for (const shell of ["sh", "bash"]) {
        const root = mkdtempSync(join(tmpdir(), `localllm-install-${shell}-`));
        tempDirs.push(root);

        const deployDir = join(root, "deploy");
        const homeDir = join(root, "home");
        mkdirSync(join(deployDir, "skills", "sample-skill"), { recursive: true });
        mkdirSync(join(deployDir, "agents"), { recursive: true });
        mkdirSync(homeDir, { recursive: true });

        const installScript = join(deployDir, "install.sh");
        writeFileSync(installScript, readFileSync(INSTALL_SH_SRC, "utf8"));
        chmodSync(installScript, 0o755);

        const exeSrc = join(deployDir, "localllm");
        writeFileSync(exeSrc, "#!/bin/sh\necho ok\n");
        chmodSync(exeSrc, 0o755);
        const fixedTime = new Date("2026-05-01T12:00:00Z");
        utimesSync(exeSrc, fixedTime, fixedTime);

        writeFileSync(join(deployDir, "skills", "sample-skill", "SKILL.md"), "# sample\n");
        writeFileSync(join(deployDir, "agents", "sample-agent.md"), "# agent\n");

        const res = spawnSync(shell, [installScript], {
          cwd: deployDir,
          env: { ...process.env, HOME: homeDir },
          encoding: "utf8",
        });

        expect(res.status, `${shell} stderr: ${res.stderr}`).toBe(0);

        const installedExe = join(homeDir, ".local", "bin", "localllm");
        const installedSkill = join(homeDir, ".localllm", "skills", "sample-skill", "SKILL.md");
        const installedAgent = join(homeDir, ".local", "bin", "agents", "sample-agent.md");

        expect(readFileSync(installedExe, "utf8")).toBe("#!/bin/sh\necho ok\n");
        expect(readFileSync(installedSkill, "utf8")).toBe("# sample\n");
        expect(readFileSync(installedAgent, "utf8")).toBe("# agent\n");

        // build-deploy.js の sameFile() が mtime 秒単位で同一版判定するため、cp -p で更新日時が保たれることを確認
        expect(Math.floor(statSync(installedExe).mtimeMs / 1000)).toBe(Math.floor(statSync(exeSrc).mtimeMs / 1000));
      }
    },
  );
});
