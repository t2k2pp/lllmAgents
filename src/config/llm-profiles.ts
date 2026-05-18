/**
 * LLM 接続プロファイルの履歴管理。
 *
 * メイン/セカンド LLM の endpoint 設定を `~/.localllm/llm-profiles.json` に
 * 永続化し、 REPL から一覧表示・選択・削除できるようにする。
 *
 * 設計方針 (docs/llm-profiles.md):
 *  - applyMainLLMEndpoint / applySecondLLMEndpoint の直後に recordLLMProfile を呼ぶ
 *    (= ユーザは「保存」 操作を意識せず、 実際に動いた設定だけが履歴に残る)
 *  - 重複判定は **接続情報のみ** (providerType + model + baseUrl/endpoint + deploymentName + projectId+region)。
 *    サンプリングパラメータ (temperature 等) や description は最新値で上書き
 *  - プロファイル名は自動生成のみ。 ユーザによるリネームは現状サポートしない
 *  - apiKey は config.json と同じ表現 (env:VAR / encrypted:... / 平文) でそのまま保存
 *    → 履歴から復元するときも CredentialVault で同じパスフレーズで復号できる
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigDir } from "./config-manager.js";
import type { LLMEndpoint } from "./types.js";

const PROFILES_FILE = path.join(getConfigDir(), "llm-profiles.json");

export interface LLMProfile {
  /** 接続情報の signature ハッシュ。 同一 signature は merge される */
  id: string;
  /** 自動生成された表示名 (例: "anthropic:claude-sonnet-4-6", "ollama:qwen3-32b @ 192.168.1.33:11434") */
  name: string;
  /** 復元する endpoint。 mainLLM/secondLLM どちらにも書き戻せる形 */
  endpoint: LLMEndpoint;
  /** 初回登録時刻 (ISO 8601) */
  createdAt: string;
  /** 最終利用時刻 (ISO 8601)。 並び順のキー */
  lastUsedAt: string;
}

interface ProfileStore {
  profiles: LLMProfile[];
}

// ── ストレージ I/O ────────────────────────────────────────

