/**
 * 秘密情報の表示用マスク。設計: docs/production-readiness.md PR-04
 *
 * トークンや Webhook URL を画面に出すときは必ずここを通す。
 * 「設定されていること」と「どれが設定されているか (末尾数文字)」だけ分かればよい。
 */

/** 汎用マスク: 末尾4文字だけ残す。短すぎる値は全部伏せる。 */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `****${value.slice(-4)}`;
}

/**
 * Webhook URL のマスク: ホストとパスの形は残し、最終セグメント (トークン) を伏せる。
 * 例: https://discord.com/api/webhooks/1234/****abcd
 */
export function maskWebhookUrl(url: string): string {
  if (!url) return "";
  const idx = url.lastIndexOf("/");
  if (idx < 0 || idx === url.length - 1) return maskSecret(url);
  return `${url.slice(0, idx + 1)}${maskSecret(url.slice(idx + 1))}`;
}
