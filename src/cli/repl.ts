import chalk from "chalk";
import type { AgentLoop } from "../agent/agent-loop.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { displayHelp } from "./renderer.js";
import { estimateMessageTokens } from "../agent/token-counter.js";
import { formatTodos } from "../tools/definitions/todo-write.js";
import { listSessions, loadSession, getLatestSession } from "../agent/session-manager.js";
import { loadMemory, saveMemory } from "../agent/memory.js";
import { resolveAtMentions, printMentionFeedback } from "./input-resolver.js";
import {
  InteractiveInput,
  SIGINT_SIGNAL,
} from "./interactive-input.js";
import {
  createCommandMenuProvider,
  createFileMenuProvider,
} from "./completer.js";
import type { Config } from "../config/types.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { PlanManager } from "../agent/plan-mode.js";
import type { ContextModeManager, ContextMode } from "../context/context-mode.js";
import { sendDiscordNotification } from "../utils/discord.js";
import { saveConfig } from "../config/config-manager.js";

export class REPL {
  private input: InteractiveInput;
  private multilineBuffer: string[] = [];
  private isMultiline = false;
  private lineNumber = 0;

  constructor(
    private agent: AgentLoop,
    private config: Config,
    private skillRegistry?: SkillRegistry,
    private planManager?: PlanManager,
    private contextModeManager?: ContextModeManager,
    private secondLLMManager?: SecondLLMManager,
  ) {
    // スキル情報を取得してメニュープロバイダーに渡す
    const skillInfos = skillRegistry
      ? skillRegistry.list().map((s) => ({
          trigger: s.trigger,
          description: s.description,
        }))
      : [];

    this.input = new InteractiveInput({
      commandProvider: createCommandMenuProvider(skillInfos),
      filePathProvider: createFileMenuProvider(),
    });
  }

  /**
   * REPLメインループ。ユーザーが /quit するまで resolve しない。
   */
  async start(): Promise<void> {
    try {
      while (true) {
        const prefix = this.getPromptPrefix();
        // マルチラインモード中はドロップダウンを抑制
        const raw = await this.input.question(prefix, {
          disableMenu: this.isMultiline,
        });

        // ── Ctrl+C ──
        if (raw === SIGINT_SIGNAL) {
          if (this.isMultiline) {
            this.isMultiline = false;
            this.multilineBuffer = [];
            this.lineNumber = 0;
            console.log(chalk.dim("  (マルチライン入力をキャンセル)"));
          } else {
            console.log(chalk.dim("  (Ctrl+C) /quit で終了"));
          }
          continue;
        }

        // ── EOF (Ctrl+D on empty / stdin closed) ──
        if (raw === "" && !this.isMultiline) {
          continue;
        }

        // ── マルチライン: ``` で開始/終了 ──
        if (raw.trim() === "```" && !this.isMultiline) {
          this.isMultiline = true;
          this.multilineBuffer = [];
          this.lineNumber = 0;
          console.log(chalk.dim("  マルチライン入力モード (``` で終了)"));
          continue;
        }
        if (raw.trim() === "```" && this.isMultiline) {
          this.isMultiline = false;
          const fullInput = this.multilineBuffer.join("\n");
          this.multilineBuffer = [];
          this.lineNumber = 0;
          if (fullInput.trim()) {
            await this.processInput(fullInput);
          }
          continue;
        }
        if (this.isMultiline) {
          this.multilineBuffer.push(raw);
          continue;
        }

        const trimmed = raw.trim();
        if (!trimmed) continue;

        // ── スラッシュコマンド ──
        if (trimmed.startsWith("/")) {
          const result = await this.handleCommand(trimmed);
          if (result === "quit") break;
          continue;
        }

        // ── 通常入力 → エージェントへ ──
        await this.processInput(trimmed);
      }
    } finally {
      this.agent.saveCurrentSession();
      // stdin を pause してイベントループを解放し、プロセスを終了可能にする
      process.stdin.pause();
    }
  }

  // ─── プロンプトプレフィックス ────────────────────────

