/**
 * Slack Incoming Webhook URLの形式を検証する。
 * 正しい形式: https://hooks.slack.com/services/T.../B.../...
 */
export declare function isValidSlackWebhookUrl(url: string): boolean;
export declare function sendSlackNotification(webhookUrl: string, content: string): Promise<{
    success: boolean;
    error?: string;
}>;
/**
 * Markdown → Slack mrkdwn 変換。
 * 主な違い: **bold** → *bold*, [text](url) → <url|text>, # Header → *Header*
 */
export declare function markdownToSlackMrkdwn(md: string): string;
//# sourceMappingURL=slack.d.ts.map