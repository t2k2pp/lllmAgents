import { httpPost } from "./http-client.js";
import * as logger from "./logger.js";

const SLACK_MAX_LENGTH = 3000;

/**
 * Slack Incoming Webhook URLの形式を検証する。
 * 正しい形式: https://hooks.slack.com/services/T.../B.../...
 */
export function isValidSlackWebhookUrl(url: string): boolean {
  return /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/.+$/.test(url);
}

export async function sendSlackNotification(
  webhookUrl: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  if (!webhookUrl || !content) return { success: false, error: "URL or content is empty" };

  if (!isValidSlackWebhookUrl(webhookUrl)) {
    const msg = `Slack Webhook URL が無効です: "${webhookUrl}"\n正しい形式: https://hooks.slack.com/services/T.../B.../...\nSlack App設定 → Incoming Webhooks で取得してください。`;
    console.warn(`\n  ⚠️  ${msg}\n`);
    logger.warn(msg);
    return { success: false, error: "Invalid webhook URL format" };
  }

  try {
    const converted = markdownToSlackMrkdwn(content);
    const chunks = splitIntoChunks(converted, SLACK_MAX_LENGTH);
    for (const chunk of chunks) {
      const res = await httpPost(webhookUrl, { text: chunk });
      if (!res.ok) {
        const msg = `Slack webhook failed with status ${res.status}: ${res.data}`;
        logger.error(msg);
        console.warn(`\n  ⚠️  Slack通知の送信に失敗しました (HTTP ${res.status})\n`);
        return { success: false, error: msg };
      }
    }
    return { success: true };
  } catch (error) {
    const msg = `Failed to send message to Slack webhook: ${error}`;
    logger.error(msg);
    console.warn(`\n  ⚠️  Slack通知の送信に失敗しました: ${error}\n`);
    return { success: false, error: String(error) };
  }
}

/**
 * Markdown → Slack mrkdwn 変換。
 * 主な違い: **bold** → *bold*, [text](url) → <url|text>, # Header → *Header*
 */
export function markdownToSlackMrkdwn(md: string): string {
  let result = md;

  // **bold** → *bold* (コードブロック内は除外)
  result = result.replace(/(?<!`)\*\*(.+?)\*\*(?!`)/g, "*$1*");

  // [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // # Header → *Header* (行頭の#を太字に変換)
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, "*$2*");

  return result;
}

function splitIntoChunks(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let currentPos = 0;

  while (currentPos < text.length) {
    let chunkLength = Math.min(maxLength, text.length - currentPos);

    if (currentPos + chunkLength < text.length) {
      const newLinePos = text.lastIndexOf("\n", currentPos + chunkLength);
      if (newLinePos > currentPos + maxLength / 2) {
        chunkLength = newLinePos - currentPos + 1;
      }
    }

    chunks.push(text.slice(currentPos, currentPos + chunkLength));
    currentPos += chunkLength;
  }

  return chunks;
}
