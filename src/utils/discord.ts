import { httpPost } from "./http-client.js";
import * as logger from "./logger.js";

const DISCORD_MAX_LENGTH = 2000;

export async function sendDiscordNotification(webhookUrl: string, content: string): Promise<void> {
  if (!webhookUrl || !content) return;

  try {
    // 2000文字の制限があるため、内容を分割して送信する
    const chunks = splitIntoChunks(content, DISCORD_MAX_LENGTH);
    for (const chunk of chunks) {
      // http-client.tsのhttpPostを利用する
      const res = await httpPost(webhookUrl, {
        content: chunk,
      });
      if (!res.ok) {
        logger.error(`Discord webhook failed with status ${res.status}: ${res.data}`);
      }
    }
  } catch (error) {
    logger.error("Failed to send message to Discord webhook:", error);
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
      const newLinePos = text.lastIndexOf('\n', currentPos + chunkLength);
      if (newLinePos > currentPos + maxLength / 2) {
        chunkLength = newLinePos - currentPos + 1; // 改行文字を含める
      }
    }

    chunks.push(text.slice(currentPos, currentPos + chunkLength));
    currentPos += chunkLength;
  }

  return chunks;
}
