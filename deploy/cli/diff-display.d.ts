type LangId = "ts" | "js" | "py" | "json" | "css" | "html" | "md" | "sh" | "unknown";
/** unified diff 風の行単位差分を生成する */
export declare function generateLineDiff(oldText: string, newText: string, lang?: LangId): string[];
/**
 * file_edit の変更を色付きで表示する。
 * old_string / new_string から直接diffを生成。
 */
export declare function renderEditDiff(filePath: string, oldString: string, newString: string, occurrences: number): void;
/**
 * file_write の上書き変更を色付きで表示する。
 * 既存ファイルとの差分が大きすぎる場合はサマリーのみ。
 */
export declare function renderWriteDiff(filePath: string, oldContent: string | null, newContent: string): void;
export {};
//# sourceMappingURL=diff-display.d.ts.map