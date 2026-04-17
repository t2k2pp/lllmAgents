/**
 * @ファイル/フォルダ参照の解決
 *
 * ユーザー入力中の @path/to/file や @src/cli/ を検出し、
 * ファイルなら内容をインライン展開、フォルダならファイル一覧に展開する。
 *
 * 例:
 *   "このファイルを見て @src/cli/repl.ts"
 *   → "このファイルを見て\n\n--- @src/cli/repl.ts ---\n<ファイル内容>\n--- end ---"
 *
 *   "@src/cli/ のファイル構成を教えて"
 *   → "\n\n--- @src/cli/ ---\nrepl.ts\nrenderer.ts\ninput-resolver.ts\n--- end ---\n のファイル構成を教えて"
 */
export interface ResolvedMention {
    /** 元のマッチ文字列 (例: "@src/cli/repl.ts") */
    original: string;
    /** 解決された絶対パス */
    absolutePath: string;
    /** ファイルかディレクトリか。画像ファイルの場合は file_image */
    type: "file" | "file_image" | "directory" | "not_found";
    /** 展開されたコンテンツ (テキストまたは画像Base64情報) */
    content: string;
    /** 画像の場合はmime-type */
    mimeType?: string;
}
import type { ContentPart } from "../providers/base-provider.js";
/**
 * ユーザー入力中の @path 参照をすべて解決して展開済みテキスト（または ContentPart配列）を返す。
 * 見つからないパスはそのまま残す。
 */
export declare function resolveAtMentions(input: string, cwd?: string): {
    resolved: string | ContentPart[];
    mentions: ResolvedMention[];
};
/**
 * @メンションが含まれている場合にユーザーへフィードバックを表示する
 */
export declare function printMentionFeedback(mentions: ResolvedMention[]): void;
//# sourceMappingURL=input-resolver.d.ts.map