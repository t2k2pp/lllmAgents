/**
 * ファイル変更のカラーdiff表示。
 * file_edit / file_write の実行結果をユーザーにわかりやすく表示する。
 * シンタックスハイライト付き。
 */
import chalk from "chalk";
import * as path from "node:path";
const EXT_MAP = {
    ".ts": "ts", ".tsx": "ts", ".mts": "ts",
    ".js": "js", ".jsx": "js", ".mjs": "js",
    ".py": "py", ".pyw": "py",
    ".json": "json", ".jsonc": "json",
    ".css": "css", ".scss": "css", ".less": "css",
    ".html": "html", ".htm": "html", ".vue": "html", ".svelte": "html",
    ".md": "md", ".mdx": "md",
    ".sh": "sh", ".bash": "sh", ".zsh": "sh",
};
function detectLang(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return EXT_MAP[ext] ?? "unknown";
}
// 予約語パターン（言語別）
const KEYWORDS = {
    ts: /\b(import|export|from|const|let|var|function|class|interface|type|enum|async|await|return|if|else|for|while|switch|case|break|default|new|this|super|extends|implements|typeof|instanceof|void|null|undefined|true|false|try|catch|finally|throw|as|in|of|readonly|private|protected|public|static|abstract|override)\b/g,
    js: /\b(import|export|from|const|let|var|function|class|async|await|return|if|else|for|while|switch|case|break|default|new|this|super|extends|typeof|instanceof|void|null|undefined|true|false|try|catch|finally|throw|in|of|yield)\b/g,
    py: /\b(import|from|def|class|return|if|elif|else|for|while|with|as|in|not|and|or|is|None|True|False|try|except|finally|raise|yield|async|await|pass|break|continue|lambda|global|nonlocal|self)\b/g,
    sh: /\b(if|then|else|elif|fi|for|do|done|while|until|case|esac|function|return|exit|export|local|readonly|source|echo|cd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk)\b/g,
};
// 型名パターン（TS/JS）
const TYPE_PATTERN = /\b([A-Z][a-zA-Z0-9]+)\b/g;
/**
 * コードの1行にシンタックスハイライトを適用する。
 * diffの +-行の色（red/green）の上にさらに予約語等の色を重ねる。
 */
function highlightLine(line, lang, baseColor) {
    if (lang === "unknown" || lang === "md" || lang === "json") {
        // JSON: キーとstringsだけ色分け
        if (lang === "json") {
            return highlightJson(line, baseColor);
        }
        return baseColor === "red" ? chalk.red(line) : chalk.green(line);
    }
    // コメント行はdim表示
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        return baseColor === "red"
            ? chalk.red.dim(line)
            : chalk.green.dim(line);
    }
    // 文字列リテラルを退避（予約語ハイライトが文字列内に適用されないように）
    const strings = [];
    let processed = line.replace(/(["'`])(?:\\.|(?!\1).)*?\1/g, (match) => {
        strings.push(match);
        return `\x00STR${strings.length - 1}\x00`;
    });
    // 予約語ハイライト
    const kwPattern = KEYWORDS[lang] ?? KEYWORDS.js;
    processed = processed.replace(kwPattern, (kw) => {
        return baseColor === "red"
            ? chalk.red.bold(kw)
            : chalk.green.bold(kw);
    });
    // 型名（大文字始まり）のハイライト — TS/JSのみ
    if (lang === "ts" || lang === "js") {
        processed = processed.replace(TYPE_PATTERN, (match) => {
            return baseColor === "red"
                ? chalk.redBright(match)
                : chalk.greenBright(match);
        });
    }
    // 文字列リテラルを復元（黄色系で表示）
    processed = processed.replace(/\x00STR(\d+)\x00/g, (_m, idx) => {
        const s = strings[parseInt(idx)];
        return baseColor === "red"
            ? chalk.red(chalk.italic(s))
            : chalk.green(chalk.italic(s));
    });
    // 数値リテラル
    processed = processed.replace(/\b(\d+(?:\.\d+)?)\b/g, (num) => {
        return baseColor === "red"
            ? chalk.red(num)
            : chalk.green(num);
    });
    return processed;
}
function highlightJson(line, baseColor) {
    const colorFn = baseColor === "red" ? chalk.red : chalk.green;
    // JSON キー
    return line.replace(/"([^"]+)"\s*:/g, (_m, key) => {
        return baseColor === "red"
            ? chalk.red.bold(`"${key}"`) + ":"
            : chalk.green.bold(`"${key}"`) + ":";
    }).replace(/:\s*"([^"]*)"/g, (_m, val) => {
        return `: ${colorFn.italic(`"${val}"`)}`;
    });
}
// ─── Diff生成 ──────────────────────────────────────────
/** unified diff 風の行単位差分を生成する */
export function generateLineDiff(oldText, newText, lang = "unknown") {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    // 変更範囲を特定（前後の共通部分を除く）
    let commonStart = 0;
    while (commonStart < oldLines.length &&
        commonStart < newLines.length &&
        oldLines[commonStart] === newLines[commonStart]) {
        commonStart++;
    }
    let commonEnd = 0;
    while (commonEnd < oldLines.length - commonStart &&
        commonEnd < newLines.length - commonStart &&
        oldLines[oldLines.length - 1 - commonEnd] === newLines[newLines.length - 1 - commonEnd]) {
        commonEnd++;
    }
    const removedLines = oldLines.slice(commonStart, oldLines.length - commonEnd);
    const addedLines = newLines.slice(commonStart, newLines.length - commonEnd);
    return buildDiffOutput(commonStart, removedLines, addedLines, lang);
}
function buildDiffOutput(startLine, removedLines, addedLines, lang) {
    const output = [];
    // ヘッダー: 変更位置
    const oldStart = startLine + 1;
    const newStart = startLine + 1;
    output.push(chalk.cyan(`@@ -${oldStart},${removedLines.length} +${newStart},${addedLines.length} @@`));
    // 削除行（シンタックスハイライト付き）
    for (const line of removedLines) {
        output.push(`${chalk.red("- ")}${highlightLine(line, lang, "red")}`);
    }
    // 追加行（シンタックスハイライト付き）
    for (const line of addedLines) {
        output.push(`${chalk.green("+ ")}${highlightLine(line, lang, "green")}`);
    }
    return output;
}
// ─── 公開API ───────────────────────────────────────────
/**
 * file_edit の変更を色付きで表示する。
 * old_string / new_string から直接diffを生成。
 */
