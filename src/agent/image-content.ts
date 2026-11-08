/**
 * 会話に載せた画像の扱い (docs/in-context-vision-design.md)。
 *
 * - ツール結果の画像を 1 件のハーネスの user メッセージ (画像の運び役) にまとめる
 * - 本文を文字にする所で base64 を出さない (`[画像: …]` の置き換え文にする)
 * - 推定トークン数は画像 1 枚を決まった数で数える (base64 の長さで数えない)
 * - 古い画像の退役 (整理イベントの前処理・生きている枚数の上限)
 * - メインのモデルが画像を見られるかの判定 (起動時・接続先の切替)
 */
import type { ContentPart, LLMProvider, Message } from "../providers/base-provider.js";
import type { ImageAttachment, ImageInputState } from "../tools/tool-registry.js";

/**
 * 画像 1 枚の推定トークン数。 2026-11-09 の実測 (Gufo の Qwen3.8 Flash Next に 1200×900 の PNG を 1 枚送ると
 * prompt が 約 1,300 トークン増えた) に余裕を足した値。 base64 の長さ (数十万文字) で数えると、
 * 整理の判定が「文脈が溢れた」 と誤る
 */
export const IMAGE_TOKEN_ESTIMATE = 1500;

/** 整理イベントの前処理で残す、 新しい画像の枚数 (これより古い画像は退役させる) */
export const KEEP_RECENT_IMAGES = 3;

/** 生きている画像の上限。 超えたら古い画像を KEEP_RECENT_IMAGES 枚まで退役させる (書き換え理由 image-retire) */
export const MAX_LIVE_IMAGES = 8;

/** 画像の運び役の先頭の印 (ハーネスの注入として扱わせる。 progress-judge は「[ハーネス」 で始まる発言を除く) */
export const TOOL_IMAGE_NOTE_MARKER = "[ハーネス] 画像の添付";

/** 画像の運び役の中で、 各画像の直前に置く見出し (退役のときに見出しから label を拾う) */
const IMAGE_LABEL_PREFIX = "[画像 ";

/** data URL から形式と大きさ (バイト) を読む */
function describeDataUrl(url: string): { mime: string; bytes: number } | null {
  const m = /^data:([^;,]+);base64,/.exec(url);
  if (!m) return null;
  const b64Len = url.length - m[0].length;
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  return { mime: m[1], bytes: Math.max(0, Math.floor((b64Len * 3) / 4) - padding) };
}

/** 画像のパートを短い置き換え文にする (label が分かればそれ、 無ければ形式と大きさ) */
export function imagePlaceholder(part: ContentPart, label?: string): string {
  if (label) return `[画像: ${label}]`;
  const url = part.image_url?.url ?? "";
  const d = describeDataUrl(url);
  if (d) return `[画像: ${d.mime} ${d.bytes}B]`;
  return url.length > 0 && url.length <= 200 ? `[画像: ${url}]` : "[画像]";
}

/** 本文を文字にする (画像は置き換え文。 base64 を出さない) */
export function contentToText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "image_url" ? imagePlaceholder(p) : (p.text ?? "")))
    .filter((t) => t.length > 0)
    .join("\n");
}

/** 本文の画像パートの数 */
export function countImageParts(m: Message): number {
  if (typeof m.content === "string") return 0;
  return m.content.filter((p) => p.type === "image_url").length;
}

/**
 * 推定トークン数を数えるための本文の文字列 (画像のパートは URL を空にして JSON にする。 画像そのものは
 * IMAGE_TOKEN_ESTIMATE で別に数える)。 文字だけの配列は従来どおりの JSON になる
 */
export function contentForTokenCount(content: Message["content"]): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  let images = 0;
  const stripped = content.map((p) => {
    if (p.type !== "image_url") return p;
    images++;
    return { type: p.type, image_url: { url: "" } };
  });
  return { text: JSON.stringify(stripped), images };
}

/** ツール結果の画像 1 枚と、 それを返したツールの名前 */
export interface ToolImage {
  toolName: string;
  image: ImageAttachment;
}

/**
 * 同じ応答のツール結果の画像を、 1 件の運び役の本文にする。
 * 先頭の文字パートで「利用者の発言ではない」 ことと一覧を示し、 各画像の直前に見出しを置く
 */
