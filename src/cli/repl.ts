import * as readline from "node:readline";
import chalk from "chalk";
import type { AgentLoop } from "../agent/agent-loop.js";
import { displayHelp } from "./renderer.js";
import { estimateMessageTokens } from "../agent/token-counter.js";
import { formatTodos } from "../tools/definitions/todo-write.js";
import { listSessions, loadSession, getLatestSession } from "../agent/session-manager.js";
import { loadMemory, saveMemory } from "../agent/memory.js";
import { resolveAtMentions, printMentionFeedback } from "./input-resolver.js";
import type { Config } from "../config/types.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { PlanManager } from "../agent/plan-mode.js";
import type { ContextModeManager, ContextMode } from "../context/context-mode.js";

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
    private contextModeManager?: ContextModeManager,
  ) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /**
   * REPLを起動し、ユーザーが /quit するまで resolve しない。
   * index.ts の await repl.start() はユーザーが終了を選ぶまでブロックされる。
   */
  async start(): Promise<void> {
    return new Promise<void>((resolveRepl) => {
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
            if (handled === "quit") {
              resolveRepl();
              return;
            }
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
        resolveRepl();
      });
    });
  }

  private async processInput(input: string): Promise<void> {
    try {
      // @ファイル/フォルダ参照を解決してコンテキストに展開
      const { resolved, mentions } = resolveAtMentions(input);
      if (mentions.length > 0) {
        printMentionFeedback(mentions);
      }
      await this.agent.run(resolved);
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

      case "/model": {
        if (args.length === 0) {
          // /model (no args) - show current model info
          console.log(chalk.dim(`  現在のモデル: ${this.agent.getModel()}`));
          console.log(chalk.dim(`  プロバイダー: ${this.config.mainLLM.providerType} @ ${this.config.mainLLM.baseUrl}`));
          if (this.config.visionLLM) {
            console.log(chalk.dim(`  Vision: ${this.config.visionLLM.model} @ ${this.config.visionLLM.baseUrl}`));
          }
        } else if (args[0] === "list") {
          // /model list - list available models from the provider
          try {
            const models = await this.agent.getProvider().listModels();
            if (models.length === 0) {
              console.log(chalk.dim("  利用可能なモデルはありません。"));
            } else {
              console.log(chalk.dim("  利用可能なモデル:"));
              const currentModel = this.agent.getModel();
              for (const m of models) {
                const marker = m.name === currentModel ? chalk.green(" ← current") : "";
                const sizeLabel = m.size > 0 ? chalk.dim(` (${(m.size / 1e9).toFixed(1)}GB)`) : "";
                console.log(chalk.dim(`    ${chalk.cyan(m.name)}${sizeLabel}${marker}`));
              }
            }
          } catch (e) {
            console.log(chalk.red(`  モデル一覧の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`));
          }
        } else {
          // /model <name> - switch to a different model
          const newModel = args[0];
          const oldModel = this.agent.getModel();
          if (newModel === oldModel) {
            console.log(chalk.dim(`  既に ${newModel} を使用中です。`));
          } else {
            this.agent.setModel(newModel);
            this.config.mainLLM.model = newModel;
            console.log(chalk.dim(`  モデルを ${chalk.yellow(oldModel)} から ${chalk.cyan(newModel)} に切り替えました`));
          }
        }
        break;
      }

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

      case "/continue": {
        const latest = getLatestSession();
        if (!latest) {
          console.log(chalk.yellow("  復元可能なセッションがありません。"));
          break;
        }
        this.agent.restoreSession(latest);
        console.log(chalk.dim(`  最新セッションを復元しました: ${latest.meta.id} (${latest.meta.messageCount} messages)`));
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

      case "/mode": {
        if (!this.contextModeManager) {
          console.log(chalk.dim("  コンテキストモードシステムが初期化されていません。"));
          break;
        }
        const modeArg = args[0] as ContextMode | undefined;
        if (!modeArg) {
          const info = this.contextModeManager.getModeInfo();
          console.log(chalk.dim(`  Current mode: ${chalk.cyan(this.contextModeManager.currentMode)} (${info.name})`));
          console.log(chalk.dim(`  ${info.description}`));
          console.log(chalk.dim(`  Priority: ${info.priority}`));
        } else if (modeArg === "dev" || modeArg === "review" || modeArg === "research") {
          this.contextModeManager.switchMode(modeArg);
          const info = this.contextModeManager.getModeInfo();
          console.log(chalk.dim(`  Switched to ${chalk.cyan(modeArg)} mode (${info.name})`));
          console.log(chalk.dim(`  Priority: ${info.priority}`));
        } else {
          console.log(chalk.yellow(`  Unknown mode: ${modeArg}`));
          console.log(chalk.dim("  Available modes: dev, review, research"));
        }
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
