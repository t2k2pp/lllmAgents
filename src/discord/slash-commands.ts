/**
 * Discord スラッシュコマンド登録ユーティリティ
 *
 * Discord REST API を使って /ask コマンドをアプリに登録する。
 * グローバル登録 (全サーバーに反映、最大 1 時間かかる) と
 * ギルド登録 (指定サーバーのみ、即時反映) に対応。
 */

import * as logger from "../utils/logger.js";

const DISCORD_API = "https://discord.com/api/v10";

/** /ask コマンドの定義 */
const ASK_COMMAND = {
  name: "ask",
  description: "lllmAgents にメッセージを送る",
  options: [
    {
      type: 3, // STRING
      name: "prompt",
      description: "エージェントへの指示や質問",
      required: true,
    },
  ],
};

export interface RegisterResult {
  success: boolean;
  error?: string;
  commandId?: string;
}

/**
 * /ask スラッシュコマンドを登録する
 *
 * @param applicationId Discord Application ID
 * @param botToken Bot トークン
 * @param guildId 指定時はギルド限定で登録 (即時反映)、省略時はグローバル登録 (最大 1h)
 */
export async function registerAskCommand(
  applicationId: string,
  botToken: string,
  guildId?: string,
): Promise<RegisterResult> {
  const endpoint = guildId
    ? `${DISCORD_API}/applications/${applicationId}/guilds/${guildId}/commands`
    : `${DISCORD_API}/applications/${applicationId}/commands`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${botToken}`,
        "User-Agent": "lllmAgents/1.0",
      },
      body: JSON.stringify(ASK_COMMAND),
    });

    const data = (await res.json()) as any;

    if (!res.ok) {
      const msg = `Discord command registration failed: ${res.status} ${JSON.stringify(data)}`;
      logger.error(msg);
      return { success: false, error: msg };
    }

    return { success: true, commandId: data.id };
  } catch (e) {
    const msg = `Failed to register Discord command: ${e}`;
    logger.error(msg);
    return { success: false, error: msg };
  }
}

/**
 * アプリに登録されているコマンド一覧を取得する
 */
export async function listCommands(
  applicationId: string,
  botToken: string,
  guildId?: string,
): Promise<{ success: boolean; commands?: any[]; error?: string }> {
  const endpoint = guildId
    ? `${DISCORD_API}/applications/${applicationId}/guilds/${guildId}/commands`
    : `${DISCORD_API}/applications/${applicationId}/commands`;

  try {
    const res = await fetch(endpoint, {
      headers: {
        Authorization: `Bot ${botToken}`,
        "User-Agent": "lllmAgents/1.0",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `HTTP ${res.status}: ${text}` };
    }

    const commands = (await res.json()) as any[];
    return { success: true, commands };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
