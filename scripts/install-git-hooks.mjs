import { spawnSync } from "node:child_process";
import { gitExecutableCandidates } from "./git-revision.js";

for (const executable of gitExecutableCandidates()) {
  const result = spawnSync(executable, ["config", "core.hooksPath", ".githooks"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") continue;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "failed to configure core.hooksPath");
  }
  console.log("Git hooks enabled: core.hooksPath=.githooks");
  process.exit(0);
}

throw new Error("git executable was not found");
