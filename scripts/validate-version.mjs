#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { validateVersionState } from "./version-policy.js";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const tagArgIndex = process.argv.indexOf("--tag");
const argTag = tagArgIndex >= 0 ? process.argv[tagArgIndex + 1] : undefined;
const ciTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
const releaseTag = argTag ?? ciTag;
const errors = validateVersionState({
  packageVersion: pkg.version,
  lockVersion: lock.version,
  lockRootVersion: lock.packages?.[""]?.version,
  changelog,
  releaseTag,
});

if (errors.length > 0) {
  console.error("Version policy validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Version policy OK: public=${pkg.version}, build=git commit[-dirty], display=v${pkg.version} (build <commit>[-dirty])${
    releaseTag ? `, tag=${releaseTag}` : ""
  }`,
);
