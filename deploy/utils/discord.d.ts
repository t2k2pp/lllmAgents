/**
 * Discord Webhook URLの形式を検証する。
 * 正しい形式: https://discord.com/api/webhooks/<id>/<token>
 */
export declare function isValidDiscordWebhookUrl(url: string): boolean;
export declare function sendDiscordNotification(webhookUrl: string, content: string): Promise<{
    success: boolean;
    error?: string;
}>;
//# sourceMappingURL=discord.d.ts.map