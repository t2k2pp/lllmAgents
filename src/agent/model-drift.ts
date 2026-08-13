/**
 * モデル設定の「設定値」と「実行中」のズレ検出とメッセージ整形。
 *
 * 設計書: docs/model-apply-immediacy.md §3
 *
 * config.mainLLM は *設定ファイルの値* であり、 AgentLoop が握っている provider は
 * *起動時 (または最後に成功した反映時) の値* である。 この 2 つがズレたまま気づけないのが
 * 不具合 3 の本体なので、 比較と文言生成をここに切り出して単体テスト可能にしている。
 *
 * chalk は使わず素のテキストを返す。 色付けは呼び出し側 (repl / doctor) に任せる。
 */

import type { LLMEndpoint } from "../config/types.js";
import { endpointSignature, generateEntryName } from "../config/model-registry.js";

/** provider を生成した時点の接続情報。 AgentLoop が保持する */
export interface LiveModelBinding {
  /** 生成時点の endpointSignature (接続情報のみ。 サンプリング値は含まない) */
  signature: string;
  model: string;
  providerType: string;
  /** 表示用ラベル。 例: "azure-anthropic:claude-sonnet-4-5 @ my-resource.azure.com" */
  label: string;
}

/** 設定値と実行中のズレ */
export interface ModelDrift {
  wantSignature: string;
  liveSignature: string;
  wantLabel: string;
  liveLabel: string;
}

/** endpoint から実行中バインディングを作る (AgentLoop.setProvider / setLiveBinding から呼ぶ) */
export function makeLiveBinding(endpoint: LLMEndpoint, model?: string): LiveModelBinding {
  return {
    signature: endpointSignature(endpoint),
    model: model ?? endpoint.model ?? "",
    providerType: endpoint.providerType ?? "",
    label: generateEntryName(endpoint),
  };
}

/** 表示用ラベル。 endpoint が無い場合は "(未設定)" */
export function describeEndpoint(endpoint: LLMEndpoint | null | undefined): string {
  if (!endpoint) return "(未設定)";
  return generateEntryName(endpoint);
}

/**
 * 設定値と実行中を比較する。 ズレていなければ null。
 *
 * liveBinding が無い (= provider 生成経路を通っていない) 場合は **ズレなしとみなす**。
 * 誤警告よりは検出漏れの方がましという安全側の判断 (設計書 §6)。
 */
export function detectModelDrift(
  configured: LLMEndpoint | null | undefined,
  live: LiveModelBinding | null | undefined,
): ModelDrift | null {
  if (!configured || !live?.signature) return null;
  const wantSignature = endpointSignature(configured);
  if (wantSignature === live.signature) return null;
  return {
    wantSignature,
    liveSignature: live.signature,
    wantLabel: describeEndpoint(configured),
    liveLabel: live.label,
  };
}

/**
 * ユーザー入力を受け付ける直前に毎ターン出す 1 行警告 (設計書 §3.3)。
 * うるさいのは承知の上。 ズレを解消すれば消えるので恒常的なノイズにはならない。
 */
export function formatDriftWarningLine(drift: ModelDrift): string {
  return `⚠ モデル設定が実行中に反映されていません。 設定: ${drift.wantLabel} / 実行中: ${drift.liveLabel} → /model apply で反映`;
}

/** /model・/status で出す 2 行表示の素材 */
export interface ModelBindingLines {
  /** 「設定値」 の行 */
  configured: string;
  /** 「実行中」 の行 (ズレていれば末尾に注意書きが付く) */
  live: string;
  /** ズレているときだけ付く導線 */
  hint?: string;
  drifted: boolean;
}

/**
 * 「設定値」 と「実行中」 を 2 行に分けた表示を作る (設計書 §3.3)。
 * 画面が嘘をつかないことが本件の主眼なので、 一致していても必ず 2 行出す。
 */
export function formatBindingLines(
  label: string,
  configured: LLMEndpoint | null | undefined,
  live: LiveModelBinding | null | undefined,
): ModelBindingLines {
  const drift = detectModelDrift(configured, live);
  const liveLabel = live ? live.label : "(不明)";
  const lines: ModelBindingLines = {
    configured: `${label} (設定):   ${describeEndpoint(configured)}`,
    live: `${label} (実行中): ${liveLabel}${drift ? "   ← 一致していません" : ""}`,
    drifted: !!drift,
  };
  if (drift) lines.hint = "/model apply で設定値を反映できます";
  return lines;
}

/**
 * 反映に失敗したときの文言 (設計書 §2.2)。
 * 「再起動してください」 で終わらせず、 **いま動いているのは何か** を必ず併記する。
 */
export function formatApplyFailureLines(reason: string, live: LiveModelBinding | null | undefined): string[] {
  const running = live ? `以前の設定 (${live.label}) のまま` : "起動時の設定のまま";
  return [
    "⚠ 設定は保存しましたが、 実行中への反映に失敗しました。",
    `   理由: ${reason}`,
    `   いま動いているのは${running}です。`,
    "   /model apply で再試行できます。",
  ];
}
