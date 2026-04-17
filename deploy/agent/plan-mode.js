import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import inquirer from "inquirer";
import chalk from "chalk";
import { nonTTYReader } from "../utils/non-tty-reader.js";
export class PlanManager {
    currentPlan = null;
    plansDir;
    constructor() {
        this.plansDir = path.join(os.homedir(), ".localllm", "plans");
        fs.mkdirSync(this.plansDir, { recursive: true });
    }
    getState() {
        return this.currentPlan?.state ?? "idle";
    }
    isInPlanMode() {
        return this.currentPlan !== null && this.currentPlan.state === "planning";
    }
    enterPlanMode() {
        const id = `plan-${Date.now()}`;
        const filePath = path.join(this.plansDir, `${id}.md`);
        this.currentPlan = {
            id,
            state: "planning",
            content: "",
            filePath,
            createdAt: new Date().toISOString(),
        };
        return this.currentPlan;
    }
    updatePlanContent(content) {
        if (this.currentPlan) {
            this.currentPlan.content = content;
            fs.writeFileSync(this.currentPlan.filePath, content, "utf-8");
        }
    }
    async requestApproval() {
        if (!this.currentPlan) {
            return { approved: false, feedback: "No active plan" };
        }
        this.currentPlan.state = "awaiting_approval";
        // Display the plan
        console.log(chalk.bold("\n  ======== 実装計画 ========\n"));
        console.log(this.currentPlan.content);
        console.log(chalk.bold("\n  ==========================\n"));
        let action;
        if (!process.stdin.isTTY) {
            // 非TTYモード（パイプ等）: テキストメニューにフォールバック
            process.stdout.write(`  1: 承認して実装開始\n` +
                `  2: フィードバックを追加\n` +
                `  3: 却下\n` +
                `選択 [1-3]: `);
            const answer = await nonTTYReader.readLine();
            const map = { "1": "approve", "2": "feedback", "3": "reject" };
            action = map[answer?.trim()] ?? "approve";
        }
        else {
            const result = await inquirer.prompt([
                {
                    type: "list",
                    name: "action",
                    message: "この計画を承認しますか？",
                    choices: [
                        { name: "承認して実装開始", value: "approve" },
                        { name: "フィードバックを追加", value: "feedback" },
                        { name: "却下", value: "reject" },
                    ],
                },
            ]);
            action = result.action;
        }
        if (action === "approve") {
            this.currentPlan.state = "approved";
            return { approved: true };
        }
        if (action === "feedback") {
            let feedback;
            if (!process.stdin.isTTY) {
                process.stdout.write(`フィードバック: `);
                feedback = await nonTTYReader.readLine();
            }
            else {
                const result = await inquirer.prompt([
                    {
                        type: "input",
                        name: "feedback",
                        message: "フィードバック:",
                    },
                ]);
                feedback = result.feedback;
            }
            this.currentPlan.state = "planning";
            this.currentPlan.feedback = feedback;
            return { approved: false, feedback };
        }
        this.currentPlan.state = "rejected";
        return { approved: false, feedback: "ユーザーが計画を却下しました" };
    }
    exitPlanMode() {
        if (this.currentPlan) {
            this.currentPlan.state = "idle";
        }
        this.currentPlan = null;
    }
    getCurrentPlan() {
        return this.currentPlan;
    }
    /** planモードで許可するツール（調査+設計。実装系はブロックしないが注意喚起で制御） */
    static getPlanModeAllowedTools() {
        // 全ツール許可。ツール制限ではなくシステムプロンプト+ハーネス検出で制御する
        // （Claude Codeと同じアプローチ: 行動方針として制限、機械的ブロックはしない）
        return new Set([
            "file_read", "file_write", "file_edit", "glob", "grep",
            "web_fetch", "web_search", "bash",
            "ask_user", "todo_write", "exit_plan_mode",
            "enter_plan_mode", "knowledge_search", "knowledge_save",
            "second_llm_consult", "second_llm_agent",
        ]);
    }
    /** planモード中に使うと「実装開始」とみなすツール */
    static getImplementationTools() {
        return new Set(["file_write", "file_edit"]);
    }
}
//# sourceMappingURL=plan-mode.js.map