#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const allowedKeys = new Set(["name", "description", "license", "allowed-tools", "metadata"]);

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
  if (/\[TODO|TODO:/i.test(content)) fail(`${file}: 未完了TODOがあります`);
  if (!process.exitCode) console.log(`${file}: skill validation passed`);
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  fail("usage: node scripts/validate-skill.mjs <skill-dir> [...]");
} else {
  for (const dir of dirs) validateSkill(dir);
}
