import chalk from "chalk";
import type { AgentLoop } from "../agent/agent-loop.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { displayHelp, type SkillSummary } from "./renderer.js";
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
import { sendDiscordNotification, isValidDiscordWebhookUrl } from "../utils/discord.js";
import { DiscordInteractionServer } from "../discord/interaction-server.js";
import { registerAskCommand } from "../discord/slash-commands.js";
import { select } from "@inquirer/prompts";
import { saveConfig } from "../config/config-manager.js";

export class REPL {
  private input: InteractiveInput;
  private multilineBuffer: string[] = [];
  private isMultiline = false;
  private lineNumber = 0;
  private interactionServer: DiscordInteractionServer | null = null;

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

    // 登録済みツール名を取得（/permission auto-add 等の補完用）
    const toolNames = agent.getToolRegistry().getDefinitions().map((d) => d.function.name);

    this.input = new InteractiveInput({
      commandProvider: createCommandMenuProvider(skillInfos, toolNames),
      filePathProvider: createFileMenuProvider(),
    });
  }

  /**
   * REPLメインループ。ユーザーが /quit するまで resolve しない。
   */
  async start(): Promise<void> {
    // listenEnabled が有効なら起動時に Interaction Server を自動起動
    if (this.config.discord?.listenEnabled && this.config.discord.publicKey) {
      await this.startInteractionServer();
    }
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

  // ─── Discord Interaction Server ──────────────────────

  private async startInteractionServer(): Promise<void> {
    const d = this.config.discord;
    if (!d?.applicationId) {
      console.log(chalk.yellow("  Application ID が未設定です。'/discord app-id <id>' で設定してください。"));
      return;
    }
    if (!d.publicKey) {
      console.log(chalk.yellow("  Public Key が未設定です。'/discord public-key <key>' で設定してください。"));
      return;
    }
    try {
      this.interactionServer = new DiscordInteractionServer(d, this.agent);
      await this.interactionServer.start();
      const port = d.interactionPort ?? 3003;
      console.log(chalk.green(`  ✅ Discord Interaction Server を起動しました (port ${port})`));
      console.log(chalk.dim(`  Discord Developer Portal の Interactions Endpoint URL を:`));
      console.log(chalk.dim(`    http://<your-ip>:${port}/interactions`));
      console.log(chalk.dim("  に設定してください。"));
    } catch (e) {
      console.log(chalk.red(`  ❌ Interaction Server の起動に失敗しました: ${e}`));
      this.interactionServer = null;
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
      case "/help": {
        const helpSkills: SkillSummary[] | undefined = this.skillRegistry
          ? this.skillRegistry.list().map((s) => ({
              name: s.trigger.replace(/^\//, ""),
              description: s.description,
            }))
          : undefined;
        displayHelp(helpSkills);
        break;
      }

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
              const currentModel = this.agent.getModel();
              const chosen = await select({
                message: "モデルを選択:",
                choices: models.map((m) => {
                  const sizeLabel = m.size > 0 ? ` (${(m.size / 1e9).toFixed(1)}GB)` : "";
                  const isCurrent = m.name === currentModel;
                  return {
                    name: `${m.name}${sizeLabel}${isCurrent ? "  ← current" : ""}`,
                    value: m.name,
                  };
                }),
                default: currentModel,
              });
              if (chosen !== currentModel) {
                this.agent.setModel(chosen);
                this.config.mainLLM.model = chosen;
                console.log(chalk.dim(`  モデルを ${chalk.yellow(currentModel)} から ${chalk.cyan(chosen)} に切り替えました`));
              } else {
                console.log(chalk.dim(`  モデルは変更されませんでした。`));
              }
            }
          } catch (e) {
            // Ctrl+C でキャンセルされた場合は何もしない
            if (!(e instanceof Error && e.message.includes("User force closed"))) {
              console.log(chalk.red(`  モデル一覧の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`));
            }
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
          const d = this.config.discord;
          const dEnabled = d?.enabled ?? false;
          const dUrl = d?.webhookUrl || "未設定";
          const dListening = this.interactionServer?.running ?? false;
          const dPort = d?.interactionPort ?? 3003;
          const dAppId = d?.applicationId ? chalk.dim(d.applicationId) : chalk.yellow("未設定");
          const dPubKey = d?.publicKey ? chalk.green("設定済み") : chalk.yellow("未設定");
          const dToken = d?.botToken ? chalk.green("設定済み") : chalk.yellow("未設定");
          console.log(chalk.bold("\n  === Discord Status ==="));
          console.log(chalk.dim(`  通知 (Webhook): ${dEnabled ? chalk.green("有効") : chalk.yellow("無効")}`));
          console.log(chalk.dim(`  Webhook URL:    ${dUrl}`));
          console.log(chalk.dim(`  受信サーバー:   ${dListening ? chalk.green(`起動中 (port ${dPort})`) : chalk.yellow("停止中")}`));
          console.log(chalk.dim(`  Application ID: ${dAppId}`));
          console.log(chalk.dim(`  Public Key:     ${dPubKey}`));
          console.log(chalk.dim(`  Bot Token:      ${dToken}`));
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
            console.log(chalk.dim("  例: /discord url https://discord.com/api/webhooks/123456/abcdef"));
          } else if (!isValidDiscordWebhookUrl(urlStr)) {
            console.log(chalk.red("  ❌ 無効なWebhook URLです。"));
            console.log(chalk.yellow("  正しい形式: https://discord.com/api/webhooks/<id>/<token>"));
            console.log(chalk.dim("  Discordサーバー設定 → 連携サービス → ウェブフック で取得してください。"));
          } else {
            if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
            this.config.discord.webhookUrl = urlStr;
            saveConfig(this.config);
            console.log(chalk.green(`  ✅ Discord Webhook URL を設定しました。`));
            console.log(chalk.dim(`  URL: ${urlStr}`));
            console.log(chalk.dim("  /discord test でテスト送信できます。"));
          }
        } else if (subCmd === "test") {
          const webhookUrl = this.config.discord?.webhookUrl ?? "";
          if (!webhookUrl) {
            console.log(chalk.yellow("  Webhook URL が設定されていません。先に '/discord url <URL>' を実行してください。"));
          } else if (!isValidDiscordWebhookUrl(webhookUrl)) {
            console.log(chalk.red("  ❌ 設定されているURLが無効です。'/discord url <URL>' で正しいWebhook URLを設定してください。"));
          } else {
            console.log(chalk.dim("  Discord にテストメッセージを送信中..."));
            const result = await sendDiscordNotification(webhookUrl, "🤖 lllmAgents テスト通知\nDiscord通知が正常に動作しています！");
            if (result.success) {
              console.log(chalk.green("  ✅ テストメッセージを送信しました。Discordを確認してください。"));
            } else {
              console.log(chalk.red(`  ❌ 送信失敗: ${result.error}`));
            }
          }
        } else if (subCmd === "app-id") {
          // Application ID 設定
          const id = args[1];
          if (!id) {
            console.log(chalk.yellow("  使い方: /discord app-id <application-id>"));
            console.log(chalk.dim("  Discord Developer Portal → アプリ → General Information → Application ID"));
          } else {
            if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
            this.config.discord.applicationId = id;
            saveConfig(this.config);
            console.log(chalk.green(`  ✅ Application ID を設定しました: ${id}`));
          }
        } else if (subCmd === "public-key") {
          // Public Key 設定 (署名検証用)
          const key = args[1];
          if (!key) {
            console.log(chalk.yellow("  使い方: /discord public-key <public-key>"));
            console.log(chalk.dim("  Discord Developer Portal → アプリ → General Information → Public Key"));
          } else {
            if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
            this.config.discord.publicKey = key;
            saveConfig(this.config);
            console.log(chalk.green("  ✅ Public Key を設定しました。"));
          }
        } else if (subCmd === "bot-token") {
          // Bot Token 設定 (コマンド登録・follow-up 送信用)
          const token = args[1];
          if (!token) {
            console.log(chalk.yellow("  使い方: /discord bot-token <bot-token>"));
            console.log(chalk.dim("  Discord Developer Portal → アプリ → Bot → Token"));
          } else {
            if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
            this.config.discord.botToken = token;
            saveConfig(this.config);
            console.log(chalk.green("  ✅ Bot Token を設定しました。"));
          }
        } else if (subCmd === "port") {
          // Interaction Server のポート設定
          const portNum = parseInt(args[1] ?? "", 10);
          if (!portNum || portNum < 1 || portNum > 65535) {
            console.log(chalk.yellow("  使い方: /discord port <port-number>  (例: 3003)"));
          } else {
            if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
            this.config.discord.interactionPort = portNum;
            saveConfig(this.config);
            console.log(chalk.green(`  ✅ Interaction Server ポートを ${portNum} に設定しました。`));
          }
        } else if (subCmd === "register") {
          // スラッシュコマンドを Discord に登録
          const guildId = args[1]; // 省略時はグローバル登録
          const appId = this.config.discord?.applicationId;
          const botToken = this.config.discord?.botToken;
          if (!appId || !botToken) {
            console.log(chalk.yellow("  Application ID と Bot Token が必要です。"));
            console.log(chalk.dim("  /discord app-id <id>     → Application ID を設定"));
            console.log(chalk.dim("  /discord bot-token <tok> → Bot Token を設定"));
          } else {
            const scope = guildId ? `ギルド ${guildId}` : "グローバル";
            console.log(chalk.dim(`  /ask コマンドを登録中 (${scope})...`));
            const result = await registerAskCommand(appId, botToken, guildId);
            if (result.success) {
              console.log(chalk.green(`  ✅ /ask コマンドを登録しました (ID: ${result.commandId})`));
              if (!guildId) {
                console.log(chalk.dim("  グローバル登録は反映まで最大 1 時間かかります。"));
                console.log(chalk.dim("  すぐ試したい場合は '/discord register <guild-id>' でギルド限定登録をどうぞ。"));
              }
            } else {
              console.log(chalk.red(`  ❌ 登録失敗: ${result.error}`));
            }
          }
        } else if (subCmd === "listen") {
          // Interaction Server の起動/停止
          const action = args[1];
          if (action === "start") {
            if (this.interactionServer?.running) {
              console.log(chalk.yellow("  Interaction Server はすでに起動中です。"));
            } else {
              await this.startInteractionServer();
            }
          } else if (action === "stop") {
            if (!this.interactionServer?.running) {
              console.log(chalk.yellow("  Interaction Server は起動していません。"));
            } else {
              this.interactionServer.stop();
              console.log(chalk.yellow("  Interaction Server を停止しました。"));
            }
          } else if (action === "auto-start") {
            // 次回起動時から自動起動
            const on = args[2] !== "off";
            if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
            this.config.discord.listenEnabled = on;
            saveConfig(this.config);
            console.log(on
              ? chalk.green("  ✅ 次回起動時から Interaction Server を自動起動します。")
              : chalk.yellow("  自動起動を無効化しました。"),
            );
          } else {
            console.log(chalk.yellow("  使い方: /discord listen [start|stop|auto-start [off]]"));
          }
        } else {
          console.log(chalk.yellow("  使い方: /discord <サブコマンド>"));
          console.log(chalk.dim("  通知系:    status | enable | disable | url <URL> | test"));
          console.log(chalk.dim("  受信設定:  app-id <id> | public-key <key> | bot-token <tok> | port <num>"));
          console.log(chalk.dim("  コマンド:  register [guild-id]"));
          console.log(chalk.dim("  サーバー:  listen start | listen stop | listen auto-start [off]"));
        }
        break;
      }

      case "/permission": {
        const permissions = this.agent.getPermissions();
        const subCmd = args[0];
        const toolName = args[1];

        if (!subCmd || subCmd === "list") {
          const autoList = permissions.getAutoApproveList();
          const requireList = permissions.getRequireApprovalList();
          const discordList = permissions.getDiscordAutoApproveList();
          const rules = permissions.getRules();
          console.log(chalk.bold("  [パターンルール] rules (ツール名リストより優先):"));
          console.log(chalk.bold("    deny (常に拒否):"));
          if (rules.deny.length === 0) console.log(chalk.dim("      (なし)"));
          else for (const r of rules.deny) console.log(chalk.red(`      ✗ ${r}`));
          console.log(chalk.bold("    allow (常に許可):"));
          if (rules.allow.length === 0) console.log(chalk.dim("      (なし)"));
          else for (const r of rules.allow) console.log(chalk.green(`      ✓ ${r}`));
          console.log(chalk.bold("    ask (常に確認):"));
          if (rules.ask.length === 0) console.log(chalk.dim("      (なし)"));
          else for (const r of rules.ask) console.log(chalk.yellow(`      ? ${r}`));
          console.log(chalk.bold("  [CLI] 自動許可 (autoApproveTools):"));
          if (autoList.length === 0) {
            console.log(chalk.dim("    (なし)"));
          } else {
            for (const t of autoList) console.log(chalk.green(`    ✓ ${t}`));
          }
          console.log(chalk.bold("  [CLI] 確認必要 (requireApprovalTools):"));
          if (requireList.length === 0) {
            console.log(chalk.dim("    (なし)"));
          } else {
            for (const t of requireList) console.log(chalk.yellow(`    ? ${t}`));
          }
          console.log(chalk.bold("  [Discord] 自動許可 (discordAutoApproveTools):"));
          if (discordList.length === 0) {
            console.log(chalk.dim("    (なし)"));
          } else {
            for (const t of discordList) console.log(chalk.cyan(`    ✓ ${t}`));
          }
        } else if (subCmd === "rules") {
          // /permission rules のみ: ルール一覧表示
          const rules = permissions.getRules();
          console.log(chalk.bold("  パターンルール一覧:"));
          for (const action of ["deny", "allow", "ask"] as const) {
            console.log(chalk.bold(`  ${action}:`));
            if (rules[action].length === 0) {
              console.log(chalk.dim("    (なし)"));
            } else {
              for (const r of rules[action]) {
                const icon = action === "deny" ? chalk.red("✗") : action === "allow" ? chalk.green("✓") : chalk.yellow("?");
                console.log(`    ${icon} ${r}`);
              }
            }
          }
        } else if (subCmd === "rule-add") {
          // /permission rule-add <allow|deny|ask> <pattern>
          const action = args[1] as "allow" | "deny" | "ask" | undefined;
          const pattern = args.slice(2).join(" ");
          if (!action || !["allow", "deny", "ask"].includes(action) || !pattern) {
            console.log(chalk.yellow(`  使い方: /permission rule-add <allow|deny|ask> <パターン>`));
            console.log(chalk.dim(`  例: /permission rule-add allow "bash(npm *)"`));
            console.log(chalk.dim(`  例: /permission rule-add deny "bash(rm -rf *)"`));
            console.log(chalk.dim(`  例: /permission rule-add allow "file_write(./src/**)"`));
            console.log(chalk.dim(`  例: /permission rule-add allow "web_fetch(domain:github.com)"`));
          } else {
            permissions.addRule(action, pattern);
            if (!this.config.security.rules) {
              this.config.security.rules = { allow: [], deny: [], ask: [] };
            }
            if (!this.config.security.rules[action].includes(pattern)) {
              this.config.security.rules[action].push(pattern);
            }
            saveConfig(this.config);
            const icon = action === "deny" ? "🚫" : action === "allow" ? "✅" : "❓";
            console.log(chalk.green(`  ${icon} ${action}: "${pattern}" を追加しました`));
          }
        } else if (subCmd === "rule-remove") {
          // /permission rule-remove <allow|deny|ask> <pattern>
          const action = args[1] as "allow" | "deny" | "ask" | undefined;
          const pattern = args.slice(2).join(" ");
          if (!action || !["allow", "deny", "ask"].includes(action) || !pattern) {
            console.log(chalk.yellow(`  使い方: /permission rule-remove <allow|deny|ask> <パターン>`));
          } else {
            permissions.removeRule(action, pattern);
            if (this.config.security.rules) {
              this.config.security.rules[action] = this.config.security.rules[action].filter((p) => p !== pattern);
            }
            saveConfig(this.config);
            console.log(chalk.green(`  ✅ ${action}: "${pattern}" を削除しました`));
          }
        } else if (subCmd === "auto-add" && toolName) {
          permissions.addAutoApprove(toolName);
          if (!this.config.security.autoApproveTools.includes(toolName)) {
            this.config.security.autoApproveTools.push(toolName);
          }
          saveConfig(this.config);
          console.log(chalk.green(`  ✅ ${toolName} を autoApproveTools に追加しました`));
        } else if (subCmd === "auto-remove" && toolName) {
          permissions.removeAutoApprove(toolName);
          this.config.security.autoApproveTools = this.config.security.autoApproveTools.filter((t) => t !== toolName);
          saveConfig(this.config);
          console.log(chalk.green(`  ✅ ${toolName} を autoApproveTools から削除しました`));
        } else if (subCmd === "require-add" && toolName) {
          permissions.addRequireApproval(toolName);
          if (!this.config.security.requireApprovalTools.includes(toolName)) {
            this.config.security.requireApprovalTools.push(toolName);
          }
          saveConfig(this.config);
          console.log(chalk.green(`  ✅ ${toolName} を requireApprovalTools に追加しました`));
        } else if (subCmd === "require-remove" && toolName) {
          permissions.removeRequireApproval(toolName);
          this.config.security.requireApprovalTools = this.config.security.requireApprovalTools.filter((t) => t !== toolName);
          saveConfig(this.config);
          console.log(chalk.green(`  ✅ ${toolName} を requireApprovalTools から削除しました`));
        } else if (subCmd === "discord-add" && toolName) {
          permissions.addDiscordAutoApprove(toolName);
          if (!this.config.security.discordAutoApproveTools) {
            this.config.security.discordAutoApproveTools = [];
          }
          if (!this.config.security.discordAutoApproveTools.includes(toolName)) {
            this.config.security.discordAutoApproveTools.push(toolName);
          }
          saveConfig(this.config);
          console.log(chalk.green(`  ✅ ${toolName} を discordAutoApproveTools に追加しました`));
        } else if (subCmd === "discord-remove" && toolName) {
          permissions.removeDiscordAutoApprove(toolName);
          if (this.config.security.discordAutoApproveTools) {
            this.config.security.discordAutoApproveTools = this.config.security.discordAutoApproveTools.filter((t) => t !== toolName);
          }
          saveConfig(this.config);
          console.log(chalk.green(`  ✅ ${toolName} を discordAutoApproveTools から削除しました`));
        } else {
          console.log(chalk.yellow("  使い方: /permission <サブコマンド> [引数]"));
          console.log(chalk.bold("  パターンルール (優先):"));
          console.log(chalk.dim('  rule-add allow "bash(npm *)"    - パターンに一致する実行を常に許可'));
          console.log(chalk.dim('  rule-add deny  "bash(rm -rf *)" - パターンに一致する実行を常に拒否'));
          console.log(chalk.dim('  rule-add ask   "bash(git push *)"- パターンに一致する実行を常に確認'));
          console.log(chalk.dim('  rule-remove allow "bash(npm *)" - allowルールを削除'));
          console.log(chalk.dim("  rules                           - パターンルール一覧"));
          console.log(chalk.bold("  ツール名リスト:"));
          console.log(chalk.dim("  list                        - 現在の設定一覧を表示"));
          console.log(chalk.dim("  auto-add <tool>             - CLIで自動許可するツールを追加（設定保存）"));
          console.log(chalk.dim("  auto-remove <tool>          - CLIの自動許可から削除（設定保存）"));
          console.log(chalk.dim("  require-add <tool>          - CLIで確認必要なツールを追加（設定保存）"));
          console.log(chalk.dim("  require-remove <tool>       - CLIの確認必要から削除（設定保存）"));
          console.log(chalk.dim("  discord-add <tool>          - Discord経由で自動許可するツールを追加（設定保存）"));
          console.log(chalk.dim("  discord-remove <tool>       - Discord経由の自動許可から削除（設定保存）"));
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