export function buildToolImageNote(
  images: readonly ToolImage[],
  omitted: readonly ToolImage[] = [],
  omittedReason = `1 回の応答で載せられる画像は ${MAX_LIVE_IMAGES} 枚まで`,
): ContentPart[] {
  const lines = [
    `${TOOL_IMAGE_NOTE_MARKER}: 直前のツール結果が返した画像です。 利用者の発言ではありません。 画像を自分の目で確かめ、 作業を続けてください。`,
    ...images.map((x, i) => `- 画像 ${i + 1}: ${x.toolName} — ${x.image.label}`),
  ];
  if (omitted.length > 0) {
    lines.push(
      `- ${omittedReason}のため、 次の ${omitted.length} 枚は載せていません: ` +
        omitted.map((x) => `${x.toolName} — ${x.image.label}`).join(", "),
    );
  }
  const parts: ContentPart[] = [{ type: "text", text: lines.join("\n") }];
  images.forEach((x, i) => {
    parts.push({ type: "text", text: `${IMAGE_LABEL_PREFIX}${i + 1}] ${x.image.label}` });
    parts.push({ type: "image_url", image_url: { url: `data:${x.image.mimeType};base64,${x.image.data}` } });
  });
  return parts;
}

/** 画像の運び役か (ハーネスの注入。 利用者の依頼として扱わない) */
export function isToolImageNote(m: Message): boolean {
  if (m.role !== "user" || typeof m.content === "string") return false;
  const first = m.content[0];
  return first?.type === "text" && typeof first.text === "string" && first.text.startsWith(TOOL_IMAGE_NOTE_MARKER);
}

/** 退役させた画像の置き換え文 (もう一度見る手を示す) */
export function retiredImageText(part: ContentPart, label: string | undefined, reason: string): string {
  const what = label ?? imagePlaceholder(part).replace(/^\[画像: ?|\]$/g, "");
  return (
    `[画像は文脈から外しました (${reason}): ${what || "(不明)"}。 ` +
    `もう一度見る必要があれば file_read でそのファイルを読み直してください]`
  );
}

/** 画像パートの直前の見出し (運び役の `[画像 N] label`) から label を拾う */
function labelBefore(parts: readonly ContentPart[], index: number): string | undefined {
  const prev = parts[index - 1];
  if (prev?.type !== "text" || !prev.text?.startsWith(IMAGE_LABEL_PREFIX)) return undefined;
  return prev.text.replace(/^\[画像 \d+\] /, "");
}

/** メッセージの画像パートを全部置き換え文にする (画像が無ければ同じ参照を返す) */
export function retireImagesInMessage(m: Message, reason: string): Message {
  if (typeof m.content === "string" || countImageParts(m) === 0) return m;
  const parts = m.content;
  const content: ContentPart[] = parts.map((p, i) =>
    p.type === "image_url" ? { type: "text", text: retiredImageText(p, labelBefore(parts, i), reason) } : p,
  );
  return { ...m, content };
}

/**
 * 新しい画像を keep 枚だけ残し、 それより古い画像を置き換え文にする。 変えたメッセージだけ新しいオブジェクト。
 * @returns 置き換えた後の写しと、 退役させた画像の枚数
 */
export function retireOldImages(
  messages: readonly Message[],
  keep: number,
  reason: string,
): { messages: Message[]; retired: number } {
  let remaining = keep;
  let retired = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    const n = countImageParts(m);
    if (n === 0) continue;
    if (remaining >= n) {
      remaining -= n;
      continue;
    }
    // このメッセージの中で新しい (後ろの) remaining 枚を残す
    if (typeof m.content === "string") continue;
    const parts = m.content;
    const imageIdx = parts.flatMap((p, j) => (p.type === "image_url" ? [j] : []));
    const retireSet = new Set(imageIdx.slice(0, imageIdx.length - remaining));
    retired += retireSet.size;
    remaining = 0;
    out[i] = {
      ...m,
      content: parts.map((p, j) =>
        retireSet.has(j) ? { type: "text", text: retiredImageText(p, labelBefore(parts, j), reason) } : p,
      ),
    };
  }
  return { messages: out, retired };
}

/** "1.2MB" のような表記 */
export function formatImageBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** 画像パートの base64 の長さ (送る本文に占めるバイト数の目安) */
export function imagePartBytes(part: ContentPart): number {
  const url = part.image_url?.url ?? "";
  const i = url.indexOf(";base64,");
  return i >= 0 ? url.length - i - ";base64,".length : url.length;
}

/** 履歴の中で生きている画像の base64 の合計 */
export function liveImageBytes(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const p of m.content) if (p.type === "image_url") total += imagePartBytes(p);
  }
  return total;
}

/**
 * 新しい画像から数えて、 枚数が maxCount 以下・base64 の合計が maxBytes 以下に収まるところまで残し、
 * それより古い画像を全部置き換え文にする (古い方から外す)。 変えたメッセージだけ新しいオブジェクト
 */
