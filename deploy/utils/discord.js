import { httpPost } from "./http-client.js";
import * as logger from "./logger.js";
const DISCORD_MAX_LENGTH = 2000;
/**
 * Discord Webhook URLの形式を検証する。
 * 正しい形式: https://discord.com/api/webhooks/<id>/<token>
 */
export function isValidDiscordWebhookUrl(url) {
    return /^https:\/\/discord\.com\/api\/webhooks\/\d+\/.+$/.test(url);
}
export async function sendDiscordNotification(webhookUrl, content) {
    if (!webhookUrl || !content)
        return { success: false, error: "URL or content is empty" };
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
    }
    catch (error) {
        const msg = `Failed to send message to Discord webhook: ${error}`;
        logger.error(msg);
        console.warn(`\n  ⚠️  Discord通知の送信に失敗しました: ${error}\n`);
        return { success: false, error: String(error) };
    }
}
function splitIntoChunks(text, maxLength) {
    const chunks = [];
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
//# sourceMappingURL=discord.js.map