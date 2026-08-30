/**
 * Model Resolver: 「モデル参照 (ref)」 を実行可能な provider に変換する単一の解決層
 *
 * 設計書: docs/model-orchestration.md §3 (Model Registry Phase 6)
 *
 * 役割:
 *  - サブエージェント定義 / `task` ツール引数 / CLI から渡される 1 本の文字列 (ModelRef) を
 *    registry の entry まで辿り、 provider を生成して返す
 *  - 生成した provider を entry 単位でキャッシュし、 endpoint が変わったら作り直す
 *  - 暗号化 apiKey の復号に使う合言葉を起動時に 1 回だけ預かる
 *
 * ここでは対話プロンプトを一切出さない。 ツール実行中に合言葉を聞くと描画が壊れるため、
 * 解決できない場合は undefined を返す。明示された参照を別モデルへ自動置換してはならない。
 */

import type { LLMEndpoint, LLMRegistryEntry } from "./types.js";
import type { LLMProvider } from "../providers/base-provider.js";
import { createProvider } from "../providers/provider-factory.js";
import { CredentialVault } from "../security/credential-vault.js";
import { endpointSignature, getEntry, getSlot, listEntries, listNamedSlots } from "./model-registry.js";
import * as logger from "../utils/logger.js";

export interface ResolvedModel {
  /** 実行に使う provider (キャッシュ済み) */
  provider: LLMProvider;
  /** provider に渡すモデル名 */
  model: string;
  /** 接続情報一式 (contextWindow / サンプリング値の参照元) */
  endpoint: LLMEndpoint;
  /** 由来の registry entry id */
  entryId: string;
  /** 解決に使われた slot 名 (id:/name: 直指定なら undefined) */
  slot?: string;
  /** 表示用ラベル (entry.name) */
  label: string;
}

interface CacheItem {
  /** 生成時点の endpointSignature。 現在値と違えば作り直す */
  signature: string;
  provider: LLMProvider;
  model: string;
}

// entryId → 生成済み provider。 `task` が呼ばれるたびに provider を作ると
// HTTP 接続プールが毎回捨てられ、 クラウド系で目に見えて遅くなるためキャッシュする。
const providerCache = new Map<string, CacheItem>();

// 起動時に index.ts から預かる合言葉。 暗号化 apiKey の復号に使う。
let resolverPassphrase: string | undefined;

/** 復号用の合言葉を登録する (起動時に index.ts が 1 回だけ呼ぶ)。 */
export function setResolverPassphrase(passphrase: string | undefined): void {
  resolverPassphrase = passphrase;
  // 合言葉が変わると復号結果も変わりうるので、 生成済み provider は一旦捨てる
  providerCache.clear();
}

/** entry が編集された / slot が付け替えられた時に provider キャッシュを捨てる。 */
export function invalidateModelCache(entryId?: string): void {
  if (entryId) {
    providerCache.delete(entryId);
  } else {
    providerCache.clear();
  }
}

