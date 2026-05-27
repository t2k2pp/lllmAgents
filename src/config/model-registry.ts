/**
 * Model Registry: LLM 接続のレジストリ + スロット割当の管理
 *
 * 設計書: docs/model-registry.md
 *
 * 役割:
 *  - 登録された全 LLM 接続を `~/.localllm/model-registry.json` に永続化
 *  - main / second slot (および将来の named slot) への割当を同ファイルに保持
 *  - 旧 `llm-profiles.json` (LLMProfile[]) からの透過的な移行 (1 リリースの間は併存)
 *
 * 旧 `src/config/llm-profiles.ts` の export API は同名 facade として本ファイルへ
 * 委譲される (`LLMProfile = LLMRegistryEntry`、 record/list/get/delete 等は名前を
 * そのまま温存)。 移行が落ち着いたら facade は撤去予定。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getConfigDir } from "./config-manager.js";
import type {
  Config,
  LLMEndpoint,
  LLMRegistryEntry,
  LLMSlotAssignments,
  ModelRegistryStore,
} from "./types.js";

// パスは遅延評価。 テストで getConfigDir() を mock したい場合に対応する。
function registryFile(): string {
  return path.join(getConfigDir(), "model-registry.json");
}
function legacyProfilesFile(): string {
  return path.join(getConfigDir(), "llm-profiles.json");
}

// ── ID 生成 ───────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID();
}

// ── Signature (重複判定用、 ID とは別軸) ──────────────────

/**
 * 接続情報のみから dedup 用 signature を作る。
 * サンプリングパラメータ・description は含めない (= 後から変えても同一エントリ扱い)。
 * apiKey は「ストレージモード+環境変数名」 のみ含める (暗号文/平文の値は含めない)。
 */
export function endpointSignature(ep: LLMEndpoint): string {
  const apiKeyKind = ep.apiKey
    ? ep.apiKey.startsWith("env:")
      ? `env:${ep.apiKey.slice(4)}`
      : ep.apiKey.startsWith("encrypted:")
        ? "encrypted"
        : "plain"
    : "";
  return [
    ep.providerType,
    ep.model ?? "",
    ep.baseUrl ?? "",
    ep.endpoint ?? "",
    ep.deploymentName ?? "",
    ep.projectId ?? "",
    ep.region ?? "",
    apiKeyKind,
  ].join("|");
}

/**
 * 自動生成エントリ名。 例:
 *   "anthropic:claude-sonnet-4-6"
 *   "ollama:qwen3-32b @ 192.168.1.33:11434"
 *   "azure-anthropic:claude-sonnet-4-5 @ my-resource.azure.com"
 *   "vertex-ai:claude-sonnet-4 @ my-project/us-east5"
 */
export function generateEntryName(ep: LLMEndpoint): string {
  const head = `${ep.providerType}:${ep.model || "(no-model)"}`;
  let loc = "";
  if (ep.baseUrl) {
    try {
      loc = new URL(ep.baseUrl).host;
    } catch {
      loc = ep.baseUrl;
    }
  } else if (ep.endpoint) {
    try {
      loc = new URL(ep.endpoint).host;
    } catch {
      loc = ep.endpoint;
    }
  } else if (ep.projectId || ep.region) {
    loc = [ep.projectId, ep.region].filter(Boolean).join("/");
  }
  return loc ? `${head} @ ${loc}` : head;
}

// ── Storage I/O ──────────────────────────────────────────

function emptyStore(): ModelRegistryStore {
  return { version: 1, entries: [], slots: { main: "" } };
}

function isValidEntry(p: unknown): p is LLMRegistryEntry {
  if (!p || typeof p !== "object") return false;
  const o = p as Partial<LLMRegistryEntry>;
  return typeof o.id === "string"
    && typeof o.name === "string"
    && !!o.endpoint
    && typeof o.endpoint === "object"
    && typeof (o.endpoint as LLMEndpoint).providerType === "string"
    && typeof o.createdAt === "string"
    && typeof o.lastUsedAt === "string";
}

/**
 * 旧 `llm-profiles.json` (LLMProfile[]) から ModelRegistryStore を構築する。
 * 旧 ID (8 文字 hex) はそのまま温存。 slot は空のままで返し、 後段の
 * `reconcileSlotsFromConfig` が config.mainLLM/secondLLM と突き合わせて確定させる。
 *
 * 旧ファイルは削除しない (rollback 用に温存)。
 */
