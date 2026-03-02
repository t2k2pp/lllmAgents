import * as readline from "node:readline";
import chalk from "chalk";
import type { AgentLoop } from "../agent/agent-loop.js";
import { displayHelp } from "./renderer.js";
import { estimateMessageTokens } from "../agent/token-counter.js";
import { formatTodos } from "../tools/definitions/todo-write.js";
import { listSessions, loadSession } from "../agent/session-manager.js";
import { loadMemory, saveMemory } from "../agent/memory.js";
import type { Config } from "../config/types.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { PlanManager } from "../agent/plan-mode.js";

export class REPL {
  private rl: readline.Interface;
  private multilineBuffer: string[] = [];
  private isMultiline = false;
  private lineNumber = 0;

  constructor(
    private agent: AgentLoop,
    private config: Config,
    private skillRegistry?: SkillRegistry,
    private planManager?: PlanManager,
  ) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async start(): Promise<void> {
    const prompt = () => {
      let prefix: string;
      if (this.isMultiline) {
        this.lineNumber++;
        prefix = chalk.dim(`${String(this.lineNumber).padStart(3)}| `);
      } else if (this.planManager?.isInPlanMode()) {
        prefix = chalk.yellow("[plan] > ");
      } else {
        prefix = chalk.green("> ");
      }

      this.rl.question(prefix, async (input) => {
        // Multi-line mode: triple backtick to start/end
        if (input.trim() === "```" && !this.isMultiline) {
          this.isMultiline = true;
          this.multilineBuffer = [];
          this.lineNumber = 0;
          console.log(chalk.dim("  マルチライン入力モード (``` で終了)"));
          prompt();
          return;
        }
        if (input.trim() === "```" && this.isMultiline) {
          this.isMultiline = false;
          const fullInput = this.multilineBuffer.join("\n");
          this.multilineBuffer = [];
          this.lineNumber = 0;
          if (fullInput.trim()) {
            await this.processInput(fullInput);
          }
          prompt();
          return;
        }
        if (this.isMultiline) {
          this.multilineBuffer.push(input);
          prompt();
          return;
        }

        const trimmed = input.trim();
        if (!trimmed) {
          prompt();
          return;
        }

        // Handle commands
        if (trimmed.startsWith("/")) {
          const handled = await this.handleCommand(trimmed);
          if (handled === "quit") return;
          prompt();
          return;
        }

        await this.processInput(trimmed);
        prompt();
      });
    };

    prompt();

    this.rl.on("SIGINT", () => {
      if (this.isMultiline) {
        this.isMultiline = false;
        this.multilineBuffer = [];
        this.lineNumber = 0;
        console.log(chalk.dim("\n  (マルチライン入力をキャンセル)"));
      } else {
        console.log(chalk.dim("\n  (Ctrl+C) /quit で終了"));
      }
      prompt();
    });

    this.rl.on("close", () => {
      this.agent.saveCurrentSession();
    });
  }

  private async processInput(input: string): Promise<void> {
    try {
      await this.agent.run(input);
    } catch (e) {
      console.error(chalk.red(`\n  Error: ${e instanceof Error ? e.message : String(e)}\n`));
    }
  }