  private getPromptPrefix(): string {
    if (this.isMultiline) {
      this.lineNumber++;
      return chalk.dim(`${String(this.lineNumber).padStart(3)}| `);
    }
    if (this.planManager?.isInPlanMode()) {
      return chalk.yellow("[plan] > ");
    }
    return chalk.green("> ");
  }

  // ─── 入力処理 ──────────────────────────────────────

  private async processInput(input: string): Promise<void> {
    try {
      if (input.startsWith("@second ")) {
         if (!this.secondLLMManager || !this.secondLLMManager.isAvailable()) {
           console.log(chalk.red("  Second LLM is not configured or enabled."));
           return;
         }
         const prompt = input.slice("@second ".length).trim();
         console.log(chalk.dim("  Delegating to Second LLM..."));
         const result = await this.secondLLMManager.runAsAgent(prompt);
         console.log(chalk.cyan(`\n${result}\n`));
         return;
      }

      // @ファイル/フォルダ参照を解決してコンテキストに展開
      const { resolved, mentions } = resolveAtMentions(input);
      if (mentions.length > 0) {
        printMentionFeedback(mentions);
      }
      await this.agent.run(resolved);

      // LLMの応答が完了した後、Discord通知設定が有効なら送信する
      if (this.config.discord?.enabled && this.config.discord?.webhookUrl) {
        const historyMsgs = this.agent.getHistory().getMessages();
        // 直近のメッセージ（大抵はassistantのもの）を探す
        const lastMsg = historyMsgs[historyMsgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant" && typeof lastMsg.content === "string" && lastMsg.content.trim() !== "") {
          console.log(chalk.dim("  Sending response to Discord..."));
          await sendDiscordNotification(this.config.discord.webhookUrl, lastMsg.content);
        }
      }

    } catch (e) {
      console.error(
        chalk.red(`\n  Error: ${e instanceof Error ? e.message : String(e)}\n`),
      );
    }
  }

  // ─── コマンドハンドラ ──────────────────────────────

