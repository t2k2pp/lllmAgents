import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import inquirer from "inquirer";
import chalk from "chalk";

export type PlanState = "idle" | "planning" | "awaiting_approval" | "approved" | "rejected";

export interface Plan {
  id: string;
  state: PlanState;
  content: string;
  filePath: string;
  createdAt: string;
  feedback?: string;
}

export class PlanManager {
  private currentPlan: Plan | null = null;
  private plansDir: string;

  constructor() {
    this.plansDir = path.join(os.homedir(), ".localllm", "plans");
    fs.mkdirSync(this.plansDir, { recursive: true });
  }

  getState(): PlanState {
    return this.currentPlan?.state ?? "idle";
  }

  isInPlanMode(): boolean {
    return this.currentPlan !== null && this.currentPlan.state === "planning";
  }

  enterPlanMode(): Plan {
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

  updatePlanContent(content: string): void {
    if (this.currentPlan) {
      this.currentPlan.content = content;
      fs.writeFileSync(this.currentPlan.filePath, content, "utf-8");
    }
  }

  async requestApproval(): Promise<{ approved: boolean; feedback?: string }> {
    if (!this.currentPlan) {
      return { approved: false, feedback: "No active plan" };
    }

    this.currentPlan.state = "awaiting_approval";

    // Display the plan
    console.log(chalk.bold("\n  ======== 実装計画 ========\n"));
    console.log(this.currentPlan.content);
    console.log(chalk.bold("\n  ==========================\n"));

    const { action } = await inquirer.prompt<{ action: string }>([
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

    if (action === "approve") {
      this.currentPlan.state = "approved";
      return { approved: true };
    }

    if (action === "feedback") {
      const { feedback } = await inquirer.prompt<{ feedback: string }>([
        {
          type: "input",
          name: "feedback",
          message: "フィードバック:",
        },
      ]);
      this.currentPlan.state = "planning";
      this.currentPlan.feedback = feedback;
      return { approved: false, feedback };
    }

    this.currentPlan.state = "rejected";
    return { approved: false, feedback: "ユーザーが計画を却下しました" };
  }

  exitPlanMode(): void {
    if (this.currentPlan) {
      this.currentPlan.state = "idle";
    }
    this.currentPlan = null;
  }

  getCurrentPlan(): Plan | null {
    return this.currentPlan;
  }

  /** List of read-only tools allowed during planning */
  static getPlanModeAllowedTools(): Set<string> {
    return new Set([
      "file_read", "glob", "grep", "web_fetch", "web_search",
      "ask_user", "todo_write", "exit_plan_mode",
    ]);
  }
}