  private async handleCommand(cmd: string): Promise<string | void> {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Check if it's a skill trigger
    if (this.skillRegistry) {
      const skill = this.skillRegistry.get(command);
      if (skill) {
        console.log(chalk.dim(`\n  [Skill] ${skill.name}: ${skill.description}`));
        const skillPrompt = `${skill.content}\n\n${args.length > 0 ? `引数: ${args.join(" ")}` : "上記のスキル指示に従ってタスクを実行してください。"}`;
        await this.processInput(skillPrompt);
        return;
      }
    }

    switch (command) {
      case "/help":
        displayHelp();
        break;

      case "/quit":
      case "/exit":
        this.agent.saveCurrentSession();
        console.log(chalk.dim("\n  Goodbye!\n"));
        this.rl.close();
        return "quit";

      case "/clear":
        this.agent.getHistory().clear();
        console.log(chalk.dim("  会話履歴をクリアしました。"));
        break;

      case "/context": {
        const messages = this.agent.getHistory().getMessages();
        const tokens = estimateMessageTokens(messages);
        const ctxWindow = this.config.mainLLM.contextWindow ?? 4096;
        const pct = Math.round((tokens / ctxWindow) * 100);
        console.log(chalk.dim(`  Messages: ${messages.length}`));
        console.log(chalk.dim(`  Tokens: ~${tokens} / ${ctxWindow} (${pct}%)`));
        const bar = progressBar(pct);
        console.log(chalk.dim(`  ${bar}`));
        break;
      }

      case "/compact":
        console.log(chalk.dim("  コンテキストを圧縮中..."));
        await this.agent.forceCompress();
        console.log(chalk.dim("  完了。"));
        break;

      case "/model":
        console.log(chalk.dim(`  現在のモデル: ${this.config.mainLLM.model}`));
        console.log(chalk.dim(`  プロバイダー: ${this.config.mainLLM.providerType} @ ${this.config.mainLLM.baseUrl}`));
        if (this.config.visionLLM) {
          console.log(chalk.dim(`  Vision: ${this.config.visionLLM.model} @ ${this.config.visionLLM.baseUrl}`));
        }
        break;

      case "/todo":
        console.log(chalk.dim(formatTodos()));
        break;

      case "/sessions": {
        const sessions = listSessions(10);
        if (sessions.length === 0) {
          console.log(chalk.dim("  保存されたセッションはありません。"));
        } else {
          console.log(chalk.dim("  保存されたセッション:"));
          for (const s of sessions) {
            const date = new Date(s.updatedAt).toLocaleString();
            console.log(chalk.dim(`    ${s.id}  ${date}  ${s.title.slice(0, 50)}`));
          }
        }
        break;
      }

      case "/resume": {
        const sessionId = args[0];
        if (!sessionId) {
          console.log(chalk.yellow("  使い方: /resume <session-id>"));
          break;
        }
        const session = loadSession(sessionId);
        if (!session) {
          console.log(chalk.red(`  セッション ${sessionId} が見つかりません。`));
          break;
        }
        this.agent.restoreSession(session);
        console.log(chalk.dim(`  セッション ${sessionId} を復元しました (${session.meta.messageCount} messages)`));
        break;
      }

      case "/memory": {
        const mem = loadMemory();
        if (mem) {
          console.log(chalk.dim("  --- Memory ---"));
          console.log(chalk.dim(mem));
        } else {
          console.log(chalk.dim("  メモリは空です。"));
        }
        break;
      }

      case "/remember": {
        const text = args.join(" ");
        if (!text) {
          console.log(chalk.yellow("  使い方: /remember <記憶する内容>"));
          break;
        }
        const current = loadMemory();
        saveMemory(current ? `${current}\n- ${text}` : `- ${text}`);
        console.log(chalk.dim("  メモリに保存しました。"));
        break;
      }

      case "/diff": {
        console.log(chalk.dim("  直近のgit diffを表示..."));
        const { execSync } = await import("node:child_process");
        try {
          const diff = execSync("git diff --stat", { encoding: "utf-8", cwd: process.cwd() });
          console.log(diff || "  変更なし");
        } catch {
          console.log(chalk.yellow("  gitリポジトリではないか、git diffの実行に失敗しました。"));
        }
        break;
      }

      case "/plan":
        if (this.planManager?.isInPlanMode()) {
          console.log(chalk.yellow("  既にプランモードです。"));
        } else {
          await this.processInput("このタスクの実装計画を立てたい。enter_plan_modeを使ってプランモードに入ってください。");
        }
        break;

      case "/skills": {
        if (!this.skillRegistry) {
          console.log(chalk.dim("  スキルシステムが初期化されていません。"));
          break;
        }
        const skills = this.skillRegistry.list();
        if (skills.length === 0) {
          console.log(chalk.dim("  利用可能なスキルはありません。"));
        } else {
          console.log(chalk.dim("  利用可能なスキル:"));
          for (const s of skills) {
            const tag = s.builtIn ? chalk.dim("[builtin]") : chalk.dim("[custom]");
            console.log(chalk.dim(`    ${chalk.cyan(s.trigger)}  ${s.description}  ${tag}`));
          }
        }
        break;
      }

      case "/status": {
        const messages = this.agent.getHistory().getMessages();
        const tokens = estimateMessageTokens(messages);
        const ctxWindow = this.config.mainLLM.contextWindow ?? 4096;
        const pct = Math.round((tokens / ctxWindow) * 100);
        const planState = this.planManager?.getState() ?? "idle";
        const todoSummary = formatTodos();

        console.log(chalk.bold("\n  === Status ==="));
        console.log(chalk.dim(`  Model: ${this.config.mainLLM.model}`));
        console.log(chalk.dim(`  Context: ${progressBar(pct)}`));
        console.log(chalk.dim(`  Plan mode: ${planState}`));
        console.log(chalk.dim(`  Messages: ${messages.length}`));
        if (todoSummary.includes("pending") || todoSummary.includes("in_progress")) {
          console.log(chalk.dim(`\n  --- Tasks ---`));
          console.log(chalk.dim(todoSummary));
        }
        console.log();
        break;
      }

      default:
        console.log(chalk.yellow(`  Unknown command: ${cmd}`));
        console.log(chalk.dim("  /help でコマンド一覧を表示"));
    }
  }
}

function progressBar(pct: number): string {
  const width = 30;
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct > 80 ? chalk.red : pct > 60 ? chalk.yellow : chalk.green;
  return `[${color("█".repeat(filled))}${chalk.dim("░".repeat(empty))}] ${pct}%`;
}
