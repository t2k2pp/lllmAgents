#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const allowedKeys = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "trigger",
  "context",
  "tools",
  "disable-model-invocation",
]);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function validateSkill(dir) {
  const file = join(resolve(dir), "SKILL.md");
  let content;
  try {
    const bytes = readFileSync(file);
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`${file}: UTF-8 SKILL.mdを読めません: ${error}`);
    return;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) {
    fail(`${file}: YAML frontmatterがありません`);
    return;
  }
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].replace(/^['"]|['"]$/g, "").trim());
  }
  for (const key of fields.keys()) {
    if (!allowedKeys.has(key)) fail(`${file}: 未対応frontmatter key: ${key}`);
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) fail(`${file}: nameが不正です: ${name}`);
  if (name !== basename(resolve(dir))) fail(`${file}: nameとディレクトリ名が一致しません`);
  if (!description || description.length > 1024) fail(`${file}: descriptionが空または長すぎます`);
  const trigger = fields.get("trigger");
  if (trigger && !/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trigger)) fail(`${file}: triggerが不正です: ${trigger}`);
  const context = fields.get("context");
  if (context && context !== "fork") fail(`${file}: contextはforkだけを指定できます: ${context}`);
  const disableModelInvocation = fields.get("disable-model-invocation");
  if (fields.has("disable-model-invocation") && !["true", "false"].includes(disableModelInvocation)) {
    fail(`${file}: disable-model-invocationはtrueまたはfalseだけを指定できます: ${disableModelInvocation}`);
  }
  for (const key of ["tools", "allowed-tools"]) {
    const raw = fields.get(key);
    if (!raw) continue;
    const tools = raw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
    if (tools.length === 0 || tools.some((tool) => !/^[a-zA-Z0-9_-]+$/.test(tool))) {
      fail(`${file}: ${key}が不正です: ${raw}`);
    }
  }
  const hasPlaceholder = content.split(/\r?\n/).some((line) => /^\s*(?:[-*]\s*)?\[TODO|^\s*TODO:/i.test(line));
  if (hasPlaceholder) fail(`${file}: 未完了TODOがあります`);
  if (!process.exitCode) console.log(`${file}: skill validation passed`);
}

function skillDirsUnder(root) {
  const absolute = resolve(root);
  try {
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(absolute, entry.name));
  } catch (error) {
    fail(`${absolute}: skill rootを読めません: ${error}`);
    return [];
  }
}

const args = process.argv.slice(2);
const dirs = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] !== "--root") {
    dirs.push(args[index]);
    continue;
  }
  const root = args[++index];
  if (!root) {
    fail("--rootにはskill root directoryが必要です");
    continue;
  }
  dirs.push(...skillDirsUnder(root));
}
if (dirs.length === 0) {
  fail("usage: node scripts/validate-skill.mjs <skill-dir> [...] [--root <skills-root>]");
} else {
  for (const dir of dirs) validateSkill(dir);
}
