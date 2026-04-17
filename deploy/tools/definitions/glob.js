import { glob as globFn } from "glob";
import * as path from "node:path";
export const globTool = {
    name: "glob",
    definition: {
        type: "function",
        function: {
            name: "glob",
            description: "globパターンでファイルを検索します。例: **/*.ts, src/**/*.js",
            parameters: {
                type: "object",
                properties: {
                    pattern: {
                        type: "string",
                        description: "globパターン",
                    },
                    path: {
                        type: "string",
                        description: "検索ディレクトリ（省略時はカレントディレクトリ）",
                    },
                },
                required: ["pattern"],
            },
        },
    },
    async execute(params) {
        const pattern = params.pattern;
        const cwd = params.path ?? process.cwd();
        try {
            const matches = await globFn(pattern, {
                cwd: path.resolve(cwd),
                absolute: true,
                nodir: true,
                ignore: ["**/node_modules/**", "**/.git/**"],
            });
            if (matches.length === 0) {
                return { success: true, output: "No matching files found." };
            }
            const output = matches.slice(0, 200).join("\n");
            const suffix = matches.length > 200 ? `\n... and ${matches.length - 200} more` : "";
            return { success: true, output: output + suffix };
        }
        catch (e) {
            return { success: false, output: "", error: String(e) };
        }
    },
};
//# sourceMappingURL=glob.js.map