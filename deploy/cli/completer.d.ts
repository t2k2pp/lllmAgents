/**
 * 入力補完・メニュー候補プロバイダー
 *
 * - createCommandMenuProvider: /コマンドのドロップダウン候補（説明付き）
 * - createFileMenuProvider: @ファイルパスのドロップダウン候補
 * - createCompleter: readline用Tab補完（フォールバック用）
 */
import type { CompleterResult } from "node:readline";
import type { MenuProvider } from "./interactive-input.js";
/**
 * /コマンドのドロップダウン候補プロバイダーを生成。
 * partial は "/" の後の文字列（例: "he" → /help がマッチ）
 */
export declare function createCommandMenuProvider(skillTriggers?: {
    trigger: string;
    description: string;
}[], toolNames?: string[]): MenuProvider;
/**
 * @ファイルパスのドロップダウン候補プロバイダーを生成。
 * partial は "@" の後の文字列（例: "src/cl" → src/cli/ がマッチ）
 */
export declare function createFileMenuProvider(cwd?: string): MenuProvider;
export interface CompleterOptions {
    skillTriggers?: string[];
    toolNames?: string[];
    cwd?: string;
}
export declare function createCompleter(options?: CompleterOptions): (line: string) => CompleterResult;
//# sourceMappingURL=completer.d.ts.map