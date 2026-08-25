#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const resource = readFileSync(join(skillDir, "assets", "utf8-marker.txt"), "utf8").trim();
process.stdout.write(`${JSON.stringify({ skill: "demo-skill", utf8: "日本語OK", resource })}\n`);