export function retireImagesToFit(
  messages: readonly Message[],
  limits: { maxCount: number; maxBytes: number },
  reason: string,
): { messages: Message[]; retired: number; retiredBytes: number } {
  let count = 0;
  let bytes = 0;
  let full = false;
  let retired = 0;
  let retiredBytes = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (typeof m.content === "string" || countImageParts(m) === 0) continue;
    const parts = m.content;
    const retireSet = new Set<number>();
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.type !== "image_url") continue;
      const size = imagePartBytes(p);
      if (!full && count + 1 <= limits.maxCount && bytes + size <= limits.maxBytes) {
        count++;
        bytes += size;
        continue;
      }
      full = true;
      retireSet.add(j);
      retired++;
      retiredBytes += size;
    }
    if (retireSet.size === 0) continue;
    out[i] = {
      ...m,
      content: parts.map((p, j) =>
        retireSet.has(j) ? { type: "text", text: retiredImageText(p, labelBefore(parts, j), reason) } : p,
      ),
    };
  }
  return { messages: out, retired, retiredBytes };
}

/** 履歴の中で生きている (置き換えていない) 画像の枚数 */
export function countLiveImages(messages: readonly Message[]): number {
  return messages.reduce((n, m) => n + countImageParts(m), 0);
}

// ─── メインのモデルが画像を見られるか ───

/** config の mainLLM.vision。 未指定は auto */
export type ImageInputPreference = "auto" | "on" | "off";

/** 載せる前に縮める長辺の既定 (px)。 config mainLLM.visionMaxLongSide */
export const DEFAULT_VISION_MAX_LONG_SIDE = 1280;

/**
 * 履歴に載っている画像の base64 の合計の既定の上限 (4 MiB)。 config mainLLM.visionImageBudgetBytes。
 * 2026-11-09 の Gufo は本文 7 MiB まで通し、 8 MiB から 413 (payload_too_large) を返した。 文字の分を残すため 4 MiB
 */
export const DEFAULT_VISION_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024;

/** config の画像の上限 (mainLLM.visionMaxLongSide / visionImageBudgetBytes)。 未指定・不正は既定 */
export interface ImageInputLimitsConfig {
  visionMaxLongSide?: number;
  visionImageBudgetBytes?: number;
}

function positiveInt(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

/**
 * メインのモデルが画像を見られるかを決める。 config の明示 (on/off) があればそれ、 auto なら provider に問う。
 * provider が失敗したら unknown (失敗の中身つき) を返す。 推測で on/off にしない
 */
export async function resolveImageInput(
  provider: Pick<LLMProvider, "supportsVision" | "providerType">,
  model: string,
  preference: ImageInputPreference | undefined,
  limitsConfig: ImageInputLimitsConfig = {},
): Promise<ImageInputState> {
  const limits = {
    maxLongSide: positiveInt(limitsConfig.visionMaxLongSide, DEFAULT_VISION_MAX_LONG_SIDE),
    budgetBytes: positiveInt(limitsConfig.visionImageBudgetBytes, DEFAULT_VISION_IMAGE_BUDGET_BYTES),
  };
  const pref = preference ?? "auto";
  if (pref === "on") {
    return { mode: "on", source: "config", detail: `${model}: config の mainLLM.vision = "on"`, ...limits };
  }
  if (pref === "off") {
    return { mode: "off", source: "config", detail: `${model}: config の mainLLM.vision = "off"`, ...limits };
  }
  try {
    const supported = await provider.supportsVision(model);
    return supported
      ? {
          mode: "on",
          source: "provider",
          detail: `${model}: ${provider.providerType} が画像の入力に対応と報告`,
          ...limits,
        }
      : {
          mode: "off",
          source: "provider",
          detail: `${model}: ${provider.providerType} が画像の入力に非対応と報告 (対応なら mainLLM.vision = "on")`,
          ...limits,
        };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      mode: "unknown",
      source: "provider",
      detail: `${model}: ${provider.providerType} の判定に失敗: ${msg}`,
      ...limits,
    };
  }
}

/** 起動時・/status に出す 1 行 */
export function formatImageInputLine(state: ImageInputState): string {
  const label = state.mode === "on" ? "見る (ON)" : state.mode === "off" ? "見ない (OFF)" : "判定できず";
  const limits =
    state.mode === "on"
      ? ` (長辺 ${state.maxLongSide}px まで縮める・載せる画像の合計 ${(state.budgetBytes / (1024 * 1024)).toFixed(1)} MiB まで)`
      : "";
  return `画像 (メインのモデル): ${label} — ${state.detail}${limits}`;
}
