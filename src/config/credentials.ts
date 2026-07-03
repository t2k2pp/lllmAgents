/**
 * シークレットの credentials.json 分離 (docs/production-readiness.md PR-04 方針2)。
 *
 * API キー・Bot トークン・Webhook URL などのシークレットを config.json から
 * `~/.localllm/credentials.json` (自ユーザーのみ読み書き可) に分離する。
 * config.json は共有・バックアップしても安全な状態を保つ。
 *
 * 方式:
 * - credentials.json は Config と同じ形の部分オブジェクト (シークレットのパスのみ)。
 *   読み込み時にマージ、保存時に分離するので、呼び出し側は従来どおり
 *   config.mainLLM.apiKey 等を読み書きするだけでよい (config-manager に透過統合)
 * - config.json 側にシークレットが残っていた場合 (旧形式・手編集) は
 *   config.json の値を優先して読み、次回保存時に credentials.json へ移される
 * - imageGen.profiles 配列の apiKey は index で対応づける。両ファイルは常に
 *   同じ saveConfig で一緒に書かれるため index はずれない
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Config } from "./types.js";
import { writeFileAtomic, hardenFilePermissions } from "../utils/atomic-file.js";

const CREDENTIALS_FILE = path.join(os.homedir(), ".localllm", "credentials.json");

export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}

/**
 * シークレットとして扱う Config 内のパス。"*" は配列の全要素。
 * ここに追加したキーは自動的に credentials.json へ分離される。
 */
const SECRET_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ["mainLLM", "apiKey"],
  ["visionLLM", "apiKey"],
  ["secondLLM", "endpoint", "apiKey"],
  ["discord", "webhookUrl"],
  ["discord", "botToken"],
  ["slack", "webhookUrl"],
  ["slack", "botToken"],
  ["slack", "appToken"],
  ["imageGen", "profiles", "*", "apiKey"],
];

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** path ("*" 展開済みの具体パス) の値を取得。途中が object でなければ undefined */
function getAtPath(obj: unknown, keys: ReadonlyArray<string | number>): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** path の値を設定する。途中のオブジェクト/配列は作成する */
function setAtPath(obj: PlainObject, keys: ReadonlyArray<string | number>, value: unknown): void {
  let cur: Record<string | number, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const nextKey = keys[i + 1];
    if (cur[key] === null || typeof cur[key] !== "object") {
      cur[key] = typeof nextKey === "number" ? [] : {};
    }
    cur = cur[key] as Record<string | number, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

/** path の値を削除する (親が無ければ何もしない) */
function deleteAtPath(obj: unknown, keys: ReadonlyArray<string | number>): void {
  const parent = getAtPath(obj, keys.slice(0, -1));
  if (parent === null || typeof parent !== "object") return;
  delete (parent as PlainObject)[keys[keys.length - 1]];
}

/** SECRET_PATHS の "*" を config の実配列長で展開し、具体パスの一覧にする */
function expandSecretPaths(config: unknown): Array<Array<string | number>> {
  const result: Array<Array<string | number>> = [];
  for (const pattern of SECRET_PATHS) {
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) {
      result.push([...pattern]);
      continue;
    }
    const arr = getAtPath(config, pattern.slice(0, starIndex));
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      result.push([...pattern.slice(0, starIndex), i, ...pattern.slice(starIndex + 1)]);
    }
  }
  return result;
}

export interface SplitSecretsResult {
  /** シークレットを取り除いた config (config.json に書く側) */
  sanitized: Config;
  /** 取り出したシークレット (credentials.json に書く側)。無ければ空オブジェクト */
  credentials: PlainObject;
}

/**
 * config からシークレットを分離する。空文字・undefined は「未設定」なので
 * credentials 側には移さない (config.json 側からは常に取り除く)。
 */
export function splitSecrets(config: Config): SplitSecretsResult {
  const sanitized = structuredClone(config) as unknown as PlainObject;
  const credentials: PlainObject = {};
  for (const keys of expandSecretPaths(sanitized)) {
    const value = getAtPath(sanitized, keys);
    if (value === undefined) continue;
    deleteAtPath(sanitized, keys);
    if (typeof value === "string" && value.length > 0) {
      setAtPath(credentials, keys, value);
    }
  }
  return { sanitized: sanitized as unknown as Config, credentials };
}

/**
 * credentials.json の値を config にマージする。
 * config 側に非空の値が既にある場合はそちらを優先する
 * (旧形式や手編集で config.json に書かれたシークレットを尊重し、次回保存で分離する)。
 */
export function mergeCredentials(parsed: PlainObject, credentials: unknown): void {
  if (!isPlainObject(credentials)) return;
  for (const keys of expandSecretPaths(credentials)) {
    const secret = getAtPath(credentials, keys);
    if (typeof secret !== "string" || secret.length === 0) continue;
    const existing = getAtPath(parsed, keys);
    if (typeof existing === "string" && existing.length > 0) continue;
    // マージ先の親が存在しないシークレット (例: visionLLM 自体が null) は捨てる
    const parent = getAtPath(parsed, keys.slice(0, -1));
    if (parent === null || typeof parent !== "object") continue;
    setAtPath(parsed, keys, secret);
  }
}

/** config.json 由来のオブジェクトにシークレットが残っているか (旧形式の検出) */
export function hasInlineSecrets(parsed: unknown): boolean {
  for (const keys of expandSecretPaths(parsed)) {
    const value = getAtPath(parsed, keys);
    if (typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

/**
 * credentials.json を読む。壊れていた場合は .broken-<ts> に退避して告知し、
 * 無いものとして扱う (黙って握りつぶさない。次回保存で上書きしてしまうのを防ぐ)。
 */
export function loadCredentialsFile(filePath: string = CREDENTIALS_FILE): unknown {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const brokenPath = `${filePath}.broken-${ts}`;
    try {
      fs.renameSync(filePath, brokenPath);
      console.error(`credentials.json が壊れていたため退避しました: ${brokenPath}`);
      console.error(`API キーやトークンの再設定が必要な場合があります。`);
    } catch {
      console.error(`credentials.json (${filePath}) が壊れていますが、退避にも失敗しました。`);
    }
    return undefined;
  }
}

/** credentials.json をアトミックに書き、自ユーザーのみに権限を絞る */
export function saveCredentialsFile(credentials: PlainObject, filePath: string = CREDENTIALS_FILE): void {
  writeFileAtomic(filePath, JSON.stringify(credentials, null, 2));
  hardenFilePermissions(filePath);
}
