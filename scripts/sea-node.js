import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** Candidate自身へ問い合わせ、曖昧なundefinedをSEA対応として扱わない。 */
export function isSeaCapableNode(candidate, dependencies = {}) {
  const exists = dependencies.exists ?? fs.existsSync;
  const execFile = dependencies.execFile ?? execFileSync;
  if (!candidate || !exists(candidate)) return false;
  try {
    return (
      execFile(candidate, ["-p", "process.config.variables.single_executable_application === true"], {
        encoding: "utf8",
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

export function selectSeaNode({ requested, current, fallbackCandidates = [], isCapable = isSeaCapableNode }) {
  if (requested) {
    if (!isCapable(requested)) {
      throw new Error(
        `NODE_EXE is not an existing SEA-capable Node binary: ${requested}. ` +
          "Set NODE_EXE to an official SEA-enabled Node executable or unset it.",
      );
    }
    return requested;
  }

  const candidates = [...new Set([current, ...fallbackCandidates].filter(Boolean))];
  const selected = candidates.find(isCapable);
  if (!selected) {
    throw new Error(
      `No SEA-capable Node binary was found. Checked: ${candidates.join(", ")}. ` +
        "Install an official Node build with single_executable_application support or set NODE_EXE explicitly.",
    );
  }
  return selected;
}
