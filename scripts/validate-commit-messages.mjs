import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gitExecutableCandidates } from "./git-revision.js";
import { validateCommitMessage } from "./commit-message-policy.js";

function runGit(args) {
  for (const executable of gitExecutableCandidates()) {
    const result = spawnSync(executable, args, { encoding: "utf8" });
    if (result.error?.code === "ENOENT") continue;
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
    }
    return result.stdout.trim();
  }
  throw new Error("git executable was not found");
}

function validateOne(label, message) {
  const errors = validateCommitMessage(message);
  if (errors.length === 0) {
    console.log(`commit message passed: ${label}`);
    return true;
  }
  console.error(`commit message failed: ${label}`);
  for (const error of errors) console.error(`  - ${error}`);
  return false;
}

const args = process.argv.slice(2);
let valid = true;

if (args[0] === "--range") {
  const [, before, after] = args;
  if (!before || !after) throw new Error("usage: --range <before> <after>");
  const commits = runGit(["rev-list", "--reverse", `${before}..${after}`])
    .split("\n")
    .filter(Boolean);
  if (commits.length === 0) throw new Error(`no commits found in ${before}..${after}`);
  for (const commit of commits) {
    valid = validateOne(commit, runGit(["show", "-s", "--format=%B", commit])) && valid;
  }
} else {
  const messageFile = args[0];
  if (!messageFile) throw new Error("usage: <message-file> or --range <before> <after>");
  valid = validateOne(messageFile, readFileSync(messageFile, "utf8"));
}

if (!valid) process.exit(1);