function migrateFromLegacy(): ModelRegistryStore {
  try {
    const raw = fs.readFileSync(legacyProfilesFile(), "utf-8");
    const parsed = JSON.parse(raw) as { profiles?: unknown };
    if (!parsed.profiles || !Array.isArray(parsed.profiles)) return emptyStore();
    const entries = (parsed.profiles as unknown[]).filter(isValidEntry);
    return { version: 1, entries, slots: { main: "" } };
  } catch {
    return emptyStore();
  }
}

function readStore(): ModelRegistryStore {
  if (!fs.existsSync(registryFile()) && fs.existsSync(legacyProfilesFile())) {
    const migrated = migrateFromLegacy();
    writeStore(migrated);
    return migrated;
  }
  if (!fs.existsSync(registryFile())) return emptyStore();
  try {
    const raw = fs.readFileSync(registryFile(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ModelRegistryStore>;
    const entries = Array.isArray(parsed.entries)
      ? (parsed.entries as unknown[]).filter(isValidEntry)
      : [];
    const slots: LLMSlotAssignments = parsed.slots && typeof parsed.slots === "object"
      ? {
          main: typeof parsed.slots.main === "string" ? parsed.slots.main : "",
          second: typeof parsed.slots.second === "string" ? parsed.slots.second : undefined,
          named: parsed.slots.named && typeof parsed.slots.named === "object"
            ? { ...parsed.slots.named as Record<string, string> }
            : undefined,
        }
      : { main: "" };
    return { version: 1, entries, slots };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: ModelRegistryStore): void {
  const dir = path.dirname(registryFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify(store, null, 2), "utf-8");
}

// ── Entry CRUD ───────────────────────────────────────────

/** lastUsedAt 降順で全エントリを返す。 */
export function listEntries(): LLMRegistryEntry[] {
  return [...readStore().entries].sort(
    (a, b) => (b.lastUsedAt > a.lastUsedAt ? 1 : b.lastUsedAt < a.lastUsedAt ? -1 : 0),
  );
}

export function getEntry(id: string): LLMRegistryEntry | undefined {
  return readStore().entries.find((e) => e.id === id);
}

export function findEntryBySignature(ep: LLMEndpoint): LLMRegistryEntry | undefined {
  const sig = endpointSignature(ep);
  return readStore().entries.find((e) => endpointSignature(e.endpoint) === sig);
}

/**
 * 接続情報を registry に記録する。
 *  - signature 一致の既存があれば endpoint を最新値で上書き + lastUsedAt 更新
 *  - 無ければ新規 UUID で追加
 *  - 不完全な endpoint (providerType / model 空) は記録しない (undefined を返す)
 *
 * @param options.forceNew true なら signature 一致を無視して新規エントリを作る (Duplicate 用、 /models から呼ぶ)
 */
export function recordEntry(
  endpoint: LLMEndpoint,
  options: { forceNew?: boolean } = {},
): LLMRegistryEntry | undefined {
  if (!endpoint || !endpoint.providerType || !endpoint.model) return undefined;

  const store = readStore();
  const now = new Date().toISOString();
  const autoName = generateEntryName(endpoint);

  if (!options.forceNew) {
    const sig = endpointSignature(endpoint);
    const existing = store.entries.find((e) => endpointSignature(e.endpoint) === sig);
    if (existing) {
      existing.endpoint = endpoint;
      existing.lastUsedAt = now;
      // user が改名していなければ自動名で追従、 改名済みなら触らない
      if (existing.name === generateEntryName(existing.endpoint) || existing.name === autoName) {
        existing.name = autoName;
      }
      writeStore(store);
      return existing;
    }
  }

  const created: LLMRegistryEntry = {
    id: newId(),
    name: autoName,
    endpoint,
    createdAt: now,
    lastUsedAt: now,
  };
  store.entries.push(created);
  writeStore(store);
  return created;
}

/** エントリの一部フィールドを更新。 id / createdAt は変更不可。 */
export function updateEntry(
  id: string,
  patch: Partial<Pick<LLMRegistryEntry, "name" | "endpoint" | "tags">>,
): LLMRegistryEntry | undefined {
  const store = readStore();
  const entry = store.entries.find((e) => e.id === id);
  if (!entry) return undefined;
  if (patch.name !== undefined) entry.name = patch.name;
  if (patch.endpoint !== undefined) entry.endpoint = patch.endpoint;
  if (patch.tags !== undefined) entry.tags = patch.tags;
  entry.lastUsedAt = new Date().toISOString();
  writeStore(store);
  return entry;
}

export function deleteEntry(id: string): boolean {
  const store = readStore();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.id !== id);
  if (store.entries.length === before) return false;
  // slot が指していた場合は解除
  if (store.slots.main === id) store.slots.main = "";
  if (store.slots.second === id) delete store.slots.second;
  if (store.slots.named) {
    for (const [k, v] of Object.entries(store.slots.named)) {
      if (v === id) delete store.slots.named[k];
    }
  }
  writeStore(store);
  return true;
}

export function deleteEntries(ids: string[]): number {
  if (ids.length === 0) return 0;
  const store = readStore();
  const targets = new Set(ids);
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => !targets.has(e.id));
  const removed = before - store.entries.length;
  if (removed === 0) return 0;
  if (targets.has(store.slots.main)) store.slots.main = "";
  if (store.slots.second && targets.has(store.slots.second)) delete store.slots.second;
  if (store.slots.named) {
    for (const [k, v] of Object.entries(store.slots.named)) {
      if (targets.has(v)) delete store.slots.named[k];
    }
  }
  writeStore(store);
  return removed;
}

/** lastUsedAt のみ更新する (再利用したことをマーク)。 */
export function touchEntry(id: string): void {
  const store = readStore();
  const entry = store.entries.find((e) => e.id === id);
  if (!entry) return;
  entry.lastUsedAt = new Date().toISOString();
  writeStore(store);
}

// ── Slot operations ──────────────────────────────────────

export function getSlots(): LLMSlotAssignments {
  return readStore().slots;
}

export function getSlot(slot: "main" | "second" | string): string | undefined {
  const slots = readStore().slots;
  if (slot === "main") return slots.main || undefined;
  if (slot === "second") return slots.second;
  return slots.named?.[slot];
}

/**
 * slot に entry を割り当てる。 entry が存在しない id を指定された場合は何もしない。
 */
export function setSlot(slot: "main" | "second" | string, entryId: string): boolean {
  const store = readStore();
  if (!store.entries.find((e) => e.id === entryId)) return false;
  if (slot === "main") {
    store.slots.main = entryId;
  } else if (slot === "second") {
    store.slots.second = entryId;
  } else {
    store.slots.named ??= {};
    store.slots.named[slot] = entryId;
  }
  writeStore(store);
  return true;
}

export function clearSlot(slot: "main" | "second" | string): void {
  const store = readStore();
  if (slot === "main") {
    store.slots.main = "";
  } else if (slot === "second") {
    delete store.slots.second;
  } else if (store.slots.named) {
    delete store.slots.named[slot];
  }
  writeStore(store);
}

/**
 * main ⇔ second slot を入れ替える。 second が未割当なら何もしない (現 /swap 挙動を踏襲)。
 * entry そのものは変更しない (slot 参照だけ書き換え)。
 */
export function swapMainSecond(): boolean {
  const store = readStore();
  const m = store.slots.main;
  const s = store.slots.second;
  if (!s || !m) return false;
  store.slots.main = s;
  store.slots.second = m;
  writeStore(store);
  return true;
}

/**
 * config.mainLLM / config.secondLLM.endpoint を registry に整合させる。
 * 起動時 (config 読み込み直後) に呼ぶ:
 *  - signature 一致する entry が無ければ新規追加
 *  - slots.main / slots.second を該当エントリに揃える
 *
 * これにより旧 config.json から新 registry への透過移行が成立する。
 */
export function reconcileSlotsFromConfig(config: Config): void {
  const store = readStore();
  const now = new Date().toISOString();

  const ensureEntry = (ep: LLMEndpoint | undefined): string | undefined => {
    if (!ep || !ep.providerType || !ep.model) return undefined;
    const sig = endpointSignature(ep);
    const existing = store.entries.find((e) => endpointSignature(e.endpoint) === sig);
    if (existing) {
      existing.endpoint = ep;
      existing.lastUsedAt = now;
      return existing.id;
    }
    const created: LLMRegistryEntry = {
      id: newId(),
      name: generateEntryName(ep),
      endpoint: ep,
      createdAt: now,
      lastUsedAt: now,
    };
    store.entries.push(created);
    return created.id;
  };

  const mainId = ensureEntry(config.mainLLM);
  if (mainId) store.slots.main = mainId;

  const secondId = ensureEntry(config.secondLLM?.endpoint);
  if (secondId) {
    store.slots.second = secondId;
  } else if (!config.secondLLM?.enabled) {
    // secondLLM が無効化されている場合は slot を解除
    delete store.slots.second;
  }

  writeStore(store);
}

// ── テスト用 ── (本番コードからは使わない)
/** @internal — tests のみ。 ファイルパスを返す (getConfigDir() に依存するため遅延評価) */
export function _registryFilePath(): string {
  return registryFile();
}
/** @internal — tests のみ。 legacy ファイルパスを返す */
export function _legacyProfilesFilePath(): string {
  return legacyProfilesFile();
}
