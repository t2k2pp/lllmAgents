import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Config, getDefaultConfig } from "./types.js";

const CONFIG_DIR = path.join(os.homedir(), ".localllm");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    return getDefaultConfig();
  }
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  const parsed = JSON.parse(raw) as Partial<Config>;
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    ...parsed,
    security: { ...defaults.security, ...parsed.security },
    context: { ...defaults.context, ...parsed.context },
  };
}

export function saveConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}
