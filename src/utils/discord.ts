import * as fs from "node:fs";
import * as path from "node:path";
import { httpPost } from "./http-client.js";
import * as logger from "./logger.js";
import { prepareForDiscord } from "./image-attachment.js";

const DISCORD_MAX_LENGTH = 2000;
/** Discord の 1 メッセージあたり添付ファイル数上限 */
const DISCORD_MAX_FILES = 10;
/** 添付サイズ上限の既定 (MB)。config.discord.maxAttachmentMb で上書き可 */
const DEFAULT_MAX_ATTACHMENT_MB = 8;

/**
 * Discord Webhook URLの形式を検証する。
 * 正しい形式: https://discord.com/api/webhooks/<id>/<token>
 */
export function isValidDiscordWebhookUrl(url: string): boolean {
  return /^https:\/\/discord\.com\/api\/webhooks\/\d+\/.+$/.test(url);
}

export async function sendDiscordNotification(
  webhookUrl: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  if (!webhookUrl || !content) return { success: false, error: "URL or content is empty" };

  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    const msg = `Discord Webhook URL が無効です: "${webhookUrl}"\n正しい形式: https://discord.com/api/webhooks/<id>/<token>\nDiscordサーバー設定 → 連携サービス → ウェブフック で取得してください。`;
    console.warn(`\n  ⚠️  ${msg}\n`);
    logger.warn(msg);
    return { success: false, error: "Invalid webhook URL format" };
  }

  try {
    // 2000文字の制限があるため、内容を分割して送信する
    const chunks = splitIntoChunks(content, DISCORD_MAX_LENGTH);
    for (const chunk of chunks) {
      // http-client.tsのhttpPostを利用する
      const res = await httpPost(webhookUrl, {
        content: chunk,
      });
      if (!res.ok) {
        const msg = `Discord webhook failed with status ${res.status}: ${res.data}`;
        logger.error(msg);
        console.warn(`\n  ⚠️  Discord通知の送信に失敗しました (HTTP ${res.status})\n`);
        return { success: false, error: msg };
      }
    }
    return { success: true };
  } catch (error) {
    const msg = `Failed to send message to Discord webhook: ${error}`;
    logger.error(msg);
    console.warn(`\n  ⚠️  Discord通知の送信に失敗しました: ${error}\n`);
    return { success: false, error: String(error) };
  }
}

/** 拡張子から Content-Type を推定する (添付 Blob 用) */
function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

/**
 * Discord webhook に画像ファイルを添付して送信する。
 *
 * httpPost は Content-Type: application/json 固定で multipart に使えないため、
 * グローバル fetch + FormData + Blob で multipart/form-data を組み立てる。
 *
 * - 各ファイルは prepareForDiscord() でサイズ上限に収まるよう自動縮小する
 *   (オリジナルは無加工。縮小版は一時ファイルとして生成し、送信後に必ず破棄)。
 * - 添付は最大 DISCORD_MAX_FILES 枚。超過分・縮小しても上限超のファイルはスキップし
 *   content に注記する。
 *
 * @param maxAttachmentMb 1 ファイルの目標上限 (MB)。未指定なら既定 8MB。
 */
export async function sendDiscordFiles(
  webhookUrl: string,
  content: string,
  filePaths: string[],
  maxAttachmentMb = DEFAULT_MAX_ATTACHMENT_MB,
): Promise<{ success: boolean; error?: string }> {
  if (!webhookUrl) return { success: false, error: "URL is empty" };
  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    const msg = `Discord Webhook URL が無効です: "${webhookUrl}"`;
    logger.warn(msg);
    return { success: false, error: "Invalid webhook URL format" };
  }
  if (filePaths.length === 0) return { success: false, error: "No files to send" };

  const maxBytes = Math.floor(maxAttachmentMb * 1024 * 1024);
  const tempPaths: string[] = [];
  const notes: string[] = [];
  const skipped: string[] = [];

  try {
    const form = new FormData();
    let attachCount = 0;

    for (const original of filePaths) {
      if (attachCount >= DISCORD_MAX_FILES) {
        skipped.push(`${path.basename(original)} (添付上限 ${DISCORD_MAX_FILES} 枚超過)`);
        continue;
      }
      const prepared = await prepareForDiscord(original, maxBytes);
      if (prepared.isTemp) tempPaths.push(prepared.path);

      let buf: Buffer;
      try {
        buf = fs.readFileSync(prepared.path);
      } catch (e) {
        skipped.push(`${path.basename(original)} (読み込み失敗)`);
        logger.warn(`添付ファイルの読み込みに失敗: ${prepared.path}: ${e}`);
        continue;
      }
      // 縮小しても上限を超える場合は Discord に弾かれるためスキップ
      if (buf.length > maxBytes) {
        skipped.push(`${path.basename(original)} (サイズ上限超過)`);
        continue;
      }

      const filename = path.basename(prepared.path);
      const blob = new Blob([new Uint8Array(buf)], { type: mimeFromPath(prepared.path) });
      form.append(`files[${attachCount}]`, blob, filename);
      if (prepared.note) notes.push(`${path.basename(original)}: ${prepared.note}`);
      attachCount++;
    }

    if (attachCount === 0) {
      return { success: false, error: `添付可能な画像がありません (${skipped.join(", ")})` };
    }

    // content を 2000 文字に収める (注記を付加)
    const extraLines = [...notes, ...skipped.map((s) => `⚠ スキップ: ${s}`)];
    let payloadContent = content ?? "";
    if (extraLines.length > 0) {
      payloadContent = `${payloadContent}\n${extraLines.join("\n")}`.trim();
    }
    if (payloadContent.length > DISCORD_MAX_LENGTH) {
      payloadContent = payloadContent.slice(0, DISCORD_MAX_LENGTH - 1) + "…";
    }
    form.append("payload_json", JSON.stringify({ content: payloadContent }));

    const res = await fetch(webhookUrl, { method: "POST", body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const msg = `Discord webhook (files) failed with status ${res.status}: ${text}`;
      logger.error(msg);
      console.warn(`\n  ⚠️  Discord への画像添付に失敗しました (HTTP ${res.status})\n`);
      return { success: false, error: msg };
    }
    return { success: true };
  } catch (error) {
    const msg = `Failed to send files to Discord webhook: ${error}`;
    logger.error(msg);
    console.warn(`\n  ⚠️  Discord への画像添付に失敗しました: ${error}\n`);
    return { success: false, error: String(error) };
  } finally {
    // 一時ファイル (縮小版) は成功・失敗・例外いずれでも破棄する。オリジナルは触らない。
    for (const tmp of tempPaths) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 破棄失敗は無視 (OS の tmp 掃除に委ねる) */
      }
    }
  }
}

function splitIntoChunks(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let currentPos = 0;

  while (currentPos < text.length) {
    let chunkLength = Math.min(maxLength, text.length - currentPos);

    // 区切る際、なるべく単語の途中や文の途中で切れないように直前の改行を探す工夫をする
    // ギリギリで改行が見つかるか確認 (最低でもmaxLength/2 以上で改行を探す)
    if (currentPos + chunkLength < text.length) {
      const newLinePos = text.lastIndexOf("\n", currentPos + chunkLength);
      if (newLinePos > currentPos + maxLength / 2) {
        chunkLength = newLinePos - currentPos + 1; // 改行文字を含める
      }
    }

    chunks.push(text.slice(currentPos, currentPos + chunkLength));
    currentPos += chunkLength;
  }

  return chunks;
}
