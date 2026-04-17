const DEV_STRATEGY = `
## ツール選択の原則
- ファイル内容の確認には file_read を使う。bash (cat/type/head) は使わない
- file_edit が失敗したら file_read で現在の内容を確認し正しい old_string で再試行する。2回失敗したら file_write でファイル全体を書き直す
- 新規ファイル作成は file_write を使う。コードをテキスト応答に書かない
- bash は git bash 構文で書く（cmd.exe/PowerShell 構文は不可）

## マルチファイルプロジェクト作成
1. ファイル一覧と依存関係を整理する（todo_write で管理）
2. 依存される側から順に作成する（定数/型定義 → ユーティリティ → コアロジック → UI → エントリポイント）
3. 各ファイルの export/インターフェースを意識し、呼び出し側と整合性を保つ
4. 独立した複数ファイルは1回のレスポンスで並列に file_write する
5. 全ファイル作成後、エントリポイントの import/参照を file_read で検証する

## エラー回復
- 同じ操作が2回失敗したら別のアプローチに切り替える（繰り返さない）
- file_edit 連続失敗 → file_write で全体書き直し
- bash エラー → エラーメッセージを読んで修正。認識されないコマンドなら file_read 等の専用ツールに切り替える
`;
const MODE_DEFINITIONS = {
    dev: {
        name: "Development",
        description: "Active development mode",
        priority: "Work -> Correct -> Clean",
        behavior: "Write code first, test after, commit atomically",
        preferredTools: ["file_write", "file_edit", "bash", "task"],
    },
    review: {
        name: "Code Review",
        description: "Code review mode",
        priority: "Critical > High > Medium > Low",
        behavior: "Thorough analysis, severity-based prioritization, provide solutions",
        preferredTools: ["file_read", "grep", "glob"],
    },
    research: {
        name: "Research",
        description: "Research and exploration mode",
        priority: "Understand -> Verify -> Document",
        behavior: "Explore and learn, read broadly, summarize findings",
        preferredTools: ["file_read", "grep", "glob", "web_fetch", "web_search"],
    },
};
export class ContextModeManager {
    currentMode = "dev";
    switchMode(mode) {
        this.currentMode = mode;
    }
    getPromptSection() {
        const def = MODE_DEFINITIONS[this.currentMode];
        let section = `
# Context Mode: ${def.name}
- Priority: ${def.priority}
- Behavior: ${def.behavior}
- Preferred tools: ${def.preferredTools.join(", ")}`;
        // devモードのみ: 作業戦略を注入
        if (this.currentMode === "dev") {
            section += `\n\n# 作業戦略\n${DEV_STRATEGY}`;
        }
        return section;
    }
    getModeInfo() {
        const def = MODE_DEFINITIONS[this.currentMode];
        return {
            name: def.name,
            description: def.description,
            priority: def.priority,
        };
    }
}
//# sourceMappingURL=context-mode.js.map