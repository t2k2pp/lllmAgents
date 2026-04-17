import type { ChatLogConfig } from "../config/types.js";
/**
 * チャットログをObsidian Vaultに保存するロガー。
 * - セッションごとに1ファイル（日時ベースのファイル名）
 * - コンテキスト圧縮が発生するとパート番号を繰り上げて新ファイルに切替
 * - 圧縮前のファイルには圧縮サマリーを末尾に追記
 */
export declare class ChatLogger {
    private config;
    private sessionDir;
    private sessionTimestamp;
    private partNumber;
    private currentFilePath;
    private messageCount;
    constructor(config: ChatLogConfig);
    /** 日時文字列: YYYYMMDD-HHmmss */
    private static formatTimestamp;
    private buildFilePath;
    private writeHeader;
    /** ユーザーメッセージを記録 */
    logUser(message: string): void;
    /** AI応答を記録 */
    logAssistant(message: string, toolSummary?: string): void;
    /** ツール実行を記録（簡易サマリー） */
    logToolExecution(toolName: string, success: boolean): void;
    /**
     * コンテキスト圧縮が発生した際に呼ぶ。
     * 現在のファイルに圧縮マーカーを追記し、新しいパートファイルに切り替える。
     */
    onCompressed(compressionSummary?: string): void;
    /** 有効/無効を切り替え */
    setEnabled(enabled: boolean): void;
    isEnabled(): boolean;
    getConfig(): ChatLogConfig;
    getCurrentFilePath(): string;
    getPartNumber(): number;
}
//# sourceMappingURL=chat-logger.d.ts.map