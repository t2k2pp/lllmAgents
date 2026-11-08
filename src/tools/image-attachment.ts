/**
 * ツール結果に付ける画像 (docs/in-context-vision-design.md §3)。
 *
 * メインのモデルが画像を見られるとき、 file_read・MCP の画像は ToolResult.images に入り、
 * AgentLoop が同じ応答の結果を全部入れた後に 1 件のハーネスの user メッセージとして会話に載せる。
 * ここは画像の検査 (形式・大きさ・base64 の正しさ) と、 見出しに書く大きさ (幅×高さ) の読み取りだけを持つ。
 */
import type { ImageAttachment, ImageMimeType, ToolExecutionContext } from "./tool-registry.js";

/** 1 枚の上限 (MCP の画像と同じ 20 MiB) */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, ImageMimeType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** 拡張子から画像の形式を返す (画像でなければ null) */
export function imageMimeFromExtension(ext: string): ImageMimeType | null {
  return MIME_BY_EXTENSION[ext.toLowerCase()] ?? null;
}

export function isImageMime(mime: string | undefined): mime is ImageMimeType {
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
}

/** バイト列から画像の添付を作る。 上限を超えたら理由つきで投げる */
export function attachmentFromBytes(bytes: Buffer, mimeType: ImageMimeType, label: string): ImageAttachment {
  if (bytes.length === 0) throw new Error(`画像が空です: ${label}`);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `画像が大きすぎます (${bytes.length} バイト > 上限 ${MAX_IMAGE_BYTES} バイト): ${label}。 縮小した PNG/JPEG/WebP を用意してください`,
    );
  }
  return { mimeType, data: bytes.toString("base64"), label };
}

/**
 * base64 の画像 (MCP の image ブロックなど) を検査して添付にする。
 * 形式・大きさ・base64 の往復一致を確かめ、 だめなら理由つきで投げる (黙って捨てない)。
 */
export function attachmentFromBase64(data: string | undefined, mimeType: string | undefined, label: string) {
  if (!isImageMime(mimeType)) {
    throw new Error(`画像の形式 ${mimeType ?? "(なし)"} は扱えません。 PNG/JPEG/WebP を返してください`);
  }
  if (!data || data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error("画像が不正か 20 MiB を超えています。 小さい PNG/JPEG/WebP を返してください");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new Error("画像の base64 が不正です");
  return attachmentFromBytes(bytes, mimeType, label);
}

/** PNG / JPEG / WebP の先頭から幅と高さを読む (読めなければ null。 中身全体は解かない) */
export function readImageSize(bytes: Buffer): { width: number; height: number } | null {
  try {
    // PNG: 8 バイトの印 + IHDR (幅・高さはビッグエンディアンの 4 バイト)
    if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("ascii", 12, 16) === "IHDR") {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    // JPEG: SOF マーカー (C0〜CF のうち C4/C8/CC を除く) を探す
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        const len = bytes.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
    if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
      const kind = bytes.toString("ascii", 12, 16);
      if (kind === "VP8X") {
        return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      }
      if (kind === "VP8L") {
        const b = bytes.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
      if (kind === "VP8 ") {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * メインのモデルが画像を見られないときにツールが返す文 (黙って画像を捨てない。 docs/in-context-vision-design.md §2)。
 * context に状態が無い経路 (サブエージェント・テスト等) も「見られない」 と名指しで返す。
 */
export function imageInputUnavailableNote(context: ToolExecutionContext | undefined): string {
  const state = context?.imageInput;
  if (!state) {
    return "[画像] この実行経路 (サブエージェント等) では画像を会話に載せません。 画像の中身を確かめるには vision_analyze を使ってください。";
  }
  if (state.mode === "unknown") {
    return (
      `[画像] メインのモデルが画像を見られるか判定できませんでした (${state.detail})。 画像は会話に載せていません。 ` +
      `config.json の mainLLM.vision を "on" か "off" にすると判定を省けます。 当面は vision_analyze を使ってください。`
    );
  }
  return `[画像] メインのモデルは画像を見られない設定です (${state.detail})。 画像は会話に載せていません。 vision_analyze を使ってください。`;
}
