// core.hooksPath を .githooks に向け、commit-msg / pre-commit フックを有効にする。設計書: docs/git-hooks.md
// npm install / npm ci の prepare からも呼ばれる。git 作業ツリーの外 (tarball 展開先など) では
// 設定先が無いため、そう表示して何もしない。表示は stderr に出す (npm pack --json の stdout を汚さないため)。
import { spawnSync } from "node:child_process";
import { gitExecutableCandidates } from "./git-revision.js";

for (const executable of gitExecutableCandidates()) {
  const inside = spawnSync(executable, ["rev-parse", "--is-inside-work-tree"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (inside.error?.code === "ENOENT") continue;
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    console.error("Git hooks not configured: not inside a git work tree");
    process.exit(0);
  }
  const result = spawnSync(executable, ["config", "core.hooksPath", ".githooks"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "failed to configure core.hooksPath");
  }
  console.error("Git hooks enabled: core.hooksPath=.githooks");
  process.exit(0);
}

throw new Error("git executable was not found");
