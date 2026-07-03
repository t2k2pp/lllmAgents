import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Config, getDefaultConfig } from "./types.js";
import type { RoomConfig, Surface, RoomId } from "../agent/room-types.js";
import { writeFileAtomic, hardenFilePermissions } from "../utils/atomic-file.js";
import { sanitizeParsedConfig } from "./config-schema.js";
import {
  splitSecrets,
  mergeCredentials,
  hasInlineSecrets,
  loadCredentialsFile,
  saveCredentialsFile,
  getCredentialsPath,
} from "./credentials.js";

const CONFIG_DIR = path.join(os.homedir(), ".localllm");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const CONFIG_BACKUP = CONFIG_FILE + ".bak";

// スキーマ検証の警告をプロセス内で1回だけ表示するためのフラグ (PR-03)
let schemaWarningsShown = false;
// 旧形式 (config.json 内シークレット) の分離マイグレーションを1回だけ行うフラグ (PR-04 方針2)
let credentialsMigrationDone = false;

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
  // シークレットは credentials.json から合流させる (PR-04 方針2)。
  // config.json 側に残っている旧形式のシークレットは後段のマイグレーションで分離する。
  const hadInlineSecrets = hasInlineSecrets(parsed);
  mergeCredentials(parsed as Record<string, unknown>, loadCredentialsFile());
  // 型の合わないフィールドをスキーマ検証で取り除き、どのキーがなぜ無効かを告知する (PR-03)。
  // loadConfig は起動後も繰り返し呼ばれるため、警告表示はプロセス内で1回だけにする。
  const validated = sanitizeParsedConfig(parsed);
  parsed = validated.config;
  if (!schemaWarningsShown && validated.warnings.length > 0) {
    schemaWarningsShown = true;
    for (const w of validated.warnings) console.error(w);
  }
  const defaults = getDefaultConfig();

  // ツール配列はデフォルト ∪ ユーザー設定 で合成する。
  // こうすることでコード側に追加されたデフォルトツールが既存 config.json でも有効になる。
  const mergeToolList = (defaultList: string[], savedList?: string[]): string[] => {
    if (!savedList) return defaultList;
    return [...new Set([...defaultList, ...savedList])];
  };

  const savedSecurity = parsed.security ?? ({} as Partial<Config["security"]>);
  const merged: Config = {
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
    roomConfig: mergeRoomConfig(defaults.roomConfig!, parsed.roomConfig),
  };

  // 旧形式マイグレーション: config.json にシークレットが残っていたら、この場で
  // 保存し直して credentials.json へ分離する (PR-04 方針2)。プロセス内1回だけ告知。
  if (hadInlineSecrets && !credentialsMigrationDone) {
    credentialsMigrationDone = true;
    saveConfig(merged);
    console.log(`config.json 内のシークレットを ${getCredentialsPath()} に分離しました。`);
    console.log(`config.json は共有・バックアップしても安全な内容になりました。`);
  }

  return merged;
}

/**
 * roomConfig を既定にマージする (キー欠損を全 Room 分そろえる)。
 * 不正値の検証 (旧 L-4 の手書きサニタイズ) は config-schema.ts の zod 検証に統合済みで、
 * ここに来る時点で bindings / autoResume の値は型保証されている (PR-03)。
 */
function mergeRoomConfig(defaults: RoomConfig, saved?: Partial<RoomConfig>): RoomConfig {
  const bindings = { ...defaults.bindings };
  for (const surface of Object.keys(bindings) as Surface[]) {
    const v = saved?.bindings?.[surface];
    if (v !== undefined) bindings[surface] = v;
  }
  const autoResume = { ...defaults.autoResume };
  for (const room of Object.keys(autoResume) as RoomId[]) {
    const v = saved?.autoResume?.[room];
    if (v !== undefined) autoResume[room] = v;
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
  // シークレットは credentials.json へ分離して書く (PR-04 方針2)。
  // config.json 側は共有・バックアップ可能な内容だけになる。
  const { sanitized, credentials } = splitSecrets(config);
  // 直前の正常版を1世代残してからアトミックに書き込む (PR-02)。
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fs.copyFileSync(CONFIG_FILE, CONFIG_BACKUP);
    } catch {
      /* バックアップ失敗は保存を止めない */
    }
  }
  writeFileAtomic(CONFIG_FILE, JSON.stringify(sanitized, null, 2));
  // 旧形式の .bak にはシークレットが残りうるため、権限は引き続き自ユーザーのみに絞る (PR-04)
  hardenFilePermissions(CONFIG_FILE);
  hardenFilePermissions(CONFIG_BACKUP);
  // トークンのクリアも永続化する必要があるため、空でも常に書く
  saveCredentialsFile(credentials);
}
