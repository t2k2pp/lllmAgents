import * as readline from "node:readline";
import chalk from "chalk";
import type { AgentLoop } from "../agent/agent-loop.js";
import { displayHelp } from "./renderer.js";
import { estimateMessageTokens } from "../agent/token-counter.js";

export class REPL {
  private rl: readline.Interface;

  constructor(private agent: AgentLoop) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async start(): Promise<void> {
    const prompt = () => {
      this.rl.question(chalk.green("> "), async (input) => {
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

        // Send to agent
        try {
          await this.agent.run(trimmed);
        } catch (e) {
          console.error(chalk.red(`\n  Error: ${e instanceof Error ? e.message : String(e)}\n`));
        }

        prompt();
      });
    };

    prompt();

    // Handle Ctrl+C gracefully
    this.rl.on("SIGINT", () => {
      console.log(chalk.dim("\n  (Ctrl+C)"));
      prompt();
    });
  }

  private async handleCommand(cmd: string): Promise<string | void> {
    switch (cmd.toLowerCase()) {
      case "/help":
        displayHelp();
        break;
      case "/quit":
      case "/exit":
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
        console.log(chalk.dim(`  Messages: ${messages.length}`));
        console.log(chalk.dim(`  Estimated tokens: ${tokens}`));
        break;
      }
      default:
        console.log(chalk.yellow(`  Unknown command: ${cmd}`));
        displayHelp();
    }
  }
}