  private async handleCommand(cmd: string): Promise<string | void> {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    // スキルトリガーチェック（/chunkbaseシード値 のようにスペースなしで引数が続くケースに対応）
    if (this.skillRegistry) {
      const prefixMatch = this.skillRegistry.getByPrefix(cmd);
      if (prefixMatch) {
        const { skill, remainingArgs } = prefixMatch;
        console.log(
          chalk.dim(`\n  [Skill] ${skill.name}: ${skill.description}`),
        );
        const skillPrompt = `${skill.content}\n\n${remainingArgs ? `引数: ${remainingArgs}` : "上記のスキル指示に従ってタスクを実行してください。"}`;
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
          console.log(
            chalk.dim(`  現在のモデル: ${this.agent.getModel()}`),
          );
          console.log(
            chalk.dim(
              `  プロバイダー: ${this.config.mainLLM.providerType} @ ${this.config.mainLLM.baseUrl}`,
            ),
          );
          if (this.config.visionLLM) {
            console.log(
              chalk.dim(
                `  Vision: ${this.config.visionLLM.model} @ ${this.config.visionLLM.baseUrl}`,
              ),
            );
          }
        } else if (args[0] === "list") {
          try {
            const models = await this.agent.getProvider().listModels();
            if (models.length === 0) {
              console.log(chalk.dim("  利用可能なモデルはありません。"));
            } else {
              console.log(chalk.dim("  利用可能なモデル:"));
              const currentModel = this.agent.getModel();
              for (const m of models) {
                const marker =
                  m.name === currentModel ? chalk.green(" ← current") : "";
                const sizeLabel =
                  m.size > 0
                    ? chalk.dim(` (${(m.size / 1e9).toFixed(1)}GB)`)
                    : "";
                console.log(
                  chalk.dim(
                    `    ${chalk.cyan(m.name)}${sizeLabel}${marker}`,
                  ),
                );
              }
            }
          } catch (e) {
            console.log(
              chalk.red(
                `  モデル一覧の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          }
        } else {
          const newModel = args[0];
          const oldModel = this.agent.getModel();
          if (newModel === oldModel) {
            console.log(chalk.dim(`  既に ${newModel} を使用中です。`));
          } else {
            this.agent.setModel(newModel);
            this.config.mainLLM.model = newModel;
            console.log(
              chalk.dim(
                `  モデルを ${chalk.yellow(oldModel)} から ${chalk.cyan(newModel)} に切り替えました`,
              ),
            );
          }
        }
        break;
      }

      case "/todo":
        console.log(chalk.dim(formatTodos()));
        break;

      case "/cost": {
        const stats = globalTokenTracker.getSessionTotal();
        console.log(chalk.bold("\n  === Session Cost & Usage ==="));
        console.log(chalk.dim(`  Requests: ${stats.recordCount}`));
        console.log(chalk.dim(`  Input Tokens: ${stats.totalInputTokens.toLocaleString()}`));
        console.log(chalk.dim(`  Output Tokens: ${stats.totalOutputTokens.toLocaleString()}`));
        console.log(chalk.dim(`  Total Cost: $${stats.totalCostUsd.toFixed(4)}`));
        console.log();
        break;
      }

      case "/second": {
        if (!this.secondLLMManager) {
          console.log(chalk.dim("  セカンドLLMマネージャが初期化されていません。"));
          break;
        }
        
        const subCmd = args[0];
        if (!subCmd || subCmd === "status") {
          const isAvail = this.secondLLMManager.isAvailable();
          const p = this.secondLLMManager.getProvider();
          console.log(chalk.bold("\n  === Second LLM Status ==="));
          console.log(chalk.dim(`  Status: ${isAvail ? chalk.green("Available") : chalk.red("Disabled or Not Configured")}`));
          if (p) {
             const ep = this.secondLLMManager.getEndpoint();
             console.log(chalk.dim(`  Provider: ${ep?.providerType}`));
             console.log(chalk.dim(`  Model: ${ep?.model}`));
          }
          console.log();
        } else if (subCmd === "enable") {
           if (this.config.secondLLM) {
             this.config.secondLLM.enabled = true;
             console.log(chalk.green("  Second LLM を有効化しました。（再起動後に完全適用される場合があります）"));
           } else {
             console.log(chalk.red("  Second LLM の設定が config.json に存在しません。"));
           }
        } else if (subCmd === "disable") {
           if (this.config.secondLLM) {
             this.config.secondLLM.enabled = false;
             console.log(chalk.yellow("  Second LLM を無効化しました。"));
           }
        } else {
           console.log(chalk.yellow("  使い方: /second [status|enable|disable]"));
        }
        break;
      }

      case "/discord": {
        const subCmd = args[0];
        if (!subCmd || subCmd === "status") {
          const dEnabled = this.config.discord?.enabled ?? false;
          const dUrl = this.config.discord?.webhookUrl ?? "Not configured";
          console.log(chalk.bold("\n  === Discord Notification Status ==="));
          console.log(chalk.dim(`  Status: ${dEnabled ? chalk.green("Enabled") : chalk.yellow("Disabled")}`));
          console.log(chalk.dim(`  Webhook URL: ${dUrl}`));
          console.log();
        } else if (subCmd === "enable") {
          if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
          if (!this.config.discord.webhookUrl) {
            console.log(chalk.yellow("  注意: Webhook URL が設定されていません。先に '/discord url <URL>' を実行してください。"));
          }
          this.config.discord.enabled = true;
          saveConfig(this.config);
          console.log(chalk.green("  Discord 通知を有効化しました。"));
        } else if (subCmd === "disable") {
          if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
          this.config.discord.enabled = false;
          saveConfig(this.config);
          console.log(chalk.yellow("  Discord 通知を無効化しました。"));
        } else if (subCmd === "url") {
          const urlStr = args[1];
          if (!urlStr) {
            console.log(chalk.yellow("  使い方: /discord url <webhook-url>"));
          } else {
            if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
            this.config.discord.webhookUrl = urlStr;
            saveConfig(this.config);
            console.log(chalk.green(`  Discord Webhook URL を設定しました: ${urlStr}`));
          }
        } else {
          console.log(chalk.yellow("  使い方: /discord [status|enable|disable|url <URL>]"));
        }
        break;
      }

      case "/sessions": {
        const sessions = listSessions(10);
        if (sessions.length === 0) {
          console.log(chalk.dim("  保存されたセッションはありません。"));
        } else {
          console.log(chalk.dim("  保存されたセッション:"));
          for (const s of sessions) {
            const date = new Date(s.updatedAt).toLocaleString();
            console.log(
              chalk.dim(`    ${s.id}  ${date}  ${s.title.slice(0, 50)}`),
            );
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
          console.log(
            chalk.red(`  セッション ${sessionId} が見つかりません。`),
          );
          break;
        }
        this.agent.restoreSession(session);
        console.log(
          chalk.dim(
            `  セッション ${sessionId} を復元しました (${session.meta.messageCount} messages)`,
          ),
        );
        break;
      }

      case "/continue": {
        const latest = getLatestSession();
        if (!latest) {
          console.log(chalk.yellow("  復元可能なセッションがありません。"));
          break;
        }
        this.agent.restoreSession(latest);
        console.log(
          chalk.dim(
            `  最新セッションを復元しました: ${latest.meta.id} (${latest.meta.messageCount} messages)`,
          ),
        );
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
          const diff = execSync("git diff --stat", {
            encoding: "utf-8",
            cwd: process.cwd(),
          });
          console.log(diff || "  変更なし");
        } catch {
          console.log(
            chalk.yellow(
              "  gitリポジトリではないか、git diffの実行に失敗しました。",
            ),
          );
        }
        break;
      }

      case "/plan":
        if (this.planManager?.isInPlanMode()) {
          console.log(chalk.yellow("  既にプランモードです。"));
        } else {
          await this.processInput(
            "このタスクの実装計画を立てたい。enter_plan_modeを使ってプランモードに入ってください。",
          );
        }
        break;

      case "/skills": {
        if (!this.skillRegistry) {
          console.log(
            chalk.dim("  スキルシステムが初期化されていません。"),
          );
          break;
        }
        const skills = this.skillRegistry.list();
        if (skills.length === 0) {
          console.log(chalk.dim("  利用可能なスキルはありません。"));
        } else {
          console.log(chalk.dim("  利用可能なスキル:"));
          for (const s of skills) {
            const tag = s.builtIn
              ? chalk.dim("[builtin]")
              : chalk.dim("[custom]");
            console.log(
              chalk.dim(
                `    ${chalk.cyan(s.trigger)}  ${s.description}  ${tag}`,
              ),
            );
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
        if (
          todoSummary.includes("pending") ||
          todoSummary.includes("in_progress")
        ) {
          console.log(chalk.dim(`\n  --- Tasks ---`));
          console.log(chalk.dim(todoSummary));
        }
        console.log();
        break;
      }

      case "/mode": {
        if (!this.contextModeManager) {
          console.log(
            chalk.dim("  コンテキストモードシステムが初期化されていません。"),
          );
          break;
        }
        const modeArg = args[0] as ContextMode | undefined;
        if (!modeArg) {
          const info = this.contextModeManager.getModeInfo();
          console.log(
            chalk.dim(
              `  Current mode: ${chalk.cyan(this.contextModeManager.currentMode)} (${info.name})`,
            ),
          );
          console.log(chalk.dim(`  ${info.description}`));
          console.log(chalk.dim(`  Priority: ${info.priority}`));
        } else if (
          modeArg === "dev" ||
          modeArg === "review" ||
          modeArg === "research"
        ) {
          this.contextModeManager.switchMode(modeArg);
          const info = this.contextModeManager.getModeInfo();
          console.log(
            chalk.dim(
              `  Switched to ${chalk.cyan(modeArg)} mode (${info.name})`,
            ),
          );
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
  const color =
    pct > 80 ? chalk.red : pct > 60 ? chalk.yellow : chalk.green;
  return `[${color("█".repeat(filled))}${chalk.dim("░".repeat(empty))}] ${pct}%`;
}