/** entry 名の部分一致 (大小無視)。 一意に絞れた場合だけ採用する。 */
function findEntryByNameQuery(query: string): LLMRegistryEntry | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const entries = listEntries();
  const exact = entries.filter((e) => e.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = entries.filter((e) => e.name.toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : undefined;
}

/** entry を provider 付きの ResolvedModel に変換する。 生成に失敗したら undefined。 */
function materialize(entry: LLMRegistryEntry, slot: string | undefined): ResolvedModel | undefined {
  const endpoint = entry.endpoint;
  if (!endpoint.model) {
    logger.warn(`model ref: エントリ '${entry.name}' に model が設定されていません`);
    return undefined;
  }

  // 暗号化 apiKey を合言葉なしで解こうとしない (対話プロンプトは出さない方針)
  if (endpoint.apiKey && CredentialVault.isEncrypted(endpoint.apiKey) && !resolverPassphrase) {
    logger.warn(
      `model ref: エントリ '${entry.name}' の apiKey は暗号化されていますが合言葉が未登録のため解決できません。 ` +
        `/models から明示的に切り替えてください。`,
    );
    return undefined;
  }

  const signature = endpointSignature(endpoint);
  const cached = providerCache.get(entry.id);
  if (cached && cached.signature === signature) {
    return {
      provider: cached.provider,
      model: cached.model,
      endpoint,
      entryId: entry.id,
      slot,
      label: entry.name,
    };
  }

  let provider: LLMProvider;
  try {
    provider = createProvider(endpoint, resolverPassphrase);
  } catch (e) {
    logger.warn(
      `model ref: エントリ '${entry.name}' の provider 生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }

  providerCache.set(entry.id, { signature, provider, model: endpoint.model });
  return { provider, model: endpoint.model, endpoint, entryId: entry.id, slot, label: entry.name };
}

/**
 * ref を解決する。解決できなければ undefined。明示refを別モデルへ置換しない。
 *
 * 文法 (設計書 §3.1):
 *   main / second / <slot-name>  slot 参照
 *   id:<entry-id>                registry entry を id 直指定
 *   name:<部分一致>               entry 名の部分一致 (一意なら採用)
 *
 * 素の文字列は slot → id → name の順に試す。 slot 名と entry 名が衝突したら slot が勝つ。
 */
export function resolveModelRef(ref: string): ResolvedModel | undefined {
  const raw = (ref ?? "").trim();
  if (!raw) return undefined;

  if (raw.startsWith("id:")) {
    const entry = getEntry(raw.slice(3).trim());
    return entry ? materialize(entry, undefined) : undefined;
  }

  if (raw.startsWith("name:")) {
    const entry = findEntryByNameQuery(raw.slice(5));
    return entry ? materialize(entry, undefined) : undefined;
  }

  // 1) slot
  const slotEntryId = getSlot(raw);
  if (slotEntryId) {
    const entry = getEntry(slotEntryId);
    if (entry) return materialize(entry, raw);
  }

  // 2) id 完全一致
  const byId = getEntry(raw);
  if (byId) return materialize(byId, undefined);

  // 3) 名前の部分一致
  const byName = findEntryByNameQuery(raw);
  return byName ? materialize(byName, undefined) : undefined;
}

/**
 * ref を解決する。未指定時だけ既定の main slot を返す。
 * 明示された ref の解決失敗は undefined とし、別モデルへ自動置換しない。
 */
export function resolveModelRefOrMain(ref: string | undefined): ResolvedModel | undefined {
  return ref?.trim() ? resolveModelRef(ref) : resolveModelRef("main");
}

export interface ResolvableSlot {
  slot: string;
  label: string;
  description?: string;
}

/**
 * 現在有効な自由 named slot の一覧 (プロンプト注入・`task` の description 生成用)。
 *
 * 予約 slot (main / second / vision) は含めない。 これらはコード側が固定で使う枠であり、
 * 「モデルが委任時に指名する対象」 ではないため。 provider は生成しない (表示専用)。
 * 並びは entry の lastUsedAt 降順 (よく使う slot ほど先頭)。
 */
export function listResolvableSlots(): ResolvableSlot[] {
  const rows: Array<{ slot: string; label: string; description?: string; lastUsedAt: string }> = [];
  for (const { slot, entryId } of listNamedSlots()) {
    const entry = getEntry(entryId);
    if (!entry) continue;
    rows.push({
      slot,
      label: entry.name,
      description: entry.endpoint.description?.trim() || undefined,
      lastUsedAt: entry.lastUsedAt,
    });
  }
  rows.sort((a, b) => (b.lastUsedAt > a.lastUsedAt ? 1 : b.lastUsedAt < a.lastUsedAt ? -1 : 0));
  return rows.map(({ slot, label, description }) => ({ slot, label, description }));
}
