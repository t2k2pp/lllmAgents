import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Config, getDefaultConfig } from "./types.js";
import { isRoomId, type RoomConfig, type Surface, type RoomId } from "../agent/room-types.js";

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

  // ツール配列はデフォルト ∪ ユーザー設定 で合成する。
  // こうすることでコード側に追加されたデフォルトツールが既存 config.json でも有効になる。
  const mergeToolList = (defaultList: string[], savedList?: string[]): string[] => {
    if (!savedList) return defaultList;
    return [...new Set([...defaultList, ...savedList])];
  };

  const savedSecurity = parsed.security ?? {} as Partial<Config["security"]>;
  return {
    ...defaults,
    ...parsed,
    security: {
      ...defaults.security,
      ...savedSecurity,
      autoApproveTools: mergeToolList(defaults.security.autoApproveTools, savedSecurity.autoApproveTools),
      requireApprovalTools: mergeToolList(defaults.security.requireApprovalTools, savedSecurity.requireApprovalTools),
      discordAutoApproveTools: mergeToolList(defaults.security.discordAutoApproveTools, savedSecurity.discordAutoApproveTools),
      slackAutoApproveTools: mergeToolList(defaults.security.slackAutoApproveTools, savedSecurity.slackAutoApproveTools),
    },
    context: { ...defaults.context, ...parsed.context },
    discord: { ...(defaults.discord ?? { enabled: false, webhookUrl: "" }), ...parsed.discord },
    slack: { ...(defaults.slack ?? { enabled: false, webhookUrl: "" }), ...parsed.slack },
    // Room 設定は bindings / autoResume を個別にマージし、 手編集や旧 config での
    // キー欠損 (例: autoResume だけ無い) でも全 Room 分そろうようにする。
    // L-4: 手編集による不正値 (例 bindings.discord:"X", autoResume.B:"yes") は isRoomId /
    // boolean で検証し、 不正なら既定へフォールバックする (下流の bindingFor 等が壊れないように)。
    roomConfig: mergeRoomConfig(defaults.roomConfig!, parsed.roomConfig),
  };
}

/** roomConfig を既定にマージしつつ不正値をサニタイズする (L-4)。 */
function mergeRoomConfig(defaults: RoomConfig, saved?: Partial<RoomConfig>): RoomConfig {
  const bindings = { ...defaults.bindings };
  for (const surface of Object.keys(bindings) as Surface[]) {
    const v = saved?.bindings?.[surface];
    if (isRoomId(v)) bindings[surface] = v;
  }
  const autoResume = { ...defaults.autoResume };
  for (const room of Object.keys(autoResume) as RoomId[]) {
    const v = saved?.autoResume?.[room];
    if (typeof v === "boolean") autoResume[room] = v;
  }
  return { bindings, autoResume };
}

export function saveConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}
