/**
 * Claude Code風インタラクティブ入力
 *
 * /コマンドや@ファイルパスを入力すると、入力行の下部にリアルタイムで
 * ドロップダウン候補が表示される。カーソルキーで選択しEnterで確定。
 *
 * 特徴:
 * - raw stdinでキーストロークを1つずつ処理
 * - ANSI エスケープシーケンスでドロップダウンを描画
 * - Shift+Enter でマルチライン入力（モダンターミナル対応）
 * - 入力履歴 (↑↓)
 * - マルチバイト文字（日本語）対応
 * - TTY非対応時はreadlineフォールバック
 */
export interface MenuItem {
    label: string;
    value: string;
    description?: string;
}
export type MenuProvider = (partial: string) => MenuItem[];
export interface InteractiveInputOptions {
    /** /コマンド候補を返すプロバイダー */
    commandProvider?: MenuProvider;
    /** @ファイルパス候補を返すプロバイダー */
    filePathProvider?: MenuProvider;
}
/** Ctrl+C が押されたことを示す特殊値 */
export declare const SIGINT_SIGNAL = "\u0003";
export declare class InteractiveInput {
    private commandProvider;
    private filePathProvider;
    private history;
    private historyIndex;
    private keypressInitialized;
    constructor(options?: InteractiveInputOptions);
    /**
     * プロンプトを表示しユーザー入力を返す。
     * Shift+Enter で改行を挿入し、Enter で確定。
     * @param prefix  プロンプト文字列 (例: "> ")
     * @param options.disableMenu  trueならドロップダウンを抑制
     */
    question(prefix: string, options?: {
        disableMenu?: boolean;
    }): Promise<string>;
    private fallbackQuestion;
    private interactiveQuestion;
}
/**
 * 文字列のターミナル表示幅を計算する。
 * 全角文字(CJK, ひらがな, カタカナ等) = 2カラム、半角 = 1カラム。
 */
export declare function getDisplayWidth(str: string): number;
//# sourceMappingURL=interactive-input.d.ts.map