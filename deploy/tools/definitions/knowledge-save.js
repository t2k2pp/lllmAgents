import * as fs from "node:fs";
import * as path from "node:path";
/** Obsidian設定への参照 (index.ts から注入) */
let obsidianConfig = null;
export function setObsidianConfig(config) {
    obsidianConfig = config;
}
export function getObsidianConfig() {
    return obsidianConfig;
}
/** Vault のナレッジディレクトリの絶対パスを返す */
export function getKnowledgeBasePath() {
    if (!obsidianConfig?.vaultPath)
        return null;
    const knowledgeDir = obsidianConfig.knowledgeDir ?? "Knowledge";
    return path.join(obsidianConfig.vaultPath, knowledgeDir);
}
/** ファイル名に使えない文字を除去し、タイトルからslugを生成 */
function slugify(title) {
    return title
        .replace(/[\\/:*?"<>|#^[\]]/g, "") // Obsidian非対応文字
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80); // 長すぎるファイル名を防止
}
/** 日付文字列 YYYY-MM-DD を返す */
function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** ISO 8601 タイムスタンプを返す */
function nowISO() {
    return new Date().toISOString();
}
/** 同名ファイルが存在する場合、連番サフィックスを付けて一意なパスを返す */
function uniquePath(dir, baseName) {
    const ext = ".md";
    let candidate = path.join(dir, baseName + ext);
    if (!fs.existsSync(candidate))
        return candidate;
    for (let i = 2; i <= 99; i++) {
        candidate = path.join(dir, `${baseName}_${i}${ext}`);
        if (!fs.existsSync(candidate))
            return candidate;
    }
    // 極端なケース: タイムスタンプを付加
    return path.join(dir, `${baseName}_${Date.now()}${ext}`);
}
/** source URL で既存ノートを検索 (重複防止) */
function findExistingBySource(dir, sourceUrl) {
    if (!fs.existsSync(dir))
        return null;
    try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
        for (const file of files) {
            const filePath = path.join(dir, file);
            const head = fs.readFileSync(filePath, "utf-8").slice(0, 2000);
            if (head.includes(`source: "${sourceUrl}"`) || head.includes(`- "${sourceUrl}"`)) {
                return filePath;
            }
        }
    }
    catch { /* ignore */ }
    return null;
}
/** YAML frontmatter + 本文のMarkdownを構築 */
function buildNote(params) {
    const defaultTags = obsidianConfig?.defaultTags ?? ["lllmagents"];
    const allTags = [...new Set([...defaultTags, ...params.tags])];
    const fm = ["---"];
    fm.push(`title: "${params.title.replace(/"/g, '\\"')}"`);
    fm.push(`type: ${params.type}`);
    if (params.source && params.source.length > 0) {
        if (params.source.length === 1) {
            fm.push(`source: "${params.source[0]}"`);
        }
        else {
            fm.push("source:");
            for (const s of params.source) {
                fm.push(`  - "${s}"`);
            }
        }
    }
    if (params.query) {
        fm.push(`query: "${params.query.replace(/"/g, '\\"')}"`);
    }
    fm.push("tags:");
    for (const t of allTags) {
        fm.push(`  - ${t}`);
    }
    fm.push(`created: ${nowISO()}`);
    if (params.sessionId) {
        fm.push(`agent_session: "${params.sessionId}"`);
    }
    fm.push("---");
    fm.push("");
    return fm.join("\n") + params.content;
}
const TYPE_DIRS = {
    web: "web",
    research: "research",
    reference: "reference",
};
export const knowledgeSaveTool = {
    name: "knowledge_save",
    definition: {
        type: "function",
        function: {
            name: "knowledge_save",
            description: "調査結果やWebコンテンツをObsidian Vaultにナレッジノートとして保存する。" +
                "ユーザーが「記録して」「ナレッジに保存して」と指示した場合に使用する。" +
                "タグは階層構造を推奨 (例: technology/frontend, language/typescript)。",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "ノートのタイトル (日本語)",
                    },
                    content: {
                        type: "string",
                        description: "ノート本文 (Markdown形式、日本語)。## 要約、## 主要ポイント、## 詳細、## ソース のセクション構成を推奨",
                    },
                    type: {
                        type: "string",
                        enum: ["web", "research", "reference"],
                        description: "ノート種別: web=Web検索/取得結果, research=調査まとめ, reference=リファレンス/チートシート",
                    },
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description: "タグ配列。階層タグ推奨 (例: ['technology/frontend', 'framework/react'])",
                    },
                    source: {
                        type: "array",
                        items: { type: "string" },
                        description: "情報のソースURL (複数可)",
                    },
                    query: {
                        type: "string",
                        description: "元の検索クエリ (あれば)",
                    },
                },
                required: ["title", "content", "type", "tags"],
            },
        },
    },
    async execute(params) {
        if (!obsidianConfig?.vaultPath) {
            return {
                success: false,
                output: "",
                error: "Obsidian Vaultが設定されていません。/knowledge vault <path> で設定してください。",
            };
        }
        if (!fs.existsSync(obsidianConfig.vaultPath)) {
            return {
                success: false,
                output: "",
                error: `Vaultパスが存在しません: ${obsidianConfig.vaultPath}`,
            };
        }
        const title = params.title;
        const content = params.content;
        const type = params.type ?? "research";
        const tags = params.tags ?? [];
        const source = params.source;
        const query = params.query;
        // 重複チェック: 同じソースURLのノートが既にあるか
        const knowledgeDir = obsidianConfig.knowledgeDir ?? "Knowledge";
        const typeDir = TYPE_DIRS[type] ?? "research";
        const targetDir = path.join(obsidianConfig.vaultPath, knowledgeDir, typeDir);
        if (source && source.length > 0) {
            const existing = findExistingBySource(targetDir, source[0]);
            if (existing) {
                return {
                    success: false,
                    output: "",
                    error: `同じソースURLのノートが既に存在します: ${existing}`,
                };
            }
        }
        // ディレクトリ作成
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        // ファイル名生成: YYYY-MM-DD_slug.md
        const slug = slugify(title);
        const baseName = `${today()}_${slug}`;
        const filePath = uniquePath(targetDir, baseName);
        // ノート構築 & 書き込み
        const noteContent = buildNote({ title, content, type, tags, source, query });
        fs.writeFileSync(filePath, noteContent, "utf-8");
        const relativePath = path.relative(obsidianConfig.vaultPath, filePath).replace(/\\/g, "/");
        return {
            success: true,
            output: `ナレッジを保存しました: ${relativePath}\nタグ: ${tags.join(", ")}`,
        };
    },
};
//# sourceMappingURL=knowledge-save.js.map