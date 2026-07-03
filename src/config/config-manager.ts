import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Config, getDefaultConfig } from "./types.js";
import { isRoomId, type RoomConfig, type Surface, type RoomId } from "../agent/room-types.js";
import { writeFileAtomic, hardenFilePermissions } from "../utils/atomic-file.js";

const CONFIG_DIR = path.join(os.homedir(), ".localllm");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const CONFIG_BACKUP = CONFIG_FILE + ".bak";

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
  // 破損した config.json で起動不能にならないようにする (PR-02)。
  // 黙って既定値にせず、壊れたファイルの退避とバックアップからの復元をユーザーに告知する。
  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Partial<Config>;
  } catch {
    parsed = recoverFromBrokenConfig();
  }
  const defaults = getDefaultConfig();

  // ツール配列はデフォルト ∪ ユーザー設定 で合成する。
  // こうすることでコード側に追加されたデフォルトツールが既存 config.json でも有効になる。
  const mergeToolList = (defaultList: string[], savedList?: string[]): string[] => {
    if (!savedList) return defaultList;
    return [...new Set([...defaultList, ...savedList])];
  };

  const savedSecurity = parsed.security ?? ({} as Partial<Config["security"]>);
  return {
    ...defaults,
    ...parsed,
    security: {
      ...defaults.security,
      ...savedSecurity,
      autoApproveTools: mergeToolList(defaults.security.autoApproveTools, savedSecurity.autoApproveTools),
      requireApprovalTools: mergeToolList(defaults.security.requireApprovalTools, savedSecurity.requireApprovalTools),
      discordAutoApproveTools: mergeToolList(
        defaults.security.discordAutoApproveTools,
        savedSecurity.discordAutoApproveTools,
      ),
      slackAutoApproveTools: mergeToolList(
        defaults.security.slackAutoApproveTools,
        savedSecurity.slackAutoApproveTools,
      ),
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

/**
 * 壊れた config.json を .broken-<ts> に退避し、バックアップ (.bak) が読めれば
 * そこから復元する。どちらも告知する (silent な欠損の禁止)。
 */
function recoverFromBrokenConfig(): Partial<Config> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const brokenPath = `${CONFIG_FILE}.broken-${ts}`;
  try {
    fs.renameSync(CONFIG_FILE, brokenPath);
    console.error(`設定ファイルが壊れていたため退避しました: ${brokenPath}`);
  } catch {
    console.error(`設定ファイル (${CONFIG_FILE}) が壊れていますが、退避にも失敗しました。`);
  }
  if (fs.existsSync(CONFIG_BACKUP)) {
    try {
      const backup = JSON.parse(fs.readFileSync(CONFIG_BACKUP, "utf-8")) as Partial<Config>;
      console.error(`前回保存時のバックアップ (config.json.bak) から設定を復元しました。`);
      return backup;
    } catch {
      console.error(`バックアップ (config.json.bak) も壊れていました。`);
    }
  }
  console.error(`既定の設定で起動します。--setup で再設定してください。`);
  return {};
}

export function saveConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // 直前の正常版を1世代残してからアトミックに書き込む (PR-02)。
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fs.copyFileSync(CONFIG_FILE, CONFIG_BACKUP);
    } catch {
      /* バックアップ失敗は保存を止めない */
    }
  }
  writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
  // API キーやトークンを含むため自ユーザーのみ読めるようにする (PR-04)
  hardenFilePermissions(CONFIG_FILE);
  hardenFilePermissions(CONFIG_BACKUP);
}
