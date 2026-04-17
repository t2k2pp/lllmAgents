import * as fs from "node:fs";
import * as path from "node:path";
import { getObsidianConfig, getKnowledgeBasePath } from "./knowledge-save.js";
/** frontmatter を解析して key-value を返す (簡易パーサー) */
function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match)
        return {};
    const yaml = match[1];
    const result = {};
    let currentKey = "";
    let currentArray = null;
    for (const line of yaml.split("\n")) {
        const arrayItem = line.match(/^\s+-\s+(.+)/);
        if (arrayItem && currentKey) {
            if (!currentArray)
                currentArray = [];
            currentArray.push(arrayItem[1].replace(/^["']|["']$/g, ""));
            result[currentKey] = currentArray;
            continue;
        }
        if (currentArray) {
            currentArray = null;
        }
        const kv = line.match(/^(\w[\w_]*)\s*:\s*(.+)?/);
        if (kv) {
            currentKey = kv[1];
            const val = (kv[2] ?? "").trim();
            if (val) {
                result[currentKey] = val.replace(/^["']|["']$/g, "");
            }
            currentArray = null;
        }
    }
    return result;
}
/** ナレッジディレクトリ配下の全mdファイルを再帰的に列挙 */
function walkMdFiles(dir) {
    if (!fs.existsSync(dir))
        return [];
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkMdFiles(fullPath));
        }
        else if (entry.name.endsWith(".md")) {
            results.push(fullPath);
        }
    }
    return results;
}
/** ファイルを読み込んで NoteInfo を構築 */
function loadNote(filePath, vaultPath) {
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        const fm = parseFrontmatter(content);
        // frontmatter 以降の本文を取得
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
        const body = bodyMatch ? bodyMatch[1] : content;
        const preview = body.trim().slice(0, 500);
        return {
            filePath,
            relativePath: path.relative(vaultPath, filePath).replace(/\\/g, "/"),
            frontmatter: fm,
            preview,
        };
    }
    catch {
        return null;
    }
}
/** タグが配列の一部にマッチするか (前方一致で階層タグ対応) */
function matchesTags(noteTags, filterTags) {
    if (!Array.isArray(noteTags))
        return false;
    return filterTags.some((ft) => noteTags.some((nt) => nt === ft || nt.startsWith(ft + "/")));
}
/** キーワードがfrontmatter + 本文にマッチするか */
function matchesQuery(note, query) {
    const lower = query.toLowerCase();
    const keywords = lower.split(/\s+/).filter((k) => k.length > 0);
    const searchText = [
        String(note.frontmatter.title ?? ""),
        String(note.frontmatter.query ?? ""),
        note.preview,
    ].join(" ").toLowerCase();
    return keywords.every((kw) => searchText.includes(kw));
}
export const knowledgeSearchTool = {
    name: "knowledge_search",
    definition: {
        type: "function",
        function: {
            name: "knowledge_search",
            description: "Obsidian Vaultに保存されたナレッジノートを検索する。" +
                "過去に記録した調査結果やWebコンテンツから関連情報を探す。",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "検索キーワード (タイトル・本文・元クエリにマッチ)",
                    },
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description: "タグフィルタ (前方一致: 'technology' は 'technology/frontend' にもマッチ)",
                    },
                    type: {
                        type: "string",
                        enum: ["web", "research", "reference"],
                        description: "ノート種別フィルタ",
                    },
                    limit: {
                        type: "number",
                        description: "最大件数 (デフォルト: 10)",
                    },
                },
                required: ["query"],
            },
        },
    },
    async execute(params) {
        const config = getObsidianConfig();
        if (!config?.vaultPath) {
            return {
                success: false,
                output: "",
                error: "Obsidian Vaultが設定されていません。/knowledge vault <path> で設定してください。",
            };
        }
        const basePath = getKnowledgeBasePath();
        if (!basePath || !fs.existsSync(basePath)) {
            return {
                success: true,
                output: "ナレッジノートはまだありません。",
            };
        }
        const query = params.query ?? "";
        const filterTags = params.tags ?? [];
        const filterType = params.type;
        const limit = params.limit ?? 10;
        // 全ノートを列挙・解析
        const allFiles = walkMdFiles(basePath);
        const notes = [];
        for (const f of allFiles) {
            const note = loadNote(f, config.vaultPath);
            if (note)
                notes.push(note);
        }
        // フィルタリング
        let filtered = notes;
        if (filterType) {
            filtered = filtered.filter((n) => n.frontmatter.type === filterType);
        }
        if (filterTags.length > 0) {
            filtered = filtered.filter((n) => matchesTags(n.frontmatter.tags, filterTags));
        }
        if (query.trim().length > 0) {
            filtered = filtered.filter((n) => matchesQuery(n, query));
        }
        // 日付降順ソート (ファイル名にYYYY-MM-DDが含まれる前提)
        filtered.sort((a, b) => b.relativePath.localeCompare(a.relativePath));
        const results = filtered.slice(0, limit);
        if (results.length === 0) {
            return {
                success: true,
                output: `検索結果: 0件 (query="${query}"${filterTags.length ? `, tags=[${filterTags.join(",")}]` : ""}${filterType ? `, type=${filterType}` : ""})`,
            };
        }
        // 結果整形
        const lines = [];
        lines.push(`検索結果: ${results.length}件 / ${filtered.length}件中 (全${notes.length}ノート)`);
        lines.push("");
        for (const note of results) {
            const title = note.frontmatter.title ?? path.basename(note.filePath, ".md");
            const tags = Array.isArray(note.frontmatter.tags)
                ? note.frontmatter.tags.join(", ")
                : "";
            const created = note.frontmatter.created ?? "";
            lines.push(`### ${title}`);
            lines.push(`パス: ${note.relativePath}`);
            if (tags)
                lines.push(`タグ: ${tags}`);
            if (created)
                lines.push(`作成: ${created}`);
            lines.push("");
            // プレビュー (先頭200文字)
            const shortPreview = note.preview.slice(0, 200).trim();
            if (shortPreview) {
                lines.push(shortPreview + (note.preview.length > 200 ? "..." : ""));
                lines.push("");
            }
            lines.push("---");
            lines.push("");
        }
        return {
            success: true,
            output: lines.join("\n"),
        };
    },
};
//# sourceMappingURL=knowledge-search.js.map