function readStore(): ProfileStore {
  if (!fs.existsSync(PROFILES_FILE)) return { profiles: [] };
  try {
    const raw = fs.readFileSync(PROFILES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProfileStore>;
    if (!parsed.profiles || !Array.isArray(parsed.profiles)) return { profiles: [] };
    return { profiles: parsed.profiles.filter(isValidProfile) };
  } catch {
    // 壊れたファイルは黙って空とみなす (バックアップは作らない — ユーザ作業の邪魔)
    return { profiles: [] };
  }
}

function writeStore(store: ProfileStore): void {
  const dir = path.dirname(PROFILES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(store, null, 2), "utf-8");
}

function isValidProfile(p: unknown): p is LLMProfile {
  if (!p || typeof p !== "object") return false;
  const o = p as Partial<LLMProfile>;
  return typeof o.id === "string"
    && typeof o.name === "string"
    && !!o.endpoint
    && typeof o.endpoint === "object"
    && typeof (o.endpoint as LLMEndpoint).providerType === "string"
    && typeof o.createdAt === "string"
    && typeof o.lastUsedAt === "string";
}

// ── signature / 名前生成 ──────────────────────────────────

/**
 * 接続情報のみから dedup 用 signature を作る。
 * サンプリングパラメータ (temperature 等) や description は含めない (= 後から変えても同一プロファイル扱い)。
 * apiKey も含めない (= env:VAR と平文を同じプロファイルとは扱わないが、 同じ env 名なら merge する)。
 *  → 厳密に分けたいケースもあるので、 apiKey は signature に「ストレージモード+値の先頭」 だけ含める。
 */
export function endpointSignature(ep: LLMEndpoint): string {
  const apiKeyKind = ep.apiKey
    ? ep.apiKey.startsWith("env:")
      ? `env:${ep.apiKey.slice(4)}`           // 環境変数名は signature に含める
      : ep.apiKey.startsWith("encrypted:")
        ? "encrypted"                          // 暗号化済みは値は無視 (同じ apiKey でも salt 変わると別文字列のため)
        : "plain"
    : "";
  const parts = [
    ep.providerType,
    ep.model ?? "",
    ep.baseUrl ?? "",
    ep.endpoint ?? "",
    ep.deploymentName ?? "",
    ep.projectId ?? "",
    ep.region ?? "",
    apiKeyKind,
  ];
  return parts.join("|");
}

/** signature を短い hex (8 文字) に圧縮した ID */
function makeId(ep: LLMEndpoint): string {
  const sig = endpointSignature(ep);
  // 軽量な非暗号 hash (FNV-1a 32bit) で十分。 衝突確率は実用上問題なし
  let h = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 自動生成プロファイル名。
 * 例:
 *   "anthropic:claude-sonnet-4-6"
 *   "claude-cli:claude-haiku-4-5"
 *   "ollama:qwen3-32b @ 192.168.1.33:11434"
 *   "azure-anthropic:claude-sonnet-4-5 @ my-resource.azure.com"
 *   "vertex-ai:claude-sonnet-4 @ my-project/us-east5"
 */
export function generateProfileName(ep: LLMEndpoint): string {
  const head = `${ep.providerType}:${ep.model || "(no-model)"}`;
  // location: baseUrl の host:port、 endpoint の host、 vertex の project/region、 cli は省略
  let loc = "";
  if (ep.baseUrl) {
    try {
      const u = new URL(ep.baseUrl);
      loc = u.host;
    } catch {
      loc = ep.baseUrl;
    }
  } else if (ep.endpoint) {
    try {
      const u = new URL(ep.endpoint);
      loc = u.host;
    } catch {
      loc = ep.endpoint;
    }
  } else if (ep.projectId || ep.region) {
    loc = [ep.projectId, ep.region].filter(Boolean).join("/");
  }
  return loc ? `${head} @ ${loc}` : head;
}

// ── 公開 API ──────────────────────────────────────────────

export function listLLMProfiles(): LLMProfile[] {
  const store = readStore();
  // 最終使用が新しい順
  return [...store.profiles].sort(
    (a, b) => (b.lastUsedAt > a.lastUsedAt ? 1 : b.lastUsedAt < a.lastUsedAt ? -1 : 0),
  );
}

export function getLLMProfile(id: string): LLMProfile | undefined {
  return readStore().profiles.find((p) => p.id === id);
}

export function findProfileBySignature(ep: LLMEndpoint): LLMProfile | undefined {
  const id = makeId(ep);
  return getLLMProfile(id);
}

/**
 * 設定を履歴に記録する (auto-merge)。
 *  - 同一 signature の既存があれば endpoint を最新値で上書き + lastUsedAt 更新
 *  - 無ければ新規追加
 * 戻り値は記録後のプロファイル。
 *
 * 不完全な endpoint (model 空 等) は記録しない。
 */
export function recordLLMProfile(endpoint: LLMEndpoint): LLMProfile | undefined {
  if (!endpoint || !endpoint.providerType || !endpoint.model) return undefined;

  const store = readStore();
  const id = makeId(endpoint);
  const now = new Date().toISOString();
  const name = generateProfileName(endpoint);

  const existing = store.profiles.find((p) => p.id === id);
  if (existing) {
    existing.endpoint = endpoint;
    existing.lastUsedAt = now;
    existing.name = name; // model alias 変更等で表示名が変わるケースに追随
    writeStore(store);
    return existing;
  }

  const created: LLMProfile = {
    id,
    name,
    endpoint,
    createdAt: now,
    lastUsedAt: now,
  };
  store.profiles.push(created);
  writeStore(store);
  return created;
}

/** プロファイルを 1 件削除。 削除成功なら true */
export function deleteLLMProfile(id: string): boolean {
  const store = readStore();
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.profiles.length === before) return false;
  writeStore(store);
  return true;
}

/** 複数削除。 削除件数を返す */
export function deleteLLMProfiles(ids: string[]): number {
  const store = readStore();
  const before = store.profiles.length;
  const targets = new Set(ids);
  store.profiles = store.profiles.filter((p) => !targets.has(p.id));
  const removed = before - store.profiles.length;
  if (removed > 0) writeStore(store);
  return removed;
}

/** 履歴使用時に lastUsedAt だけ更新する (再利用したことをマーク) */
export function touchProfile(id: string): void {
  const store = readStore();
  const found = store.profiles.find((p) => p.id === id);
  if (!found) return;
  found.lastUsedAt = new Date().toISOString();
  writeStore(store);
}
