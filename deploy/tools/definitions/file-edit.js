import * as fs from "node:fs";
import * as path from "node:path";
export const fileEditTool = {
    name: "file_edit",
    definition: {
        type: "function",
        function: {
            name: "file_edit",
            description: "ファイル内の文字列を置換して編集します。old_stringが一意に特定できる必要があります。",
            parameters: {
                type: "object",
                properties: {
                    file_path: {
                        type: "string",
                        description: "編集するファイルの絶対パス",
                    },
                    old_string: {
                        type: "string",
                        description: "置換する元のテキスト（ファイル内で一意であること）",
                    },
                    new_string: {
                        type: "string",
                        description: "置換後のテキスト",
                    },
                    replace_all: {
                        type: "boolean",
                        description: "全ての出現箇所を置換する場合true（デフォルト: false）",
                    },
                },
                required: ["file_path", "old_string", "new_string"],
            },
        },
    },
    async execute(params) {
        const filePath = path.resolve(params.file_path);
        const oldString = params.old_string;
        const newString = params.new_string;
        const replaceAll = params.replace_all ?? false;
        if (!fs.existsSync(filePath)) {
            return { success: false, output: "", error: `File not found: ${filePath}` };
        }
        let content = fs.readFileSync(filePath, "utf-8");
        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) {
            // ファイルの現在の内容を添付してモデルの次の判断を助ける
            const lineCount = content.split("\n").length;
            const preview = content.length > 1500 ? content.slice(0, 1500) + "\n...(truncated)" : content;
            return {
                success: false,
                output: `ファイルの現在の内容 (${lineCount}行):\n${preview}`,
                error: "old_string not found in file. 正しい文字列で再試行するか、file_writeでファイル全体を書き直してください。",
            };
        }
        if (!replaceAll && occurrences > 1) {
            return {
                success: false,
                output: "",
                error: `old_string found ${occurrences} times. Use replace_all=true or provide a more unique string.`,
            };
        }
        if (replaceAll) {
            content = content.split(oldString).join(newString);
        }
        else {
            content = content.replace(oldString, newString);
        }
        fs.writeFileSync(filePath, content, "utf-8");
        const replacedCount = replaceAll ? occurrences : 1;
        return {
            success: true,
            output: `Edited ${filePath}: replaced ${replacedCount} occurrence(s)`,
            userDisplay: {
                type: "edit-diff",
                filePath,
                oldString,
                newString,
                occurrences: replacedCount,
            },
        };
    },
};
//# sourceMappingURL=file-edit.js.map