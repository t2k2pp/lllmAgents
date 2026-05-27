/**
 * LLM 接続プロファイル履歴 (旧 API)。
 *
 * 2026-05-27: model-registry.ts に統合された (docs/model-registry.md)。
 * 既存呼出元の互換のため、 同名の export を facade として残す:
 *  - `LLMProfile` 型は `LLMRegistryEntry` の alias
 *  - record/list/get/delete/touch/signature/generateName は model-registry へ委譲
 *
 * 新規コードからは `src/config/model-registry.ts` を直接 import すること。
 * 本 facade は移行が落ち着いたら撤去する。
 */

import type { LLMEndpoint, LLMRegistryEntry } from "./types.js";
import {
  listEntries,
  getEntry,
  findEntryBySignature,
  recordEntry,
  deleteEntry,
  deleteEntries,
  touchEntry,
  endpointSignature as _endpointSignature,
  generateEntryName,
} from "./model-registry.js";

export type LLMProfile = LLMRegistryEntry;

export const endpointSignature = _endpointSignature;
export const generateProfileName = generateEntryName;

export function listLLMProfiles(): LLMProfile[] {
  return listEntries();
}

export function getLLMProfile(id: string): LLMProfile | undefined {
  return getEntry(id);
}

export function findProfileBySignature(ep: LLMEndpoint): LLMProfile | undefined {
  return findEntryBySignature(ep);
}

export function recordLLMProfile(endpoint: LLMEndpoint): LLMProfile | undefined {
  return recordEntry(endpoint);
}

export function deleteLLMProfile(id: string): boolean {
  return deleteEntry(id);
}

export function deleteLLMProfiles(ids: string[]): number {
  return deleteEntries(ids);
}

export function touchProfile(id: string): void {
  touchEntry(id);
}
