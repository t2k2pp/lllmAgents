/**
 * Discord スラッシュコマンド登録ユーティリティ
 *
 * Discord REST API を使って /ask コマンドをアプリに登録する。
 * グローバル登録 (全サーバーに反映、最大 1 時間かかる) と
 * ギルド登録 (指定サーバーのみ、即時反映) に対応。
 */
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
export declare function registerAskCommand(applicationId: string, botToken: string, guildId?: string): Promise<RegisterResult>;
/**
 * アプリに登録されているコマンド一覧を取得する
 */
export declare function listCommands(applicationId: string, botToken: string, guildId?: string): Promise<{
    success: boolean;
    commands?: any[];
    error?: string;
}>;
//# sourceMappingURL=slash-commands.d.ts.map