export function renderEditDiff(filePath, oldString, newString, occurrences) {
    const shortPath = shortenPath(filePath);
    const lang = detectLang(filePath);
    console.log(chalk.dim(`  ── ${shortPath} ──`));
    const diffLines = generateLineDiff(oldString, newString, lang);
    for (const line of diffLines) {
        console.log(`  ${line}`);
    }
    if (occurrences > 1) {
        console.log(chalk.dim(`  (${occurrences} 箇所を置換)`));
    }
}
/**
 * file_write の上書き変更を色付きで表示する。
 * 既存ファイルとの差分が大きすぎる場合はサマリーのみ。
 */
export function renderWriteDiff(filePath, oldContent, newContent) {
    const shortPath = shortenPath(filePath);
    const lang = detectLang(filePath);
    if (oldContent === null) {
        // 新規ファイル
        const lineCount = newContent.split("\n").length;
        console.log(chalk.dim(`  ── ${shortPath} (new, ${lineCount} lines) ──`));
        // 先頭数行だけプレビュー
        const previewLines = newContent.split("\n").slice(0, 8);
        for (const line of previewLines) {
            console.log(`  ${chalk.green("+ ")}${highlightLine(line, lang, "green")}`);
        }
        if (lineCount > 8) {
            console.log(chalk.dim(`  ... (${lineCount - 8} more lines)`));
        }
        return;
    }
    // 上書き: 差分が大きすぎなければdiff表示
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const diffLines = generateLineDiff(oldContent, newContent, lang);
    // 差分行が多すぎる場合はサマリー
    if (diffLines.length > 40) {
        console.log(chalk.dim(`  ── ${shortPath} (${oldLines.length} → ${newLines.length} lines) ──`));
        const removed = diffLines.filter((l) => l.includes("\x1b[31m")).length;
        const added = diffLines.filter((l) => l.includes("\x1b[32m")).length;
        console.log(chalk.dim(`  ${chalk.red(`-${removed}`)} / ${chalk.green(`+${added}`)} lines changed`));
        return;
    }
    console.log(chalk.dim(`  ── ${shortPath} ──`));
    for (const line of diffLines) {
        console.log(`  ${line}`);
    }
}
function shortenPath(p) {
    try {
        const cwd = process.cwd();
        if (p.startsWith(cwd)) {
            const rel = p.slice(cwd.length).replace(/^[\\/]+/, "");
            return rel || ".";
        }
    }
    catch { /* ignore */ }
    return p;
}
//# sourceMappingURL=diff-display.js.map