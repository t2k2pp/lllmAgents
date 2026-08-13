import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { AgentLoop } from "../agent/agent-loop.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import { bashTool } from "../tools/definitions/bash.js";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { resetWindow, exportUsage, resolvePeriod, type PeriodSpec } from "../cost/usage-store.js";
import { formatSummary, formatModels, formatProviders, fmtMoney } from "./cost-view.js";
import { setDisplayJpyRate } from "../cost/money-format.js";
import { displayHelp, type SkillSummary } from "./renderer.js";
import { estimateMessageTokens } from "../agent/token-counter.js";
import {
  buildContextBreakdown,
  formatContextBreakdown,
  formatContextDetail,
  formatStrategyStatus,
  normalizeContextSection,
} from "./context-breakdown.js";
import { formatTodos, formatTodosActive, clearTodos, archiveCompletedTodos } from "../tools/definitions/todo-write.js";
import type { GoalDefinition } from "../agent/goal-slot.js";
import { getGoal as getGoalSlot } from "../agent/goal-slot.js";
import { listSessions, loadSession, getLatestSession } from "../agent/session-manager.js";
import { normalizeRoomId } from "../agent/room-types.js";
import { loadMemory, saveMemory } from "../agent/memory.js";
import { resolveAtMentions, printMentionFeedback } from "./input-resolver.js";
import { runGoalLoop } from "../goal-loop/goal-loop-runner.js";
import { InteractiveInput, SIGINT_SIGNAL } from "./interactive-input.js";
import { interruptWatcher } from "./interrupt-watcher.js";
import { progressIndicator } from "./progress-indicator.js";
import { createCommandMenuProvider, createFileMenuProvider } from "./completer.js";
import { getCommandRegistry, getRegistryHelpEntries } from "./commands/registry.js";
import { parseTokenCount } from "../config/types.js";
import type { Config, LLMEndpoint, SecondLLMEndpoint, SecondLLMProviderType } from "../config/types.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { PlanManager } from "../agent/plan-mode.js";
import { sendDiscordNotification, isValidDiscordWebhookUrl } from "../utils/discord.js";
import { sendSlackNotification, isValidSlackWebhookUrl } from "../utils/slack.js";
import { formatTaskReport } from "../agent/task-reporter.js";
import { maybePromoteToGoal, extractAcceptanceCriteria } from "../agent/goal-promotion.js";
import { DiscordInteractionServer } from "../discord/interaction-server.js";
import { registerAskCommand } from "../discord/slash-commands.js";
// プロンプトは prompt-gate 経由で呼ぶ (docs/tui-alternate-screen.md §4.3)。
// 表示中はライブ領域を排他所有し、他の出力をキューへ退避させる。
import { select, input, password, confirm, checkbox, Separator, inquirer, withPrompt } from "./prompt-gate.js";
import { CredentialVault } from "../security/credential-vault.js";
import { AzureFoundryProvider } from "../providers/azure-foundry.js";
import { AzureAnthropicProvider } from "../providers/azure-anthropic.js";
import { AzureGPTProvider } from "../providers/azure-gpt.js";
import { AzureOpenAIProvider } from "../providers/azure-openai.js";
import { AzureClaudeProvider } from "../providers/azure-claude.js";
import { saveConfig } from "../config/config-manager.js";
import { isWindows, isMacOS } from "../utils/platform.js";
import { maskWebhookUrl } from "../utils/mask.js";
import { detectWsl } from "../security/wsl.js";
import { configureSandboxProxy, getSandboxProxy } from "../security/sandbox-proxy.js";
import { addDomain, removeDomain, resolveAllowedDomains, domainAllowed } from "../security/net-allowlist.js";
import { ProcessSandbox, cleanupStaleSandboxArtifacts, withSandboxState } from "../security/process-sandbox.js";
import {
  resetActiveProcessSandbox,
  reconcileSandboxProxy,
  getActiveProcessSandbox,
} from "../security/active-sandbox.js";
import { isBashNetworkContained } from "../security/containment.js";
import { runLocalLLMSetup, connectAndListModels } from "../config/setup-wizard.js";
import {
  recordLLMProfile,
  listLLMProfiles,
  deleteLLMProfiles,
  touchProfile,
  type LLMProfile,
} from "../config/llm-profiles.js";
import {
  setSlot as setRegistrySlot,
  listEntries as listRegistryEntries,
  getEntry as getRegistryEntry,
  updateEntry as updateRegistryEntry,
  deleteEntry as deleteRegistryEntry,
  recordEntry as recordRegistryEntry,
  getSlots as getRegistrySlots,
  clearSlot as clearRegistrySlot,
  listNamedSlots,
  resolveEntryQuery,
  isValidSlotName,
  RESERVED_SLOT_NAMES,
} from "../config/model-registry.js";
import { invalidateModelCache, setResolverPassphrase } from "../config/model-resolver.js";
import {
  describeEndpoint,
  detectModelDrift,
  formatApplyFailureLines,
  formatBindingLines,
  formatDriftWarningLine,
} from "../agent/model-drift.js";
import type { LLMRegistryEntry } from "../config/types.js";
import { nonTTYReader } from "../utils/non-tty-reader.js";
import { LoopManager, parseLoopArgs } from "../loop/loop-manager.js";
import { secondLLMAgentTool, setSecondLLMManager } from "../tools/definitions/second-llm.js";
import { federatedDelegateTool, setFederatedSecondLLMManager } from "../tools/definitions/federated-delegate.js";
import { buildLLMProfiles } from "../agent/llm-profiles.js";
import { createProvider } from "../providers/provider-factory.js";
import { getSubAgentManager } from "../tools/definitions/task.js";
import { DEFAULT_PORTS } from "../config/types.js";
import type { ProviderType } from "../config/types.js";
import type { ImageGenProfile, ImageProviderType } from "../config/types.js";
import { createImageGenerateTool } from "../tools/definitions/image-generate.js";
import { AzureImageProvider } from "../image/azure-image.js";

export class REPL {
  private input: InteractiveInput;
  private multilineBuffer: string[] = [];
  private isMultiline = false;
  private lineNumber = 0;
  private interactionServer: DiscordInteractionServer | null = null;
  private loopManager = new LoopManager();
  private agentBusy = false;
  /** Phase 1.5: run 中に type-ahead で打たれた追加入力 (受信順に後で処理する)。 docs/room-model-design.md §11 */
  private pendingInputs: string[] = [];

  constructor(
    private agent: AgentLoop,
    private config: Config,
    private skillRegistry?: SkillRegistry,
    private planManager?: PlanManager,
    private secondLLMManager?: SecondLLMManager,
    private passphrase?: string,
    /** Phase F-1: /mcp slash command で参照するため optional 引数として受ける */
    private mcpManager?: import("../mcp/mcp-manager.js").MCPManager,
    /** Phase 5: /model vision setup から hot-swap するために保持 */
    private visionService?: import("../tools/definitions/vision.js").VisionService,
    /** /image コマンドで参照する画像生成サービス。docs/image-generation.md §7 */
    private imageService?: import("../image/image-service.js").ImageService,
    /** Room モデル: 会話 Room の管理 (docs/room-model-design.md)。 index.ts が必ず渡す */
    private roomManager?: import("../agent/room-manager.js").RoomManager,
    /** 受信順グローバル FIFO キュー (全サーフェス共有)。 index.ts が必ず渡す */
    private roomQueue?: import("../agent/room-run-queue.js").RoomRunQueue,
  ) {
    // スキル情報を取得してメニュープロバイダーに渡す
    const skillInfos = skillRegistry
      ? skillRegistry.list().map((s) => ({
          trigger: s.trigger,
          description: s.description,
        }))
      : [];

    // 登録済みツール名を取得（/permission auto-add 等の補完用）
    const toolNames = agent
      .getToolRegistry()
      .getDefinitions()
      .map((d) => d.function.name);

    this.input = new InteractiveInput({
      commandProvider: createCommandMenuProvider(skillInfos, toolNames),
      filePathProvider: createFileMenuProvider(),
    });

    this.configureSandboxNetProxy();
    cleanupStaleSandboxArtifacts(); // 前回クラッシュ等で残った一時プロファイル/ソケットを掃除
  }

  /**
   * Phase 2b-1: サンドボックスのネット allowlist プロキシを構成する。
   * 未許可ドメインは対話確認（非TTY は fail-closed=deny）。 allowlist は config に保存。
   */
  private configureSandboxNetProxy(): void {
    configureSandboxProxy({
      getAllowedDomains: () => resolveAllowedDomains(this.config.security.processSandbox?.allowedHosts),
      persistDomain: (domain) => {
        const ps = this.config.security.processSandbox ?? { enabled: false, level: "none" as const };
        const hosts = addDomain(resolveAllowedDomains(ps.allowedHosts), domain);
        this.config.security.processSandbox = { ...ps, allowedHosts: hosts };
        saveConfig(this.config);
      },
      onUnknownDomain: async (host) => {
        console.log(
          chalk.cyan(
            `\n  [sandbox] サンドボックス内の bash が未許可ドメインへ接続しようとしています: ${chalk.bold(host)}`,
          ),
        );
        // 国際化ドメイン(punycode)はホモグラフ詐称の恐れがあるため明示警告
        if (host.startsWith("xn--") || host.includes(".xn--")) {
          console.log(
            chalk.yellow(
              `  ⚠ これは国際化ドメイン(punycode)です。 見た目が既知サイトに酷似する偽装の可能性に注意してください。`,
            ),
          );
        }
        if (!process.stdin.isTTY) {
          console.log(chalk.yellow(`  非対話モードのため拒否 (fail-closed)。 /sandbox allow ${host} で恒久許可可。`));
          return "deny";
        }
        try {
          const { action } = await withPrompt(() =>
            inquirer.prompt<{ action: "once" | "always" | "deny" }>([
              {
                type: "list",
                name: "action",
                message: `${host} への接続を許可しますか？`,
                choices: [
                  { name: "許可 (今回のセッションのみ)", value: "once" },
                  { name: "許可 (allowlist に保存して常に)", value: "always" },
                  { name: "拒否", value: "deny" },
                ],
              },
            ]),
          );
          return action;
        } catch {
          return "deny";
        }
      },
    });
  }

  /**
   * REPLメインループ。ユーザーが /quit するまで resolve しない。
   */
  async start(): Promise<void> {
    // Ctrl+C 中断ハンドラー: エージェント処理中は abort()、そうでなければ案内
    // Ctrl+C ハンドラー:
    //   処理中1回目 → ソフト中断 (abort) + "もう一度で終了" 案内
    //   処理中2回目 → プロセス終了（強制脱出手段を保持）
    //   待機中      → プロセス終了（通常動作）
    //
    // 2026-05-16 修正: 強制終了経路でも resume 可能にするため save を必ず実行する。
    // 旧: process.exit(1) 直叩きで save が走らず、 翌日 /resume で見つからない症状 (user 報告) があった。
    const saveBeforeExit = (reason: string): void => {
      try {
        this.agent.saveCurrentSession();
        const msgCount = this.agent.getCurrentSessionMessageCount();
        if (msgCount > 0) {
          console.log(
            chalk.dim(
              `  セッション保存 (${reason}): ${chalk.cyan(this.agent.getCurrentSessionId())} (${msgCount} messages)`,
            ),
          );
        }
      } catch (e) {
        console.error(chalk.red(`  セッション保存に失敗: ${String(e).slice(0, 100)}`));
      }
      // 終了時にネット allowlist プロキシを停止（listen ソケット/unix ソケットを解放）。
      try {
        getSandboxProxy()?.stop();
      } catch {
        /* ignore */
      }
    };
    // 2026-05-17 修正: 1回押しでの即時 process.exit を廃止。
    // 旧仕様では agentBusy=false の窓 (例: processInput の finally 直後〜次の input.question で
    // raw mode が立つまでの一瞬) に SIGINT が届くと、 ユーザーが「思考中」と認識している間でも
    // 1回の Ctrl+C で exit してしまう事象 (user 報告) があった。 常に 2 回押し必須にして
    // 事故的な終了を防ぐ。 raw mode 中の Ctrl+C は interactive-input が拾うため、 通常の
    // 待機プロンプトでは /quit を案内するメッセージのみが出る (この handler は呼ばれない)。
    //
    // 2026-06-10 修正: エージェント実行中 (interruptWatcher が raw mode を保持) は端末が
    // SIGINT を生成しないため、Ctrl+C が完全に無視される事象があった。interrupt-watcher が
    // 0x03 バイトを検知して process.emit("SIGINT") でこの handler に合流させる。
    let ctrlCCount = 0;
    let ctrlCResetTimer: ReturnType<typeof setTimeout> | null = null;
    const sigintHandler = () => {
      ctrlCCount++;
      if (ctrlCResetTimer) clearTimeout(ctrlCResetTimer);
      if (ctrlCCount === 1) {
        if (this.agentBusy) {
          this.agent.abort();
          bashTool.killRunningProcess();
          console.log(chalk.yellow("\n  (Ctrl+C) 処理を中断中... もう一度 Ctrl+C でプロセス終了"));
        } else {
          console.log(chalk.yellow("\n  (Ctrl+C) もう一度 Ctrl+C で終了 (/quit でも可)"));
        }
        // 3秒以内に2回目が来なければリセット
        ctrlCResetTimer = setTimeout(() => {
          ctrlCCount = 0;
        }, 3000);
      } else {
        // 2回目: 終了 (save してから)
        console.log(chalk.yellow("\n  終了します..."));
        saveBeforeExit(this.agentBusy ? "Ctrl+C×2 (busy)" : "Ctrl+C×2 (idle)");
        process.exit(this.agentBusy ? 1 : 0);
      }
    };
    process.on("SIGINT", sigintHandler);
    // SIGTERM (= kill / システム shutdown / Docker stop 等) でも save して終了
    process.on("SIGTERM", () => {
      console.log(chalk.yellow("\n  SIGTERM 受信、 セッションを保存して終了します..."));
      saveBeforeExit("SIGTERM");
      process.exit(0);
    });

    // listenEnabled が有効なら起動時に受信 (Gateway 接続) を自動開始
    if (this.config.discord?.listenEnabled && this.config.discord.botToken) {
      await this.startInteractionServer();
    }
    try {
      while (true) {
        // モデル設定が実行中に反映されていない間は、 入力を受け付ける前に毎ターン警告する
        // (docs/model-apply-immediacy.md §3.3)。 マルチライン入力の途中では出さない。
        if (!this.isMultiline) this.printModelDriftWarning();
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
          // 非TTYモード（パイプ等）: stdin が閉じたら自動終了
          if (!process.stdin.isTTY && nonTTYReader.isClosed()) {
            console.log(chalk.dim("  (stdin closed, exiting)"));
            break;
          }
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
        // 2026-05-16: 各 turn 完了後に save (= 進捗 checkpoint)。
        // 旧来は /quit / finally でしか save しなかったため、 長 session 中の crash や
        // SIGKILL で全消失していた。 turn 単位で save しておけば最悪でも直前 turn まで復元可能。
        try {
          this.agent.saveCurrentSession();
        } catch (e) {
          // save 失敗で REPL を止めない (= 主処理を優先)。 ログだけ出す
          console.error(chalk.dim(`  [warn] turn save 失敗: ${String(e).slice(0, 80)}`));
        }
        // Phase 1.5: run 中に type-ahead で積まれた追加入力を受信順に処理する (docs §11)。
        if (await this.drainPendingInputs()) break; // type-ahead の /quit で終了
      }
    } finally {
      this.agent.saveCurrentSession();
      // アクティブなループタイマーを全停止
      const stoppedLoops = this.loopManager.stopAll();
      if (stoppedLoops > 0) {
        console.log(chalk.dim(`  ループ ${stoppedLoops} 件を停止しました。`));
      }
      // Discord 受信 (Gateway) を停止する。これを閉じないと WebSocket 接続と heartbeat
      // タイマーがイベントループを維持し続け、/quit 後もプロセスが終了せずターミナルに
      // 戻らない (--background モードが「WS 接続と heartbeat がプロセスを生かす」と
      // コメントしている通り、REPL 終了時はこれを明示的に止める必要がある)。
      this.interactionServer?.stop();
      this.interactionServer = null;
      // stdin を pause してイベントループを解放し、プロセスを終了可能にする
      process.stdin.pause();
    }
  }

  // ─── Discord 受信 (Gateway 接続。 docs/discord-gateway-design.md) ──────

  private async startInteractionServer(): Promise<void> {
    const d = this.config.discord;
    if (!d?.applicationId) {
      console.log(
        chalk.yellow("  Application ID が未設定です。/integrations の Discord 連携メニューから設定してください。"),
      );
      return;
    }
    if (!d.botToken) {
      console.log(
        chalk.yellow("  Bot Token が未設定です。/integrations の Discord 連携メニューから設定してください。"),
      );
      return;
    }
    if (!this.roomManager || !this.roomQueue) {
      console.log(chalk.yellow("  内部エラー: RoomManager 未初期化のため Discord 受信を開始できません。"));
      return;
    }
    try {
      this.interactionServer = new DiscordInteractionServer(
        d,
        this.agent,
        this.roomManager,
        this.roomQueue,
        this.skillRegistry,
        this.mcpManager,
        () => saveConfig(this.config),
      );
      await this.interactionServer.start();
      const botName = this.interactionServer.botUser;
      console.log(
        chalk.green(`  ✅ Discord に接続し、呼び出しの受信を開始しました${botName ? ` (Bot: ${botName})` : ""}`),
      );
      console.log(chalk.dim("  公開 URL やトンネルは不要です (Bot がこちらから Discord に接続しています)。"));
      console.log(chalk.dim("  注意: Developer Portal の Interactions Endpoint URL は空欄にしてください。"));
      console.log(chalk.dim("        設定されていると、呼び出しがこちらに届かなくなります。"));
    } catch (e) {
      console.log(chalk.red(`  ❌ 受信の開始に失敗しました: ${e instanceof Error ? e.message : e}`));
      this.interactionServer = null;
    }
  }

  /**
   * 暗号化済み apiKey の復号に必要な合言葉を確保する。
   * 既存の this.passphrase で復号できれば再利用、できなければプロンプトで取得して保持する。
   * 暗号化されていない apiKey の場合は何もしない。
   * /swap や /second setup 後に Provider を再生成する際、起動時に取得した合言葉を使い回すための共通処理。
   */
  private async ensurePassphraseFor(
    apiKey: string | undefined,
    label: string,
    providerType: string | undefined,
  ): Promise<void> {
    if (!apiKey || !CredentialVault.isEncrypted(apiKey)) return;
    if (this.passphrase && CredentialVault.resolve(apiKey, this.passphrase)) return;
    const secret = await password({
      message: `${label} (${providerType ?? ""})の暗号化キーを復号するための合言葉:`,
      mask: "*",
    });
    this.adoptPassphrase(secret);
  }

  /**
   * 合言葉をセッションの合言葉として採用する (docs/model-apply-immediacy.md §2.1 / §4)。
   *
   * 暗号化保存を選んだ直後に呼ぶと、 その場で ensurePassphraseFor() が再入力を求めなくなり、
   * 再起動なしで反映できる。 model-resolver 側にも渡さないと、 暗号化 apiKey の entry が
   * named slot から解決できないまま残る (resolver は合言葉が無いと解決を拒否する仕様)。
   */
  private adoptPassphrase(passphrase: string): void {
    this.passphrase = passphrase;
    try {
      setResolverPassphrase(passphrase);
    } catch {
      /* resolver への伝播失敗で設定操作自体を止めない */
    }
  }

  /**
   * 反映失敗の共通表示 (docs/model-apply-immediacy.md §2.2)。
   * 「再起動してください」 で終わらせず、 いま動いているのが何かを必ず併記する。
   */
  private reportApplyFailure(reason: string): void {
    for (const line of formatApplyFailureLines(reason, this.agent.getLiveBinding())) {
      console.log(chalk.yellow(`  ${line}`));
    }
  }

  /**
   * メインLLM の「設定値」 と「実行中」 のズレ (docs/model-apply-immediacy.md §3.2)。
   * 実行中バインディングが未記録なら null (= ズレなし扱い)。
   */
  private currentModelDrift(): ReturnType<typeof detectModelDrift> {
    return detectModelDrift(this.config.mainLLM, this.agent.getLiveBinding());
  }

  /**
   * 「設定値」 と「実行中」 を 2 行に分けて表示する (docs/model-apply-immediacy.md §3.3)。
   * 一致していても 2 行出す。 1 行にまとめると、 どちらを見せているのか分からなくなる。
   */
  private printMainLLMBinding(label: string, indent: string): void {
    const lines = formatBindingLines(label, this.config.mainLLM, this.agent.getLiveBinding());
    console.log(chalk.dim(`${indent}${lines.configured}`));
    console.log(lines.drifted ? chalk.red(`${indent}${lines.live}`) : chalk.dim(`${indent}${lines.live}`));
    if (lines.hint) console.log(chalk.yellow(`${indent}${" ".repeat(label.length + 2)}${lines.hint}`));
  }

  /**
   * ユーザー入力を受け付ける直前に出す 1 行警告 (docs/model-apply-immediacy.md §3.3)。
   * ズレている間は毎ターン出す。 うるさいが、 うるさくないと気づかない不具合なので意図的。
   * 反映すれば消えるため恒常的なノイズにはならない。
   */
  private printModelDriftWarning(): void {
    const drift = this.currentModelDrift();
    if (drift) console.log(chalk.red(`  ${formatDriftWarningLine(drift)}`));
  }

  /**
   * メインLLMの接続先 (providerType / baseUrl / model) 変更を実行時に反映する。
   * Configを保存後に呼ぶと、新しいProviderインスタンスを作成して AgentLoop と
   * SubAgentManager に注入し、システムプロンプトのプロファイル情報も更新する。
   * 接続テストを行い、失敗時は警告を出すが処理は続行する（ユーザーがリトライできる）。
   *
   * 反映できたら true。 provider 生成に失敗したら false を返し、 §2.2 の文言
   * (いま動いているのは何か) を出す。 設定の保存自体は呼び出し側で済んでいる。
   */
  private async applyMainLLMEndpoint(): Promise<boolean> {
    await this.ensurePassphraseFor(this.config.mainLLM.apiKey, "メインLLM", this.config.mainLLM.providerType);
    let newProvider;
    try {
      newProvider = createProvider(this.config.mainLLM, this.passphrase);
    } catch (e) {
      this.reportApplyFailure(`Provider 生成に失敗 (${e instanceof Error ? e.message : String(e)})`);
      return false;
    }

    // 接続テスト
    try {
      const ok = await newProvider.testConnection();
      if (!ok) {
        console.log(
          chalk.yellow(
            `  ⚠ ${this.config.mainLLM.baseUrl} への接続テストに失敗しました。設定は反映しましたが次の応答でエラーになる可能性があります。`,
          ),
        );
      }
    } catch {
      console.log(chalk.yellow(`  ⚠ 接続テスト中にエラーが発生しました。設定は反映済み。`));
    }

    // 第3引数の endpoint で実行中バインディングを更新する (docs/model-apply-immediacy.md §3.1)
    this.agent.setProvider(newProvider, this.config.mainLLM.model, this.config.mainLLM);
    // contextWindow も切り替える。 ollama 32K → anthropic 200K 等の急変で
    // 古い値が残ると context 圧縮や max_tokens 計算が壊れる (= 旧バグ)
    if (this.config.mainLLM.contextWindow && this.config.mainLLM.contextWindow > 0) {
      this.agent.setContextWindow(this.config.mainLLM.contextWindow);
    }
    const subAgentMgr = getSubAgentManager();
    if (subAgentMgr) {
      subAgentMgr.setProvider(newProvider, this.config.mainLLM.model);
    }
    this.refreshLLMProfiles();
    // Model Registry に記録 + main slot を更新 (失敗しても本体動作には影響させない)
    try {
      const entry = recordLLMProfile(this.config.mainLLM);
      if (entry) setRegistrySlot("main", entry.id);
    } catch {
      /* ignore */
    }
    // F1 との整合 (docs/model-apply-immediacy.md §4): resolver の provider キャッシュを捨てる
    invalidateModelCache();
    return true;
  }

  /**
   * セットアップ wizard 完了後に、 保存した設定を実行中へ反映する共通処理。
   * 設計: docs/model-apply-immediacy.md §2
   *
   * 暗号化保存でも再起動は要求しない (合言葉は adoptPassphrase() で採用済み)。
   * 反映に失敗しても設定の保存は済んでいる状態を保ち、 §2.2 の文言で
   * 「いま動いているのは何か」 を伝える。
   */
  private async applyAfterSetup(target: "main" | "second" | "vision"): Promise<void> {
    try {
      if (target === "main") {
        if (await this.applyMainLLMEndpoint()) {
          console.log(chalk.green("  実行時に反映しました。"));
        }
      } else if (target === "vision") {
        await this.applyVisionLLMEndpoint();
        console.log(chalk.green("  実行時に反映しました。"));
      } else {
        await this.applySecondLLMEndpoint();
        if (this.secondLLMManager?.isAvailable() ?? false) {
          console.log(chalk.green("  実行時に反映しました。"));
        } else {
          console.log(chalk.yellow("  反映時に接続失敗しました。 /model second で確認してください。"));
        }
      }
    } catch (e) {
      this.reportApplyFailure(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Azure 系 LLM (azure-openai / azure-claude / azure-foundry) を対話プロンプトでセットアップする。
   * メインLLM (target=main) / セカンドLLM (target=second) の両方をカバーする共通実装。
   * endpoint / (deploymentName) / apiKey / model を順に質問し、apiKey は
   * 平文 / 環境変数参照 / パスフレーズ暗号化のいずれかで保存する。
   *
   * - azure-openai/azure-claude: Azure OpenAI Service。/openai/deployments/{name} パスを使う
   * - azure-foundry: Azure AI Foundry (Models as a Service)。/models/chat/completions パスを使い、
   *                  deploymentName は不要、model 名でルーティング
   */
  private async setupAzureLLM(
    target: "main" | "second" | "vision",
    provider: "azure-openai" | "azure-gpt" | "azure-claude" | "azure-foundry" | "azure-anthropic",
  ): Promise<void> {
    const targetLabel = target === "main" ? "メインLLM" : target === "vision" ? "Vision LLM" : "セカンドLLM";
    console.log(chalk.bold(`\n  ── ${targetLabel} ${provider} セットアップ ──`));
    console.log(chalk.dim("  キャンセルは Ctrl+C\n"));

    if (await this.maybeOfferProfileHistory(target, provider)) return;

    const existing =
      target === "main"
        ? this.config.mainLLM
        : target === "vision"
          ? (this.config.visionLLM ?? undefined)
          : this.config.secondLLM?.endpoint;
    const existingIsAzure =
      existing?.providerType === "azure-openai" ||
      existing?.providerType === "azure-gpt" ||
      existing?.providerType === "azure-claude" ||
      existing?.providerType === "azure-foundry" ||
      existing?.providerType === "azure-anthropic";

    const isFoundry = provider === "azure-foundry";
    const isAnthropic = provider === "azure-anthropic";
    const isGpt = provider === "azure-gpt";
    // Foundry / Anthropic / GPT(Responses) は deployment 名不要、model 名でルーティング
    const skipDeployment = isFoundry || isAnthropic || isGpt;
    // どのプロバイダでも完全URLを貼られても protocol+host だけに自動正規化される
    const endpointHint = isAnthropic
      ? "例: https://your-resource.services.ai.azure.com  (完全URL '/anthropic/v1/messages' を貼っても自動で host 部だけに切り詰めます)"
      : isFoundry
        ? "例: https://your-resource.services.ai.azure.com  (完全URLを貼っても自動で host 部だけに切り詰めます)"
        : isGpt
          ? "例: https://your-resource.openai.azure.com  (完全URL '/openai/v1/responses' を貼っても自動で host 部だけに切り詰めます)"
          : "例: https://your-resource.openai.azure.com  (Azure ポータルから貼った完全URLでも自動で host 部だけに切り詰めます)";

    const endpointUrl = await input({
      message: `Azure endpoint URL (${endpointHint}):`,
      default: existingIsAzure ? existing?.endpoint : undefined,
      validate: (v: string) => {
        if (!v.trim()) return "endpoint URL は必須です";
        if (!/^https?:\/\//i.test(v.trim())) return "http(s):// で始めてください";
        return true;
      },
    });

    let deploymentName = "";
    if (!skipDeployment) {
      deploymentName = await input({
        message: "Deployment name:",
        default: existingIsAzure ? existing?.deploymentName : undefined,
        validate: (v: string) => v.trim().length > 0 || "deployment name は必須です",
      });
    }

    const modelHint = isAnthropic
      ? "Model 名 (Azure 上の Claude モデル ID。 例: claude-sonnet-4-5):"
      : isFoundry
        ? "Model 名 (Azure Foundry 上の model ID。例: Kimi-K2-Instruct-0905):"
        : isGpt
          ? "Model 名 (Azure 上の GPT/Codex モデル ID。例: gpt-5.3-codex):"
          : "モデル識別子 (空欄なら deployment name と同じ):";
    const model = await input({
      message: modelHint,
      default: existingIsAzure ? existing?.model : skipDeployment ? undefined : deploymentName,
      validate: skipDeployment
        ? (v: string) => v.trim().length > 0 || `${provider} では model 名が必須です`
        : undefined,
    });

    const storageMode = await select({
      message: "API Key の保存方法:",
      choices: [
        { name: "パスフレーズで暗号化保存 (推奨)", value: "encrypt" },
        { name: "環境変数参照 (env:VAR_NAME)", value: "env" },
        { name: "平文で保存 (非推奨)", value: "plain" },
      ],
      default: "encrypt",
    });

    let storedApiKey = "";

    if (storageMode === "env") {
      const envName = await input({
        message: "環境変数名 (例: AZURE_OPENAI_API_KEY):",
        validate: (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) || "有効な環境変数名を入力してください",
      });
      storedApiKey = `env:${envName.trim()}`;
      if (!process.env[envName.trim()]) {
        console.log(
          chalk.yellow(`  ⚠ 環境変数 ${envName.trim()} は現在未設定です。アプリ起動時にセットしてください。`),
        );
      }
    } else if (storageMode === "plain") {
      const ok = await confirm({
        message: "平文保存は config.json にそのまま記録されます。本当に続行しますか？",
        default: false,
      });
      if (!ok) {
        console.log(chalk.yellow("  セットアップを中止しました。"));
        return;
      }
      const apiKey = await password({
        message: "API Key (入力は表示されません):",
        mask: "*",
      });
      if (!apiKey.trim()) {
        console.log(chalk.red("  API Key が空です。中止しました。"));
        return;
      }
      storedApiKey = apiKey.trim();
    } else {
      // encrypt
      const apiKey = await password({
        message: "API Key (入力は表示されません):",
        mask: "*",
      });
      if (!apiKey.trim()) {
        console.log(chalk.red("  API Key が空です。中止しました。"));
        return;
      }
      const passphrase = await password({
        message: "暗号化用パスフレーズ:",
        mask: "*",
      });
      const passphrase2 = await password({
        message: "もう一度入力 (確認):",
        mask: "*",
      });
      if (passphrase !== passphrase2) {
        console.log(chalk.red("  パスフレーズが一致しません。中止しました。"));
        return;
      }
      if (passphrase.length < 4) {
        console.log(chalk.red("  パスフレーズが短すぎます (4文字以上)。中止しました。"));
        return;
      }
      storedApiKey = CredentialVault.encrypt(apiKey.trim(), passphrase);
      // 復号に必要な合言葉はいま手元にある。 セッションの合言葉として採用すれば
      // 再起動なしで反映できる (docs/model-apply-immediacy.md §2.1)
      this.adoptPassphrase(passphrase);
    }

    // 全 Azure プロバイダ共通: 完全URLを貼られても protocol+host だけに正規化する
    // (5 クラスの normalizeEndpoint は全て同じ実装。 ここではプロバイダに合わせて呼ぶ)
    const finalEndpoint = isAnthropic
      ? AzureAnthropicProvider.normalizeEndpoint(endpointUrl.trim())
      : isFoundry
        ? AzureFoundryProvider.normalizeEndpoint(endpointUrl.trim())
        : isGpt
          ? AzureGPTProvider.normalizeEndpoint(endpointUrl.trim())
          : provider === "azure-claude"
            ? AzureClaudeProvider.normalizeEndpoint(endpointUrl.trim())
            : AzureOpenAIProvider.normalizeEndpoint(endpointUrl.trim());

    const finalModel = model.trim() || deploymentName.trim();
    const finalDeployment = skipDeployment ? undefined : deploymentName.trim();

    if (target === "main") {
      // メインLLM: 既存のサンプリングパラメータ・contextWindow・description を保持
      const cur = this.config.mainLLM;
      this.config.mainLLM = {
        ...cur,
        providerType: provider,
        model: finalModel,
        endpoint: finalEndpoint,
        apiKey: storedApiKey,
        deploymentName: finalDeployment,
        baseUrl: undefined, // クラウドでは未使用
        // projectId/region は Vertex AI 用なのでクリア
        projectId: undefined,
        region: undefined,
      };
    } else if (target === "vision") {
      // Vision LLM: secondLLM のような wrapper は持たない。 LLMEndpoint 直書き。
      this.config.visionLLM = {
        providerType: provider,
        model: finalModel,
        endpoint: finalEndpoint,
        apiKey: storedApiKey,
        deploymentName: finalDeployment,
        description: existingIsAzure ? existing?.description : undefined,
        contextWindow: existingIsAzure ? existing?.contextWindow : undefined,
      };
    } else {
      this.config.secondLLM = {
        enabled: true,
        endpoint: {
          providerType: provider,
          model: finalModel,
          endpoint: finalEndpoint,
          apiKey: storedApiKey,
          deploymentName: finalDeployment,
          description: existingIsAzure ? existing?.description : undefined,
          contextWindow: existingIsAzure ? existing?.contextWindow : undefined,
        },
        budget: this.config.secondLLM?.budget ?? null,
        cost: this.config.secondLLM?.cost ?? { referenceModels: [] },
      };
    }
    saveConfig(this.config);

    console.log(chalk.green(`\n  ✓ ${targetLabel} (Azure) を設定しました:`));
    console.log(chalk.dim(`    プロバイダー:    ${provider}`));
    console.log(chalk.dim(`    Endpoint:        ${finalEndpoint}`));
    if (!skipDeployment) {
      console.log(chalk.dim(`    Deployment:      ${deploymentName.trim()}`));
    }
    console.log(chalk.dim(`    Model:           ${finalModel}`));
    console.log(
      chalk.dim(
        `    API Key:         ${storageMode === "encrypt" ? "暗号化保存" : storageMode === "env" ? `環境変数 (${storedApiKey})` : "平文保存"}`,
      ),
    );

    // 暗号化保存でも合言葉は手元にあるので、 その場で反映する (再起動は要求しない)
    await this.applyAfterSetup(target);
    console.log();
  }

  // ─── 画像生成 (/image) ────────────────────────────────────────────
  // 設計: docs/image-generation.md §7

  /** image_generate ツールの登録状態を config に合わせて同期する (動的 ON/OFF 用) */
  private syncImageGenerateTool(): void {
    if (!this.imageService) return;
    const registry = this.agent.getToolRegistry();
    const registered = registry.get("image_generate") !== undefined;
    const shouldRegister = this.imageService.isEnabled();
    if (shouldRegister && !registered) {
      registry.register(createImageGenerateTool(this.imageService, this.config));
    } else if (!shouldRegister && registered) {
      registry.unregister("image_generate");
    }
  }

  private async handleImageCommand(args: string[]): Promise<void> {
    if (!this.imageService) {
      console.log(chalk.yellow("  画像生成サービスが初期化されていません。"));
      return;
    }
    const ig = this.config.imageGen ?? { enabled: false, profiles: [] };
    const sub = (args[0] ?? "").toLowerCase();

    const printStatus = (): void => {
      const active = this.imageService?.getActiveProfile() ?? null;
      const toolOn = this.agent.getToolRegistry().get("image_generate") !== undefined;
      console.log(chalk.bold("\n  === 画像生成 (/image) ==="));
      console.log(
        chalk.dim(
          `  機能:     ${ig.enabled ? chalk.green("有効") : chalk.red("無効")}  /  ツール登録: ${toolOn ? "image_generate ✓" : "なし"}`,
        ),
      );
      if (ig.profiles.length === 0) {
        console.log(chalk.dim("  プロファイル: なし — /image setup <azure|sd-webui|comfyui> で追加"));
      } else {
        console.log(chalk.dim("  プロファイル:"));
        for (const p of ig.profiles) {
          const mark = active?.name === p.name ? chalk.green("● ") : "  ";
          const loc = p.endpoint ?? p.baseUrl ?? "";
          const model = p.model ?? p.checkpoint ?? "";
          console.log(chalk.dim(`    ${mark}${p.name}  [${p.providerType}] ${model} @ ${loc}`));
        }
        if (!active) {
          console.log(chalk.yellow("  ⚠ アクティブなプロファイルがありません。/image use <name> で選択してください。"));
        }
      }
      console.log(
        chalk.dim(
          "  使い方: /image on|off | setup [type] | set | use <name> | list | remove <name> | test | gen <prompt>",
        ),
      );
      console.log(
        chalk.dim(
          "  ヒント: /image setup を引数なしで実行するとバックエンド候補 (Azure / SD-WebUI / ComfyUI) から選べます。",
        ),
      );
      console.log();
    };

    switch (sub) {
      case "":
      case "status":
      case "list": {
        printStatus();
        break;
      }

      case "on": {
        if (ig.profiles.length === 0) {
          console.log(
            chalk.yellow("  プロファイルがありません。先に /image setup で追加してください (引数なしで候補から選択)。"),
          );
          break;
        }
        ig.enabled = true;
        if (!ig.active || !ig.profiles.some((p) => p.name === ig.active)) {
          ig.active = ig.profiles[0].name;
          console.log(chalk.dim(`  アクティブ未設定のため "${ig.active}" を選択しました。`));
        }
        this.config.imageGen = ig;
        saveConfig(this.config);
        this.syncImageGenerateTool();
        console.log(chalk.green("  ✓ 画像生成機能を有効化しました (image_generate ツール登録)。"));
        break;
      }

      case "off": {
        ig.enabled = false;
        this.config.imageGen = ig;
        saveConfig(this.config);
        this.syncImageGenerateTool();
        console.log(chalk.green("  ✓ 画像生成機能を無効化しました (image_generate ツール解除)。"));
        break;
      }

      case "setup": {
        const type = (args[1] ?? "").toLowerCase();
        const typeMap: Record<string, ImageProviderType> = {
          azure: "azure-image",
          "azure-image": "azure-image",
          "sd-webui": "sd-webui",
          sd: "sd-webui",
          comfyui: "comfyui",
          comfy: "comfyui",
        };
        let providerType: ImageProviderType | undefined = typeMap[type];
        if (!providerType && !type) {
          // 引数なし → プロバイダー候補メニューを提示して選んでもらう
          try {
            providerType = await select<ImageProviderType>({
              message: "画像生成バックエンドを選択してください:",
              choices: [
                new Separator("── クラウド ──"),
                { name: "Azure OpenAI GPT Images (gpt-image 系)", value: "azure-image" },
                new Separator("── ローカル / セルフホスト ──"),
                { name: "Stable Diffusion WebUI (AUTOMATIC1111)", value: "sd-webui" },
                { name: "ComfyUI (ワークフローテンプレート対応)", value: "comfyui" },
              ],
            });
          } catch (e) {
            if (e instanceof Error && e.message.includes("User force closed")) {
              console.log(chalk.yellow("\n  セットアップを中止しました。"));
              break;
            }
            throw e;
          }
        }
        if (!providerType) {
          console.log(chalk.yellow("  使い方: /image setup [azure|sd-webui|comfyui]  (引数なしで候補から選択)"));
          break;
        }
        await this.setupImageProfile(providerType);
        break;
      }

      case "use": {
        const name = args[1];
        if (!name) {
          console.log(chalk.yellow("  使い方: /image use <name>"));
          break;
        }
        if (!ig.profiles.some((p) => p.name === name)) {
          console.log(chalk.red(`  プロファイル "${name}" が見つかりません。/image list で確認してください。`));
          break;
        }
        ig.active = name;
        this.config.imageGen = ig;
        saveConfig(this.config);
        this.syncImageGenerateTool();
        console.log(chalk.green(`  ✓ アクティブプロファイルを "${name}" に切り替えました。`));
        break;
      }

      case "remove": {
        const name = args[1];
        if (!name) {
          console.log(chalk.yellow("  使い方: /image remove <name>"));
          break;
        }
        const idx = ig.profiles.findIndex((p) => p.name === name);
        if (idx < 0) {
          console.log(chalk.red(`  プロファイル "${name}" が見つかりません。`));
          break;
        }
        ig.profiles.splice(idx, 1);
        if (ig.active === name) ig.active = undefined;
        this.config.imageGen = ig;
        saveConfig(this.config);
        this.syncImageGenerateTool();
        console.log(chalk.green(`  ✓ プロファイル "${name}" を削除しました。`));
        if (!ig.active && ig.enabled && ig.profiles.length > 0) {
          console.log(chalk.yellow("  ⚠ アクティブなプロファイルがありません。/image use <name> で選択してください。"));
        }
        break;
      }

      case "set": {
        const active = this.imageService.getActiveProfile();
        if (!active) {
          console.log(chalk.yellow("  アクティブなプロファイルがありません。/image use <name> で選択してください。"));
          break;
        }
        // getActiveProfile() の戻り値は複製の可能性があるため、保存対象は ig.profiles 内の実体を掴む
        const profile = ig.profiles.find((p) => p.name === active.name);
        if (!profile) {
          console.log(chalk.red(`  プロファイル "${active.name}" が config 内に見つかりません。`));
          break;
        }

        // ① 品質を先に選ぶ (Azure のみ意味を持つ。ローカルは品質課金なしのためスキップ)
        if (profile.providerType === "azure-image") {
          const quality = await select({
            message: `既定品質を選択 (現在: ${profile.defaultQuality ?? "medium"}):`,
            choices: [
              { name: "low (約$0.006/枚)", value: "low" },
              { name: "medium (約$0.05/枚) — 推奨", value: "medium" },
              { name: "high (約$0.21/枚)", value: "high" },
            ],
            default: profile.defaultQuality ?? "medium",
          });
          profile.defaultQuality = quality as "low" | "medium" | "high";
        } else {
          console.log(chalk.dim(`  (${profile.providerType} は品質課金がないため解像度のみ設定します)`));
        }

        // ② 選んだ品質を踏まえて解像度を選ぶ (正方形 / 横長 / 縦長 / カスタム)
        const presets = ["1024x1024", "1536x1024", "1024x1536"];
        const currentSize = profile.defaultSize ?? "1024x1024";
        const sizeChoice = await select({
          message: `既定解像度を選択 (現在: ${currentSize}):`,
          choices: [
            { name: "正方形    1024x1024", value: "1024x1024" },
            { name: "横長      1536x1024", value: "1536x1024" },
            { name: "縦長      1024x1536", value: "1024x1536" },
            { name: "カスタム  (WxH を入力)", value: "custom" },
          ],
          default: presets.includes(currentSize) ? currentSize : "custom",
        });
        let size = sizeChoice;
        if (sizeChoice === "custom") {
          size = (
            await input({
              message: "解像度 WxH (例: 1024x1024):",
              default: presets.includes(currentSize) ? "1024x1024" : currentSize,
              validate: (v: string) =>
                /^\d{2,5}x\d{2,5}$/i.test(v.trim()) || "WxH 形式で入力してください (例: 1024x1024)",
            })
          )
            .trim()
            .toLowerCase();
        }
        profile.defaultSize = size;

        this.config.imageGen = ig;
        saveConfig(this.config);
        const qLabel = profile.providerType === "azure-image" ? `品質=${profile.defaultQuality} / ` : "";
        console.log(
          chalk.green(
            `  ✓ "${profile.name}" の既定を更新しました (${qLabel}解像度=${profile.defaultSize})。API Key は変更していません。`,
          ),
        );
        break;
      }

      case "test": {
        const active = this.imageService.getActiveProfile();
        if (!active) {
          console.log(chalk.yellow("  アクティブなプロファイルがありません。/image use <name> で選択してください。"));
          break;
        }
        await this.testImageBackend(active);
        break;
      }

      case "gen": {
        const prompt = args.slice(1).join(" ").trim();
        if (!prompt) {
          console.log(chalk.yellow("  使い方: /image gen <プロンプト>  (例: /image gen a red dragon, pixel art)"));
          break;
        }
        if (!this.imageService.isEnabled()) {
          console.log(chalk.yellow("  画像生成機能が無効です。/image on で有効化してください。"));
          break;
        }
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
        const outputPath = path.resolve(process.cwd(), "generated-images", `img-${stamp}.png`);
        console.log(chalk.dim(`  生成中... (保存先: ${outputPath})`));
        try {
          const result = await this.imageService.generateAndSave({ prompt }, outputPath);
          console.log(chalk.green(`  ✓ 生成しました (${result.providerType} / ${result.model}):`));
          for (const p of result.savedPaths) console.log(chalk.dim(`    ${p}`));
          console.log(
            chalk.dim(
              result.costUsd > 0
                ? `  推定コスト: ${fmtMoney(result.costUsd, this.config.jpyPerUsd)}`
                : "  コスト: $0 (ローカル生成)",
            ),
          );
          for (const w of result.warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
        } catch (e) {
          console.log(chalk.red(`  生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`));
        }
        break;
      }

      default: {
        console.log(
          chalk.yellow("  使い方: /image [on|off|setup [type]|set|use <name>|list|remove <name>|test|gen <prompt>]"),
        );
        break;
      }
    }
  }

  /** アクティブバックエンドへの疎通確認。Azure は課金回避のため設定検証のみ */
  private async testImageBackend(profile: ImageGenProfile): Promise<void> {
    console.log(chalk.dim(`  プロファイル "${profile.name}" (${profile.providerType}) を確認中...`));
    try {
      if (profile.providerType === "azure-image") {
        // 生成 API を叩くと課金されるため、設定値の検証 (apiKey 解決含む) のみ
        const { createImageProvider } = await import("../image/image-provider-factory.js");
        createImageProvider(profile, this.passphrase);
        console.log(
          chalk.green("  ✓ 設定は有効です (endpoint/apiKey/model)。実生成は課金されるため確認していません。"),
        );
      } else {
        const base = (profile.baseUrl ?? "").trim().replace(/\/$/, "");
        const pingPath = profile.providerType === "sd-webui" ? "/sdapi/v1/options" : "/system_stats";
        const res = await fetch(`${base}${pingPath}`);
        if (res.ok) {
          console.log(chalk.green(`  ✓ 接続 OK (${base}${pingPath})`));
        } else {
          console.log(chalk.yellow(`  ⚠ 応答はありましたが HTTP ${res.status} です (${base}${pingPath})`));
        }
      }
    } catch (e) {
      console.log(chalk.red(`  ✗ 確認失敗: ${e instanceof Error ? e.message : String(e)}`));
      if (profile.providerType === "sd-webui") {
        console.log(chalk.dim("    WebUI を --api オプション付きで起動しているか確認してください。"));
      }
    }
  }

  /** /image setup <type>: プロファイル追加ウィザード (/model setup と同じ inquirer 流儀) */
  private async setupImageProfile(providerType: ImageProviderType): Promise<void> {
    console.log(chalk.bold(`\n  ── 画像生成プロファイル セットアップ (${providerType}) ──`));
    console.log(chalk.dim("  キャンセルは Ctrl+C\n"));

    const ig = this.config.imageGen ?? { enabled: false, profiles: [] };

    const name = await input({
      message: "プロファイル名 (例: azure-main, local-sd):",
      validate: (v: string) => {
        const t = v.trim();
        if (!t) return "プロファイル名は必須です";
        if (ig.profiles.some((p) => p.name === t)) return `"${t}" は既に存在します`;
        return true;
      },
    });

    const profile: ImageGenProfile = { name: name.trim(), providerType };

    if (providerType === "azure-image") {
      const endpointUrl = await input({
        message: "Azure endpoint URL (例: https://your-resource.openai.azure.com — 完全URLでも host 部に自動正規化):",
        validate: (v: string) => {
          if (!v.trim()) return "endpoint URL は必須です";
          if (!/^https?:\/\//i.test(v.trim())) return "http(s):// で始めてください";
          return true;
        },
      });
      profile.endpoint = AzureImageProvider.normalizeEndpoint(endpointUrl.trim());

      profile.model = (
        await input({
          message: "Deployment 名 (例: gpt-image-2):",
          default: "gpt-image-2",
          validate: (v: string) => v.trim().length > 0 || "deployment 名は必須です",
        })
      ).trim();

      const storageMode = await select({
        message: "API Key の保存方法:",
        choices: [
          { name: "パスフレーズで暗号化保存 (推奨)", value: "encrypt" },
          { name: "環境変数参照 (env:VAR_NAME)", value: "env" },
          { name: "平文で保存 (非推奨)", value: "plain" },
        ],
        default: "encrypt",
      });
      if (storageMode === "env") {
        const envName = await input({
          message: "環境変数名 (例: AZURE_IMAGE_API_KEY):",
          validate: (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) || "有効な環境変数名を入力してください",
        });
        profile.apiKey = `env:${envName.trim()}`;
        if (!process.env[envName.trim()]) {
          console.log(
            chalk.yellow(`  ⚠ 環境変数 ${envName.trim()} は現在未設定です。アプリ起動時にセットしてください。`),
          );
        }
      } else {
        const apiKey = await password({ message: "API Key (入力は表示されません):", mask: "*" });
        if (!apiKey.trim()) {
          console.log(chalk.red("  API Key が空です。中止しました。"));
          return;
        }
        if (storageMode === "plain") {
          const ok = await confirm({
            message: "平文保存は config.json にそのまま記録されます。本当に続行しますか？",
            default: false,
          });
          if (!ok) {
            console.log(chalk.yellow("  セットアップを中止しました。"));
            return;
          }
          profile.apiKey = apiKey.trim();
        } else {
          const pass1 = await password({ message: "暗号化用パスフレーズ:", mask: "*" });
          const pass2 = await password({ message: "もう一度入力 (確認):", mask: "*" });
          if (pass1 !== pass2) {
            console.log(chalk.red("  パスフレーズが一致しません。中止しました。"));
            return;
          }
          if (pass1.length < 4) {
            console.log(chalk.red("  パスフレーズが短すぎます (4文字以上)。中止しました。"));
            return;
          }
          profile.apiKey = CredentialVault.encrypt(apiKey.trim(), pass1);
          console.log(chalk.yellow("  ⚠ 暗号化保存のため、生成実行にはメインLLM と同じ合言葉での起動が必要です。"));
        }
      }

      const quality = await select({
        message: "既定品質 (high は 1024x1024 で約$0.21/枚と高額):",
        choices: [
          { name: "medium (約$0.05/枚) — 推奨", value: "medium" },
          { name: "low (約$0.006/枚)", value: "low" },
          { name: "high (約$0.21/枚)", value: "high" },
        ],
        default: "medium",
      });
      profile.defaultQuality = quality as "low" | "medium" | "high";
    } else {
      // sd-webui / comfyui (ローカル)
      const defaultPort = providerType === "sd-webui" ? "7860" : "8188";
      const baseUrl = await input({
        message: `API URL (例: http://localhost:${defaultPort}):`,
        default: `http://localhost:${defaultPort}`,
        validate: (v: string) => /^https?:\/\//i.test(v.trim()) || "http(s):// で始めてください",
      });
      profile.baseUrl = baseUrl.trim().replace(/\/$/, "");

      if (providerType === "comfyui") {
        const checkpoint = await input({
          message: "Checkpoint ファイル名 (組み込みテンプレート用。例: sd_xl_base_1.0.safetensors):",
          validate: (v: string) => v.trim().length > 0 || "組み込みテンプレートには checkpoint 名が必須です",
        });
        profile.checkpoint = checkpoint.trim();
        const tpl = await input({
          message: "独自ワークフローテンプレート JSON の絶対パス (空欄で組み込み txt2img):",
        });
        if (tpl.trim()) profile.workflowTemplate = tpl.trim();
      }

      const negative = await input({
        message: "既定 negative prompt (空欄可):",
      });
      if (negative.trim()) profile.negativePrompt = negative.trim();
    }

    const size = await input({
      message: '既定サイズ "WxH" (空欄で 1024x1024):',
      validate: (v: string) =>
        !v.trim() || /^\d+\s*[xX×]\s*\d+$/.test(v.trim()) || '"WxH" 形式で入力してください (例: 1024x1024)',
    });
    if (size.trim()) profile.defaultSize = size.trim();

    ig.profiles.push(profile);
    // 初回プロファイルは自動でアクティブ + 機能有効化
    const isFirst = ig.profiles.length === 1;
    if (isFirst || !ig.active) {
      ig.active = profile.name;
    }
    if (isFirst && !ig.enabled) {
      ig.enabled = true;
      console.log(chalk.dim("  初回プロファイルのため画像生成機能を有効化しました。"));
    }
    this.config.imageGen = ig;
    saveConfig(this.config);
    this.syncImageGenerateTool();

    console.log(chalk.green(`\n  ✓ プロファイル "${profile.name}" を追加しました:`));
    console.log(chalk.dim(`    タイプ:   ${providerType}`));
    console.log(chalk.dim(`    接続先:   ${profile.endpoint ?? profile.baseUrl}`));
    if (profile.model) console.log(chalk.dim(`    Model:    ${profile.model}`));
    if (profile.checkpoint) console.log(chalk.dim(`    Checkpoint: ${profile.checkpoint}`));
    console.log(chalk.dim(`    アクティブ: ${ig.active === profile.name ? "はい" : `いいえ (現在: ${ig.active})`}`));
    console.log(chalk.dim("    疎通確認: /image test  /  試し生成: /image gen <プロンプト>\n"));
  }

  // ─── LLM プロファイル履歴 (/profiles) ────────────────────────────

  /**
   * `/profiles` コマンドハンドラ。
   *
   *   /profiles              対話的に履歴一覧 → 選んで main/second に適用
   *   /profiles list         一覧表示のみ (適用なし)
   *   /profiles delete       チェックボックスで複数選択削除
   *   /profiles help         使い方表示
   *
   * プロファイル選択 → 適用先 (main/second) を選ぶ → 該当 endpoint を書き戻し → applyXxxEndpoint で反映。
   */
  private async handleProfilesCommand(args: string[]): Promise<void> {
    const sub = (args[0] ?? "").toLowerCase();
    const profiles = listLLMProfiles();

    if (sub === "help" || sub === "--help" || sub === "-h") {
      console.log(chalk.bold("\n  ── /profiles ──"));
      console.log(chalk.dim("    /profiles            履歴から選んで main/second に適用"));
      console.log(chalk.dim("    /profiles list       一覧のみ表示"));
      console.log(chalk.dim("    /profiles delete     複数選択して削除"));
      console.log(chalk.dim("    /profiles help       このヘルプ"));
      console.log(chalk.dim("\n  ※ メイン/セカンドLLM を変更するたびに自動で履歴に記録されます。"));
      console.log(chalk.dim("  ※ 同じ接続情報 (providerType + model + URL/endpoint) は自動マージされます。"));
      console.log();
      return;
    }

    if (profiles.length === 0) {
      console.log(chalk.dim("  履歴はまだありません。"));
      console.log(
        chalk.dim("  /model setup や /second setup でメイン/セカンドLLM を設定すると自動的に履歴が残ります。"),
      );
      return;
    }

    if (sub === "list") {
      this.printProfilesList(profiles);
      return;
    }

    if (sub === "delete" || sub === "del" || sub === "rm") {
      try {
        const targets = await checkbox({
          message: "削除するプロファイルを選択 (スペースで複数選択):",
          choices: profiles.map((p) => ({
            name: `${p.name}  ${chalk.dim(`(last used: ${formatRelativeTime(p.lastUsedAt)})`)}`,
            value: p.id,
          })),
        });
        if (targets.length === 0) {
          console.log(chalk.dim("  削除対象が選択されませんでした。"));
          return;
        }
        const removed = deleteLLMProfiles(targets);
        console.log(chalk.green(`  ${removed} 件のプロファイルを削除しました。`));
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("User force closed"))) {
          console.log(chalk.red(`  削除に失敗: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      return;
    }

    // デフォルト動作: プロファイル選択 → 適用先選択
    if (sub && sub !== "switch" && sub !== "apply") {
      console.log(chalk.yellow(`  未知のサブコマンド: ${sub}`));
      console.log(chalk.dim("  /profiles help で使い方を表示"));
      return;
    }

    const curMain = this.config.mainLLM;
    const curSec = this.config.secondLLM?.endpoint;
    try {
      const chosenId = await select({
        message: "適用するプロファイルを選択:",
        choices: profiles.map((p) => {
          const isMain = curMain && profileMatchesEndpoint(p, curMain);
          const isSec = curSec && profileMatchesEndpoint(p, curSec);
          const tag =
            isMain && isSec
              ? chalk.cyan("  [main + second]")
              : isMain
                ? chalk.cyan("  [main]")
                : isSec
                  ? chalk.cyan("  [second]")
                  : "";
          const used = chalk.dim(`  (${formatRelativeTime(p.lastUsedAt)})`);
          return { name: `${p.name}${tag}${used}`, value: p.id };
        }),
      });

      const chosen = profiles.find((p) => p.id === chosenId);
      if (!chosen) return;

      const target = await select({
        message: `「${chosen.name}」 をどこに適用しますか?`,
        choices: [
          { name: "メインLLM に適用", value: "main" },
          { name: "セカンドLLM に適用", value: "second" },
          { name: "キャンセル", value: "cancel" },
        ],
        default: "main",
      });
      if (target === "cancel") {
        console.log(chalk.dim("  キャンセルしました。"));
        return;
      }
      await this.applyProfileTo(chosen, target as "main" | "second");
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("User force closed"))) {
        console.log(chalk.red(`  操作失敗: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  private printProfilesList(profiles: LLMProfile[]): void {
    console.log(chalk.bold(`\n  ── LLM プロファイル履歴 (${profiles.length} 件) ──`));
    const curMain = this.config.mainLLM;
    const curSec = this.config.secondLLM?.endpoint;
    for (const p of profiles) {
      const tags: string[] = [];
      if (curMain && profileMatchesEndpoint(p, curMain)) tags.push(chalk.cyan("main"));
      if (curSec && profileMatchesEndpoint(p, curSec)) tags.push(chalk.cyan("second"));
      const tagStr = tags.length > 0 ? `  [${tags.join(", ")}]` : "";
      console.log(`  ${chalk.bold(p.name)}${tagStr}`);
      console.log(chalk.dim(`    id: ${p.id}  /  last used: ${formatRelativeTime(p.lastUsedAt)}`));
    }
    console.log();
  }

  /**
   * 選んだプロファイルを main または second に書き戻して反映する。
   * apiKey が暗号化済みの場合は applyXxxEndpoint 側で合言葉を要求する。
   */
  private async applyProfileTo(profile: LLMProfile, target: "main" | "second" | "vision"): Promise<void> {
    const ep = { ...profile.endpoint };
    if (target === "main") {
      this.config.mainLLM = ep;
      saveConfig(this.config);
      await this.applyMainLLMEndpoint();
      console.log(chalk.green(`  メインLLM を 「${profile.name}」 に切り替えました。`));
    } else if (target === "vision") {
      this.config.visionLLM = ep;
      saveConfig(this.config);
      await this.applyVisionLLMEndpoint();
      console.log(chalk.green(`  Vision LLM を 「${profile.name}」 に切り替えました。`));
    } else {
      // secondLLM の枠組みを維持しつつ endpoint だけ差し替え
      this.config.secondLLM = {
        enabled: true,
        endpoint: ep,
        budget: this.config.secondLLM?.budget ?? null,
        cost: this.config.secondLLM?.cost ?? { referenceModels: [] },
        samplingDefaults: this.config.secondLLM?.samplingDefaults,
        iterationLimits: this.config.secondLLM?.iterationLimits,
      };
      saveConfig(this.config);
      await this.applySecondLLMEndpoint();
      console.log(chalk.green(`  セカンドLLM を 「${profile.name}」 に切り替えました。`));
    }
    touchProfile(profile.id);
  }

  // ─── Model Registry (/models) ─────────────────────────────────
  //
  // docs/model-registry.md
  // /profiles を一般化したコマンド: registry エントリ一覧 → アクション選択
  // (Set as main / Set as second / Edit / Duplicate / Delete / Add new)
  //
  // 互換: /profiles は alias として残し、 deprecation 注記を出す。

  private async handleModelsCommand(args: string[]): Promise<void> {
    const sub = (args[0] ?? "").toLowerCase();

    if (sub === "help" || sub === "--help" || sub === "-h") {
      console.log(chalk.bold("\n  ── /models ──"));
      console.log(chalk.dim("    /models          レジストリ一覧 → アクション選択"));
      console.log(chalk.dim("    /models list     一覧表示のみ"));
      console.log(chalk.dim("    /models slot     全 slot の割当状況を一覧表示"));
      console.log(chalk.dim("    /models slot <name>          対話ピッカーで <name> slot に割当"));
      console.log(chalk.dim("    /models slot <name> <query>  番号 / id / 名前で非対話割当"));
      console.log(chalk.dim("    /models slot clear <name>    slot を解除"));
      console.log(chalk.dim("    /models help     このヘルプ"));
      console.log(chalk.dim("\n  アクション:"));
      console.log(chalk.dim("    Set as main / second   現在の slot 割当を更新"));
      console.log(chalk.dim("    Edit                   name / サンプリング / description を編集"));
      console.log(chalk.dim("    Duplicate              バリアント (temperature 違い等) を別エントリとして複製"));
      console.log(chalk.dim("    Delete                 エントリ削除 (slot は未割当に)"));
      console.log(chalk.dim("    Add new                プロバイダ選択 → setup wizard で新規追加"));
      console.log(chalk.dim("\n  接続情報の編集 (provider / model / URL 等) は当面 Duplicate + Add new で対応。"));
      console.log(chalk.dim("  詳細: docs/model-registry.md / docs/model-orchestration.md"));
      console.log();
      return;
    }

    if (sub === "slot") {
      await this.handleModelsSlotCommand(args.slice(1));
      return;
    }

    if (sub && sub !== "list") {
      console.log(chalk.yellow(`  未知のサブコマンド: ${sub}`));
      console.log(chalk.dim("  /models help で使い方を表示"));
      return;
    }

    if (sub === "list") {
      this.modelsPrintList();
      return;
    }

    // メインループ: 一覧表示 → アクション → 戻る
    // user が Exit を選ぶか Ctrl+C で抜けるまで繰り返す
    while (true) {
      const r = await this.modelsListMenu();
      if (r === "exit") break;
    }
  }

  /** /models list — 静的な一覧表示。 操作なし。 */
  private modelsPrintList(): void {
    const entries = listRegistryEntries();
    const slots = getRegistrySlots();
    if (entries.length === 0) {
      console.log(chalk.dim("  登録モデルはまだありません。"));
      return;
    }
    console.log(chalk.bold(`\n  ── Model Registry (${entries.length} 件) ──`));
    for (const e of entries) {
      const tags: string[] = [];
      if (e.id === slots.main) tags.push("main");
      if (e.id === slots.second) tags.push("second");
      if (slots.named) {
        for (const [k, v] of Object.entries(slots.named)) {
          if (v === e.id) tags.push(k);
        }
      }
      const tagStr = tags.length > 0 ? `  ${chalk.cyan("[" + tags.join(", ") + "]")}` : "";
      const sp = formatSamplingHint(e.endpoint);
      console.log(`  ${chalk.bold(e.name)}${tagStr}${sp ? "  " + chalk.dim(sp) : ""}`);
      console.log(chalk.dim(`    id: ${e.id}  last used: ${formatRelativeTime(e.lastUsedAt)}`));
    }
    console.log();
  }

  // ─── /models slot (Model Registry Phase 6) ───────────────────
  //
  // docs/model-orchestration.md §7
  //   /models slot                 全 slot の割当状況を一覧
  //   /models slot <name>          対話ピッカーで entry を選び <name> に割当
  //   /models slot <name> <query>  番号 / id 前方一致 / 名前部分一致で非対話割当
  //   /models slot clear <name>    slot を解除

  private async handleModelsSlotCommand(args: string[]): Promise<void> {
    const first = (args[0] ?? "").trim();

    if (!first) {
      this.modelsPrintSlots();
      return;
    }

    if (first.toLowerCase() === "clear") {
      const name = (args[1] ?? "").trim().toLowerCase();
      if (!name) {
        console.log(chalk.yellow("  解除する slot 名を指定してください。 例: /models slot clear deep"));
        return;
      }
      if (!this.assertFreeSlotName(name)) return;
      const current = getRegistrySlots().named?.[name];
      if (!current) {
        console.log(chalk.dim(`  slot '${name}' は元から未割当です。`));
        return;
      }
      clearRegistrySlot(name);
      invalidateModelCache(current);
      console.log(chalk.green(`  slot '${name}' を解除しました。`));
      return;
    }

    const name = first.toLowerCase();
    if (!this.assertFreeSlotName(name)) return;

    const entries = listRegistryEntries();
    if (entries.length === 0) {
      console.log(chalk.yellow("  登録モデルがありません。 /models の Add new から追加してください。"));
      return;
    }

    const query = args.slice(1).join(" ").trim();
    let entry: LLMRegistryEntry | undefined;

    if (query) {
      entry = resolveEntryQuery(query);
      if (!entry) {
        console.log(chalk.yellow(`  '${query}' に一致するモデルを 1 件に絞れませんでした。`));
        console.log(chalk.dim("  /models list で番号 / id / 名前を確認してください。"));
        return;
      }
    } else {
      try {
        const chosen = await select<string>({
          message: `slot '${name}' に割り当てるモデル:`,
          choices: [...entries.map((e) => ({ name: e.name, value: e.id })), { name: chalk.dim("Cancel"), value: "" }],
          pageSize: Math.min(15, entries.length + 1),
        });
        if (!chosen) return;
        entry = getRegistryEntry(chosen);
      } catch {
        return;
      }
    }

    if (!entry) return;
    if (!setRegistrySlot(name, entry.id)) {
      console.log(chalk.red("  割当に失敗しました (エントリが見つかりません)。"));
      return;
    }
    invalidateModelCache(entry.id);
    console.log(chalk.green(`  slot '${name}' に 「${entry.name}」 を割り当てました。`));
    console.log(
      chalk.dim(`  task ツールの model 引数、 またはエージェント定義の frontmatter 'model: ${name}' で指名できます。`),
    );
  }

  /** 自由 named slot として使える名前かを検証する。 駄目なら理由を表示して false。 */
  private assertFreeSlotName(name: string): boolean {
    if ((RESERVED_SLOT_NAMES as readonly string[]).includes(name)) {
      // main/second/vision は config.json への同期書込みと provider 再生成を伴うため、
      // 単なる slot 参照の付け替えでは済まない。 それぞれの正規経路へ誘導する。
      const how =
        name === "main"
          ? "/models の Set as main"
          : name === "second"
            ? "/models の Set as second (または /model second setup)"
            : "/models の Set as vision (または /model vision setup)";
      console.log(chalk.yellow(`  '${name}' は予約 slot です。 /models slot からは変更できません。`));
      console.log(chalk.dim(`  ${how} から設定してください。`));
      return false;
    }
    if (!isValidSlotName(name)) {
      console.log(chalk.yellow(`  slot 名 '${name}' は使えません。`));
      console.log(
        chalk.dim("  英小文字で始まり、 英小文字 / 数字 / ハイフンのみ、 2〜20 文字 (例: fast, deep, review)。"),
      );
      console.log(chalk.dim("  大文字や日本語を許すと task ツール引数での取り違えが増えるため制限しています。"));
      return false;
    }
    return true;
  }

  /** 全 slot の割当状況を表示する。 */
  private modelsPrintSlots(): void {
    const slots = getRegistrySlots();
    const nameOf = (id: string | undefined, fallback: string): string => {
      if (!id) return chalk.dim(fallback);
      const e = getRegistryEntry(id);
      return e ? e.name : chalk.red(`(削除済みエントリ: ${id})`);
    };

    console.log(chalk.bold("\n  ── Slots ──"));
    console.log(`  ${"main".padEnd(8)} ${nameOf(slots.main || undefined, "(未割当)")}`);
    console.log(`  ${"second".padEnd(8)} ${nameOf(slots.second, "(未割当)")}`);
    console.log(`  ${"vision".padEnd(8)} ${nameOf(slots.named?.vision, "(未割当 → main にフォールバック)")}`);

    const free = listNamedSlots();
    for (const { slot, entryId } of free) {
      console.log(`  ${slot.padEnd(8)} ${nameOf(entryId, "(未割当)")}`);
    }
    if (free.length === 0) {
      console.log(chalk.dim("\n  自由 slot はまだありません。"));
    }
    console.log(chalk.dim("\n  /models slot <name> <モデル> で割当 / /models slot clear <name> で解除"));
    console.log();
  }

  /** インタラクティブ一覧 + Exit/Add のキー。 */
  private async modelsListMenu(): Promise<"continue" | "exit"> {
    const entries = listRegistryEntries();
    const slots = getRegistrySlots();

    if (entries.length === 0) {
      console.log(chalk.dim("\n  モデル未登録です。"));
      try {
        const ok = await confirm({ message: "新規追加する?", default: true });
        if (!ok) return "exit";
      } catch {
        return "exit";
      }
      await this.modelsAddNew();
      return "continue";
    }

    const choices = entries.map((e) => {
      const tags: string[] = [];
      if (e.id === slots.main) tags.push("main");
      if (e.id === slots.second) tags.push("second");
      if (slots.named) {
        for (const [k, v] of Object.entries(slots.named)) {
          if (v === e.id) tags.push(k);
        }
      }
      const tagStr = tags.length > 0 ? chalk.cyan(` [${tags.join(", ")}]`) : "";
      const sp = formatSamplingHint(e.endpoint);
      return {
        name: `${chalk.bold(e.name)}${tagStr}${sp ? chalk.dim("  " + sp) : ""}`,
        value: `entry:${e.id}`,
      };
    });
    choices.push({ name: chalk.green("  + Add new..."), value: "add" });
    choices.push({ name: chalk.dim("  Exit"), value: "exit" });

    let chosen: string;
    try {
      chosen = await select({
        message: `Model Registry (${entries.length} 件):`,
        choices,
        pageSize: Math.min(15, choices.length),
      });
    } catch {
      return "exit";
    }

    if (chosen === "exit") return "exit";
    if (chosen === "add") {
      await this.modelsAddNew();
      return "continue";
    }
    if (chosen.startsWith("entry:")) {
      const id = chosen.slice("entry:".length);
      const entry = getRegistryEntry(id);
      if (entry) await this.modelsEntryActionMenu(entry);
      return "continue";
    }
    return "continue";
  }

  /** エントリ選択後のアクションメニュー。 */
  private async modelsEntryActionMenu(entry: LLMRegistryEntry): Promise<void> {
    const slots = getRegistrySlots();
    const isMain = entry.id === slots.main;
    const isSec = entry.id === slots.second;
    const isVision = slots.named?.vision === entry.id;
    const slotTags: string[] = [];
    if (isMain) slotTags.push("main");
    if (isSec) slotTags.push("second");
    if (isVision) slotTags.push("vision");
    const tag = slotTags.length > 0 ? ` [${slotTags.join(" + ")}]` : "";

    let action: string;
    try {
      action = await select({
        message: `${entry.name}${chalk.cyan(tag)}`,
        choices: [
          { name: "Set as main" + (isMain ? chalk.dim("  (現在)") : ""), value: "set-main", disabled: isMain },
          { name: "Set as second" + (isSec ? chalk.dim("  (現在)") : ""), value: "set-second", disabled: isSec },
          { name: "Set as vision" + (isVision ? chalk.dim("  (現在)") : ""), value: "set-vision", disabled: isVision },
          { name: "Edit (name / サンプリング / description)", value: "edit" },
          { name: "Duplicate (バリアント作成)", value: "duplicate" },
          { name: chalk.red("Delete"), value: "delete" },
          { name: chalk.dim("Back"), value: "back" },
        ],
      });
    } catch {
      return;
    }

    switch (action) {
      case "set-main":
        await this.applyProfileTo(entry, "main");
        break;
      case "set-second":
        await this.applyProfileTo(entry, "second");
        break;
      case "set-vision":
        await this.applyProfileTo(entry, "vision");
        break;
      case "edit":
        await this.modelsEditDialog(entry);
        break;
      case "duplicate":
        await this.modelsDuplicate(entry);
        break;
      case "delete":
        await this.modelsDelete(entry);
        break;
      // "back" は何もしない
    }
  }

  /**
   * Edit ダイアログ。 Phase 2 では name / サンプリングパラメータ / description のみ。
   * 接続情報 (provider / model / URL 等) は Duplicate + Add new で対応 (docs/model-registry.md §4.3)。
   */
  private async modelsEditDialog(entry: LLMRegistryEntry): Promise<void> {
    try {
      const newName = await input({ message: "Name:", default: entry.name });
      const tempStr = await input({
        message: "Temperature (空で未指定):",
        default: entry.endpoint.temperature !== undefined ? String(entry.endpoint.temperature) : "",
      });
      const topPStr = await input({
        message: "Top-p (空で未指定):",
        default: entry.endpoint.top_p !== undefined ? String(entry.endpoint.top_p) : "",
      });
      const topKStr = await input({
        message: "Top-k (空で未指定):",
        default: entry.endpoint.top_k !== undefined ? String(entry.endpoint.top_k) : "",
      });
      const repPStr = await input({
        message: "Repetition penalty (空で未指定):",
        default: entry.endpoint.repetition_penalty !== undefined ? String(entry.endpoint.repetition_penalty) : "",
      });
      const desc = await input({ message: "Description (空で未指定):", default: entry.endpoint.description ?? "" });

      const parseOpt = (s: string): number | undefined => {
        const t = s.trim();
        if (t === "") return undefined;
        const n = Number(t);
        return Number.isNaN(n) ? NaN : n;
      };
      const parsedTemp = parseOpt(tempStr);
      const parsedTopP = parseOpt(topPStr);
      const parsedTopK = parseOpt(topKStr);
      const parsedRepP = parseOpt(repPStr);
      const numerics: [string, number | undefined][] = [
        ["temperature", parsedTemp],
        ["top_p", parsedTopP],
        ["top_k", parsedTopK],
        ["repetition_penalty", parsedRepP],
      ];
      for (const [n, v] of numerics) {
        if (v !== undefined && Number.isNaN(v)) {
          console.log(chalk.red(`  ${n} が数値ではありません。 編集を中止しました。`));
          return;
        }
      }

      const newEndpoint: LLMEndpoint = {
        ...entry.endpoint,
        temperature: parsedTemp,
        top_p: parsedTopP,
        top_k: parsedTopK,
        repetition_penalty: parsedRepP,
        description: desc.trim() === "" ? undefined : desc,
      };

      updateRegistryEntry(entry.id, { name: newName, endpoint: newEndpoint });
      console.log(chalk.green(`  「${newName}」 を更新しました。`));

      // slot に居れば config も同期 + apply
      const slots = getRegistrySlots();
      if (entry.id === slots.main) {
        this.config.mainLLM = newEndpoint;
        saveConfig(this.config);
        await this.applyMainLLMEndpoint();
      } else if (entry.id === slots.second && this.config.secondLLM) {
        this.config.secondLLM.endpoint = newEndpoint;
        saveConfig(this.config);
        await this.applySecondLLMEndpoint();
      }
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("User force closed"))) {
        console.log(chalk.red(`  編集失敗: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  /** Duplicate: 同 endpoint で新規 UUID のエントリを作る。 サンプリング違いを試したい用途。 */
  private async modelsDuplicate(entry: LLMRegistryEntry): Promise<void> {
    try {
      const newName = await input({ message: "新しいエントリ名:", default: `${entry.name} (copy)` });
      const created = recordRegistryEntry(entry.endpoint, { forceNew: true });
      if (!created) {
        console.log(chalk.red("  複製に失敗しました (endpoint が不完全)。"));
        return;
      }
      updateRegistryEntry(created.id, { name: newName });
      console.log(chalk.green(`  「${newName}」 として複製しました。`));
      console.log(chalk.dim("  サンプリングパラメータ等の変更は Edit から。"));
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("User force closed"))) {
        console.log(chalk.red(`  複製失敗: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  /** Delete: 確認の上 entry 削除。 slot に居た場合は警告。 */
  private async modelsDelete(entry: LLMRegistryEntry): Promise<void> {
    const slots = getRegistrySlots();
    const isMain = entry.id === slots.main;
    const isSec = entry.id === slots.second;
    try {
      if (isMain || isSec) {
        const t = isMain && isSec ? "main + second" : isMain ? "main" : "second";
        console.log(
          chalk.yellow(
            `  ⚠ このエントリは現在 [${t}] slot に割り当てられています。 削除すると slot は未割当になります。`,
          ),
        );
      }
      const ok = await confirm({ message: `「${entry.name}」 を削除しますか?`, default: false });
      if (!ok) {
        console.log(chalk.dim("  キャンセルしました。"));
        return;
      }
      deleteRegistryEntry(entry.id);
      console.log(chalk.green("  削除しました。"));
      if (isMain)
        console.log(chalk.yellow("  main slot が空になりました。 /models から Set as main で再割当してください。"));
      if (isSec) console.log(chalk.yellow("  second slot が空になりました。"));
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("User force closed"))) {
        console.log(chalk.red(`  削除失敗: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  /** Add new: provider 選択 → slot 選択 → 既存 setup wizard へ流す。 */
  private async modelsAddNew(): Promise<void> {
    try {
      const target = await select<"main" | "second" | "vision">({
        message: "新規モデルを割り当てる slot:",
        choices: [
          { name: "メインLLM (main)", value: "main" },
          { name: "セカンドLLM (second)", value: "second" },
          { name: "Vision LLM (画像認識を含むマルチモーダル言語生成 AI)", value: "vision" },
        ],
        default: "main",
      });

      const provider = await select<string>({
        message: "プロバイダを選択:",
        choices: [
          { name: "Anthropic API (Claude direct, ANTHROPIC_API_KEY)", value: "anthropic" },
          { name: "Google AI Studio (Gemini, GEMINI_API_KEY)", value: "gemini" },
          { name: "Claude Code CLI (claude -p、 認証は claude login、 tool calling 不可)", value: "claude-cli" },
          {
            name: "Claude Agent SDK (in-process MCP、 認証は claude login、 tool calling 対応)",
            value: "claude-agent-sdk",
          },
          { name: "Azure OpenAI — Chat Completions API", value: "azure-openai" },
          { name: "Azure OpenAI — Responses API (gpt-5/codex系)", value: "azure-gpt" },
          { name: "Azure Claude — Anthropic Messages API", value: "azure-anthropic" },
          { name: "Azure Claude — OpenAI互換ルート", value: "azure-claude" },
          { name: "Azure AI Foundry (Kimi/Mistral等)", value: "azure-foundry" },
          { name: "Ollama (local)", value: "ollama" },
          { name: "LM Studio (local)", value: "lmstudio" },
          { name: "llama.cpp (local)", value: "llamacpp" },
          { name: "vLLM (local)", value: "vllm" },
        ],
      });

      if (provider === "anthropic" || provider === "claude-cli" || provider === "claude-agent-sdk") {
        await this.setupClaudeLLM(target, provider);
      } else if (provider === "gemini") {
        await this.setupGeminiLLM(target);
      } else if (
        provider === "azure-openai" ||
        provider === "azure-gpt" ||
        provider === "azure-claude" ||
        provider === "azure-foundry" ||
        provider === "azure-anthropic"
      ) {
        await this.setupAzureLLM(target, provider);
      } else if (provider === "ollama" || provider === "lmstudio" || provider === "llamacpp" || provider === "vllm") {
        // ローカル系: target ごとに別の setup ヘルパを使う
        if (target === "vision") {
          await this.setupLocalVisionLLM(provider);
        } else {
          // 既存の handleModelSetupLocal は main 固定。 second の場合は注意喚起のみ。
          if (target === "second") {
            console.log(chalk.yellow("  ローカル系 LLM の second セットアップ専用フローは未実装です。"));
            console.log(chalk.dim("  一旦 main にセットアップし、 /swap で main ⇔ second を入れ替えてください。"));
          }
          await this.handleModelSetupLocal();
        }
      } else {
        console.log(chalk.red(`  未対応のプロバイダ: ${provider}`));
      }
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("User force closed"))) {
        console.log(chalk.red(`  追加失敗: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  /**
   * セカンドLLM (second slot) のサブコマンドハンドラ。
   *
   * 2026-05-27: /model second ... と /second ... の両方から呼ばれる共通実装。
   * docs/model-registry.md §4.1 で /second を /model のサブに統合した結果、
   * dispatch だけ 2 経路あり、 ロジックは本メソッドに集約される。
   *
   * args は subcommand 部分 (`/model second context 128k` なら ["context", "128k"]、
   * `/second context 128k` なら同じ ["context", "128k"])。
   */
  private async handleSecondLLMCommand(args: string[]): Promise<void> {
    const subCmd = args[0];
    // セカンドLLM未設定 かつ setup 以外のサブコマンドの場合
    if (!subCmd || subCmd === "status" || subCmd === "info") {
      // status は設定の有無にかかわらず表示。 info も同義として受ける (/model info と対称)。
      const cfg = this.config.secondLLM;
      console.log(chalk.bold("\n  ── セカンドLLM ──"));
      if (!cfg) {
        console.log(chalk.dim(`  状態: ${chalk.red("未設定")}`));
        console.log(chalk.dim(`  設定するには: /model second setup`));
      } else {
        const isAvail = this.secondLLMManager?.isAvailable() ?? false;
        console.log(
          chalk.dim(
            `  状態:         ${cfg.enabled ? (isAvail ? chalk.green("有効 (接続OK)") : chalk.yellow("有効 (接続失敗)")) : chalk.red("無効")}`,
          ),
        );
        console.log(chalk.dim(`  プロバイダー: ${cfg.endpoint.providerType}`));
        console.log(chalk.dim(`  URL:          ${cfg.endpoint.baseUrl ?? "(なし)"}`));
        console.log(chalk.dim(`  モデル:       ${cfg.endpoint.model}`));
        const ctxW = cfg.endpoint.contextWindow;
        const ctxLabel = ctxW
          ? ctxW >= 1000
            ? `${Math.round(ctxW / 1000)}K`
            : `${ctxW}`
          : "(未設定 — サーバ側デフォルト)";
        console.log(chalk.dim(`  コンテキスト: ${ctxLabel}  ${chalk.gray("※会話履歴はメインと独立")}`));
        const secDesc = cfg.endpoint.description?.trim();
        console.log(
          chalk.dim(
            `  特性:         ${secDesc ? chalk.cyan(secDesc) : chalk.yellow("(未設定 — /models Edit から設定)")}`,
          ),
        );
        const sp = cfg.endpoint;
        const fmt = (v: number | undefined) => (v !== undefined ? chalk.cyan(String(v)) : chalk.gray("auto"));
        console.log(chalk.dim(`  temperature:  ${fmt(sp.temperature)}    ${chalk.gray("(/models Edit で変更)")}`));
        console.log(chalk.dim(`  top_p:        ${fmt(sp.top_p)}`));
        console.log(chalk.dim(`  top_k:        ${fmt(sp.top_k)}`));
        console.log(chalk.dim(`  rep_penalty:  ${fmt(sp.repetition_penalty)}`));
      }
      console.log();
    } else if (subCmd === "description") {
      const text = args.slice(1).join(" ").trim();
      if (!this.config.secondLLM) {
        console.log(chalk.red("  Second LLM の設定が存在しません。/model second setup で初期設定してください。"));
      } else if (!text) {
        const cur = this.config.secondLLM.endpoint.description?.trim();
        console.log(chalk.bold("\n  ── セカンドLLM特性説明 ──"));
        console.log(chalk.dim(`  現在: ${cur ? chalk.cyan(cur) : chalk.yellow("(未設定)")}`));
        console.log(chalk.dim(`  使い方: /model second description <説明文>`));
        console.log(chalk.dim(`  クリア: /model second description clear`));
        console.log(chalk.dim(`  推奨: 100〜300文字程度でモデルの得意/不得意、速度感、用途を記載`));
        console.log(chalk.bold("\n  ── 記載例 ──"));
        console.log(chalk.dim(`    "Dense 13B。高速・コーディング特化・日本語苦手。コード生成やリファクタ委任向き"`));
        console.log(chalk.dim(`    "MoE 70B。推論品質は最高峰だが遅い。重要な設計判断・複雑レビュー委任向き"`));
        console.log(chalk.dim(`    "軽量7B。超高速だが精度中程度。要約・grep結果の絞り込み・機械的委任向き"`));
        console.log();
      } else if (text.toLowerCase() === "clear") {
        this.config.secondLLM.endpoint.description = undefined;
        saveConfig(this.config);
        this.refreshLLMProfiles();
        console.log(chalk.yellow("  セカンドLLMの特性説明をクリアしました"));
      } else {
        this.config.secondLLM.endpoint.description = text;
        saveConfig(this.config);
        this.refreshLLMProfiles();
        console.log(chalk.green(`  セカンドLLMの特性説明を設定しました (${text.length}文字):`));
        console.log(chalk.dim(`  ${text}`));
        if (text.length < 30) {
          console.log(chalk.yellow(`  ※ 短すぎて委任判断の材料になりにくいかもしれません。100文字以上推奨`));
        } else if (text.length > 500) {
          console.log(chalk.yellow(`  ※ 長すぎるとシステムプロンプトを圧迫します。300文字以内推奨`));
        }
      }
    } else if (subCmd === "enable") {
      if (this.config.secondLLM) {
        this.config.secondLLM.enabled = true;
        saveConfig(this.config);
        console.log(
          chalk.green("  Second LLM を有効化しました (設定に保存)。（再起動後に完全適用される場合があります）"),
        );
      } else {
        console.log(chalk.red("  Second LLM の設定が config.json に存在しません。"));
      }
    } else if (subCmd === "disable") {
      if (this.config.secondLLM) {
        this.config.secondLLM.enabled = false;
        saveConfig(this.config);
        console.log(chalk.yellow("  Second LLM を無効化しました (設定に保存)。"));
      }
    } else if (subCmd === "model" || subCmd === "list") {
      const newModel = subCmd === "model" ? args.slice(1).join(" ").trim() : "";
      if (!this.config.secondLLM) {
        console.log(chalk.red("  Second LLM の設定が存在しません。/model second setup で初期設定してください。"));
      } else if (!newModel) {
        // 引数なし or list: サーバーからモデル一覧を取得して選択
        const provider = this.secondLLMManager?.getProvider();
        if (!provider) {
          console.log(chalk.dim(`  現在のモデル: ${this.config.secondLLM.endpoint.model ?? "(未設定)"}`));
          console.log(chalk.dim(`  プロバイダーに接続できません。直接指定: /model second model <モデル名>`));
        } else {
          try {
            const models = await provider.listModels();
            if (models.length === 0) {
              console.log(chalk.dim("  利用可能なモデルはありません。直接指定: /model second model <モデル名>"));
            } else {
              const currentModel = this.config.secondLLM.endpoint.model;
              const chosen = await select({
                message: "セカンドLLMのモデルを選択:",
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
                this.config.secondLLM.endpoint.model = chosen;
                saveConfig(this.config);
                await this.applySecondLLMEndpoint();
                console.log(chalk.dim(`  セカンドLLMモデル: ${chalk.yellow(currentModel)} → ${chalk.cyan(chosen)}`));
              } else {
                console.log(chalk.dim(`  モデルは変更されませんでした。`));
              }
            }
          } catch (e) {
            if (!(e instanceof Error && e.message.includes("User force closed"))) {
              console.log(chalk.red(`  モデル一覧の取得に失敗: ${e instanceof Error ? e.message : String(e)}`));
              console.log(chalk.dim(`  直接指定: /model second model <モデル名>`));
            }
          }
        }
      } else {
        const oldModel = this.config.secondLLM.endpoint.model;
        this.config.secondLLM.endpoint.model = newModel;
        saveConfig(this.config);
        await this.applySecondLLMEndpoint();
        console.log(chalk.dim(`  セカンドLLMモデル: ${chalk.yellow(oldModel)} → ${chalk.cyan(newModel)}`));
      }
    } else if (subCmd === "context") {
      const val = args[1] ? parseTokenCount(args[1]) : NaN;
      if (!this.config.secondLLM) {
        console.log(chalk.red("  Second LLM の設定が config.json に存在しません。"));
      } else if (isNaN(val) || val <= 0) {
        const cur = this.config.secondLLM.endpoint.contextWindow;
        const curLabel = cur
          ? cur >= 1000
            ? `${Math.round(cur / 1000)}K`
            : `${cur}`
          : "(未設定 — サーバ側デフォルト)";
        console.log(chalk.dim(`  セカンドLLMコンテキスト長: ${curLabel}`));
        console.log(chalk.dim(`  使い方: /model second context <トークン数>`));
        console.log(chalk.dim(`  例: /model second context 128k  /model second context 32000`));
      } else {
        const old = this.config.secondLLM.endpoint.contextWindow;
        const oldLabel = old ? (old >= 1000 ? `${Math.round(old / 1000)}K` : `${old}`) : "(未設定)";
        this.config.secondLLM.endpoint.contextWindow = val;
        saveConfig(this.config);
        await this.applySecondLLMEndpoint();
        const newLabel = val >= 1000 ? `${Math.round(val / 1000)}K` : `${val}`;
        console.log(
          chalk.dim(`  セカンドLLMコンテキスト長: ${chalk.yellow(oldLabel)} → ${chalk.cyan(newLabel)} トークン`),
        );
      }
    } else if (subCmd === "url") {
      const newUrl = args.slice(1).join(" ").trim();
      if (!newUrl) {
        console.log(chalk.dim(`  現在のURL: ${this.config.secondLLM?.endpoint.baseUrl ?? "(未設定)"}`));
        console.log(chalk.dim(`  使い方: /model second url <URL>`));
        console.log(chalk.dim(`  例: /model second url http://192.168.1.201:8000`));
      } else if (this.config.secondLLM) {
        const oldUrl = this.config.secondLLM.endpoint.baseUrl ?? "(未設定)";
        this.config.secondLLM.endpoint.baseUrl = newUrl;
        saveConfig(this.config);
        await this.applySecondLLMEndpoint();
        console.log(chalk.dim(`  URL: ${chalk.yellow(oldUrl)} → ${chalk.cyan(newUrl)}`));
        console.log(chalk.green(`  実行時に反映しました。`));
      } else {
        console.log(chalk.red("  Second LLM の設定が存在しません。/model second setup で初期設定してください。"));
      }
    } else if (subCmd === "provider") {
      const newProvider = args[1]?.trim();
      const validProviders = [
        "ollama",
        "lmstudio",
        "llamacpp",
        "vllm",
        "vertex-ai",
        "azure-openai",
        "azure-gpt",
        "azure-claude",
        "azure-foundry",
        "azure-anthropic",
        "anthropic",
        "claude-cli",
        "claude-agent-sdk",
        "gemini",
      ];
      if (!newProvider) {
        console.log(chalk.dim(`  現在のプロバイダー: ${this.config.secondLLM?.endpoint.providerType ?? "(未設定)"}`));
        console.log(chalk.dim(`  使い方: /model second provider <タイプ>`));
        console.log(chalk.dim(`  選択肢: ${validProviders.join(", ")}`));
      } else if (!validProviders.includes(newProvider)) {
        console.log(chalk.red(`  無効なプロバイダー: ${newProvider}`));
        console.log(chalk.dim(`  選択肢: ${validProviders.join(", ")}`));
      } else if (this.config.secondLLM) {
        const oldProvider = this.config.secondLLM.endpoint.providerType;
        this.config.secondLLM.endpoint.providerType = newProvider as SecondLLMProviderType;
        saveConfig(this.config);
        await this.applySecondLLMEndpoint();
        console.log(chalk.dim(`  プロバイダー: ${chalk.yellow(oldProvider)} → ${chalk.cyan(newProvider)}`));
        const isCloud = [
          "vertex-ai",
          "azure-openai",
          "azure-gpt",
          "azure-claude",
          "azure-foundry",
          "azure-anthropic",
          "anthropic",
          "claude-cli",
          "claude-agent-sdk",
          "gemini",
        ].includes(newProvider);
        if (isCloud) {
          console.log(
            chalk.dim(
              `  クラウドプロバイダーは追加の認証情報が必要な場合があります。/model second で確認してください。`,
            ),
          );
        } else {
          console.log(chalk.green(`  実行時に反映しました。`));
        }
      } else {
        console.log(chalk.red("  Second LLM の設定が存在しません。/model second setup で初期設定してください。"));
      }
    } else if (subCmd === "setup") {
      const provider = (args[1] ?? "vllm") as SecondLLMProviderType;
      if (
        provider === "azure-openai" ||
        provider === "azure-gpt" ||
        provider === "azure-claude" ||
        provider === "azure-foundry" ||
        provider === "azure-anthropic"
      ) {
        try {
          await this.setupAzureLLM("second", provider);
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("User force closed"))) {
            console.log(chalk.red(`  Azure セットアップ中にエラー: ${e instanceof Error ? e.message : String(e)}`));
          } else {
            console.log(chalk.yellow("  セットアップを中止しました。"));
          }
        }
      } else if (provider === "anthropic" || provider === "claude-cli" || provider === "claude-agent-sdk") {
        try {
          await this.setupClaudeLLM("second", provider);
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("User force closed"))) {
            console.log(chalk.red(`  Claude セットアップ中にエラー: ${e instanceof Error ? e.message : String(e)}`));
          } else {
            console.log(chalk.yellow("  セットアップを中止しました。"));
          }
        }
      } else if (provider === "gemini") {
        try {
          await this.setupGeminiLLM("second");
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("User force closed"))) {
            console.log(chalk.red(`  Gemini セットアップ中にエラー: ${e instanceof Error ? e.message : String(e)}`));
          } else {
            console.log(chalk.yellow("  セットアップを中止しました。"));
          }
        }
      } else if (!args[1]) {
        // 引数なし → 履歴があれば履歴から選ぶ UI を提示
        try {
          if (await this.maybeOfferProfileHistory("second")) return;
        } catch (e) {
          if (e instanceof Error && e.message.includes("User force closed")) {
            console.log(chalk.yellow("  セットアップを中止しました。"));
            return;
          }
          throw e;
        }
        console.log(
          chalk.dim("  履歴がありません。 provider/url/model を指定して /model second setup を再実行してください。"),
        );
        console.log(chalk.dim("  例: /model second setup vllm http://localhost:8000 qwen3-8b"));
      } else {
        const url = args[2] ?? "http://localhost:8000";
        const model = args[3] ?? "";
        this.config.secondLLM = {
          enabled: true,
          endpoint: {
            providerType: provider,
            model,
            baseUrl: url,
          },
          budget: null,
          cost: { referenceModels: [] },
        };
        saveConfig(this.config);
        console.log(chalk.green("  セカンドLLMを初期設定しました:"));
        console.log(chalk.dim(`  プロバイダー: ${provider}`));
        console.log(chalk.dim(`  URL:          ${url}`));
        console.log(chalk.dim(`  モデル:       ${model || "(未指定 — /model second model で設定)"}`));
        console.log(chalk.dim(`  (反映には再起動が必要です)`));
      }
    } else if (subCmd === "temperature" || subCmd === "top_p" || subCmd === "top_k" || subCmd === "rep_penalty") {
      if (!this.config.secondLLM) {
        console.log(chalk.red("  Second LLM の設定が存在しません。/model second setup で初期設定してください。"));
      } else {
        const paramKeyMap: Record<string, "temperature" | "top_p" | "top_k" | "repetition_penalty"> = {
          temperature: "temperature",
          top_p: "top_p",
          top_k: "top_k",
          rep_penalty: "repetition_penalty",
        };
        const paramKey = paramKeyMap[subCmd];
        const ranges: Record<string, { min: number; max: number; recommended: string; integer?: boolean }> = {
          temperature: { min: 0, max: 2, recommended: "0.0〜1.0 (推論重視は 0.2、創造性重視は 0.8前後)" },
          top_p: { min: 0, max: 1, recommended: "0.85〜0.95 (1.0で無効化)" },
          top_k: { min: 1, max: 1000, recommended: "20〜50 (大きいほど多様、Ollama系で有効)", integer: true },
          repetition_penalty: { min: 0, max: 2, recommended: "1.0〜1.15 (1.0で中立、>1で繰り返し抑制)" },
        };
        const r = ranges[paramKey];
        const valArg = args[1]?.trim().toLowerCase();
        const cur = this.config.secondLLM.endpoint[paramKey];
        const curStr =
          cur !== undefined
            ? String(cur)
            : chalk.gray("auto (consult=0.2 / agent=0.2 / evaluator=0.1 を内部既定として使用)");

        if (!valArg) {
          console.log(chalk.bold(`\n  ── セカンドLLM ${subCmd} ──`));
          console.log(chalk.dim(`  現在値: ${curStr}`));
          console.log(chalk.dim(`  推奨値: ${r.recommended}`));
          console.log(chalk.dim(`  範囲:   ${r.min} 〜 ${r.max}${r.integer ? " (整数)" : ""}`));
          console.log(chalk.dim(`  使い方: /model second ${subCmd} <値>  (または /models Edit から)`));
          console.log(chalk.dim(`  クリア: /model second ${subCmd} auto  (または clear)`));
        } else if (valArg === "auto" || valArg === "clear") {
          delete this.config.secondLLM.endpoint[paramKey];
          saveConfig(this.config);
          await this.applySecondLLMEndpoint();
          console.log(chalk.yellow(`  セカンドLLM ${subCmd} を auto (内部既定) に戻しました`));
        } else {
          const num = r.integer ? parseInt(valArg, 10) : parseFloat(valArg);
          if (isNaN(num) || num < r.min || num > r.max) {
            console.log(chalk.red(`  無効な値: ${valArg}`));
            console.log(chalk.dim(`  範囲: ${r.min} 〜 ${r.max}${r.integer ? " (整数)" : ""}`));
          } else {
            this.config.secondLLM.endpoint[paramKey] = num;
            saveConfig(this.config);
            await this.applySecondLLMEndpoint();
            console.log(
              chalk.green(
                `  セカンドLLM ${subCmd} を ${chalk.cyan(String(num))} に設定しました (次のLLM呼び出しから反映)`,
              ),
            );
          }
        }
      }
    } else {
      console.log(chalk.yellow("  使い方:"));
      console.log(chalk.dim("    /model second                 状態確認 (/model second info も同義)"));
      console.log(chalk.dim("    /model second setup           初期設定 wizard (プロバイダ選択は wizard 内)"));
      console.log(chalk.dim("    /model second enable          有効化"));
      console.log(chalk.dim("    /model second disable         無効化"));
      console.log(chalk.dim("    /model second list            利用可能モデル一覧から選択"));
      console.log(chalk.dim("    /model second context <128k>  コンテキスト長変更"));
      console.log(chalk.dim("    /model second description <text>  特性説明"));
      console.log(chalk.dim("\n  詳細編集 (temperature / top_p / 等) は /models Edit を推奨。"));
      console.log(chalk.dim("  互換: /second ... も alias として動作中。"));
    }
  }

  /**
   * Vision LLM (vision slot) のサブコマンドハンドラ (Phase 5)。
   * 画像認識を含むマルチモーダル言語生成 AI (Claude / Gemini / GPT-4o / Llama Vision 等) を
   * /model vision <sub> 経由で操作する。 visionLLM 未設定時は main slot に自動フォールバック。
   *
   * docs/model-registry.md §4.1
   */
  private async handleVisionLLMCommand(args: string[]): Promise<void> {
    const subCmd = (args[0] ?? "").toLowerCase();
    const ep = this.config.visionLLM;

    if (!subCmd || subCmd === "status" || subCmd === "info") {
      console.log(chalk.bold("\n  ── Vision LLM ──"));
      if (!ep) {
        console.log(chalk.dim(`  状態: ${chalk.yellow("未設定 (main LLM にフォールバック)")}`));
        console.log(chalk.dim(`  設定するには: /model vision setup`));
      } else {
        const loc = ep.baseUrl ?? ep.endpoint ?? "(クラウド)";
        console.log(chalk.dim(`  プロバイダー: ${ep.providerType} @ ${loc}`));
        console.log(chalk.dim(`  モデル:       ${ep.model}`));
        if (ep.contextWindow) {
          const ctxLabel = ep.contextWindow >= 1000 ? `${Math.round(ep.contextWindow / 1000)}K` : `${ep.contextWindow}`;
          console.log(chalk.dim(`  コンテキスト: ${ctxLabel}`));
        }
        const desc = ep.description?.trim();
        if (desc) console.log(chalk.dim(`  特性:         ${chalk.cyan(desc)}`));
        console.log(
          chalk.dim(
            `\n  ※ 画像認識を含むマルチモーダル言語生成 AI を指定 (Claude Sonnet / Gemini Pro / Llama Vision 等)`,
          ),
        );
        console.log(chalk.dim(`  ※ 解除して main にフォールバックする場合は /model vision clear`));
      }
      console.log();
      return;
    }

    if (subCmd === "clear") {
      if (!ep) {
        console.log(chalk.dim("  vision LLM は元から未設定です (main にフォールバック中)。"));
        return;
      }
      this.config.visionLLM = null;
      saveConfig(this.config);
      await this.applyVisionLLMEndpoint();
      console.log(chalk.green("  Vision LLM をクリアしました (main LLM にフォールバック)。"));
      return;
    }

    if (subCmd === "setup") {
      // プロバイダ選択 → 既存 setup ヘルパに vision target で流す
      try {
        const provider = await select<string>({
          message: "Vision LLM のプロバイダを選択:",
          choices: [
            { name: "Anthropic API (Claude vision direct, ANTHROPIC_API_KEY)", value: "anthropic" },
            { name: "Google AI Studio (Gemini vision, GEMINI_API_KEY)", value: "gemini" },
            { name: "Claude Code CLI (claude -p)", value: "claude-cli" },
            { name: "Claude Agent SDK", value: "claude-agent-sdk" },
            { name: "Azure OpenAI — Chat Completions (GPT-4o 等)", value: "azure-openai" },
            { name: "Azure OpenAI — Responses API", value: "azure-gpt" },
            { name: "Azure Claude — Anthropic Messages API", value: "azure-anthropic" },
            { name: "Azure Claude — OpenAI互換ルート", value: "azure-claude" },
            { name: "Azure AI Foundry", value: "azure-foundry" },
            { name: "Ollama (local — Llama 3.2 Vision / Qwen2-VL / LLaVA 等)", value: "ollama" },
            { name: "LM Studio (local)", value: "lmstudio" },
            { name: "llama.cpp (local)", value: "llamacpp" },
            { name: "vLLM (local)", value: "vllm" },
          ],
        });

        if (provider === "anthropic" || provider === "claude-cli" || provider === "claude-agent-sdk") {
          await this.setupClaudeLLM("vision", provider);
        } else if (provider === "gemini") {
          await this.setupGeminiLLM("vision");
        } else if (
          provider === "azure-openai" ||
          provider === "azure-gpt" ||
          provider === "azure-claude" ||
          provider === "azure-foundry" ||
          provider === "azure-anthropic"
        ) {
          await this.setupAzureLLM("vision", provider as any);
        } else if (provider === "ollama" || provider === "lmstudio" || provider === "llamacpp" || provider === "vllm") {
          await this.setupLocalVisionLLM(provider);
        } else {
          console.log(chalk.red(`  未対応のプロバイダ: ${provider}`));
        }
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("User force closed"))) {
          console.log(chalk.red(`  Vision LLM セットアップ失敗: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      return;
    }

    if (subCmd === "list") {
      if (!this.visionService) {
        console.log(chalk.red("  Vision service が初期化されていません。 再起動してください。"));
        return;
      }
      // 現在の vision provider からモデル一覧を取得して選択させる。
      // vision LLM 未設定なら main provider を使うことになるが、 list は main の list と被るので警告。
      if (!ep) {
        console.log(chalk.yellow("  Vision LLM 未設定です。 先に /model vision setup でプロバイダを決めてください。"));
        return;
      }
      try {
        const provider = createProvider(ep, this.passphrase);
        const models = await provider.listModels();
        if (models.length === 0) {
          console.log(chalk.dim("  利用可能なモデルがありません。"));
          return;
        }
        const visionModels = models.filter((m) => m.supportsVision);
        const list = visionModels.length > 0 ? visionModels : models;
        const chosen = await select({
          message: "Vision LLM のモデルを選択:",
          choices: list.map((m) => ({
            name: `${m.name}${m.supportsVision ? " [Vision]" : ""}${m.name === ep.model ? "  ← current" : ""}`,
            value: m.name,
          })),
          default: ep.model,
        });
        if (chosen !== ep.model) {
          this.config.visionLLM = { ...ep, model: chosen };
          saveConfig(this.config);
          await this.applyVisionLLMEndpoint();
          console.log(chalk.dim(`  Vision モデル: ${chalk.yellow(ep.model)} → ${chalk.cyan(chosen)}`));
        }
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("User force closed"))) {
          console.log(chalk.red(`  モデル一覧取得に失敗: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      return;
    }

    if (subCmd === "context") {
      const val = args[1] ? parseTokenCount(args[1]) : NaN;
      if (!ep) {
        console.log(chalk.red("  Vision LLM 未設定です。 /model vision setup で設定してください。"));
      } else if (isNaN(val) || val <= 0) {
        const cur = ep.contextWindow;
        const curLabel = cur
          ? cur >= 1000
            ? `${Math.round(cur / 1000)}K`
            : `${cur}`
          : "(未設定 — サーバ側デフォルト)";
        console.log(chalk.dim(`  Vision コンテキスト長: ${curLabel}`));
        console.log(chalk.dim(`  使い方: /model vision context <トークン数>`));
      } else {
        const old = ep.contextWindow;
        this.config.visionLLM = { ...ep, contextWindow: val };
        saveConfig(this.config);
        await this.applyVisionLLMEndpoint();
        const oldLabel = old ? (old >= 1000 ? `${Math.round(old / 1000)}K` : `${old}`) : "(未設定)";
        const newLabel = val >= 1000 ? `${Math.round(val / 1000)}K` : `${val}`;
        console.log(chalk.dim(`  Vision コンテキスト長: ${chalk.yellow(oldLabel)} → ${chalk.cyan(newLabel)} トークン`));
      }
      return;
    }

    if (subCmd === "description") {
      const text = args.slice(1).join(" ").trim();
      if (!ep) {
        console.log(chalk.red("  Vision LLM 未設定です。 /model vision setup で設定してください。"));
      } else if (!text) {
        const cur = ep.description?.trim();
        console.log(chalk.bold("\n  ── Vision LLM 特性説明 ──"));
        console.log(chalk.dim(`  現在: ${cur ? chalk.cyan(cur) : chalk.yellow("(未設定)")}`));
        console.log(chalk.dim(`  使い方: /model vision description <説明文>`));
        console.log(chalk.dim(`  クリア: /model vision description clear`));
      } else if (text.toLowerCase() === "clear") {
        this.config.visionLLM = { ...ep, description: undefined };
        saveConfig(this.config);
        console.log(chalk.yellow("  Vision LLM 特性説明をクリアしました"));
      } else {
        this.config.visionLLM = { ...ep, description: text };
        saveConfig(this.config);
        console.log(chalk.green(`  Vision LLM 特性説明を設定しました (${text.length}文字)`));
      }
      return;
    }

    // 不明なサブコマンド → 使い方
    console.log(chalk.yellow("  使い方:"));
    console.log(chalk.dim("    /model vision                  状態確認"));
    console.log(chalk.dim("    /model vision setup            プロバイダ選択 → setup wizard"));
    console.log(chalk.dim("    /model vision list             利用可能モデル一覧から選択"));
    console.log(chalk.dim("    /model vision context <128k>   コンテキスト長変更"));
    console.log(chalk.dim("    /model vision description <text>  特性説明"));
    console.log(chalk.dim("    /model vision clear            未設定に戻す (main にフォールバック)"));
    console.log(
      chalk.dim("\n  ※ 画像認識を含むマルチモーダル言語生成 AI を指定します (CLIP/YOLO 等の専用視覚モデルではない)"),
    );
  }

  /**
   * ローカル系 (ollama/lmstudio/llamacpp/vllm) を vision slot にセットアップする補助関数。
   * setupLocalLLM 系がローカル系を main 専用前提で書かれているため、 vision 用は独立に実装。
   * host/port を聞いて connectAndListModels でモデル一覧 → 選択 → applyVisionLLMEndpoint。
   */
  private async setupLocalVisionLLM(provider: "ollama" | "lmstudio" | "llamacpp" | "vllm"): Promise<void> {
    const defaultPort = DEFAULT_PORTS[provider];
    try {
      const host = await input({ message: "サーバーの IP アドレス:", default: "localhost" });
      const portStr = await input({ message: "ポート番号:", default: String(defaultPort) });
      const port = parseInt(portStr, 10);
      if (isNaN(port) || port <= 0) {
        console.log(chalk.red(`  無効なポート番号: ${portStr}`));
        return;
      }
      const baseUrl = `http://${host}:${port}`;
      console.log(chalk.dim(`  ${baseUrl} に接続してモデル一覧を取得中...`));
      let models;
      try {
        models = await connectAndListModels(provider, baseUrl);
      } catch (e) {
        console.log(chalk.red(`  接続失敗: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      const visionModels = models.filter((m) => m.supportsVision);
      const list = visionModels.length > 0 ? visionModels : models;
      if (list.length === 0) {
        console.log(chalk.dim("  利用可能なモデルがありません。"));
        return;
      }
      const model = await select({
        message: "Vision LLM のモデルを選択:",
        choices: list.map((m) => ({
          name: `${m.name}${m.supportsVision ? " [Vision]" : ""}`,
          value: m.name,
        })),
      });
      this.config.visionLLM = { providerType: provider, baseUrl, model };
      saveConfig(this.config);
      await this.applyVisionLLMEndpoint();
      console.log(chalk.green(`  Vision LLM を設定しました: ${provider}:${model} @ ${baseUrl}`));
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("User force closed"))) {
        console.log(chalk.red(`  Vision LLM セットアップ失敗: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  /**
   * /resume サブコマンドの共通ハンドラ (Phase optimize #2、 2026-05-28)。
   * /sessions と /continue を alias として吸収。
   *
   *   /resume               → 対話 picker で選択
   *   /resume <id>          → ID 直接指定
   *   /resume latest        → 最新セッションを即復元 (旧 /continue)
   *   /resume list [<n>]    → 一覧表示のみ (旧 /sessions)
   */
  private async handleResumeCommand(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase();

    // /resume list [<n>] → 一覧表示のみ
    if (sub === "list") {
      const limitArg = parseInt(args[1] ?? "", 10);
      const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 20;
      const sessions = listSessions(limit);
      if (sessions.length === 0) {
        console.log(chalk.dim("  保存されたセッションはありません。"));
        console.log(chalk.dim("  会話を 1 ターン以上行ったあと /quit すると保存されます。"));
        return;
      }
      console.log(chalk.bold(`\n  保存されたセッション (新しい順、 上位 ${sessions.length} 件):`));
      for (const s of sessions) {
        const date = new Date(s.updatedAt).toLocaleString();
        const title = (s.title || "(タイトルなし)").replace(/\s+/g, " ").slice(0, 60);
        console.log(`    ${chalk.cyan(s.id)}  ${chalk.dim(date)}  ${chalk.dim(`(${s.messageCount}msgs)`)}  ${title}`);
      }
      console.log(chalk.dim(`\n  復元方法:`));
      console.log(chalk.dim(`    /resume                   ← 対話 picker から選ぶ`));
      console.log(chalk.dim(`    /resume <session-id>      ← ID 直接指定`));
      console.log(chalk.dim(`    /resume latest            ← 一番新しいセッションを即復元`));
      console.log();
      return;
    }

    // /resume latest → 最新を即復元
    if (sub === "latest") {
      const latest = getLatestSession();
      if (!latest) {
        console.log(chalk.yellow("  復元可能なセッションがありません。"));
        return;
      }
      this.agent.restoreSession(latest);
      console.log(
        chalk.dim(`  最新セッションを復元しました: ${latest.meta.id} (${latest.meta.messageCount} messages)`),
      );
      return;
    }

    // /resume <id> または /resume (引数なし→ picker)
    let sessionId = args[0];
    if (!sessionId) {
      const sessions = listSessions(20);
      if (sessions.length === 0) {
        console.log(chalk.dim("  保存されたセッションはありません。"));
        console.log(chalk.dim("  会話を 1 ターン以上行ったあと /quit すると保存されます。"));
        return;
      }
      try {
        sessionId = await select({
          message: "復元するセッションを選択 (Ctrl+C でキャンセル):",
          choices: sessions.map((s) => {
            const date = new Date(s.updatedAt).toLocaleString();
            const title = (s.title || "(タイトルなし)").replace(/\s+/g, " ").slice(0, 50);
            return {
              name: `${date}  (${s.messageCount}msgs)  ${title}`,
              value: s.id,
              description: `id=${s.id}  model=${s.model}`,
            };
          }),
          pageSize: 10,
        });
      } catch {
        console.log(chalk.dim("  キャンセルしました。"));
        return;
      }
    }
    const session = loadSession(sessionId);
    if (!session) {
      console.log(chalk.red(`  セッション ${sessionId} が見つかりません。`));
      console.log(chalk.dim(`  /resume list で一覧を表示できます。`));
      return;
    }
    this.agent.restoreSession(session);
    console.log(
      chalk.dim(`  セッション ${chalk.cyan(sessionId)} を復元しました (${session.meta.messageCount} messages)`),
    );
  }

  /**
   * /permission の対話 picker (Phase optimize #1、 2026-05-28)。
   * 引数なし呼び出しから入り、 カテゴリ → アクション → ツール/ルール選択 のループ。
   * Esc / Ctrl+C で終了。 引数付きの旧形式は dispatcher 側で従来通り処理される。
   */
  private async handlePermissionInteractive(): Promise<void> {
    const permissions = this.agent.getPermissions();
    while (true) {
      const rules = permissions.getRules();
      const auto = permissions.getAutoApproveList();
      const requireL = permissions.getRequireApprovalList();
      const discord = permissions.getDiscordAutoApproveList();
      const slack = permissions.getSlackAutoApproveList();
      const ruleCount = rules.deny.length + rules.allow.length + rules.ask.length;

      let category: string;
      try {
        category = await select({
          message: "Permission settings — 編集する対象を選択:",
          choices: [
            {
              name: `Pattern rules                              [${rules.deny.length} deny / ${rules.allow.length} allow / ${rules.ask.length} ask]`,
              value: "rules",
            },
            { name: `Auto-approve tools (CLI)                   [${auto.length} tools]`, value: "auto" },
            { name: `Require-approval tools (CLI)               [${requireL.length} tools]`, value: "require" },
            { name: `Discord auto-approve tools                 [${discord.length} tools]`, value: "discord" },
            { name: `Slack auto-approve tools                   [${slack.length} tools]`, value: "slack" },
            {
              name: chalk.dim(
                `View all (${ruleCount} rules + ${auto.length + requireL.length + discord.length + slack.length} entries)`,
              ),
              value: "list",
            },
            { name: chalk.dim("Done"), value: "done" },
          ],
          pageSize: 10,
        });
      } catch {
        return;
      }
      if (category === "done") return;
      if (category === "list") {
        this.printPermissionAll();
        continue;
      }
      if (category === "rules") {
        await this.permissionPatternRulesMenu();
        continue;
      }
      await this.permissionToolListMenu(category as "auto" | "require" | "discord" | "slack");
    }
  }

  /** /permission 対話 picker から呼ばれる「全リスト一覧表示」 */
  private printPermissionAll(): void {
    const permissions = this.agent.getPermissions();
    const rules = permissions.getRules();
    console.log(chalk.bold("\n  [Pattern rules] (ツール名リストより優先):"));
    for (const action of ["deny", "allow", "ask"] as const) {
      const icon = action === "deny" ? chalk.red("✗") : action === "allow" ? chalk.green("✓") : chalk.yellow("?");
      console.log(chalk.bold(`    ${action}:`));
      if (rules[action].length === 0) console.log(chalk.dim("      (なし)"));
      else for (const r of rules[action]) console.log(`      ${icon} ${r}`);
    }
    const dump = (label: string, list: string[], col: (s: string) => string): void => {
      console.log(chalk.bold(`  ${label}:`));
      if (list.length === 0) console.log(chalk.dim("    (なし)"));
      else for (const t of list) console.log(col(`    ✓ ${t}`));
    };
    dump("[CLI] Auto-approve", permissions.getAutoApproveList(), chalk.green);
    dump("[CLI] Require-approval", permissions.getRequireApprovalList(), chalk.yellow);
    dump("[Discord] Auto-approve", permissions.getDiscordAutoApproveList(), chalk.cyan);
    dump("[Slack] Auto-approve", permissions.getSlackAutoApproveList(), chalk.cyan);
    console.log();
  }

  /** /permission 対話 picker のパターンルール編集サブメニュー */
  private async permissionPatternRulesMenu(): Promise<void> {
    const permissions = this.agent.getPermissions();
    while (true) {
      const rules = permissions.getRules();
      console.log(chalk.bold("\n  ── Pattern rules ──"));
      for (const a of ["deny", "allow", "ask"] as const) {
        const icon = a === "deny" ? chalk.red("✗") : a === "allow" ? chalk.green("✓") : chalk.yellow("?");
        console.log(chalk.bold(`  ${a}:`));
        if (rules[a].length === 0) console.log(chalk.dim("    (なし)"));
        else for (const r of rules[a]) console.log(`    ${icon} ${r}`);
      }
      const totalRules = rules.deny.length + rules.allow.length + rules.ask.length;
      let action: string;
      try {
        action = await select({
          message: "操作:",
          choices: [
            { name: "Add deny rule (常に拒否)", value: "add-deny" },
            { name: "Add allow rule (常に許可)", value: "add-allow" },
            { name: "Add ask rule (常に確認)", value: "add-ask" },
            { name: "Remove rule", value: "remove", disabled: totalRules === 0 },
            { name: chalk.dim("Back"), value: "back" },
          ],
        });
      } catch {
        return;
      }
      if (action === "back") return;

      if (action.startsWith("add-")) {
        const kind = action.slice(4) as "deny" | "allow" | "ask";
        try {
          const pattern = await input({
            message: `${kind} ルールのパターン (例: bash(npm *) / file_write(./src/**) / web_fetch(domain:github.com)):`,
          });
          if (!pattern.trim()) {
            console.log(chalk.dim("  キャンセル。"));
            continue;
          }
          permissions.addRule(kind, pattern);
          this.config.security.rules ??= { allow: [], deny: [], ask: [] };
          if (!this.config.security.rules[kind].includes(pattern)) {
            this.config.security.rules[kind].push(pattern);
          }
          saveConfig(this.config);
          const icon = kind === "deny" ? "🚫" : kind === "allow" ? "✅" : "❓";
          console.log(chalk.green(`  ${icon} ${kind}: "${pattern}" を追加`));
        } catch {
          /* cancel */
        }
      } else if (action === "remove") {
        const flat = [
          ...rules.deny.map((p) => ({ act: "deny" as const, pat: p })),
          ...rules.allow.map((p) => ({ act: "allow" as const, pat: p })),
          ...rules.ask.map((p) => ({ act: "ask" as const, pat: p })),
        ];
        try {
          const chosen = await select({
            message: "削除するルールを選択:",
            choices: flat.map((r) => {
              const icon = r.act === "deny" ? chalk.red("✗") : r.act === "allow" ? chalk.green("✓") : chalk.yellow("?");
              return { name: `${icon} ${r.act}: ${r.pat}`, value: `${r.act}|${r.pat}` };
            }),
          });
          const sepIdx = chosen.indexOf("|");
          const a = chosen.slice(0, sepIdx) as "deny" | "allow" | "ask";
          const pat = chosen.slice(sepIdx + 1);
          permissions.removeRule(a, pat);
          if (this.config.security.rules) {
            this.config.security.rules[a] = this.config.security.rules[a].filter((p) => p !== pat);
          }
          saveConfig(this.config);
          console.log(chalk.green(`  ✓ ${a}: "${pat}" を削除`));
        } catch {
          /* cancel */
        }
      }
    }
  }

  /** /permission 対話 picker のツールリスト編集サブメニュー (auto/require/discord/slack) */
  private async permissionToolListMenu(kind: "auto" | "require" | "discord" | "slack"): Promise<void> {
    const permissions = this.agent.getPermissions();
    const labelMap = {
      auto: "Auto-approve (CLI)",
      require: "Require-approval (CLI)",
      discord: "Discord auto-approve",
      slack: "Slack auto-approve",
    };
    const getList = (): string[] => {
      switch (kind) {
        case "auto":
          return permissions.getAutoApproveList();
        case "require":
          return permissions.getRequireApprovalList();
        case "discord":
          return permissions.getDiscordAutoApproveList();
        case "slack":
          return permissions.getSlackAutoApproveList();
      }
    };
    const addTo = (tool: string): void => {
      switch (kind) {
        case "auto":
          permissions.addAutoApprove(tool);
          if (!this.config.security.autoApproveTools.includes(tool)) this.config.security.autoApproveTools.push(tool);
          break;
        case "require":
          permissions.addRequireApproval(tool);
          if (!this.config.security.requireApprovalTools.includes(tool))
            this.config.security.requireApprovalTools.push(tool);
          break;
        case "discord":
          permissions.addDiscordAutoApprove(tool);
          this.config.security.discordAutoApproveTools ??= [];
          if (!this.config.security.discordAutoApproveTools.includes(tool))
            this.config.security.discordAutoApproveTools.push(tool);
          break;
        case "slack":
          permissions.addSlackAutoApprove(tool);
          this.config.security.slackAutoApproveTools ??= [];
          if (!this.config.security.slackAutoApproveTools.includes(tool))
            this.config.security.slackAutoApproveTools.push(tool);
          break;
      }
    };
    const removeFrom = (tool: string): void => {
      switch (kind) {
        case "auto":
          permissions.removeAutoApprove(tool);
          this.config.security.autoApproveTools = this.config.security.autoApproveTools.filter((t) => t !== tool);
          break;
        case "require":
          permissions.removeRequireApproval(tool);
          this.config.security.requireApprovalTools = this.config.security.requireApprovalTools.filter(
            (t) => t !== tool,
          );
          break;
        case "discord":
          permissions.removeDiscordAutoApprove(tool);
          this.config.security.discordAutoApproveTools = (this.config.security.discordAutoApproveTools ?? []).filter(
            (t) => t !== tool,
          );
          break;
        case "slack":
          permissions.removeSlackAutoApprove(tool);
          this.config.security.slackAutoApproveTools = (this.config.security.slackAutoApproveTools ?? []).filter(
            (t) => t !== tool,
          );
          break;
      }
    };

    while (true) {
      const list = getList();
      console.log(chalk.bold(`\n  ── ${labelMap[kind]} ──`));
      if (list.length === 0) console.log(chalk.dim("  (なし)"));
      else for (const t of list) console.log(chalk.green(`  ✓ ${t}`));

      let action: string;
      try {
        action = await select({
          message: "操作:",
          choices: [
            { name: "Add tool", value: "add" },
            { name: "Remove tool", value: "remove", disabled: list.length === 0 },
            { name: chalk.dim("Back"), value: "back" },
          ],
        });
      } catch {
        return;
      }
      if (action === "back") return;

      if (action === "add") {
        const allTools = this.agent.getToolRegistry().getToolNames();
        const candidates = allTools.filter((t) => !list.includes(t)).sort();
        if (candidates.length === 0) {
          console.log(chalk.dim("  追加可能なツールはありません。"));
          continue;
        }
        try {
          const chosen = await select({
            message: "追加するツールを選択:",
            choices: candidates.map((t) => ({ name: t, value: t })),
            pageSize: 12,
          });
          addTo(chosen);
          saveConfig(this.config);
          console.log(chalk.green(`  ✓ ${chosen} を追加`));
        } catch {
          /* cancel */
        }
      } else if (action === "remove") {
        try {
          const chosen = await select({
            message: "削除するツールを選択:",
            choices: list.map((t) => ({ name: t, value: t })),
            pageSize: 12,
          });
          removeFrom(chosen);
          saveConfig(this.config);
          console.log(chalk.green(`  ✓ ${chosen} を削除`));
        } catch {
          /* cancel */
        }
      }
    }
  }

  // ─── /integrations (Phase optimize #3、 2026-05-28) ─────────────
  //
  // /discord / /slack / /chatlog / /search の 4 つの "外部統合" 設定パネルを
  // 1 つの picker に束ねる。 旧 4 コマンドは dispatcher 互換維持 (この picker は
  // 内部的に this.handleCommand("/discord <sub>") 等を再帰呼び出しする)。

  private async handleIntegrationsCommand(): Promise<void> {
    while (true) {
      const dEnabled = this.config.discord?.enabled ?? false;
      const dListening = this.interactionServer?.running ?? false;
      const sEnabled = this.config.slack?.enabled ?? false;
      const cEnabled = this.config.chatLog?.enabled ?? false;
      const cVault = this.config.chatLog?.vaultPath;
      const searchProv = this.config.search?.provider ?? "duckduckgo";
      const dTag = `${dEnabled ? chalk.green("通知オン") : chalk.yellow("通知オフ")}${dListening ? ", " + chalk.cyan("受信中") : ""}`;
      const sTag = sEnabled ? chalk.green("通知オン") : chalk.yellow("通知オフ");
      const cTag = cVault ? (cEnabled ? chalk.green("オン") : chalk.yellow("オフ")) : chalk.yellow("未設定");
      const searchTag = chalk.cyan(searchProv);

      let pick: string;
      try {
        pick = await select({
          message: "外部サービス連携 — 設定したい項目を選んでください:",
          choices: [
            { name: `Discord 連携        [${dTag}]`, value: "discord" },
            { name: `Slack 連携          [${sTag}]`, value: "slack" },
            { name: `会話ログの保存       [${cTag}]`, value: "chatlog" },
            { name: `Web検索エンジン      [${searchTag}]`, value: "search" },
            { name: chalk.dim("設定を終える"), value: "done" },
          ],
        });
      } catch {
        return;
      }
      if (pick === "done") return;
      if (pick === "discord") await this.integrationsDiscordMenu();
      else if (pick === "slack") await this.integrationsSlackMenu();
      else if (pick === "chatlog") await this.integrationsChatlogMenu();
      else if (pick === "search") await this.integrationsSearchMenu();
    }
  }

  /** /integrations → Discord 編集サブメニュー (旧 /discord と互換) */
  private async integrationsDiscordMenu(): Promise<void> {
    while (true) {
      await this.handleCommand("/discord status");
      let action: string;
      try {
        action = await select({
          message: "Discord 連携 — やりたいことを選んでください:",
          choices: [
            { name: "通知をオンにする (作業の完了などを Discord に知らせる)", value: "enable" },
            { name: "通知をオフにする", value: "disable" },
            { name: "通知の送り先を設定する (Webhook URL)", value: "url" },
            { name: "テスト通知を送ってみる", value: "test" },
            { name: "Application ID を設定する (Discord から呼び出すための準備 1/2)", value: "app-id" },
            { name: "Bot Token を設定する (Discord から呼び出すための準備 2/2)", value: "bot-token" },
            { name: "/ask コマンドを Discord に登録する", value: "register" },
            { name: "受信を開始する (Discord からの呼び出しを受け付ける)", value: "listen-start" },
            { name: "受信を停止する", value: "listen-stop" },
            { name: "起動時に受信を自動開始するか切り替える", value: "auto-start-toggle" },
            { name: "利用を許可するユーザーを表示する (許可ユーザーリスト)", value: "users" },
            { name: "待機リストから利用申請を承認する (タイピング不要・推奨)", value: "waitlist" },
            { name: "許可ユーザーを追加する (Discord ユーザー ID)", value: "user-add" },
            { name: "許可ユーザーを削除する", value: "user-remove" },
            { name: chalk.dim("前のメニューに戻る"), value: "back" },
          ],
          pageSize: 16,
        });
      } catch {
        return;
      }
      if (action === "back") return;

      if (["enable", "disable", "test"].includes(action)) {
        await this.handleCommand(`/discord ${action}`);
      } else if (action === "users") {
        await this.handleCommand("/discord users");
      } else if (action === "waitlist") {
        await this.discordWaitlistApprove();
      } else if (action === "user-add" || action === "user-remove") {
        try {
          const val = await input({ message: "Discord ユーザー ID を入力 (空欄で取り消し):" });
          if (!val.trim()) {
            console.log(chalk.dim("  取り消しました。"));
            continue;
          }
          await this.handleCommand(`/discord ${action} ${val.trim()}`);
        } catch {
          /* cancel */
        }
      } else if (action === "register") {
        // サーバーID を聞いてから登録 (空欄なら全サーバー向け = 反映に最大 1 時間)
        try {
          const gid = await input({
            message: "登録先サーバーの ID (空欄なら全サーバー向けに登録。サーバー限定なら即時反映):",
          });
          await this.handleCommand(`/discord register ${gid.trim()}`.trim());
        } catch {
          /* cancel */
        }
      } else if (action === "listen-start") {
        await this.handleCommand("/discord listen start");
      } else if (action === "listen-stop") {
        await this.handleCommand("/discord listen stop");
      } else if (action === "auto-start-toggle") {
        const cur = this.config.discord?.listenEnabled ?? false;
        await this.handleCommand(`/discord listen auto-start ${cur ? "off" : "on"}`);
      } else {
        // url / app-id / bot-token — 1 引数
        const fieldLabel: Record<string, string> = {
          url: "Webhook URL (Discord のサーバー設定 → 連携サービス → ウェブフック で取得)",
          "app-id": "Application ID (Discord Developer Portal → General Information)",
          "bot-token": "Bot Token (Discord Developer Portal → Bot)",
        };
        try {
          const val = await input({ message: `${fieldLabel[action] ?? action} を入力 (空欄で取り消し):` });
          if (!val.trim()) {
            console.log(chalk.dim("  取り消しました。"));
            continue;
          }
          await this.handleCommand(`/discord ${action} ${val.trim()}`);
        } catch {
          /* cancel */
        }
      }
    }
  }

  /** 待機リストから利用申請を select で選んで承認/却下する (ID のタイピング不要) */
  private async discordWaitlistApprove(): Promise<void> {
    const pending = this.config.discord?.pendingUsers ?? [];
    if (pending.length === 0) {
      console.log(chalk.dim("  待機リストは空です。未許可ユーザーが Discord から /ask を試みると自動で記録されます。"));
      return;
    }
    let id: string;
    try {
      id = await select({
        message: "承認する利用申請を選んでください:",
        choices: [
          ...pending.map((u) => ({
            name: `${u.username ?? "(名前不明)"} (ID: ${u.id}) — 試行 ${u.attempts} 回`,
            value: u.id,
          })),
          { name: chalk.dim("取り消す"), value: "__cancel__" },
        ],
        pageSize: 15,
      });
    } catch {
      return;
    }
    if (id === "__cancel__") {
      console.log(chalk.dim("  取り消しました。"));
      return;
    }

    let act: string;
    try {
      act = await select({
        message: "この申請をどうしますか?",
        choices: [
          { name: "承認する (許可ユーザーに追加)", value: "approve" },
          { name: "却下する (待機リストから削除)", value: "reject" },
          { name: chalk.dim("取り消す"), value: "__cancel__" },
        ],
      });
    } catch {
      return;
    }
    if (act === "__cancel__") {
      console.log(chalk.dim("  取り消しました。"));
      return;
    }
    await this.handleCommand(`/discord ${act} ${id}`);
  }

  /** /integrations → Slack 編集サブメニュー (旧 /slack と互換) */
  private async integrationsSlackMenu(): Promise<void> {
    while (true) {
      await this.handleCommand("/slack status");
      let action: string;
      try {
        action = await select({
          message: "Slack 連携 — やりたいことを選んでください:",
          choices: [
            { name: "通知をオンにする (作業の完了などを Slack に知らせる)", value: "enable" },
            { name: "通知をオフにする", value: "disable" },
            { name: "通知の送り先を設定する (Webhook URL)", value: "url" },
            { name: "テスト通知を送ってみる", value: "test" },
            { name: "Bot Token を設定する (xoxb- で始まる文字列)", value: "bot-token" },
            { name: "App-Level Token を設定する (xapp- で始まる文字列)", value: "app-token" },
            { name: "利用を許可するユーザーを表示する (許可ユーザーリスト)", value: "users" },
            { name: "許可ユーザーを追加する (Slack ユーザー ID。例: U01234567)", value: "user-add" },
            { name: "許可ユーザーを削除する", value: "user-remove" },
            { name: chalk.dim("前のメニューに戻る"), value: "back" },
          ],
          pageSize: 12,
        });
      } catch {
        return;
      }
      if (action === "back") return;

      if (["enable", "disable", "test"].includes(action)) {
        await this.handleCommand(`/slack ${action}`);
      } else if (action === "users") {
        await this.handleCommand("/slack users");
      } else if (action === "user-add" || action === "user-remove") {
        try {
          const val = await input({ message: "Slack ユーザー ID を入力 (例: U01234567、空欄で取り消し):" });
          if (!val.trim()) {
            console.log(chalk.dim("  取り消しました。"));
            continue;
          }
          await this.handleCommand(`/slack ${action} ${val.trim()}`);
        } catch {
          /* cancel */
        }
      } else {
        // url / bot-token / app-token
        const fieldLabel: Record<string, string> = {
          url: "Webhook URL (Slack アプリ設定 → Incoming Webhooks で取得)",
          "bot-token": "Bot Token (Slack アプリ設定 → OAuth & Permissions、xoxb- で始まる)",
          "app-token": "App-Level Token (Slack アプリ設定 → Basic Information、xapp- で始まる)",
        };
        try {
          const val = await input({ message: `${fieldLabel[action] ?? action} を入力 (空欄で取り消し):` });
          if (!val.trim()) {
            console.log(chalk.dim("  取り消しました。"));
            continue;
          }
          await this.handleCommand(`/slack ${action} ${val.trim()}`);
        } catch {
          /* cancel */
        }
      }
    }
  }

  /** /integrations → Chatlog 編集サブメニュー (旧 /chatlog と互換) */
  private async integrationsChatlogMenu(): Promise<void> {
    while (true) {
      await this.handleCommand("/chatlog status");
      let action: string;
      try {
        action = await select({
          message: "会話ログの保存 (Obsidian) — やりたいことを選んでください:",
          choices: [
            { name: "保存をオンにする", value: "enable" },
            { name: "保存をオフにする", value: "disable" },
            { name: "保存先フォルダを設定する (Obsidian Vault のパス)", value: "vault" },
            { name: chalk.dim("前のメニューに戻る"), value: "back" },
          ],
        });
      } catch {
        return;
      }
      if (action === "back") return;
      if (action === "enable" || action === "disable") {
        await this.handleCommand(`/chatlog ${action}`);
      } else {
        try {
          const val = await input({ message: "Obsidian Vault のフォルダパス (空欄で取り消し):" });
          if (!val.trim()) {
            console.log(chalk.dim("  取り消しました。"));
            continue;
          }
          await this.handleCommand(`/chatlog vault ${val.trim()}`);
        } catch {
          /* cancel */
        }
      }
    }
  }

  /** /integrations → Search 編集サブメニュー (旧 /search と互換) */
  private async integrationsSearchMenu(): Promise<void> {
    while (true) {
      await this.handleCommand("/search status");
      let action: string;
      try {
        action = await select({
          message: "Web検索エンジン — やりたいことを選んでください:",
          choices: [
            { name: "DuckDuckGo を使う (標準。設定不要)", value: "ddg" },
            { name: "SearXNG を使う (自分で立てた検索サーバー)", value: "searxng" },
            { name: "テスト検索をしてみる", value: "test" },
            { name: chalk.dim("前のメニューに戻る"), value: "back" },
          ],
        });
      } catch {
        return;
      }
      if (action === "back") return;
      if (action === "ddg") {
        await this.handleCommand("/search duckduckgo");
      } else if (action === "test") {
        await this.handleCommand("/search test");
      } else if (action === "searxng") {
        try {
          const val = await input({
            message: "SearXNG の URL (空欄なら今の設定のまま):",
            default: this.config.search?.searxngUrl ?? "",
          });
          await this.handleCommand(`/search searxng ${val.trim()}`.trim());
        } catch {
          /* cancel */
        }
      }
    }
  }

  /**
   * setup フロー冒頭で「履歴から選ぶ / 新規セットアップ」 を提示する共通ヘルパ。
   *  - 履歴が空、 または provider にマッチする履歴が無ければ何もせず undefined を返す
   *  - ユーザが履歴を選んだら applyProfileTo して true を返す (呼び出し側はそこで return すれば良い)
   *  - ユーザが「新規セットアップ」 を選んだら false を返す (呼び出し側は従来フローを継続)
   *
   * matchProvider に文字列 or 関数を渡すと候補を絞り込める (例: "anthropic" でその provider のみ)。
   */
  private async maybeOfferProfileHistory(
    target: "main" | "second" | "vision",
    matchProvider?: string | ((p: LLMProfile) => boolean),
  ): Promise<boolean> {
    const allProfiles = listLLMProfiles();
    if (allProfiles.length === 0) return false;

    const filter =
      typeof matchProvider === "string" ? (p: LLMProfile) => p.endpoint.providerType === matchProvider : matchProvider;
    const candidates = filter ? allProfiles.filter(filter) : allProfiles;
    if (candidates.length === 0) return false;

    const targetLabel = target === "main" ? "メインLLM" : target === "vision" ? "Vision LLM" : "セカンドLLM";
    try {
      const action = await select({
        message: `${targetLabel} の設定方法を選択 (履歴 ${candidates.length} 件):`,
        choices: [
          { name: "履歴から選ぶ", value: "history" },
          { name: "新規セットアップ", value: "new" },
        ],
        default: "history",
      });
      if (action === "new") return false;

      const chosenId = await select({
        message: "プロファイルを選択:",
        choices: candidates.map((p) => ({
          name: `${p.name}  ${chalk.dim(`(${formatRelativeTime(p.lastUsedAt)})`)}`,
          value: p.id,
        })),
      });
      const chosen = candidates.find((p) => p.id === chosenId);
      if (!chosen) return false;
      await this.applyProfileTo(chosen, target);
      return true;
    } catch (e) {
      if (e instanceof Error && e.message.includes("User force closed")) {
        // Ctrl+C → そのまま setup を抜ける扱い
        throw e;
      }
      return false;
    }
  }

  /**
   * Claude 系 (anthropic / claude-cli / claude-agent-sdk) を対話プロンプトでセットアップする。
   * メインLLM (target=main) / セカンドLLM (target=second) の両方をカバー。
   *
   *  - anthropic         : ANTHROPIC_API_KEY (env: / encrypted: / 平文) + モデル選択
   *  - claude-cli        : モデル選択のみ (認証は claude CLI 側の `claude login` に委譲)。 tool calling 不可
   *  - claude-agent-sdk  : モデル選択のみ (認証は claude login 継承)。 in-process MCP で tool calling 対応
   *
   * モデルは CLAUDE_MODELS のハードコード一覧から選択する。
   */
  private async setupClaudeLLM(
    target: "main" | "second" | "vision",
    provider: "anthropic" | "claude-cli" | "claude-agent-sdk",
  ): Promise<void> {
    const { CLAUDE_MODELS } = await import("../config/types.js");
    const targetLabel = target === "main" ? "メインLLM" : target === "vision" ? "Vision LLM" : "セカンドLLM";
    console.log(chalk.bold(`\n  ── ${targetLabel} ${provider} セットアップ ──`));
    console.log(chalk.dim("  キャンセルは Ctrl+C\n"));

    // 履歴があれば「履歴から選ぶ / 新規セットアップ」 を提示
    if (await this.maybeOfferProfileHistory(target, provider)) return;

    const existing =
      target === "main"
        ? this.config.mainLLM
        : target === "vision"
          ? (this.config.visionLLM ?? undefined)
          : this.config.secondLLM?.endpoint;
    const existingIsClaude =
      existing?.providerType === "anthropic" ||
      existing?.providerType === "claude-cli" ||
      existing?.providerType === "claude-agent-sdk";

    const chosenModel = await select({
      message: "Claude モデルを選択:",
      choices: CLAUDE_MODELS.map((m) => ({
        name: `${m.label}  ${chalk.dim(`(${m.id}, ctx ${(m.contextWindow / 1000).toLocaleString()}K)`)}`,
        value: m.id,
      })),
      default: existingIsClaude ? existing?.model : "claude-sonnet-4-6",
    });

    let storedApiKey: string | undefined;

    if (provider === "anthropic") {
      const storageMode = await select({
        message: "ANTHROPIC_API_KEY の保存方法:",
        choices: [
          { name: "環境変数参照 (env:ANTHROPIC_API_KEY) — 推奨", value: "env" },
          { name: "パスフレーズで暗号化保存", value: "encrypt" },
          { name: "平文で保存 (非推奨)", value: "plain" },
        ],
        default: "env",
      });

      if (storageMode === "env") {
        const envName = await input({
          message: "環境変数名:",
          default: "ANTHROPIC_API_KEY",
          validate: (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) || "有効な環境変数名を入力してください",
        });
        storedApiKey = `env:${envName.trim()}`;
        if (!process.env[envName.trim()]) {
          console.log(
            chalk.yellow(`  ⚠ 環境変数 ${envName.trim()} は現在未設定です。アプリ起動時にセットしてください。`),
          );
        }
      } else if (storageMode === "plain") {
        const ok = await confirm({
          message: "平文保存は config.json にそのまま記録されます。本当に続行しますか？",
          default: false,
        });
        if (!ok) {
          console.log(chalk.yellow("  セットアップを中止しました。"));
          return;
        }
        const apiKey = await password({ message: "API Key (入力は表示されません):", mask: "*" });
        if (!apiKey.trim()) {
          console.log(chalk.red("  API Key が空です。中止しました。"));
          return;
        }
        storedApiKey = apiKey.trim();
      } else {
        const apiKey = await password({ message: "API Key (入力は表示されません):", mask: "*" });
        if (!apiKey.trim()) {
          console.log(chalk.red("  API Key が空です。中止しました。"));
          return;
        }
        const passphrase = await password({ message: "暗号化用パスフレーズ:", mask: "*" });
        const passphrase2 = await password({ message: "もう一度入力 (確認):", mask: "*" });
        if (passphrase !== passphrase2) {
          console.log(chalk.red("  パスフレーズが一致しません。中止しました。"));
          return;
        }
        if (passphrase.length < 4) {
          console.log(chalk.red("  パスフレーズが短すぎます (4文字以上)。中止しました。"));
          return;
        }
        storedApiKey = CredentialVault.encrypt(apiKey.trim(), passphrase);
        // 合言葉をセッションに採用して再起動不要にする (docs/model-apply-immediacy.md §2.1)
        this.adoptPassphrase(passphrase);
      }
    } else {
      // claude-cli / claude-agent-sdk は事前に `claude login` 済みである必要がある旨を案内
      console.log(chalk.dim("  認証は claude CLI 側 (subscription / oauth) を利用します。"));
      console.log(chalk.dim("  未ログインの場合は別ターミナルで `claude login` を実行してください。"));
      if (provider === "claude-agent-sdk") {
        console.log(chalk.dim("  in-process MCP で lllmAgent ツールを公開します (tool calling 対応)。"));
      } else {
        console.log(
          chalk.dim(
            "  注: claude-cli は tool calling 非対応。 ツール委任には claude-agent-sdk か anthropic を使ってください。",
          ),
        );
      }
    }

    // コンテキストウィンドウ: モデル既定値を提示しつつユーザが上書きできるようにする。
    // 例: Sonnet 4.6 は 1M だが、 コスト/応答速度の都合で 200K に絞りたい等
    const modelDefaultCtx = CLAUDE_MODELS.find((m) => m.id === chosenModel)?.contextWindow ?? 200_000;
    const ctxInput = await input({
      message: `コンテキスト長 (例: 200k / 1m / 200000、 既定: ${(modelDefaultCtx / 1000).toLocaleString()}K):`,
      default: String(modelDefaultCtx),
      validate: (v: string) => {
        const n = parseTokenCount(v);
        if (!Number.isFinite(n) || n <= 0) return "正の数値、 または '200k' / '1m' 形式で指定してください";
        return true;
      },
    });
    const ctxWindow = parseTokenCount(ctxInput) || modelDefaultCtx;

    if (target === "main") {
      const cur = this.config.mainLLM;
      this.config.mainLLM = {
        ...cur,
        providerType: provider,
        model: chosenModel,
        apiKey: storedApiKey,
        contextWindow: ctxWindow ?? cur.contextWindow,
        // ローカル/他クラウド用フィールドはクリア
        baseUrl: undefined,
        endpoint: undefined,
        deploymentName: undefined,
        projectId: undefined,
        region: undefined,
      };
    } else if (target === "vision") {
      this.config.visionLLM = {
        providerType: provider,
        model: chosenModel,
        apiKey: storedApiKey,
        contextWindow: ctxWindow,
        description: existingIsClaude ? existing?.description : undefined,
      };
    } else {
      this.config.secondLLM = {
        enabled: true,
        endpoint: {
          providerType: provider,
          model: chosenModel,
          apiKey: storedApiKey,
          contextWindow: ctxWindow,
          description: existingIsClaude ? existing?.description : undefined,
        },
        budget: this.config.secondLLM?.budget ?? null,
        cost: this.config.secondLLM?.cost ?? { referenceModels: [] },
      };
    }
    saveConfig(this.config);

    console.log(chalk.green(`\n  ✓ ${targetLabel} (${provider}) を設定しました:`));
    console.log(chalk.dim(`    モデル:  ${chosenModel}`));
    if (ctxWindow) console.log(chalk.dim(`    Context: ${(ctxWindow / 1000).toLocaleString()}K tokens`));
    if (storedApiKey) {
      const kind = storedApiKey.startsWith("encrypted:")
        ? "暗号化保存"
        : storedApiKey.startsWith("env:")
          ? `環境変数 (${storedApiKey})`
          : "平文保存";
      console.log(chalk.dim(`    API Key: ${kind}`));
    }

    // 暗号化保存でも合言葉は手元にあるので、 その場で反映する (再起動は要求しない)
    await this.applyAfterSetup(target);
    console.log();
  }

  /**
   * Google AI Studio (Gemini) を対話プロンプトでセットアップする。
   *
   * `setupClaudeLLM` (anthropic 用) の API キー入力 + モデル選択フローを Gemini 向けに簡略化したもの。
   * 認証は GEMINI_API_KEY 1 個のみ (endpoint / deploymentName / projectId は不要)。
   * モデルは GEMINI_MODELS のハードコード一覧から選択する (= /model setup gemini はオフラインでも完走できる)。
   */
  private async setupGeminiLLM(target: "main" | "second" | "vision"): Promise<void> {
    const { GEMINI_MODELS } = await import("../config/types.js");
    const targetLabel = target === "main" ? "メインLLM" : target === "vision" ? "Vision LLM" : "セカンドLLM";
    console.log(chalk.bold(`\n  ── ${targetLabel} gemini (Google AI Studio) セットアップ ──`));
    console.log(chalk.dim("  キャンセルは Ctrl+C\n"));

    // 履歴があれば「履歴から選ぶ / 新規セットアップ」 を提示
    if (await this.maybeOfferProfileHistory(target, "gemini")) return;

    const existing =
      target === "main"
        ? this.config.mainLLM
        : target === "vision"
          ? (this.config.visionLLM ?? undefined)
          : this.config.secondLLM?.endpoint;
    const existingIsGemini = existing?.providerType === "gemini";

    const chosenModel = await select({
      message: "Gemini モデルを選択:",
      choices: GEMINI_MODELS.map((m) => ({
        name: `${m.label}  ${chalk.dim(`(${m.id}, ctx ${(m.contextWindow / 1000).toLocaleString()}K)`)}`,
        value: m.id,
      })),
      default: existingIsGemini ? existing?.model : "gemini-2.5-flash",
    });

    const storageMode = await select({
      message: "GEMINI_API_KEY の保存方法:",
      choices: [
        { name: "環境変数参照 (env:GEMINI_API_KEY) — 推奨", value: "env" },
        { name: "パスフレーズで暗号化保存", value: "encrypt" },
        { name: "平文で保存 (非推奨)", value: "plain" },
      ],
      default: "env",
    });

    let storedApiKey: string | undefined;

    if (storageMode === "env") {
      const envName = await input({
        message: "環境変数名:",
        default: "GEMINI_API_KEY",
        validate: (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) || "有効な環境変数名を入力してください",
      });
      storedApiKey = `env:${envName.trim()}`;
      if (!process.env[envName.trim()]) {
        console.log(
          chalk.yellow(`  ⚠ 環境変数 ${envName.trim()} は現在未設定です。 アプリ起動時にセットしてください。`),
        );
      }
    } else if (storageMode === "plain") {
      const ok = await confirm({
        message: "平文保存は config.json にそのまま記録されます。 本当に続行しますか？",
        default: false,
      });
      if (!ok) {
        console.log(chalk.yellow("  セットアップを中止しました。"));
        return;
      }
      const apiKey = await password({ message: "API Key (入力は表示されません):", mask: "*" });
      if (!apiKey.trim()) {
        console.log(chalk.red("  API Key が空です。 中止しました。"));
        return;
      }
      storedApiKey = apiKey.trim();
    } else {
      const apiKey = await password({ message: "API Key (入力は表示されません):", mask: "*" });
      if (!apiKey.trim()) {
        console.log(chalk.red("  API Key が空です。 中止しました。"));
        return;
      }
      const passphrase = await password({ message: "暗号化用パスフレーズ:", mask: "*" });
      const passphrase2 = await password({ message: "もう一度入力 (確認):", mask: "*" });
      if (passphrase !== passphrase2) {
        console.log(chalk.red("  パスフレーズが一致しません。 中止しました。"));
        return;
      }
      if (passphrase.length < 4) {
        console.log(chalk.red("  パスフレーズが短すぎます (4文字以上)。 中止しました。"));
        return;
      }
      storedApiKey = CredentialVault.encrypt(apiKey.trim(), passphrase);
      // 合言葉をセッションに採用して再起動不要にする (docs/model-apply-immediacy.md §2.1)
      this.adoptPassphrase(passphrase);
    }

    // コンテキストウィンドウ: モデル既定値を提示しつつユーザが上書きできるようにする
    const modelDefaultCtx = GEMINI_MODELS.find((m) => m.id === chosenModel)?.contextWindow ?? 1_048_576;
    const ctxInput = await input({
      message: `コンテキスト長 (例: 128k / 1m / 1048576、 既定: ${(modelDefaultCtx / 1000).toLocaleString()}K):`,
      default: String(modelDefaultCtx),
      validate: (v: string) => {
        const n = parseTokenCount(v);
        if (!Number.isFinite(n) || n <= 0) return "正の数値、 または '128k' / '1m' 形式で指定してください";
        return true;
      },
    });
    const ctxWindow = parseTokenCount(ctxInput) || modelDefaultCtx;

    if (target === "main") {
      const cur = this.config.mainLLM;
      this.config.mainLLM = {
        ...cur,
        providerType: "gemini",
        model: chosenModel,
        apiKey: storedApiKey,
        contextWindow: ctxWindow ?? cur.contextWindow,
        // ローカル/他クラウド用フィールドはクリア
        baseUrl: undefined,
        endpoint: undefined,
        deploymentName: undefined,
        projectId: undefined,
        region: undefined,
      };
    } else if (target === "vision") {
      this.config.visionLLM = {
        providerType: "gemini",
        model: chosenModel,
        apiKey: storedApiKey,
        contextWindow: ctxWindow,
        description: existingIsGemini ? existing?.description : undefined,
      };
    } else {
      this.config.secondLLM = {
        enabled: true,
        endpoint: {
          providerType: "gemini",
          model: chosenModel,
          apiKey: storedApiKey,
          contextWindow: ctxWindow,
          description: existingIsGemini ? existing?.description : undefined,
        },
        budget: this.config.secondLLM?.budget ?? null,
        cost: this.config.secondLLM?.cost ?? { referenceModels: [] },
      };
    }
    saveConfig(this.config);

    console.log(chalk.green(`\n  ✓ ${targetLabel} (gemini) を設定しました:`));
    console.log(chalk.dim(`    モデル:  ${chosenModel}`));
    if (ctxWindow) console.log(chalk.dim(`    Context: ${(ctxWindow / 1000).toLocaleString()}K tokens`));
    if (storedApiKey) {
      const kind = storedApiKey.startsWith("encrypted:")
        ? "暗号化保存"
        : storedApiKey.startsWith("env:")
          ? `環境変数 (${storedApiKey})`
          : "平文保存";
      console.log(chalk.dim(`    API Key: ${kind}`));
    }

    // 暗号化保存でも合言葉は手元にあるので、 その場で反映する (再起動は要求しない)
    await this.applyAfterSetup(target);
    console.log();
  }

  /**
   * セカンドLLMの接続先 (providerType / baseUrl / model / description) 変更を実行時に反映する。
   * SecondLLMManager を再初期化して新しいProviderを作成する。
   */
  private async applySecondLLMEndpoint(): Promise<void> {
    if (!this.config.secondLLM || !this.secondLLMManager) {
      return;
    }
    await this.ensurePassphraseFor(
      this.config.secondLLM.endpoint?.apiKey,
      "セカンドLLM",
      this.config.secondLLM.endpoint?.providerType,
    );
    try {
      this.secondLLMManager.initialize(this.config.secondLLM, this.passphrase);
    } catch (e) {
      console.log(chalk.red(`  セカンドLLM再初期化に失敗: ${e instanceof Error ? e.message : String(e)}`));
      console.log(chalk.dim(`  設定は保存済み。Cloud LLMで合言葉が必要な場合は再起動が必要です。`));
      return;
    }
    // 起動時に secondLLM が無効/失敗だった場合、 second_llm_agent ツールが
    // 未登録のまま起動している可能性がある。 利用可能になったタイミングで遅延登録する。
    // (ToolRegistry.register は Map.set ベースで冪等なので再呼び出しは無害)
    if (this.secondLLMManager.isAvailable()) {
      setSecondLLMManager(this.secondLLMManager);
      setFederatedSecondLLMManager(this.secondLLMManager);
      const reg = this.agent.getToolRegistry();
      reg.register(secondLLMAgentTool);
      // Phase E-2: federated_delegate (validation 付き委譲)
      reg.register(federatedDelegateTool);
    }
    this.refreshLLMProfiles();
    // Model Registry に記録 + second slot を更新 (失敗しても本体動作には影響させない)
    if (this.config.secondLLM?.endpoint) {
      try {
        const entry = recordLLMProfile(this.config.secondLLM.endpoint);
        if (entry) setRegistrySlot("second", entry.id);
      } catch {
        /* ignore */
      }
    }
    // F1 との整合 (docs/model-apply-immediacy.md §4): resolver の provider キャッシュを捨てる
    invalidateModelCache();
  }

  /**
   * Vision LLM の hot-swap (Phase 5)。 config.visionLLM の変更を visionService に反映し、
   * registry の vision slot も更新する。 visionLLM が null の場合は main provider に
   * フォールバック (= 起動時の挙動と同じ)。
   */
  private async applyVisionLLMEndpoint(): Promise<void> {
    if (!this.visionService) return;
    try {
      const ep = this.config.visionLLM;
      if (ep) {
        await this.ensurePassphraseFor(ep.apiKey, "Vision LLM", ep.providerType);
        const newProvider = createProvider(ep, this.passphrase);
        this.visionService.setProvider(newProvider, ep.model);
        // registry に記録 + vision slot 更新
        try {
          const entry = recordLLMProfile(ep);
          if (entry) setRegistrySlot("vision", entry.id);
        } catch {
          /* ignore */
        }
      } else {
        // visionLLM クリア → main provider にフォールバック
        this.visionService.setProvider(this.agent.getProvider(), this.config.mainLLM.model);
        // vision slot を解除 (registry helper を呼ぶ — clearSlot)
        try {
          const { clearSlot } = await import("../config/model-registry.js");
          clearSlot("vision");
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      console.log(chalk.red(`  Vision LLM 反映に失敗: ${e instanceof Error ? e.message : String(e)}`));
    }
    // F1 との整合 (docs/model-apply-immediacy.md §4): resolver の provider キャッシュを捨てる
    invalidateModelCache();
  }

  /**
   * LLMプロファイル (main/second の description・baseUrl等) を Config から再構築し、
   * AgentLoop のシステムプロンプトを差し替える。
   * /model description, /second description 等、profile に影響する設定を変更した直後に呼ぶ。
   */
  private refreshLLMProfiles(): void {
    const hasSecondLLM = this.secondLLMManager?.isAvailable() ?? false;
    const profiles = buildLLMProfiles(this.config, hasSecondLLM);
    const skillInfos = this.skillRegistry
      ? this.skillRegistry.list().map((s) => ({ name: s.name, trigger: s.trigger, description: s.description }))
      : undefined;
    this.agent.updateLLMProfiles(profiles, skillInfos, hasSecondLLM, !!this.config.obsidian?.vaultPath);
  }

  /**
   * Phase F: MCP の現在状態 (global ON/OFF + 個別 runtime disabled) を config.json へ
   * 永続化。 toggle / on / off の直後に呼ぶと再起動後も同じ状態が復元される。
   */
  private persistMcpState(): void {
    if (!this.mcpManager) return;
    this.config.mcpEnabled = this.mcpManager.isGlobalEnabled();
    const disabled = this.mcpManager.getRuntimeDisabledNames();
    this.config.disabledMcpServers = disabled.length > 0 ? disabled : undefined;
    saveConfig(this.config);
  }

  /**
   * Phase F: Skills の現在状態 (global ON/OFF + 個別 runtime disabled) を config.json へ
   * 永続化。 toggle / on / off の直後に呼ぶと再起動後も同じ状態が復元される。
   */
  private persistSkillsState(): void {
    if (!this.skillRegistry) return;
    this.config.skillsEnabled = this.skillRegistry.isGlobalEnabled();
    const disabled = this.skillRegistry.getRuntimeDisabledNames();
    this.config.disabledSkills = disabled.length > 0 ? disabled : undefined;
    saveConfig(this.config);
  }

  // ─── /model host / /model port / /model setup (local) ────────────────────────

  /** baseUrl から host / port を取り出す。 パース失敗時は両方 null */
  private parseBaseUrl(baseUrl: string | undefined): { host: string | null; port: number | null; protocol: string } {
    if (!baseUrl) return { host: null, port: null, protocol: "http:" };
    try {
      const u = new URL(baseUrl);
      const port = u.port ? parseInt(u.port, 10) : null;
      return { host: u.hostname, port: Number.isFinite(port) ? port : null, protocol: u.protocol };
    } catch {
      return { host: null, port: null, protocol: "http:" };
    }
  }

  /**
   * host/port 変更後に接続テスト + モデル一覧件数をプレビュー表示する。
   * 「URL を入れたのに /model list で何も出ない」 という不信感を払拭する目的。
   * 失敗しても設定は保持する (ユーザーがサーバー起動順を後回しにするケースに配慮)。
   */
  private async previewConnectionAfterEndpointChange(): Promise<void> {
    const providerType = this.config.mainLLM.providerType;
    if (
      providerType !== "ollama" &&
      providerType !== "lmstudio" &&
      providerType !== "llamacpp" &&
      providerType !== "vllm"
    ) {
      // クラウド系は host/port では設定しない
      return;
    }
    const baseUrl = this.config.mainLLM.baseUrl;
    if (!baseUrl) return;
    try {
      const models = await connectAndListModels(providerType as ProviderType, baseUrl);
      if (models.length > 0) {
        console.log(chalk.dim(`  ${models.length} 個のモデルが利用可能です。 /model list で選択できます。`));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(chalk.yellow(`  ⚠ ${msg}`));
      console.log(chalk.dim("  サーバー側のモデル起動状況を確認してください。 設定は保持しています。"));
    }
  }

  private async handleModelHostCommand(arg: string): Promise<void> {
    const cur = this.parseBaseUrl(this.config.mainLLM.baseUrl);
    if (!arg) {
      console.log(chalk.dim(`  現在のホスト: ${cur.host ?? "(未設定)"}`));
      console.log(chalk.dim(`  現在のポート: ${cur.port ?? "(未設定)"}`));
      console.log(chalk.dim(`  使い方: /model host <ホスト名またはIPアドレス>`));
      console.log(chalk.dim(`  例: /model host 192.168.1.201`));
      console.log(chalk.dim(`      /model host localhost`));
      console.log(
        chalk.dim(`  ※ ポートは現状値を維持します。 ポートも変えるなら /model port、 全部やり直すなら /model setup`),
      );
      return;
    }
    // ホスト名らしさの簡易チェック (先頭がスキームっぽければ案内)
    if (/^https?:\/\//i.test(arg)) {
      console.log(chalk.yellow("  /model host にはスキーム (http://) を含めないでください。"));
      console.log(chalk.dim("  例: /model host 192.168.1.201"));
      return;
    }
    const port = cur.port ?? DEFAULT_PORTS[this.config.mainLLM.providerType as ProviderType] ?? 8080;
    const newUrl = `http://${arg}:${port}`;
    const oldUrl = this.config.mainLLM.baseUrl;
    this.config.mainLLM.baseUrl = newUrl;
    saveConfig(this.config);
    console.log(chalk.dim(`  メインLLM URL: ${chalk.yellow(oldUrl ?? "(未設定)")} → ${chalk.cyan(newUrl)}`));
    await this.applyMainLLMEndpoint();
    await this.previewConnectionAfterEndpointChange();
  }

  private async handleModelPortCommand(arg: string): Promise<void> {
    const cur = this.parseBaseUrl(this.config.mainLLM.baseUrl);
    if (!arg) {
      console.log(chalk.dim(`  現在のホスト: ${cur.host ?? "(未設定)"}`));
      console.log(chalk.dim(`  現在のポート: ${cur.port ?? "(未設定)"}`));
      console.log(chalk.dim(`  使い方: /model port <番号>`));
      console.log(chalk.dim(`  例: /model port 8090`));
      const port = DEFAULT_PORTS[this.config.mainLLM.providerType as ProviderType];
      if (port) {
        console.log(chalk.dim(`  ${this.config.mainLLM.providerType} のデフォルトポート: ${port}`));
      }
      return;
    }
    const portNum = parseInt(arg, 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      console.log(chalk.red(`  無効なポート番号: ${arg} (1〜65535 の整数)`));
      return;
    }
    const host = cur.host ?? "localhost";
    const newUrl = `http://${host}:${portNum}`;
    const oldUrl = this.config.mainLLM.baseUrl;
    this.config.mainLLM.baseUrl = newUrl;
    saveConfig(this.config);
    console.log(chalk.dim(`  メインLLM URL: ${chalk.yellow(oldUrl ?? "(未設定)")} → ${chalk.cyan(newUrl)}`));
    await this.applyMainLLMEndpoint();
    await this.previewConnectionAfterEndpointChange();
  }

  /**
   * /model setup (引数なし or "local") — ローカル系LLMの対話ウィザード。
   * npm run setup と同じプロンプト体系で provider/host/port/model/ctx/特性 を一括再設定する。
   */
  /**
   * `/model setup` を引数なしで実行したときに、 セットアップ対象プロバイダーを
   * 候補一覧から選んでもらう。 選択された provider キー (ローカルは "local") を返す。
   * Ctrl+C は呼び出し側で "User force closed" として catch される。
   */
  private async chooseSetupProvider(): Promise<string | null> {
    const choice = await select<string>({
      message: "セットアップする LLM を選択してください:",
      pageSize: 20,
      choices: [
        new Separator("── ローカル / セルフホスト ──"),
        { name: "ローカルLLM (ollama / lmstudio / llamacpp / vllm)", value: "local" },
        new Separator("── クラウド: Anthropic Claude ──"),
        { name: "Anthropic API (Claude 直接, ANTHROPIC_API_KEY)", value: "anthropic" },
        { name: "Claude Code CLI (claude login, tool calling 不可)", value: "claude-cli" },
        { name: "Claude Agent SDK (claude login, tool calling 対応)", value: "claude-agent-sdk" },
        new Separator("── クラウド: Google ──"),
        { name: "Google AI Studio (Gemini, GEMINI_API_KEY)", value: "gemini" },
        new Separator("── クラウド: Azure ──"),
        { name: "Azure Claude — Anthropic Messages API", value: "azure-anthropic" },
        { name: "Azure OpenAI — Chat Completions API", value: "azure-openai" },
        { name: "Azure OpenAI — Responses API (gpt-5 / codex 系)", value: "azure-gpt" },
        { name: "Azure Claude — OpenAI 互換ルート", value: "azure-claude" },
        { name: "Azure AI Foundry (Kimi / Mistral 等)", value: "azure-foundry" },
      ],
    });
    return choice ?? null;
  }

  private async handleModelSetupLocal(): Promise<void> {
    const cur = this.config.mainLLM;
    const isCloud = [
      "vertex-ai",
      "azure-openai",
      "azure-gpt",
      "azure-claude",
      "azure-foundry",
      "azure-anthropic",
    ].includes(cur.providerType);

    // 履歴がある場合は冒頭で選択肢を提示 (ローカル系プロバイダのみに絞る)
    const localProviders = new Set(["ollama", "lmstudio", "llamacpp", "vllm"]);
    try {
      if (await this.maybeOfferProfileHistory("main", (p) => localProviders.has(p.endpoint.providerType))) {
        return;
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("User force closed")) {
        console.log(chalk.yellow("\n  セットアップを中止しました。"));
        return;
      }
      throw e;
    }

    try {
      const result = await runLocalLLMSetup({
        headline: "メインLLM 再設定",
        current: isCloud
          ? undefined
          : {
              providerType: cur.providerType,
              baseUrl: cur.baseUrl,
              model: cur.model,
              contextWindow: cur.contextWindow,
              description: cur.description,
            },
      });
      // ローカル系に切り替わるのでクラウド用フィールドはクリア
      this.config.mainLLM = {
        ...result.endpoint,
        // 既存のサンプリングパラメータ等は保持
        temperature: cur.temperature,
        top_p: cur.top_p,
        top_k: cur.top_k,
        repetition_penalty: cur.repetition_penalty,
      };
      saveConfig(this.config);
      console.log(chalk.green("\n  メインLLM設定を更新しました。"));
      console.log(chalk.dim(`  Provider: ${this.config.mainLLM.providerType}`));
      console.log(chalk.dim(`  URL:      ${this.config.mainLLM.baseUrl}`));
      console.log(chalk.dim(`  Model:    ${this.config.mainLLM.model}`));
      if (this.config.mainLLM.contextWindow) {
        console.log(chalk.dim(`  Context:  ${this.config.mainLLM.contextWindow.toLocaleString()} tokens`));
      }
      await this.applyMainLLMEndpoint();
    } catch (e) {
      if (e instanceof Error && (e.message.includes("User force closed") || e.message.includes("force closed"))) {
        console.log(chalk.yellow("\n  セットアップを中止しました。 設定は変更されていません。"));
      } else {
        console.log(chalk.red(`\n  セットアップに失敗しました: ${e instanceof Error ? e.message : String(e)}`));
        console.log(
          chalk.dim("  設定は変更されていません。 サーバー側を確認してから再度 /model setup を実行してください。"),
        );
      }
    }
  }

  // ─── プロンプトプレフィックス ────────────────────────

  /** W2: 封じ込め状態の常時インジケータ（有効時のみ `🛡fs·auto ` 等）。 */
  private sandboxHudTag(): string {
    try {
      const sb = getActiveProcessSandbox();
      if (!sb.isActive()) return "";
      const auto = isBashNetworkContained() ? "·auto" : "";
      return chalk.cyan(`🛡${sb.getEffectiveLevel()}${auto} `);
    } catch {
      return "";
    }
  }

  private getPromptPrefix(): string {
    if (this.isMultiline) {
      this.lineNumber++;
      return chalk.dim(`${String(this.lineNumber).padStart(3)}| `);
    }
    if (this.planManager?.isInPlanMode()) {
      return chalk.yellow("[plan] > ");
    }
    if (this.agent.getPermissions().isAutorunMode()) {
      return this.sandboxHudTag() + chalk.magenta("[autorun] > ");
    }
    return this.sandboxHudTag() + chalk.green("> ");
  }

  /** /room の一覧表示。 各 Room の active / REPL バインド / 自動 Resume / メッセージ数を出す。 */
  private printRoomStatus(): void {
    if (!this.roomManager) return;
    console.log(chalk.bold("\n  === Rooms ==="));
    for (const r of this.roomManager.status()) {
      const marker = r.active ? chalk.green("●") : chalk.dim("○");
      const tags: string[] = [];
      if (r.surfaces.length > 0) tags.push(r.surfaces.join("/"));
      tags.push(`autoResume=${r.autoResume ? "ON" : "OFF"}`);
      tags.push(`${r.messageCount} msgs`);
      const title = r.title ? chalk.dim(`  "${r.title.slice(0, 40)}"`) : "";
      console.log(`  ${marker} Room ${chalk.cyan(r.id)}  ${chalk.dim(tags.join(" · "))}${title}`);
    }
    console.log(
      chalk.dim("\n  移動: /room A|B|C   再開: /room resume [A|B|C]   自動再開: /room autoresume on|off [A|B|C]\n"),
    );
  }

  // ─── 入力処理 ──────────────────────────────────────

  private async processInput(input: string): Promise<void> {
    this.agentBusy = true;
    let interruptedByEsc = false;
    interruptWatcher.start(() => {
      interruptedByEsc = true;
      progressIndicator.end();
      console.log(chalk.yellow("\n  (ESC) 処理を中断します..."));
      this.agent.abort();
      bashTool.killRunningProcess();
    });
    // Phase 1.5: run 中の type-ahead 入力を捕捉してキューに積む (Claude Code 方式)。
    const stopTypeAhead = this.startTypeAhead();
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
      // A-6: task_complete イベントから構造化レポートを組み立てて通知する
      // (docs/task-report-notification-design.md)。 旧実装の履歴スキャンは廃止。
      let completeEvent: import("../agent/agent-events.js").AgentEventMap["task_complete"] | null = null;
      const offComplete = this.agent.events.on("task_complete", (e) => {
        completeEvent = e;
      });
      // run 本体: Goal Seek 昇格提案 (room 載せ替え後に行い、 正しい room の goal slot を操作) → run。
      // 画像添付等で ContentPart[] の場合はテキスト主体でないため提案しない。
      const runBody = async (): Promise<void> => {
        if (typeof resolved === "string") {
          await maybePromoteToGoal({
            input: resolved,
            source: "cli",
            agent: this.agent,
            enabled: this.config.goalSeek?.autoPropose,
          });
        }
        await this.agent.run(resolved);
      };
      try {
        // 受信順グローバル FIFO キューに積んで REPL の Room で実行する
        // (Discord/Slack と到着順に直列化)。 Phase 1 ではここで await する
        // (run 中の追加入力対応は Phase 1.5)。 RoomManager 未注入時は直接実行 (後方互換)。
        if (this.roomQueue && this.roomManager) {
          const { position, result } = this.roomQueue.enqueue(() =>
            this.roomManager!.runInRoom(this.roomManager!.bindingFor("repl"), runBody),
          );
          // M-2: 他サーフェス(Discord/Slack)のジョブが先行していると黙って待つことになるため、
          // Discord/Slack の「N 番目に追加」と対称に待機件数をフィードバックする。
          if (position > 0) {
            console.log(chalk.dim(`  ⏳ 他サーフェスのジョブ ${position} 件の完了を待っています...`));
          }
          await result;
        } else {
          await runBody();
        }
      } finally {
        offComplete();
      }

      // LLMの応答が完了した後、通知設定が有効なら構造化レポートを送信する
      if (completeEvent) {
        const e = completeEvent as import("../agent/agent-events.js").AgentEventMap["task_complete"];
        const shouldNotify = e.finalResponse.trim() !== "" || e.toolsExecuted > 0;
        const minMs = (this.config.notifications?.minDurationSec ?? 0) * 1000;
        if (shouldNotify && e.durationMs >= minMs) {
          const report = formatTaskReport(e);
          if (this.config.discord?.enabled && this.config.discord?.webhookUrl) {
            console.log(chalk.dim("  Sending report to Discord..."));
            await sendDiscordNotification(this.config.discord.webhookUrl, report);
          }
          if (this.config.slack?.enabled && this.config.slack?.webhookUrl) {
            console.log(chalk.dim("  Sending report to Slack..."));
            await sendSlackNotification(this.config.slack.webhookUrl, report);
          }
        }
      }
    } catch (e) {
      console.error(chalk.red(`\n  Error: ${e instanceof Error ? e.message : String(e)}\n`));
    } finally {
      stopTypeAhead();
      interruptWatcher.stop();
      progressIndicator.end();
      this.agentBusy = false;
      if (interruptedByEsc) {
        console.log(chalk.dim("  プロンプトに戻ります"));
      }
    }
  }

  /**
   * H-1: Room 状態 (履歴/goal/todos の差し替え = アクティブ Room の切り替え/clear) に触れる
   * REPL コマンドを、 メッセージ run と同じ受信順グローバル FIFO キューに乗せて直列化する。
   *
   * 背景ジョブ (Discord/Slack) は同一 AgentLoop を borrow して実行する。 その実行中の隙に
   * REPL からアクティブ Room の切り替え/clear が割り込むと、 実行中の会話を壊し「run 中に
   * アクティブ Room を切り替えてはならない」不変条件 (docs/room-model-design.md §10-1,
   * room-manager.ts) を破る。 キューに乗せることで
   * 背景ジョブの完了を待ってから実行される。 roomQueue 未注入時 (後方互換) は直接実行。
   *
   * handleCommand には switch を囲う catch が無く、 ここで reject すると REPL ループごと落ちる。
   * 失敗 (例: セッション保存のディスクエラー) はログして false を返し、 REPL を止めない
   * (「save 失敗で REPL を止めない」既存方針に合わせる)。
   */
  private async runRoomMutation(job: () => void | Promise<void>): Promise<boolean> {
    try {
      if (this.roomQueue) {
        if (this.roomQueue.pending > 0) {
          console.log(chalk.dim(`  ⏳ 他サーフェスのジョブ ${this.roomQueue.pending} 件の完了を待っています...`));
        }
        await this.roomQueue.enqueue(async () => {
          await job();
        }).result;
      } else {
        await job();
      }
      return true;
    } catch (e) {
      console.error(chalk.red(`  Room 操作に失敗しました: ${e instanceof Error ? e.message : String(e)}`));
      return false;
    }
  }

  /**
   * Phase 1.5: run 中に積まれた type-ahead 入力を受信順に処理する。
   * /quit が type-ahead された場合は true を返して REPL ループを終了させる。
   */
  private async drainPendingInputs(): Promise<boolean> {
    while (this.pendingInputs.length > 0) {
      const next = this.pendingInputs.shift()!;
      console.log(chalk.dim(`  ▶ 追加入力を処理 (残り ${this.pendingInputs.length} 件): ${next.slice(0, 60)}`));
      if (next.startsWith("/")) {
        const r = await this.handleCommand(next);
        if (r === "quit") return true;
        continue;
      }
      await this.processInput(next);
      try {
        this.agent.saveCurrentSession();
      } catch {
        /* save 失敗で止めない */
      }
    }
    return false;
  }

  /**
   * Phase 1.5: run 実行中に stdin へ届く type-ahead 入力を捕捉する。
   * 印字文字を蓄積し、 Enter で 1 行確定して pendingInputs に積む (現ターン完了後に処理)。
   * ESC/Ctrl+C は interrupt-watcher が扱うため触らない。 非 TTY では no-op。
   * 返り値は捕捉を止める cleanup 関数。
   *
   * 注: run 中は対話プロンプトを描画しないため echo はしない (確定時に確認だけ出す)。
   * マルチバイトはバイト蓄積→Enter で UTF-8 デコード。 対話品質は手動 TTY 検証が必要。
   */
  private startTypeAhead(): () => void {
    if (!process.stdin.isTTY)
      return () => {
        /* no-op */
      };
    const stdin = process.stdin;
    let bytes: number[] = [];
    const onData = (chunk: Buffer): void => {
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        // ESC (0x1b) / Ctrl+C (0x03) は interrupt-watcher が扱う。 ここでは触らない。
        // M-3: ESC は単独中断にも矢印キー等のエスケープシーケンス先頭にもなる。 どちらも
        // この chunk の残りは type-ahead 対象外なので break で読み飛ばすが、 蓄積済みの bytes は
        // 保持する (矢印キー 1 回で入力中の行が消える旧バグを防ぐ)。
        if (b === 0x1b || b === 0x03) break;
        if (b === 0x0d || b === 0x0a) {
          const text = Buffer.from(bytes).toString("utf8").trim();
          bytes = [];
          if (text) {
            this.pendingInputs.push(text);
            process.stdout.write(
              chalk.dim(
                `\n  ⏳ キューに追加しました (待ち ${this.pendingInputs.length} 件)。 現在の処理完了後に順次実行します。\n`,
              ),
            );
          }
          continue;
        }
        if (b === 0x7f || b === 0x08) {
          // L-1: UTF-8 を考慮して 1 コードポイント分削る (マルチバイトを 1 バイトだけ
          // 削ってバッファを壊さない)。 echo は無いが確定行が文字化けしないようにする。
          const cps = [...Buffer.from(bytes).toString("utf8")];
          cps.pop();
          bytes = [...Buffer.from(cps.join(""), "utf8")];
          continue;
        }
        if (b >= 0x20) bytes.push(b); // 印字 ASCII + マルチバイト先頭/継続 (>=0x80)
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.removeListener("data", onData);
    };
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
        console.log(chalk.dim(`\n  [Skill] ${skill.name}: ${skill.description}`));
        const skillPrompt = `${skill.content}\n\n${remainingArgs ? `引数: ${remainingArgs}` : "上記のスキル指示に従ってタスクを実行してください。"}`;
        await this.processInput(skillPrompt);
        return;
      }
    }

    // コマンドレジストリ (PR-10)。新規コマンドはレジストリ側に追加し、
    // 下の switch の case は触るついでにレジストリへ移設していく。
    const registered = getCommandRegistry().get(command);
    if (registered) {
      return await registered.handler(
        {
          agent: this.agent,
          config: this.config,
          saveConfig: () => saveConfig(this.config),
        },
        args,
      );
    }

    switch (command) {
      case "/help": {
        const helpSkills: SkillSummary[] | undefined = this.skillRegistry
          ? this.skillRegistry.list().map((s) => ({
              name: s.trigger.replace(/^\//, ""),
              description: s.description,
            }))
          : undefined;
        displayHelp(helpSkills, getRegistryHelpEntries());
        break;
      }

      case "/quit":
      case "/exit": {
        this.agent.saveCurrentSession();
        const sid = this.agent.getCurrentSessionId();
        const msgCount = this.agent.getCurrentSessionMessageCount();
        console.log();
        if (msgCount > 0) {
          console.log(chalk.dim(`  セッション保存: ${chalk.cyan(sid)}  (${msgCount} messages)`));
          console.log(chalk.dim(`  続きから再開する場合:`));
          console.log(chalk.dim(`    /resume ${sid}              ← REPL 起動後`));
          console.log(chalk.dim(`    起動時: --resume ${sid}     ← または --continue`));
        }
        process.removeAllListeners("SIGINT");
        console.log(chalk.dim("\n  Goodbye!\n"));
        return "quit";
      }

      case "/clear": {
        // docs/todo-goal-lifecycle.md §2.2 — session 境界の責任主体。
        // 履歴・goal-slot・todos を一括リセット (cross-contamination 阻止)。
        // H-1: 背景ジョブと衝突しないよう受信順キューに乗せ、 REPL の Room をアクティブ化してから
        // クリアする。 旧実装は agent が「今ロードしている Room」を消すため、 Discord/Slack の
        // ジョブ実行中は誤って相手の会話を消していた (docs/room-model-review.md H-1)。
        const replRoom = this.roomManager?.bindingFor("repl");
        const cleared = await this.runRoomMutation(async () => {
          const doClear = (): void => {
            this.agent.getHistory().clear();
            this.agent.exitGoalSeek("abort");
            clearTodos();
          };
          if (this.roomManager && replRoom) {
            await this.roomManager.runInRoom(replRoom, async () => doClear());
          } else {
            doClear();
          }
        });
        if (cleared) {
          console.log(
            chalk.dim(`  会話履歴・ToDo・Goal slot をクリアしました${replRoom ? ` (Room ${replRoom})` : ""}。`),
          );
        }
        break;
      }

      case "/room": {
        if (!this.roomManager) {
          console.log(chalk.yellow("  Room 機能が初期化されていません。"));
          break;
        }
        const sub = (args[0] ?? "").toLowerCase();
        // /room                 → 一覧表示
        // /room A|B|C           → REPL を当該 Room へ移動
        // /room resume [A|B|C]  → 当該 Room の最後の会話を再ロード (既定: 現在の Room)
        // /room autoresume on|off [A|B|C] → 自動 Resume 設定
        if (!sub) {
          this.printRoomStatus();
          break;
        }
        if (sub === "resume") {
          const target = args[1] ? normalizeRoomId(args[1]) : (this.roomManager.current() ?? null);
          if (!target) {
            console.log(chalk.yellow("  使い方: /room resume [A|B|C]"));
            break;
          }
          // H-1: resumeRoom は現 Room なら restoreSession で履歴を差し替える (= アクティブ Room の
          // 再ロード)。 背景ジョブと衝突しないようキューで直列化する。
          let found = false;
          const done = await this.runRoomMutation(() => {
            found = this.roomManager!.resumeRoom(target);
          });
          if (done) {
            console.log(
              found
                ? chalk.dim(`  Room ${target} の最後の会話を再開しました。`)
                : chalk.yellow(`  Room ${target} に保存された会話がありません。`),
            );
          }
          break;
        }
        if (sub === "autoresume") {
          const onoff = (args[1] ?? "").toLowerCase();
          const target = args[2] ? normalizeRoomId(args[2]) : (this.roomManager.current() ?? null);
          if ((onoff !== "on" && onoff !== "off") || !target) {
            console.log(chalk.yellow("  使い方: /room autoresume <on|off> [A|B|C]"));
            break;
          }
          this.roomManager.setAutoResume(target, onoff === "on");
          console.log(chalk.dim(`  Room ${target} の自動 Resume を ${onoff.toUpperCase()} にしました。`));
          break;
        }
        // 移動
        const room = normalizeRoomId(sub);
        if (!room) {
          console.log(
            chalk.yellow("  不明な引数です。 /room [A|B|C] | /room resume [A|B|C] | /room autoresume <on|off> [A|B|C]"),
          );
          break;
        }
        // H-1: moveSurface("repl", ...) は agent のアクティブ Room を即切り替える。 背景ジョブと
        // 衝突しないようキューで直列化する。
        const moved = await this.runRoomMutation(() => this.roomManager!.moveSurface("repl", room));
        if (moved) {
          console.log(chalk.dim(`  REPL を Room ${room} に移動しました。`));
          this.printRoomStatus();
        }
        break;
      }

      case "/queue": {
        const sub = (args[0] ?? "").toLowerCase();
        if (sub === "clear") {
          const n = this.pendingInputs.length;
          this.pendingInputs = [];
          console.log(
            chalk.dim(`  type-ahead の待機入力 ${n} 件を破棄しました。 (実行中/投入済みのジョブは取り消せません)`),
          );
          break;
        }
        const queued = this.roomQueue?.pending ?? 0;
        console.log(chalk.bold("\n  === Queue ==="));
        console.log(chalk.dim(`  実行中/待機ジョブ (全サーフェス): ${queued} 件`));
        console.log(chalk.dim(`  REPL type-ahead 待機入力: ${this.pendingInputs.length} 件`));
        if (this.pendingInputs.length > 0) {
          this.pendingInputs.forEach((p, i) => console.log(chalk.dim(`    ${i + 1}. ${p.slice(0, 60)}`)));
          console.log(chalk.dim("  破棄: /queue clear\n"));
        } else {
          console.log("");
        }
        break;
      }

      case "/context": {
        // 引数なし: カテゴリ別内訳。 引数あり: そのカテゴリの中身をダンプ (ドリルダウン)
        const sectionArg = args[0]?.trim();
        // /context strategy — 区切り整理のモード表示・切替 (docs/context-strategy.md §5.3)
        if (sectionArg?.toLowerCase() === "strategy") {
          const { text, changedTo } = formatStrategyStatus(this.agent, args[1]?.trim());
          process.stdout.write(text);
          if (changedTo) {
            this.config.context.strategy = { ...this.config.context.strategy, mode: changedTo };
            saveConfig(this.config);
          }
          break;
        }
        if (sectionArg) {
          const section = normalizeContextSection(sectionArg);
          if (!section) {
            console.log(chalk.yellow(`  不明な section: ${sectionArg}`));
            console.log(chalk.dim("  使い方: /context [system|memory|skills|tools|messages]"));
            break;
          }
          process.stdout.write(
            formatContextDetail(this.agent, this.skillRegistry, section, process.cwd(), args[1]?.trim()),
          );
          break;
        }
        // Claude Code 互換のカテゴリ別内訳: System prompt / Memory files / Skills / System tools / Messages / Free space
        const breakdown = buildContextBreakdown(this.agent, this.skillRegistry, this.mcpManager);
        process.stdout.write(formatContextBreakdown(breakdown));
        break;
      }

      case "/compact":
        console.log(chalk.dim("  コンテキストを圧縮中..."));
        await this.agent.forceCompress();
        console.log(chalk.dim("  完了。"));
        break;

      case "/checkpoint": {
        // 自動チェックポイント (シャドウ Git)。 docs/checkpoint-and-smoke-design.md §4
        const cp = this.agent.getCheckpointManager();
        const sub = args[0]?.trim() ?? "status";
        switch (sub) {
          case "status": {
            const st = cp.getStatus();
            console.log(chalk.dim(`  checkpoint: ${st.enabled ? chalk.green("ON") : chalk.yellow("OFF")}`));
            console.log(chalk.dim(`  対象フォルダ: ${st.workTree}`));
            if (st.enabled && !(await cp.isGitReady())) {
              console.log(
                chalk.red(
                  "  ⚠ git が見つかりません → スナップショットは記録されていません (git 導入か /checkpoint off を)",
                ),
              );
            }
            if (st.lastError) {
              console.log(chalk.red(`  直近のコミット失敗: ${st.lastError}`));
            }
            const recent = await cp.list(5);
            if (recent.length > 0) {
              console.log(chalk.dim(`  直近 ${recent.length} 件:`));
              for (const e of recent) {
                console.log(chalk.dim(`    #${e.n} ${e.shortHash} ${e.date}  ${e.message}`));
              }
            }
            console.log(chalk.dim("  使用例: /checkpoint on|off | list | restore <n> | diff <n> | clear [--all]"));
            break;
          }
          case "on": {
            cp.setEnabled(true);
            this.config.checkpoints = { ...(this.config.checkpoints ?? {}), enabled: true };
            saveConfig(this.config);
            console.log(
              chalk.dim("  checkpoint enabled (config に保存)。 以降のファイル変更を裏で自動コミットします。"),
            );
            break;
          }
          case "off": {
            cp.setEnabled(false);
            this.config.checkpoints = { ...(this.config.checkpoints ?? {}), enabled: false };
            saveConfig(this.config);
            console.log(chalk.dim("  checkpoint disabled (config に保存)。"));
            break;
          }
          case "list": {
            const entries = await cp.list(30);
            if (entries.length === 0) {
              console.log(chalk.dim("  チェックポイントはまだありません。"));
            } else {
              for (const e of entries) {
                console.log(chalk.dim(`    #${e.n} ${e.shortHash} ${e.date}  ${e.message}`));
              }
            }
            break;
          }
          case "restore": {
            const raw = args[1]?.trim() ?? "";
            if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1) {
              console.log(chalk.yellow("  使用方法: /checkpoint restore <n> (n は /checkpoint list の番号)"));
              break;
            }
            const n = parseInt(raw, 10);
            const r = await cp.restore(n);
            if (r.ok && r.entry) {
              console.log(chalk.green(`  #${n} (${r.entry.shortHash}) へ復元しました: ${r.entry.message}`));
            } else {
              console.log(chalk.yellow(`  復元失敗: ${r.error ?? "不明なエラー"}`));
            }
            break;
          }
          case "diff": {
            const raw = args[1]?.trim() ?? "";
            if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1) {
              console.log(chalk.yellow("  使用方法: /checkpoint diff <n>"));
              break;
            }
            console.log(chalk.dim(await cp.diffStat(parseInt(raw, 10))));
            break;
          }
          case "clear": {
            if (args[1]?.trim() === "--all") {
              const removed = cp.clearAll();
              console.log(
                chalk.dim(
                  `  全セッションのチェックポイントを削除しました (${removed} 件)。 作業フォルダのファイルは無傷です。`,
                ),
              );
            } else {
              const ok = cp.clearCurrent();
              console.log(
                ok
                  ? chalk.dim(
                      "  今セッションのチェックポイント履歴を削除しました。 作業フォルダのファイルは無傷です。 (全削除は /checkpoint clear --all)",
                    )
                  : chalk.yellow("  削除対象のチェックポイントがありませんでした。"),
              );
            }
            break;
          }
          default:
            console.log(chalk.dim("  使用方法: /checkpoint [status|on|off|list|restore <n>|diff <n>|clear [--all]]"));
        }
        break;
      }

      case "/sandbox": {
        // bash の「ハード封じ込め」を OS 横断で操作する統一コマンド。
        // Windows を 2 種に整理 (docs/wsl-sandbox-design.md §3・§4.6):
        //   - ネイティブ Windows: OS 封じ込めは無し (git bash 実行)。封じ込めが欲しければ
        //     WSL2 の中で本アプリを起動する → platform=linux となり下記 processSandbox が効く。
        //   - Mac / Linux / WSL2 内: processSandbox (sandbox-exec / bwrap) を on/off。
        const sub = args[0]?.trim() ?? "status";
        const insideWsl = !!process.env.WSL_DISTRO_NAME;

        const printStatus = () => {
          console.log(
            chalk.dim(
              `  bash 封じ込め (sandbox)  —  プラットフォーム: ${process.platform}${insideWsl ? ` (WSL2: ${process.env.WSL_DISTRO_NAME})` : ""}`,
            ),
          );
          if (isWindows) {
            const det = detectWsl();
            console.log(chalk.dim("  方式: Windows ネイティブ (git bash) — OS レベルの封じ込めは非対応"));
            console.log(`  実効: ${chalk.yellow("OFF")} — bash は git bash で実行 (封じ込め無し)`);
            if (det.available) {
              console.log(
                chalk.dim(
                  `  💡 WSL2 検出 (${det.defaultDistro ?? "?"}${det.wsl2 ? "" : " / WSL1"})。 封じ込めには WSL2 の中で本アプリを起動 → /sandbox on で processSandbox(bwrap) が効きます。`,
                ),
              );
            } else {
              console.log(
                chalk.dim("  💡 封じ込めには WSL2 が必要です。 WSL2 を導入し、 その中で本アプリを起動してください。"),
              );
            }
          } else {
            const cfg = this.config.security.processSandbox ?? { enabled: false, level: "none" as const };
            const sb = new ProcessSandbox(cfg);
            const eff = sb.getAvailability().effectiveLevel;
            console.log(
              chalk.dim(
                `  方式: processSandbox (${isMacOS ? "sandbox-exec" : insideWsl ? "bwrap (WSL2)" : "bwrap/unshare"})  /  設定 enabled=${cfg.enabled}, level=${cfg.level}`,
              ),
            );
            // ネットの実態を OS/レベル別に正直に出す（誤認防止）:
            //   fs + macOS → allowlist 経由のみ許可（プロキシ強制）
            //   fs + Linux/WSL2 → 全開（allowlist 未強制。 2b-2 未実装）
            //   network/full → 全遮断（allowlist 非適用）
            const enforceable = sb.getAvailability().netAllowlistEnforceable;
            let netDesc = "";
            if (eff === "fs") {
              netDesc = enforceable
                ? " — ネット: allowlist 経由のみ許可"
                : " — ネット: 全開 (allowlist 未強制。 Linux は socat と ip が必要)";
            } else if (eff === "network" || eff === "full") {
              netDesc = " — ネット: 全遮断 (allowlist 非適用)";
            }
            if (sb.isActive()) {
              console.log(`  実効: ${chalk.green("ON")} — ${eff}${netDesc}`);
            } else {
              console.log(`  実効: ${chalk.yellow("OFF")}`);
            }
            // allowlist が実際に効くのは fs かつ強制可能な環境のみ。 それ以外は参考表示。
            const allow = resolveAllowedDomains(this.config.security.processSandbox?.allowedHosts);
            const enforced = eff === "fs" && enforceable;
            console.log(
              chalk.dim(
                `  ネット allowlist (${allow.length}件${enforced ? "" : "・現在のレベル/OSでは未適用"}): ${allow.join(", ") || "(なし)"}`,
              ),
            );
            // Phase 3: bash 確認自動許可が今この状態で効いているか（誠実な可視化）
            if (isBashNetworkContained()) {
              console.log(chalk.dim("  bash 確認自動許可: 有効（封じ込め下。 破壊的操作・allowlist 外通信は確認）"));
            } else {
              const why = !isMacOS ? "macOS のみ対応" : eff !== "fs" ? "fs レベルのみ" : "封じ込め未成立";
              console.log(chalk.dim(`  bash 確認自動許可: 無効（${why}）`));
            }
            // B-3 監査: 今セッションで bash が実際に通信した宛先（exfil 検知の手がかり）
            const proxyNow = getSandboxProxy();
            const relayed = proxyNow?.getRelayedHosts() ?? [];
            if (relayed.length) {
              console.log(chalk.dim(`  中継した宛先 (今セッション・${relayed.length}件): ${relayed.join(", ")}`));
            }
            // W3: セッションサマリ（自動許可回数・遮断ドメイン）
            const autoAllowN = this.agent.getPermissions().getContainmentAutoAllowCount();
            const blocked = proxyNow?.getBlockedHosts() ?? [];
            if (autoAllowN > 0 || blocked.length) {
              console.log(
                chalk.dim(
                  `  今セッション: bash 自動許可 ${autoAllowN} 回` +
                    (blocked.length ? ` / 遮断ドメイン ${blocked.length}件 (${blocked.join(", ")})` : ""),
                ),
              );
            }
            // W1: 一時許可(once)した先を恒久化するナッジ（育てる allowlist）
            const once = proxyNow?.getSessionAllowedHosts() ?? [];
            if (once.length) {
              console.log(
                chalk.cyan(`  💡 今セッションで一時許可: ${once.join(", ")} — 恒久化は /sandbox allow <domain>`),
              );
            }
          }
          console.log(chalk.dim("  使用例: /sandbox on | off | allow <domain> | deny <domain> | status"));
        };

        switch (sub) {
          case "status":
            printStatus();
            break;
          case "on": {
            if (isWindows) {
              const det = detectWsl();
              console.log(
                chalk.yellow(
                  "  Windows ネイティブには OS 封じ込めが無いため、 ここで ON にするものはありません (bash は git bash で実行)。",
                ),
              );
              if (det.available) {
                console.log(
                  chalk.dim(
                    `  封じ込めるには WSL2 (${det.defaultDistro ?? "検出済み"}) の中で本アプリを起動し、 そこで /sandbox on してください。`,
                  ),
                );
              } else {
                console.log(chalk.dim("  封じ込めるには WSL2 を導入し、 その中で本アプリを起動してください。"));
              }
            } else {
              const prev = this.config.security.processSandbox;
              const arg = args[1]?.trim();
              const level: "fs" | "network" | "full" =
                arg === "fs" || arg === "network" || arg === "full"
                  ? arg
                  : prev?.level && prev.level !== "none"
                    ? (prev.level as "fs" | "network" | "full")
                    : "fs"; // 既定は fs: 書込スコープのみ・ネットは許可（開発を止めない）
              // allowedHosts / autoAllowBashWhenContained を保持（全置換で育てた allowlist と
              // opt-out が無言で消える事故を防ぐ）。
              this.config.security.processSandbox = withSandboxState(this.config.security.processSandbox, true, level);
              saveConfig(this.config);
              resetActiveProcessSandbox();
              reconcileSandboxProxy(); // 実効レベルに合わせ proxy を停止/維持（単一窓口）
              const eff = new ProcessSandbox(this.config.security.processSandbox).getAvailability().effectiveLevel;
              console.log(
                chalk.dim(
                  `  封じ込め ON (config 保存、 level=${level})。 ${isMacOS ? "sandbox-exec" : "bwrap/unshare"} で適用 (次の bash から即反映)。`,
                ),
              );
              if (eff === "none") {
                console.log(
                  chalk.yellow(
                    "  ⚠ 隔離ツールが見つからず実効レベルは none です (Linux/WSL2: bwrap, macOS: sandbox-exec が必要)。",
                  ),
                );
              } else if (eff === "fs") {
                const enforceable = getActiveProcessSandbox().getAvailability().netAllowlistEnforceable;
                if (enforceable) {
                  console.log(
                    chalk.dim(
                      "  書込は作業フォルダ等に限定、 ネットは allowlist 経由のみ (npm install / pip 等は通ります)。",
                    ),
                  );
                } else {
                  // socat/ip 不足(Linux)等で allowlist を強制できない → ネット全開。 status 任せにせず即警告。
                  console.log(
                    chalk.yellow(
                      "  ⚠ ネット allowlist を強制できません (Linux は socat と ip が必要)。 現在 fs はネット全開で、 外部送信を防げません。 `sudo apt install socat iproute2` 等で導入してください。",
                    ),
                  );
                }
                // Phase 3: fs 封じ込め下では bash 確認が自動許可される副作用を明示（macOS のみ発動）
                if (isBashNetworkContained()) {
                  console.log(
                    chalk.yellow(
                      "  ⚠ 封じ込め下では bash 実行確認が自動許可されます（破壊的操作・未許可ドメイン通信は確認）。" +
                        " 切るには /sandbox off、 自動許可だけ無効化は config の autoAllowBashWhenContained: false。",
                    ),
                  );
                }
              } else {
                console.log(
                  chalk.yellow(
                    `  ⚠ level=${eff} はネットワークを遮断します。 npm install / pip / CDN 取得などは通りません (開発作業は level=fs 推奨: /sandbox on fs)。`,
                  ),
                );
              }
            }
            break;
          }
          case "off": {
            if (isWindows) {
              console.log(
                chalk.dim(
                  "  Windows ネイティブでは封じ込めは元々動いていません (git bash 実行)。 WSL2 の中で起動している時のみ /sandbox off が有効です。",
                ),
              );
            } else {
              this.config.security.processSandbox = withSandboxState(this.config.security.processSandbox, false); // level/allowedHosts/opt-out を保持
              saveConfig(this.config);
              resetActiveProcessSandbox();
              reconcileSandboxProxy(); // 封じ込め解除 → proxy も停止（単一窓口）
              console.log(chalk.dim("  封じ込め OFF (config 保存)。 bash は隔離なしで実行します。"));
            }
            break;
          }
          case "allow": {
            const d = args[1]?.trim();
            if (!d) {
              console.log(
                chalk.yellow("  使用方法: /sandbox allow <domain>  (例: /sandbox allow example.com / *.example.com)"),
              );
              break;
            }
            const ps = this.config.security.processSandbox ?? { enabled: false, level: "none" as const };
            const hosts = addDomain(resolveAllowedDomains(ps.allowedHosts), d);
            this.config.security.processSandbox = { ...ps, allowedHosts: hosts };
            saveConfig(this.config);
            console.log(chalk.dim(`  ネット allowlist に追加: ${d} (計 ${hosts.length}件)`));
            break;
          }
          case "deny": {
            const d = args[1]?.trim();
            if (!d) {
              console.log(chalk.yellow("  使用方法: /sandbox deny <domain>"));
              break;
            }
            const ps = this.config.security.processSandbox ?? { enabled: false, level: "none" as const };
            const hosts = removeDomain(resolveAllowedDomains(ps.allowedHosts), d);
            this.config.security.processSandbox = { ...ps, allowedHosts: hosts };
            saveConfig(this.config);
            getSandboxProxy()?.revoke(d); // セッション once 許可も取り消す（残存通過を防ぐ）
            console.log(chalk.dim(`  ネット allowlist から削除: ${d} (残り ${hosts.length}件)`));
            // 完全一致を消しても残存ワイルドカード(例 *.githubusercontent.com)でまだ通る場合は誤認防止に警告
            if (domainAllowed(d, hosts)) {
              console.log(
                chalk.yellow(
                  `  ⚠ ${d} は残りの allowlist（ワイルドカード等）でまだ許可されています。 完全に塞ぐには該当のワイルドカード規則も /sandbox deny してください。`,
                ),
              );
            }
            break;
          }
          default:
            console.log(
              chalk.dim("  使用方法: /sandbox [status | on [fs|network|full] | off | allow <domain> | deny <domain>]"),
            );
        }
        break;
      }

      case "/mcp": {
        // Phase F-1: MCP server 状態管理 (status / reload / on / off / toggle)
        if (!this.mcpManager) {
          console.log(chalk.yellow("  MCP マネージャ未初期化です。"));
          break;
        }
        const sub = args[0]?.trim() ?? "status";
        const target = args[1]?.trim();
        switch (sub) {
          case "status": {
            const enabled = this.mcpManager.isGlobalEnabled();
            const servers = this.mcpManager.getServerStatus();
            console.log(chalk.dim(`  MCP global: ${enabled ? chalk.green("ON") : chalk.yellow("OFF")}`));
            if (servers.length === 0) {
              console.log(chalk.dim("  (mcp-servers.json に登録なし)"));
            } else {
              console.log(chalk.dim(`  Servers (${servers.length}):`));
              for (const s of servers) {
                // active = connected かつ disabled でない、 skipped = いずれかの disabled、 failed = それ以外
                const isSkipped = s.configDisabled || s.runtimeDisabled;
                const stateMark = isSkipped
                  ? chalk.yellow("○ skipped")
                  : s.connected
                    ? chalk.green("● active")
                    : chalk.red("✗ failed");
                const reason = s.configDisabled ? " (config.disabled)" : s.runtimeDisabled ? " (runtime skip)" : "";
                console.log(chalk.dim(`    ${stateMark} ${s.name}${reason}: ${s.toolCount} tools`));
              }
            }
            console.log(chalk.dim("  使用例: /mcp on | /mcp off | /mcp reload | /mcp toggle [server] | /mcp status"));
            break;
          }
          case "on": {
            this.mcpManager.setGlobalEnabled(true);
            this.persistMcpState();
            console.log(chalk.dim("  MCP enabled (config に保存)。 /mcp reload で再接続してください。"));
            break;
          }
          case "off": {
            this.mcpManager.setGlobalEnabled(false);
            await this.mcpManager.disconnectAll();
            this.persistMcpState();
            console.log(chalk.dim("  MCP disabled (config に保存)。 接続中のサーバを切断しました。"));
            break;
          }
          case "reload": {
            console.log(chalk.dim("  MCP: 再接続中..."));
            try {
              const total = await this.mcpManager.reload(this.agent.getToolRegistry());
              console.log(chalk.dim(`  MCP: 再接続完了 (${total} tools)`));
            } catch (e) {
              console.log(chalk.yellow(`  MCP reload 失敗: ${e}`));
            }
            break;
          }
          case "toggle": {
            const servers = this.mcpManager.getServerStatus();
            if (servers.length === 0) {
              console.log(chalk.yellow("  mcp-servers.json に登録なし"));
              break;
            }
            const registry = this.agent.getToolRegistry();

            // 引数指定 = 直接トグル (スクリプト用)
            if (target) {
              const found = servers.find((s) => s.name === target);
              if (!found) {
                console.log(chalk.yellow(`  サーバ "${target}" が見つかりません。 /mcp status で確認。`));
                break;
              }
              const isCurrentlyOn = !found.configDisabled && !found.runtimeDisabled && found.connected;
              try {
                if (isCurrentlyOn) {
                  const r = await this.mcpManager.disableServerImmediate(target, registry);
                  console.log(chalk.dim(`  ${target}: 切断・ツール ${r.removed} 件解除`));
                } else {
                  const r = await this.mcpManager.enableServerImmediate(target, registry);
                  console.log(chalk.dim(`  ${target}: 接続・ツール ${r.added} 件登録`));
                }
                this.persistMcpState();
              } catch (e) {
                console.log(chalk.yellow(`  ${target}: ${e}`));
              }
              break;
            }

            // 引数なし = checkbox UI (↑↓ 選択、 space トグル、 enter 確定)
            const initiallyOn = new Set(
              servers.filter((s) => !s.configDisabled && !s.runtimeDisabled && s.connected).map((s) => s.name),
            );
            let selected: string[];
            try {
              selected = await checkbox<string>({
                message: "MCP サーバを選択 (↑↓ 選択 / space トグル / enter 確定 / Esc キャンセル)",
                choices: servers.map((s) => ({
                  name: `${s.name}${s.configDisabled ? " (config.disabled)" : ""} — ${s.toolCount} tools`,
                  value: s.name,
                  checked: initiallyOn.has(s.name),
                  disabled: s.configDisabled ? "永続無効化中 (mcp-servers.json で disabled: true)" : false,
                })),
                pageSize: 15,
              });
            } catch {
              console.log(chalk.dim("  キャンセルしました"));
              break;
            }
            const newOn = new Set(selected);
            const turnOff = [...initiallyOn].filter((n) => !newOn.has(n));
            const turnOn = [...newOn].filter((n) => !initiallyOn.has(n));
            if (turnOff.length === 0 && turnOn.length === 0) {
              console.log(chalk.dim("  変更なし"));
              break;
            }
            for (const n of turnOff) {
              try {
                const r = await this.mcpManager.disableServerImmediate(n, registry);
                console.log(chalk.dim(`  ${chalk.yellow("− OFF")} ${n} (ツール ${r.removed} 件解除)`));
              } catch (e) {
                console.log(chalk.yellow(`  ! ${n}: ${e}`));
              }
            }
            for (const n of turnOn) {
              try {
                const r = await this.mcpManager.enableServerImmediate(n, registry);
                console.log(chalk.dim(`  ${chalk.green("+ ON ")} ${n} (ツール ${r.added} 件登録)`));
              } catch (e) {
                console.log(chalk.yellow(`  ! ${n}: ${e}`));
              }
            }
            this.persistMcpState();
            console.log(chalk.dim("  config に保存済 (再起動後も維持)"));
            break;
          }
          default: {
            console.log(chalk.yellow(`  未知のサブコマンド: ${sub}`));
            console.log(chalk.dim("  使用方法: /mcp [status|on|off|reload|toggle <server>]"));
          }
        }
        break;
      }

      case "/skills": {
        // Phase F (Skills ON/OFF): 全/個別 skill の状態管理 (status/on/off/reload/toggle)
        if (!this.skillRegistry) {
          console.log(chalk.yellow("  SkillRegistry 未初期化です。"));
          break;
        }
        const sub = args[0]?.trim() ?? "status";
        const target = args[1]?.trim();
        switch (sub) {
          case "status": {
            const enabled = this.skillRegistry.isGlobalEnabled();
            const all = this.skillRegistry.listAllWithStatus();
            console.log(chalk.dim(`  Skills global: ${enabled ? chalk.green("ON") : chalk.yellow("OFF")}`));
            if (all.length === 0) {
              console.log(chalk.dim("  (~/.localllm/skills/ 等にスキルがロードされていません)"));
            } else {
              const builtinCount = all.filter((s) => s.builtIn).length;
              const userCount = all.length - builtinCount;
              const enabledCount = all.filter((s) => s.enabled).length;
              console.log(
                chalk.dim(
                  `  Loaded: ${all.length} (builtin=${builtinCount}, user=${userCount}) / Enabled: ${enabledCount}`,
                ),
              );
              for (const s of all) {
                const stateMark = s.enabled ? chalk.green("●") : chalk.yellow("○");
                const reason = !enabled ? " (global OFF)" : s.runtimeDisabled ? " (skip)" : "";
                const tag = s.builtIn ? chalk.dim("[builtin]") : chalk.dim("[user]");
                console.log(chalk.dim(`    ${stateMark} ${s.name.padEnd(24)} ${tag}${reason}`));
              }
            }
            console.log(chalk.dim("  使用例: /skills on | /skills off | /skills toggle [name] | /skills reload"));
            console.log(chalk.dim("  ON/OFF と toggle 結果は config.json に自動保存 (再起動後も維持)"));
            break;
          }
          case "on": {
            this.skillRegistry.setGlobalEnabled(true);
            this.refreshLLMProfiles();
            this.persistSkillsState();
            console.log(chalk.dim("  Skills enabled (system prompt 反映済 / config に保存)"));
            break;
          }
          case "off": {
            this.skillRegistry.setGlobalEnabled(false);
            this.refreshLLMProfiles();
            this.persistSkillsState();
            console.log(chalk.dim("  Skills disabled (system prompt から外しました / config に保存)"));
            break;
          }
          case "reload": {
            // 完全な再読込は loadAllSkills を呼ぶ必要があるが、 registry に
            // 注入し直すと既存の disable 状態を保持できないため、 ここでは「次回起動時」 を案内。
            console.log(chalk.dim("  Skills reload は次回起動時に行われます (~/.localllm/skills/ の差分を見たい場合)"));
            console.log(chalk.dim("  個別 toggle なら /skills toggle <name> で即時反映"));
            break;
          }
          case "toggle": {
            const all = this.skillRegistry.listAllWithStatus();
            if (all.length === 0) {
              console.log(chalk.yellow("  スキルがロードされていません"));
              break;
            }

            // 引数指定 = 直接トグル (スクリプト用)
            if (target) {
              const found = all.find((s) => s.name === target);
              if (!found) {
                console.log(chalk.yellow(`  スキル "${target}" が見つかりません。 /skills status で確認。`));
                break;
              }
              if (found.runtimeDisabled) {
                this.skillRegistry.enableSkill(target);
                console.log(chalk.dim(`  ${target}: 有効化`));
              } else {
                this.skillRegistry.disableSkill(target);
                console.log(chalk.dim(`  ${target}: 無効化`));
              }
              this.refreshLLMProfiles();
              this.persistSkillsState();
              break;
            }

            // 引数なし = checkbox UI
            const initiallyOn = new Set(all.filter((s) => s.enabled).map((s) => s.name));
            let selected: string[];
            try {
              selected = await checkbox<string>({
                message: "スキルを選択 (↑↓ 選択 / space トグル / enter 確定 / Esc キャンセル)",
                choices: all.map((s) => ({
                  name: `${s.name.padEnd(24)} ${s.builtIn ? "[builtin]" : "[user]"} — ${s.description.slice(0, 48)}`,
                  value: s.name,
                  checked: s.enabled,
                })),
                pageSize: 15,
              });
            } catch {
              console.log(chalk.dim("  キャンセルしました"));
              break;
            }
            const newOn = new Set(selected);
            const turnOff = [...initiallyOn].filter((n) => !newOn.has(n));
            const turnOn = [...newOn].filter((n) => !initiallyOn.has(n));
            if (turnOff.length === 0 && turnOn.length === 0) {
              console.log(chalk.dim("  変更なし"));
              break;
            }
            for (const n of turnOff) this.skillRegistry.disableSkill(n);
            for (const n of turnOn) this.skillRegistry.enableSkill(n);
            this.refreshLLMProfiles();
            this.persistSkillsState();
            for (const n of turnOff) console.log(chalk.dim(`  ${chalk.yellow("− OFF")} ${n}`));
            for (const n of turnOn) console.log(chalk.dim(`  ${chalk.green("+ ON ")} ${n}`));
            console.log(chalk.dim("  system prompt 反映済 / config に保存 (再起動後も維持)"));
            break;
          }
          default: {
            console.log(chalk.yellow(`  未知のサブコマンド: ${sub}`));
            console.log(chalk.dim("  使用方法: /skills [status|on|off|reload|toggle <name>]"));
          }
        }
        break;
      }

      case "/try": {
        const tryArgsStr = args.join(" ").trim();
        if (!tryArgsStr) {
          console.log(chalk.dim("  使用方法: /try [最大試行数] <プロンプト>"));
          console.log(chalk.dim("  例: /try 3 output/gamesにテトリスを作って"));
          console.log(chalk.dim("  試行数省略時はデフォルト3回 / Ctrl+C で中断可"));
          break;
        }
        // 先頭が数字なら試行数とみなす
        let tryMaxAttempts = 3;
        let tryPrompt = tryArgsStr;
        const tryFirstNum = parseInt(args[0], 10);
        if (!isNaN(tryFirstNum) && tryFirstNum > 0 && tryFirstNum <= 10 && args.length > 1) {
          tryMaxAttempts = tryFirstNum;
          tryPrompt = args.slice(1).join(" ").trim();
        }
        if (!tryPrompt) {
          console.log(chalk.yellow("  プロンプトが必要です。"));
          break;
        }
        // @ファイル参照を解決
        const { resolved: tryResolved, mentions: tryMentions } = resolveAtMentions(tryPrompt);
        if (tryMentions.length > 0) printMentionFeedback(tryMentions);

        this.agentBusy = true;
        try {
          console.log(chalk.cyan(`\n  ┌─ 試行錯誤モード (最大${tryMaxAttempts}回) ─── Ctrl+C で中断可 ───`));
          console.log(chalk.dim(`  │ タスク: ${tryPrompt.slice(0, 70)}${tryPrompt.length > 70 ? "..." : ""}`));
          console.log(chalk.cyan(`  └${"─".repeat(54)}\n`));

          let trySucceeded = false;
          let tryLastFeedback = "";
          for (let tryAttempt = 1; tryAttempt <= tryMaxAttempts; tryAttempt++) {
            if (this.agent.isAborted()) break;

            console.log(chalk.cyan(`  ── 試行 ${tryAttempt}/${tryMaxAttempts} ${"─".repeat(40)}`));

            // 試行ごとに履歴をリセット（コンテキスト肥大化を防ぐ）
            this.agent.getHistory().clear();

            const promptForAttempt =
              tryAttempt === 1
                ? tryResolved
                : `${tryResolved}\n\n---\n**再試行 (${tryAttempt}回目):** 前回の試行の問題点:\n${tryLastFeedback}\n\n` +
                  `上記を踏まえて再実装してください。特に file_write ツールを呼び出して実際にファイルを保存してください。`;

            await this.agent.run(promptForAttempt);

            if (this.agent.isAborted()) break;

            // file_write が呼ばれたか: ツール結果メッセージで "File written:" を確認
            const allMsgs = this.agent.getHistory().getMessages();
            const fileWritten = allMsgs.some(
              (m) => m.role === "tool" && typeof m.content === "string" && m.content.startsWith("File written:"),
            );

            if (fileWritten) {
              // 書かれたファイルパスを表示
              const writtenPaths = allMsgs
                .filter(
                  (m) => m.role === "tool" && typeof m.content === "string" && m.content.startsWith("File written:"),
                )
                .map((m) => (m.content as string).replace("File written: ", "").trim());
              console.log(chalk.green(`\n  ✓ 試行 ${tryAttempt} 回目で完了`));
              writtenPaths.forEach((p) => console.log(chalk.green(`    → ${p}`)));
              console.log();
              trySucceeded = true;
              break;
            }

            // 失敗した場合: 最後のアシスタント応答をフィードバックとして次回に渡す
            const lastAssistant = [...allMsgs].reverse().find((m) => m.role === "assistant");
            tryLastFeedback =
              typeof lastAssistant?.content === "string"
                ? lastAssistant.content.slice(0, 500)
                : "ファイルが作成されませんでした";

            if (tryAttempt < tryMaxAttempts) {
              console.log(chalk.yellow(`\n  ✗ ファイル未作成。次の試行に進みます...\n`));
            }
          }

          if (!trySucceeded && !this.agent.isAborted()) {
            console.log(chalk.yellow(`\n  ${tryMaxAttempts}回試行しましたがファイルが作成されませんでした\n`));
          }
        } finally {
          this.agentBusy = false;
        }
        break;
      }

      case "/goal-loop": {
        // 決定的検証ゲート型ループ。設計: docs/goal-loop-deterministic-check-design.md
        // /try (LLM スコア) や /goal-seek (LLM 判定) と異なり、検証コマンドの exit code を
        // ハーネス自身が握る (記事「Write Loops Not Prompts」の思想)。
        const rawArgs = args.join(" ").trim();
        if (!rawArgs) {
          console.log(chalk.dim('  使用方法: /goal-loop [最大反復数] --check "<検証コマンド>" <タスク>'));
          console.log(chalk.dim('  例: /goal-loop 8 --check "npm test" 失敗しているテストを通るように修正して'));
          console.log(chalk.dim("  検証コマンドが exit 0 になるまで反復 (反復数省略時は 8 / Ctrl+C で中断)"));
          console.log(chalk.dim("  関連: /loop=時間反復 / /goal-seek=LLM判定で合格まで / /try=LLMスコアで再試行"));
          break;
        }

        // 先頭が数字なら最大反復数
        let glMax = 8;
        let glRest = rawArgs;
        const glNumMatch = glRest.match(/^(\d+)\s+/);
        if (glNumMatch) {
          const n = parseInt(glNumMatch[1], 10);
          if (n > 0 && n <= 50) {
            glMax = n;
            glRest = glRest.slice(glNumMatch[0].length);
          }
        }

        // --check "<cmd>" を取り出す (クォート / 単語いずれも対応)
        let glCheck = "";
        const glCheckMatch = glRest.match(/--check\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
        if (glCheckMatch) {
          glCheck = (glCheckMatch[1] ?? glCheckMatch[2] ?? glCheckMatch[3] ?? "").trim();
          glRest = (
            glRest.slice(0, glCheckMatch.index) + glRest.slice((glCheckMatch.index ?? 0) + glCheckMatch[0].length)
          ).trim();
        }

        if (!glCheck) {
          console.log(chalk.yellow('  --check "<検証コマンド>" が必要です。'));
          console.log(chalk.dim('  例: /goal-loop --check "npm test" テストを通して'));
          break;
        }
        const glPrompt = glRest.trim();
        if (!glPrompt) {
          console.log(chalk.yellow("  タスク記述が必要です。"));
          break;
        }
        if (this.agent.getMode() === "goal-seek") {
          console.log(chalk.yellow("  既に Goal Seek mode 中です。先に /exit-goal-seek を実行してください。"));
          break;
        }

        const { resolved: glResolved, mentions: glMentions } = resolveAtMentions(glPrompt);
        if (glMentions.length > 0) printMentionFeedback(glMentions);
        // goal-loop はテキスト駆動 (検証コマンドがゲート)。画像メンション展開時は素のテキストを使う。
        const glPromptText = typeof glResolved === "string" ? glResolved : glPrompt;

        this.agentBusy = true;
        try {
          console.log(chalk.cyan(`\n  ┌─ goal-loop (最大${glMax}反復) ─── Ctrl+C で中断可 ───`));
          console.log(chalk.dim(`  │ タスク: ${glPrompt.slice(0, 64)}${glPrompt.length > 64 ? "..." : ""}`));
          console.log(chalk.dim(`  │ 検証 : ${glCheck}  (exit 0 で完了)`));
          console.log(chalk.cyan(`  └${"─".repeat(50)}\n`));

          await runGoalLoop(
            { prompt: glPromptText, checkCommand: glCheck, maxIterations: glMax, cwd: process.cwd() },
            this.agent,
          );
        } finally {
          this.agentBusy = false;
        }
        break;
      }

      case "/stream": {
        // 2026-05-28: /stream は引数なし toggle / picker 化 (Phase optimize #5)。
        // 旧 /stream on / /stream off は dispatcher 互換のため残すが補完候補からは外す。
        const current = this.agent.getStreamingDisplay();
        const sub = args[0]?.toLowerCase();
        if (sub === "on") {
          this.agent.setStreamingDisplay(true);
          this.config.streamingDisplay = true;
          saveConfig(this.config);
          console.log(chalk.dim("  ストリーミング表示モードに切り替えました。（設定を保存しました）"));
          break;
        }
        if (sub === "off") {
          this.agent.setStreamingDisplay(false);
          this.config.streamingDisplay = false;
          saveConfig(this.config);
          console.log(chalk.dim("  スピナー+Markdownレンダリングモードに切り替えました。（設定を保存しました）"));
          break;
        }
        // 引数なし → 現状表示 + toggle
        console.log(chalk.bold("\n  ── Stream display ──"));
        console.log(
          chalk.dim(
            `  現在: ${current ? chalk.cyan("ストリーミング表示") : chalk.cyan("スピナー+Markdownレンダリング")}`,
          ),
        );
        try {
          const ok = await confirm({
            message: current ? "スピナー+Markdown に切り替えますか?" : "ストリーミング表示に切り替えますか?",
            default: true,
          });
          if (ok) {
            const next = !current;
            this.agent.setStreamingDisplay(next);
            this.config.streamingDisplay = next;
            saveConfig(this.config);
            console.log(chalk.green(`  切り替えました: ${next ? "ストリーミング表示" : "スピナー+Markdown"}`));
          } else {
            console.log(chalk.dim("  変更なし。"));
          }
        } catch {
          console.log(chalk.dim("  変更なし。"));
        }
        break;
      }

      case "/model": {
        // 2026-05-27: /model second ... を /second の正準形として処理する (docs/model-registry.md §4.1)。
        // 残りの args (= second 以降) を handleSecondLLMCommand に委譲。
        if (args[0] === "second") {
          await this.handleSecondLLMCommand(args.slice(1));
          break;
        }
        // 2026-05-28: /model vision ... を Vision LLM の操作経路として処理 (Phase 5)。
        if (args[0] === "vision") {
          await this.handleVisionLLMCommand(args.slice(1));
          break;
        }
        // /model apply: 設定値を実行中へ明示的に反映する (docs/model-apply-immediacy.md §3.4)。
        // ズレ警告からたどれる操作が無いと、 ユーザーは結局アプリを再起動してしまう。
        if (args[0] === "apply") {
          console.log(chalk.bold("\n  ── メインLLM 設定の反映 ──"));
          console.log(chalk.dim(`  設定値: ${describeEndpoint(this.config.mainLLM)}`));
          try {
            if (await this.applyMainLLMEndpoint()) {
              if (this.currentModelDrift()) {
                console.log(chalk.yellow("  反映しましたが、 設定値と実行中がまだ一致していません。"));
              } else {
                console.log(chalk.green("  ✓ 反映しました。 設定値と実行中が一致しています。"));
              }
            }
          } catch (e) {
            this.reportApplyFailure(e instanceof Error ? e.message : String(e));
          }
          this.printMainLLMBinding("メインLLM", "  ");
          console.log();
          break;
        }
        if (args.length === 0 || args[0] === "info") {
          // --- 基本情報 ---
          const modelName = this.agent.getModel();
          const ctxWindow = this.agent.getContextWindow();
          const ctxLabel = ctxWindow >= 1000 ? `${Math.round(ctxWindow / 1000)}K` : `${ctxWindow}`;
          console.log(chalk.bold("\n  ── モデル情報 ──"));
          // 「設定値」 と「実行中」 は別物なので必ず 2 行に分けて出す
          // (docs/model-apply-immediacy.md §3.3)。 混ぜると画面が嘘をつく。
          this.printMainLLMBinding("メインLLM", "  ");
          console.log(chalk.dim(`  実行中モデル:   ${chalk.cyan(modelName)}`));
          {
            const m = this.config.mainLLM;
            if (m.deploymentName) console.log(chalk.dim(`  Deployment:     ${m.deploymentName}`));
            if (m.apiKey) {
              const kind = m.apiKey.startsWith("encrypted:")
                ? "暗号化保存"
                : m.apiKey.startsWith("env:")
                  ? `環境変数 (${m.apiKey})`
                  : "平文保存";
              console.log(chalk.dim(`  API Key:        ${kind}`));
            }
          }
          console.log(chalk.dim(`  コンテキスト長: ${chalk.yellow(ctxLabel)} トークン (設定値)`));
          console.log(chalk.dim(`  max_tokens:     ${chalk.yellow(ctxLabel)} (= コンテキスト長から自動設定)`));
          // サンプリングパラメータ: 設定値があれば表示、なければ "auto (サーバーデフォルト)"
          const sp = this.config.mainLLM;
          const fmt = (v: number | undefined) => (v !== undefined ? String(v) : chalk.gray("auto"));
          console.log(
            chalk.dim(`  temperature:    ${fmt(sp.temperature)}    ${chalk.gray("(/model temperature <値> で変更)")}`),
          );
          console.log(chalk.dim(`  top_p:          ${fmt(sp.top_p)}    ${chalk.gray("(/model top_p <値>)")}`));
          console.log(chalk.dim(`  top_k:          ${fmt(sp.top_k)}    ${chalk.gray("(/model top_k <値>)")}`));
          console.log(
            chalk.dim(`  rep_penalty:    ${fmt(sp.repetition_penalty)}    ${chalk.gray("(/model rep_penalty <値>)")}`),
          );
          console.log(chalk.dim(`  ストリーミング: ${this.agent.getStreamingDisplay() ? "ON" : "OFF"}`));

          // --- サーバーからモデル詳細を取得 ---
          try {
            const detail = await this.agent.getProvider().getModelInfo(modelName);
            if (detail.contextLength > 0 || detail.size > 0 || detail.parameterSize || detail.quantizationLevel) {
              console.log(chalk.bold("\n  ── サーバー報告 ──"));
              if (detail.contextLength > 0) {
                const serverCtx =
                  detail.contextLength >= 1000
                    ? `${Math.round(detail.contextLength / 1000)}K`
                    : `${detail.contextLength}`;
                // K単位で丸めて比較: 262144 (二進256K) と 262000 (十進262K) のような僅差を許容
                const mismatch = Math.round(detail.contextLength / 1000) !== Math.round(ctxWindow / 1000);
                console.log(
                  chalk.dim(
                    `  コンテキスト長: ${mismatch ? chalk.red(serverCtx) : chalk.green(serverCtx)} トークン${mismatch ? chalk.red(" ⚠ 設定値と不一致!") : ""}`,
                  ),
                );
              }
              if (detail.size > 0) {
                console.log(chalk.dim(`  モデルサイズ:   ${(detail.size / 1e9).toFixed(1)} GB`));
              }
              if (detail.parameterSize) {
                console.log(chalk.dim(`  パラメータ数:   ${detail.parameterSize}`));
              }
              if (detail.quantizationLevel) {
                console.log(chalk.dim(`  量子化:         ${detail.quantizationLevel}`));
              }
              if (detail.format) {
                console.log(chalk.dim(`  フォーマット:   ${detail.format}`));
              }
              console.log(chalk.dim(`  Vision:         ${detail.supportsVision ? "対応" : "非対応"}`));
              console.log(chalk.dim(`  Function Call:  ${detail.supportsFunctionCalling ? "対応" : "非対応"}`));
            }
          } catch {
            console.log(chalk.dim("\n  (サーバーからの詳細取得に失敗)"));
          }

          // --- Vision / SecondLLM ---
          if (this.config.visionLLM) {
            console.log(chalk.bold("\n  ── Vision LLM ──"));
            const v = this.config.visionLLM;
            const loc = v.baseUrl ?? v.endpoint ?? "(クラウド)";
            console.log(chalk.dim(`  モデル: ${v.model} (${v.providerType}) @ ${loc}`));
            const vDesc = v.description?.trim();
            if (vDesc) console.log(chalk.dim(`  特性:   ${chalk.cyan(vDesc)}`));
            console.log(chalk.dim(`  詳細:   /model vision  /  変更: /model vision setup`));
          } else {
            console.log(chalk.bold("\n  ── Vision LLM ──"));
            console.log(
              chalk.dim(`  ${chalk.yellow("未設定")} (main LLM にフォールバック)。 設定: /model vision setup`),
            );
          }
          if (this.config.secondLLM?.enabled) {
            console.log(chalk.bold("\n  ── セカンドLLM ──"));
            console.log(
              chalk.dim(
                `  モデル: ${this.config.secondLLM.endpoint.model} (${this.config.secondLLM.endpoint.providerType})`,
              ),
            );
            const secDesc = this.config.secondLLM.endpoint.description?.trim();
            if (secDesc) {
              console.log(chalk.dim(`  特性:   ${chalk.cyan(secDesc)}`));
            }
            console.log(chalk.dim(`  詳細:   /model second`));
          }
          // メインLLMの特性説明
          const mainDesc = this.config.mainLLM.description?.trim();
          if (mainDesc) {
            console.log(chalk.bold("\n  ── メイン特性 ──"));
            console.log(chalk.dim(`  ${chalk.cyan(mainDesc)}`));
          }
          console.log("");
        } else if (args[0] === "description") {
          const text = args.slice(1).join(" ").trim();
          if (!text) {
            const cur = this.config.mainLLM.description?.trim();
            console.log(chalk.bold("\n  ── メインLLM特性説明 ──"));
            console.log(chalk.dim(`  現在: ${cur ? chalk.cyan(cur) : chalk.yellow("(未設定)")}`));
            console.log(chalk.dim(`  使い方: /model description <説明文>`));
            console.log(chalk.dim(`  クリア: /model description clear`));
            console.log(chalk.dim(`  推奨: 100〜300文字程度でモデルの得意/不得意、速度感、用途を記載`));
            console.log(chalk.bold("\n  ── 記載例 ──"));
            console.log(
              chalk.dim(`    "MoE 32B。日本語堅牢で推論・企画・対話が得意。応答は中速。マルチモーダル非対応"`),
            );
            console.log(
              chalk.dim(`    "Dense 13B。高速でコード生成が得意。日本語はやや不自然。長文要約やリファクタリング向き"`),
            );
            console.log(
              chalk.dim(`    "Vision対応27B。画像解析+日本語OK。スクリーンショット/図表の読み取りに最適。やや遅い"`),
            );
            console.log();
          } else if (text.toLowerCase() === "clear") {
            this.config.mainLLM.description = undefined;
            saveConfig(this.config);
            this.refreshLLMProfiles();
            console.log(chalk.yellow("  メインLLMの特性説明をクリアしました (次ターンのシステムプロンプトから削除)"));
          } else {
            this.config.mainLLM.description = text;
            saveConfig(this.config);
            this.refreshLLMProfiles();
            console.log(chalk.green(`  メインLLMの特性説明を設定しました (${text.length}文字):`));
            console.log(chalk.dim(`  ${text}`));
            if (text.length < 30) {
              console.log(chalk.yellow(`  ※ 短すぎて委任判断の材料になりにくいかもしれません。100文字以上推奨`));
            } else if (text.length > 500) {
              console.log(chalk.yellow(`  ※ 長すぎるとシステムプロンプトを圧迫します。300文字以内推奨`));
            }
          }
        } else if (args[0] === "context") {
          // /model context <数値|128k|256K|1m> — コンテキストウィンドウサイズ変更
          const val = args[1] ? parseTokenCount(args[1]) : NaN;
          if (isNaN(val) || val <= 0) {
            const cur = this.agent.getContextWindow();
            const curLabel = cur >= 1000 ? `${Math.round(cur / 1000)}K` : `${cur}`;
            console.log(chalk.dim(`  現在のコンテキスト長: ${curLabel} トークン`));
            console.log(chalk.dim(`  使い方: /model context <トークン数>`));
            console.log(chalk.dim(`  例: /model context 128k  /model context 256000`));
          } else {
            const old = this.agent.getContextWindow();
            this.agent.setContextWindow(val);
            this.config.mainLLM.contextWindow = val;
            saveConfig(this.config);
            const oldLabel = old >= 1000 ? `${Math.round(old / 1000)}K` : `${old}`;
            const newLabel = val >= 1000 ? `${Math.round(val / 1000)}K` : `${val}`;
            console.log(
              chalk.dim(
                `  コンテキスト長: ${chalk.yellow(oldLabel)} → ${chalk.cyan(newLabel)} トークン (max_tokensも連動)`,
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
                saveConfig(this.config);
                const subAgentMgr = getSubAgentManager();
                subAgentMgr?.setProvider(this.agent.getProvider(), chosen);
                this.refreshLLMProfiles();
                console.log(
                  chalk.dim(`  モデルを ${chalk.yellow(currentModel)} から ${chalk.cyan(chosen)} に切り替えました`),
                );
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
        } else if (
          args[0] === "temperature" ||
          args[0] === "top_p" ||
          args[0] === "top_k" ||
          args[0] === "rep_penalty"
        ) {
          // ハイパーパラメータ設定（メインLLM）
          // /model temperature [<値>|auto|clear]
          const paramKeyMap: Record<string, "temperature" | "top_p" | "top_k" | "repetition_penalty"> = {
            temperature: "temperature",
            top_p: "top_p",
            top_k: "top_k",
            rep_penalty: "repetition_penalty",
          };
          const paramKey = paramKeyMap[args[0]];
          const ranges: Record<string, { min: number; max: number; recommended: string; integer?: boolean }> = {
            temperature: { min: 0, max: 2, recommended: "0.0〜1.0 (推論重視は 0.2、創造性重視は 0.8前後)" },
            top_p: { min: 0, max: 1, recommended: "0.85〜0.95 (1.0で無効化)" },
            top_k: { min: 1, max: 1000, recommended: "20〜50 (大きいほど多様、Ollama系で有効)", integer: true },
            repetition_penalty: { min: 0, max: 2, recommended: "1.0〜1.15 (1.0で中立、>1で繰り返し抑制)" },
          };
          const r = ranges[paramKey];
          const valArg = args[1]?.trim().toLowerCase();
          const cur = this.config.mainLLM[paramKey];
          const curStr = cur !== undefined ? String(cur) : chalk.gray("auto (サーバーデフォルト)");

          if (!valArg) {
            console.log(chalk.bold(`\n  ── ${args[0]} ──`));
            console.log(chalk.dim(`  現在値: ${curStr}`));
            console.log(chalk.dim(`  推奨値: ${r.recommended}`));
            console.log(chalk.dim(`  範囲:   ${r.min} 〜 ${r.max}${r.integer ? " (整数)" : ""}`));
            console.log(chalk.dim(`  使い方: /model ${args[0]} <値>`));
            console.log(chalk.dim(`  クリア: /model ${args[0]} auto  (または clear)`));
          } else if (valArg === "auto" || valArg === "clear") {
            this.agent.setSamplingParam(paramKey, undefined);
            delete this.config.mainLLM[paramKey];
            saveConfig(this.config);
            console.log(chalk.yellow(`  ${args[0]} を auto (サーバーデフォルト) に戻しました`));
          } else {
            const num = r.integer ? parseInt(valArg, 10) : parseFloat(valArg);
            if (isNaN(num) || num < r.min || num > r.max) {
              console.log(chalk.red(`  無効な値: ${valArg}`));
              console.log(chalk.dim(`  範囲: ${r.min} 〜 ${r.max}${r.integer ? " (整数)" : ""}`));
            } else {
              this.agent.setSamplingParam(paramKey, num);
              this.config.mainLLM[paramKey] = num;
              saveConfig(this.config);
              console.log(
                chalk.green(`  ${args[0]} を ${chalk.cyan(String(num))} に設定しました (次のLLM呼び出しから反映)`),
              );
            }
          }
        } else if (args[0] === "host" || args[0] === "ip") {
          await this.handleModelHostCommand(args.slice(1).join(" ").trim());
        } else if (args[0] === "port") {
          await this.handleModelPortCommand(args.slice(1).join(" ").trim());
        } else if (args[0] === "url") {
          // 非推奨: 表記揺れ解消のため /model host + /model port または /model setup を推奨
          console.log(chalk.yellow("  /model url は非推奨です。"));
          console.log(chalk.dim("  代わりに /model host <ホスト名/IP>、 /model port <番号>、"));
          console.log(chalk.dim("  または /model setup (ウィザード) をご利用ください。"));
          const newUrl = args.slice(1).join(" ").trim();
          if (!newUrl) {
            console.log(chalk.dim(`  現在のURL: ${this.config.mainLLM.baseUrl}`));
          } else {
            const oldUrl = this.config.mainLLM.baseUrl;
            this.config.mainLLM.baseUrl = newUrl;
            saveConfig(this.config);
            console.log(chalk.dim(`  メインLLM URL: ${chalk.yellow(oldUrl)} → ${chalk.cyan(newUrl)}`));
            await this.applyMainLLMEndpoint();
            console.log(chalk.green(`  実行時に反映しました。`));
          }
        } else if (args[0] === "provider") {
          const newProvider = args[1]?.trim();
          const localProviders: ProviderType[] = ["ollama", "lmstudio", "llamacpp", "vllm"];
          const cloudProviders = [
            "vertex-ai",
            "azure-openai",
            "azure-gpt",
            "azure-claude",
            "azure-foundry",
            "azure-anthropic",
            "anthropic",
            "claude-cli",
            "claude-agent-sdk",
            "gemini",
          ];
          const validProviders = [...localProviders, ...cloudProviders];
          if (!newProvider) {
            console.log(chalk.dim(`  現在のプロバイダー: ${this.config.mainLLM.providerType}`));
            console.log(chalk.dim(`  使い方: /model provider <タイプ> [<URL>]   (ローカル系)`));
            console.log(chalk.dim(`         /model setup azure-foundry        (クラウド系は対話セットアップ)`));
            console.log(chalk.dim(`  ローカル: ${localProviders.join(", ")}`));
            console.log(chalk.dim(`  クラウド: ${cloudProviders.join(", ")}`));
            console.log(
              chalk.dim(`  デフォルトポート: ${localProviders.map((p) => `${p}=${DEFAULT_PORTS[p]}`).join(", ")}`),
            );
          } else if (!validProviders.includes(newProvider)) {
            console.log(chalk.red(`  無効なプロバイダー: ${newProvider}`));
            console.log(chalk.dim(`  選択肢: ${validProviders.join(", ")}`));
          } else if (cloudProviders.includes(newProvider)) {
            // クラウド系は endpoint/apiKey 等の追加情報が必要 → setup フローへ誘導
            console.log(
              chalk.yellow(
                `  ${newProvider} はクラウド系です。endpoint/apiKey 設定が必要なので /model setup ${newProvider} を実行してください。`,
              ),
            );
          } else {
            const oldProvider = this.config.mainLLM.providerType;
            this.config.mainLLM.providerType = newProvider as ProviderType;
            // URLが2番目に渡されていれば同時に変更。なければ既存URLを維持
            const newUrl = args[2]?.trim();
            if (newUrl) {
              this.config.mainLLM.baseUrl = newUrl;
            }
            // クラウドからローカルへ切り替え時はクラウド用フィールドをクリア
            this.config.mainLLM.endpoint = undefined;
            this.config.mainLLM.apiKey = undefined;
            this.config.mainLLM.deploymentName = undefined;
            this.config.mainLLM.projectId = undefined;
            this.config.mainLLM.region = undefined;
            saveConfig(this.config);
            console.log(
              chalk.dim(`  メインLLMプロバイダー: ${chalk.yellow(oldProvider)} → ${chalk.cyan(newProvider)}`),
            );
            if (newUrl) {
              console.log(chalk.dim(`  URL: ${chalk.cyan(newUrl)}`));
            } else {
              const port = DEFAULT_PORTS[newProvider as ProviderType];
              console.log(
                chalk.dim(
                  `  URL: ${this.config.mainLLM.baseUrl ?? "(未設定)"} (必要なら /model host / /model port で更新。${newProvider}のデフォルトポートは ${port})`,
                ),
              );
            }
            await this.applyMainLLMEndpoint();
            console.log(chalk.green(`  実行時に反映しました。`));
          }
        } else if (args[0] === "setup") {
          let targetProvider = args[1]?.trim();
          if (!targetProvider) {
            // 引数なし → プロバイダー候補メニューを提示して選んでもらう
            try {
              const picked = await this.chooseSetupProvider();
              if (!picked) {
                console.log(chalk.yellow("  セットアップを中止しました。"));
                return;
              }
              targetProvider = picked;
            } catch (e) {
              if (e instanceof Error && e.message.includes("User force closed")) {
                console.log(chalk.yellow("\n  セットアップを中止しました。"));
                return;
              }
              throw e;
            }
          }
          if (targetProvider === "local") {
            // "local" → ローカル系ウィザード (npm run setup と同等の流れ)
            await this.handleModelSetupLocal();
          } else if (
            targetProvider === "azure-openai" ||
            targetProvider === "azure-gpt" ||
            targetProvider === "azure-claude" ||
            targetProvider === "azure-foundry" ||
            targetProvider === "azure-anthropic"
          ) {
            try {
              await this.setupAzureLLM("main", targetProvider);
            } catch (e) {
              if (!(e instanceof Error && e.message.includes("User force closed"))) {
                console.log(chalk.red(`  Azure セットアップ中にエラー: ${e instanceof Error ? e.message : String(e)}`));
              } else {
                console.log(chalk.yellow("  セットアップを中止しました。"));
              }
            }
          } else if (
            targetProvider === "anthropic" ||
            targetProvider === "claude-cli" ||
            targetProvider === "claude-agent-sdk"
          ) {
            try {
              await this.setupClaudeLLM("main", targetProvider);
            } catch (e) {
              if (!(e instanceof Error && e.message.includes("User force closed"))) {
                console.log(
                  chalk.red(`  Claude セットアップ中にエラー: ${e instanceof Error ? e.message : String(e)}`),
                );
              } else {
                console.log(chalk.yellow("  セットアップを中止しました。"));
              }
            }
          } else if (targetProvider === "gemini") {
            try {
              await this.setupGeminiLLM("main");
            } catch (e) {
              if (!(e instanceof Error && e.message.includes("User force closed"))) {
                console.log(
                  chalk.red(`  Gemini セットアップ中にエラー: ${e instanceof Error ? e.message : String(e)}`),
                );
              } else {
                console.log(chalk.yellow("  セットアップを中止しました。"));
              }
            }
          } else {
            console.log(chalk.red(`  対話セットアップ未対応のプロバイダー: ${targetProvider}`));
            console.log(chalk.dim("  使い方:"));
            console.log(
              chalk.dim("    /model setup                  ローカル系LLM (ollama/lmstudio/llamacpp/vllm) ウィザード"),
            );
            console.log(
              chalk.dim("    /model setup anthropic        Anthropic API (Claude direct, ANTHROPIC_API_KEY)"),
            );
            console.log(
              chalk.dim(
                "    /model setup claude-cli       Claude Code CLI (claude -p、 認証は claude login、 tool calling 不可)",
              ),
            );
            console.log(
              chalk.dim(
                "    /model setup claude-agent-sdk Claude Agent SDK (in-process MCP、 認証は claude login、 tool calling 対応)",
              ),
            );
            console.log(chalk.dim("    /model setup gemini           Google AI Studio (Gemini、 GEMINI_API_KEY)"));
            console.log(chalk.dim("    /model setup azure-foundry    Azure AI Foundry (Kimi/Mistral等)"));
            console.log(chalk.dim("    /model setup azure-anthropic  Azure Claude — Anthropic Messages API"));
            console.log(chalk.dim("    /model setup azure-openai     Azure OpenAI — Chat Completions API"));
            console.log(chalk.dim("    /model setup azure-gpt        Azure OpenAI — Responses API (gpt-5/codex系)"));
            console.log(chalk.dim("    /model setup azure-claude     Azure Claude — OpenAI互換ルート"));
          }
        } else {
          const newModel = args[0];
          const oldModel = this.agent.getModel();
          if (newModel === oldModel) {
            console.log(chalk.dim(`  既に ${newModel} を使用中です。`));
          } else {
            this.agent.setModel(newModel);
            this.config.mainLLM.model = newModel;
            saveConfig(this.config);
            const subAgentMgr = getSubAgentManager();
            subAgentMgr?.setProvider(this.agent.getProvider(), newModel);
            this.refreshLLMProfiles();
            console.log(
              chalk.dim(`  モデルを ${chalk.yellow(oldModel)} から ${chalk.cyan(newModel)} に切り替えました`),
            );
          }
        }
        break;
      }

      case "/todo": {
        // docs/todo-goal-lifecycle.md §2.4 — active / all / archive サブコマンド
        const sub = (args[0] ?? "").toLowerCase();
        if (sub === "all") {
          console.log(chalk.dim(formatTodos()));
        } else if (sub === "archive") {
          const removed = archiveCompletedTodos();
          if (removed === 0) {
            console.log(chalk.dim("  完了済み ToDo はありませんでした。"));
          } else {
            console.log(chalk.dim(`  完了済み ToDo を ${removed} 件削除しました。`));
          }
          console.log(chalk.dim(formatTodosActive()));
        } else {
          // default: active のみ
          console.log(chalk.dim(formatTodosActive()));
        }
        break;
      }

      case "/goal-seek": {
        // Goal Seek mode 開始。 設計: docs/goal-seek-mode-design.md §3.3
        const goalText = args.join(" ").trim();
        if (!goalText) {
          console.log(chalk.dim("  使用方法: /goal-seek <達成したい goal の自然言語>"));
          console.log(chalk.dim("  例: /goal-seek llama.cpp の --parallel 設定を自動で最適化する機能を追加する"));
          console.log(chalk.dim(""));
          console.log(chalk.dim("  挙動: AI が acceptance criteria を抽出 → user 承認 → mode 開始"));
          console.log(chalk.dim("  終了: 全 criteria 充足で response_complete 自動許可 / 手動は /exit-goal-seek"));
          break;
        }
        if (this.agent.getMode() === "goal-seek") {
          const existing = getGoalSlot();
          console.log(
            chalk.yellow(`  既に Goal Seek mode 中です (goal: ${existing?.statement.slice(0, 60) ?? "?"}...)`),
          );
          console.log(chalk.dim(`  別の goal に切り替えるには先に /exit-goal-seek を実行してください。`));
          break;
        }

        this.agentBusy = true;
        try {
          // Step 1: LLM に acceptance criteria を抽出させる
          // (B-1 で goal-promotion.ts の共通関数に集約 — docs/goal-promotion-design.md §3)
          console.log(chalk.cyan("\n  ── /goal-seek: acceptance criteria を抽出中 ──"));
          const criteria = await extractAcceptanceCriteria(this.agent.getProvider(), this.agent.getModel(), goalText);

          if (criteria.length === 0) {
            console.log(
              chalk.yellow(`  criteria が抽出できませんでした。 goal 文を再確認するか、 LLM 設定を確認してください。`),
            );
            break;
          }

          // Step 2: user に提示して承認を取る
          console.log(chalk.bold("\n  抽出された acceptance criteria:"));
          criteria.forEach((c, i) => {
            console.log(chalk.dim(`    ${i + 1}. ${c}`));
          });
          console.log();

          let proceed = false;
          try {
            proceed = await confirm({
              message: "  この内容で Goal Seek mode を開始しますか?",
              default: true,
            });
          } catch {
            proceed = false;
          }

          if (!proceed) {
            console.log(
              chalk.yellow("  キャンセルしました。 criteria を修正したい場合は /goal-seek を再実行してください。\n"),
            );
            break;
          }

          // Step 3: mode 開始 + 最初の run
          const goal: GoalDefinition = {
            statement: goalText,
            acceptance_criteria: criteria,
            created_at: Date.now(),
            register_at_creation: this.agent.getMetrics().register,
          };
          this.agent.enterGoalSeek(goal);
          console.log(chalk.green(`\n  ✓ Goal Seek mode 開始 (criteria ${criteria.length} 項目)`));
          console.log(chalk.dim(`  acceptance 充足まで response_complete はゲートされます。 中断: /exit-goal-seek\n`));

          // 最初の run を起動 (goal 文をそのまま user message として agent.run へ渡す)
          await this.agent.run(goalText);
        } finally {
          this.agentBusy = false;
        }
        break;
      }

      case "/exit-goal-seek": {
        if (this.agent.getMode() !== "goal-seek") {
          console.log(chalk.dim("  Goal Seek mode ではありません。"));
          break;
        }
        const cur = getGoalSlot();
        this.agent.exitGoalSeek("user");
        console.log(chalk.yellow(`  Goal Seek mode を終了しました (中断: ${cur?.statement.slice(0, 60) ?? "?"}...)`));
        break;
      }

      case "/second": {
        // 2026-05-27: /model second ... に統合 (docs/model-registry.md §4.1)。
        // /second 系は alias として動作するが deprecation を 1 行表示する。
        console.log(
          chalk.dim(
            "  ℹ /second は /model second ... に統合されました (alias として動作中)。 詳細: docs/model-registry.md",
          ),
        );
        await this.handleSecondLLMCommand(args);
        break;
      }

      case "/swap":
      case "/switch": {
        // メインLLM ⇔ セカンドLLM の入れ替え
        if (!this.config.secondLLM) {
          console.log(chalk.red("\n  セカンドLLM が未設定です。先に /second setup で設定してください。\n"));
          break;
        }
        const cur = this.config.mainLLM;
        const sec = this.config.secondLLM.endpoint;
        if (!sec.model || !sec.providerType) {
          console.log(
            chalk.red("\n  セカンドLLM のモデル/プロバイダーが未設定です。先に /second model 等で設定してください。\n"),
          );
          break;
        }
        if (!cur.model || !cur.providerType) {
          console.log(chalk.red("\n  メインLLM のモデル/プロバイダーが未設定です。\n"));
          break;
        }

        console.log(chalk.bold("\n  ── メインLLM ⇔ セカンドLLM 入れ替え ──"));
        console.log(chalk.dim(`  メイン  (現在): ${cur.providerType} / ${cur.model}`));
        console.log(chalk.dim(`  セカンド (現在): ${sec.providerType} / ${sec.model}`));

        const skipConfirm = args[0] === "-y" || args[0] === "--yes";
        let proceed = true;
        if (!skipConfirm) {
          try {
            proceed = await confirm({ message: "  入れ替えますか?", default: true });
          } catch {
            proceed = false;
          }
        }
        if (!proceed) {
          console.log(chalk.yellow("  キャンセルしました。\n"));
          break;
        }

        // SecondLLMEndpoint は LLMEndpoint と同一仕様のため単純な入れ替え。 サンプリング値も含めて全フィールド保持される。
        const newMain: LLMEndpoint = { ...sec };
        const newSecondEndpoint: SecondLLMEndpoint = { ...cur };

        this.config.mainLLM = newMain;
        this.config.secondLLM = {
          ...this.config.secondLLM,
          endpoint: newSecondEndpoint,
        };
        saveConfig(this.config);

        console.log(chalk.green("\n  ✓ 設定を入れ替えました。"));
        console.log(chalk.dim(`  メイン  (新): ${newMain.providerType} / ${newMain.model}`));
        console.log(chalk.dim(`  セカンド (新): ${newSecondEndpoint.providerType} / ${newSecondEndpoint.model}`));

        // 実行時反映: Provider再生成 / SecondLLMManager再初期化
        await this.applyMainLLMEndpoint();
        await this.applySecondLLMEndpoint();
        const isAvail = this.secondLLMManager?.isAvailable() ?? false;
        if (!isAvail && this.config.secondLLM.enabled) {
          console.log(
            chalk.yellow("  ※ セカンドLLM の接続テストに失敗しています。/second status で確認してください。"),
          );
        }
        console.log();
        break;
      }

      case "/models":
      case "/model-registry":
      case "/registry": {
        await this.handleModelsCommand(args);
        break;
      }

      case "/profiles":
      case "/profile": {
        // 2026-05-27: /models へ統合された。 alias として動作するが deprecation を表示。
        console.log(
          chalk.dim(
            "  ℹ /profiles は /models に名称変更されました (alias として動作中)。 詳細: docs/model-registry.md",
          ),
        );
        await this.handleProfilesCommand(args);
        break;
      }

      case "/integrations":
      case "/integration":
      case "/intg": {
        // 2026-05-28: Discord / Slack / Chatlog / Search の設定パネルを 1 つの picker に
        // 集約 (Phase optimize #3)。 旧 4 コマンドは dispatcher 互換維持。
        await this.handleIntegrationsCommand();
        break;
      }

      case "/discord": {
        const subCmd = args[0];
        if (!subCmd || subCmd === "status") {
          const d = this.config.discord;
          const dEnabled = d?.enabled ?? false;
          const dUrl = d?.webhookUrl ? maskWebhookUrl(d.webhookUrl) : "未設定";
          const dListening = this.interactionServer?.running ?? false;
          const dBotName = this.interactionServer?.botUser;
          const dAppId = d?.applicationId ? chalk.dim(d.applicationId) : chalk.yellow("未設定");
          const dToken = d?.botToken ? chalk.green("設定済み") : chalk.yellow("未設定");
          const dAttach = (d?.attachGeneratedImages ?? true) !== false;
          console.log(chalk.bold("\n  === Discord 連携の状態 ==="));
          console.log(chalk.dim(`  通知 (Webhook): ${dEnabled ? chalk.green("オン") : chalk.yellow("オフ")}`));
          console.log(chalk.dim(`  Webhook URL:    ${dUrl}`));
          console.log(chalk.dim(`  生成画像の添付: ${dAttach ? chalk.green("オン") : chalk.yellow("オフ")}`));
          console.log(
            chalk.dim(
              `  Bot 接続:       ${dListening ? chalk.green(`接続中${dBotName ? ` (${dBotName})` : ""}`) : chalk.yellow("停止中")}`,
            ),
          );
          console.log(chalk.dim(`  Application ID: ${dAppId}`));
          console.log(chalk.dim(`  Bot Token:      ${dToken}`));
          console.log();
        } else if (subCmd === "enable") {
          if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
          if (!this.config.discord.webhookUrl) {
            console.log(
              chalk.yellow(
                "  注意: 通知の送り先 (Webhook URL) が未設定です。/integrations の Discord 連携メニューから設定してください。",
              ),
            );
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
            console.log(chalk.dim(`  URL: ${maskWebhookUrl(urlStr)}`));
            console.log(chalk.dim("  「テスト通知を送ってみる」で動作確認できます。"));
          }
        } else if (subCmd === "test") {
          const webhookUrl = this.config.discord?.webhookUrl ?? "";
          if (!webhookUrl) {
            console.log(
              chalk.yellow(
                "  通知の送り先 (Webhook URL) が未設定です。/integrations の Discord 連携メニューから設定してください。",
              ),
            );
          } else if (!isValidDiscordWebhookUrl(webhookUrl)) {
            console.log(
              chalk.red(
                "  ❌ 設定されている URL が無効です。/integrations の Discord 連携メニューから正しい Webhook URL を設定してください。",
              ),
            );
          } else {
            console.log(chalk.dim("  Discord にテストメッセージを送信中..."));
            const result = await sendDiscordNotification(
              webhookUrl,
              "🤖 lllmAgents テスト通知\nDiscord通知が正常に動作しています！",
            );
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
          // Gateway 方式 (docs/discord-gateway-design.md) への移行で署名検証が不要になった
          console.log(
            chalk.dim("  Public Key の設定は不要になりました (受信方式の変更により署名検証を使わなくなったため)。"),
          );
          console.log(chalk.dim("  必要な設定は Application ID と Bot Token の 2 つだけです。"));
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
          // Gateway 方式への移行で受信ポートが不要になった
          console.log(
            chalk.dim("  ポート設定は不要になりました (Bot がこちらから Discord に接続する方式に変わったため)。"),
          );
        } else if (subCmd === "register") {
          // スラッシュコマンドを Discord に登録
          const guildId = args[1]; // 省略時はグローバル登録
          const appId = this.config.discord?.applicationId;
          const botToken = this.config.discord?.botToken;
          if (!appId || !botToken) {
            console.log(chalk.yellow("  Application ID と Bot Token が必要です。"));
            console.log(chalk.dim("  /integrations の Discord 連携メニューから設定してください。"));
          } else {
            const scope = guildId ? `サーバー ${guildId} 限定` : "全サーバー向け";
            const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=2048`;
            console.log(chalk.dim(`  /ask コマンドを登録中 (${scope})...`));
            const result = await registerAskCommand(appId, botToken, guildId);
            if (result.success) {
              console.log(chalk.green(`  ✅ /ask コマンドを登録しました (ID: ${result.commandId})`));
              console.log(chalk.dim("  注意: /ask が使えるのは、この Bot を招待したサーバーだけです。"));
              console.log(chalk.dim("  まだ招待していなければ、下の URL を開いて招待してください:"));
              console.log(chalk.cyan(`    ${inviteUrl}`));
              if (!guildId) {
                console.log(chalk.dim("  全サーバー向けの登録は、反映まで最大 1 時間かかります。"));
                console.log(
                  chalk.dim("  すぐ試したい場合は、もう一度登録を実行してサーバーIDを指定してください (即時反映)。"),
                );
              }
            } else {
              console.log(chalk.red(`  ❌ 登録失敗: ${result.error}`));
              if (result.error?.includes("50001") || result.error?.includes("Missing Access")) {
                console.log(chalk.yellow("  原因: この Bot は指定したサーバーにまだ参加していません。"));
                console.log(chalk.dim("  下の URL を開いて Bot をサーバーに招待してから、もう一度お試しください:"));
                console.log(chalk.cyan(`    ${inviteUrl}`));
              }
            }
          }
        } else if (subCmd === "listen") {
          // Interaction Server の起動/停止
          const action = args[1];
          if (action === "start") {
            if (this.interactionServer?.running) {
              console.log(chalk.yellow("  すでに受信を開始しています。"));
            } else {
              await this.startInteractionServer();
            }
          } else if (action === "stop") {
            if (!this.interactionServer?.running) {
              console.log(chalk.yellow("  受信は開始していません。"));
            } else {
              this.interactionServer.stop();
              console.log(chalk.yellow("  受信を停止しました (Discord との接続を切りました)。"));
            }
          } else if (action === "auto-start") {
            // 次回起動時から自動起動
            const on = args[2] !== "off";
            if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
            this.config.discord.listenEnabled = on;
            saveConfig(this.config);
            console.log(
              on
                ? chalk.green("  ✅ 次回起動時から自動で受信を開始します。")
                : chalk.yellow("  受信の自動開始をオフにしました。"),
            );
          } else {
            console.log(chalk.yellow("  使い方: /discord listen [start|stop|auto-start [off]]"));
          }
        } else if (subCmd === "user-add" || subCmd === "user-remove" || subCmd === "users") {
          // A-2: 利用許可ユーザーの管理 (docs/channel-interaction-bridge-design.md §6)
          if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
          const list = this.config.discord.allowedUserIds ?? [];
          if (subCmd === "users") {
            if (list.length === 0) {
              console.log(chalk.dim("  許可ユーザー: 未設定 (全員が利用可能。確認ボタンは常に依頼者のみ有効)"));
            } else {
              console.log(chalk.bold("  許可ユーザー:"));
              for (const id of list) console.log(chalk.dim(`    - ${id}`));
            }
          } else {
            const id = args[1];
            if (!id) {
              console.log(chalk.yellow(`  使い方: /discord ${subCmd} <DiscordユーザーID>`));
            } else if (subCmd === "user-add") {
              if (!/^\d{15,21}$/.test(id)) {
                // 失敗の典型: ユーザー名 (osia4782 等) を入れてしまう。 ID は数値 snowflake。
                console.log(
                  chalk.yellow(`  ⚠ "${id}" は Discord ユーザー ID の形式 (15〜21桁の数字) ではありません。`),
                );
                console.log(chalk.dim("    ユーザー名ではなく数値の ID を指定してください (一致せず利用できません)。"));
                console.log(chalk.dim("    ID 入力が面倒な場合は、相手に Discord から /ask を一度実行してもらい、"));
                console.log(chalk.dim("    待機リスト (/discord waitlist) から承認する方法が確実です。"));
              }
              if (!list.includes(id)) list.push(id);
              this.config.discord.allowedUserIds = list;
              // 許可したユーザーは待機リストから取り除く。
              if (this.config.discord.pendingUsers) {
                this.config.discord.pendingUsers = this.config.discord.pendingUsers.filter((u) => u.id !== id);
              }
              saveConfig(this.config);
              console.log(chalk.green(`  許可ユーザーに ${id} を追加しました (${list.length} 名)。`));
            } else {
              this.config.discord.allowedUserIds = list.filter((u) => u !== id);
              saveConfig(this.config);
              console.log(chalk.yellow(`  許可ユーザーから ${id} を削除しました。`));
            }
          }
        } else if (subCmd === "waitlist" || subCmd === "approve" || subCmd === "reject") {
          // 待機リスト: 未許可ユーザーのアクセスを自動記録 → ここで承認/却下する
          if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
          const pending = this.config.discord.pendingUsers ?? [];
          if (subCmd === "waitlist") {
            if (pending.length === 0) {
              console.log(chalk.dim("  待機リスト: なし (未許可ユーザーが /ask を試みると自動で記録されます)"));
            } else {
              console.log(chalk.bold("  待機リスト (利用申請):"));
              for (const u of pending) {
                console.log(
                  chalk.dim(
                    `    - ${u.username ?? "(名前不明)"} (ID: ${u.id})  ` +
                      `試行 ${u.attempts} 回 / 最終 ${u.lastSeen.replace("T", " ").slice(0, 16)}`,
                  ),
                );
              }
              console.log(chalk.dim("  承認: /discord approve <ID>  却下: /discord reject <ID>"));
            }
          } else {
            const id = args[1];
            if (!id) {
              console.log(chalk.yellow(`  使い方: /discord ${subCmd} <DiscordユーザーID>`));
            } else if (subCmd === "approve") {
              const allow = this.config.discord.allowedUserIds ?? [];
              if (!allow.includes(id)) allow.push(id);
              this.config.discord.allowedUserIds = allow;
              this.config.discord.pendingUsers = pending.filter((u) => u.id !== id);
              saveConfig(this.config);
              console.log(chalk.green(`  ✅ ${id} を許可しました (許可ユーザー ${allow.length} 名)。`));
            } else {
              this.config.discord.pendingUsers = pending.filter((u) => u.id !== id);
              saveConfig(this.config);
              console.log(chalk.yellow(`  待機リストから ${id} を削除しました。`));
            }
          }
        } else if (subCmd === "images") {
          // 生成画像の Discord 自動添付 ON/OFF (docs/image-generation.md §5.1)
          if (!this.config.discord) this.config.discord = { enabled: false, webhookUrl: "" };
          const action = args[1];
          if (!action) {
            const on = this.config.discord.attachGeneratedImages !== false;
            console.log(
              chalk.dim(`  生成画像の自動添付: ${on ? chalk.green("オン") : chalk.yellow("オフ")} (既定: オン)`),
            );
            console.log(chalk.dim("  切替: /discord images on | off"));
          } else if (action === "on") {
            this.config.discord.attachGeneratedImages = true;
            saveConfig(this.config);
            console.log(chalk.green("  ✅ 生成画像を Discord に自動添付します。"));
          } else if (action === "off") {
            this.config.discord.attachGeneratedImages = false;
            saveConfig(this.config);
            console.log(chalk.yellow("  生成画像の自動添付をオフにしました (通知テキストは従来どおり)。"));
          } else {
            console.log(chalk.yellow("  使い方: /discord images [on|off]"));
          }
        } else {
          console.log(chalk.yellow("  使い方: /discord <サブコマンド>"));
          console.log(chalk.dim("  通知系:    status | enable | disable | url <URL> | test"));
          console.log(chalk.dim("  画像添付:  images [on|off]"));
          console.log(chalk.dim("  受信設定:  app-id <id> | bot-token <トークン>"));
          console.log(chalk.dim("  コマンド:  register [サーバーID]"));
          console.log(chalk.dim("  受信:      listen start | listen stop | listen auto-start [off]"));
          console.log(chalk.dim("  認可:      user-add <ID> | user-remove <ID> | users"));
          console.log(chalk.dim("  待機リスト: waitlist | approve <ID> | reject <ID>"));
        }
        break;
      }

      case "/slack": {
        const subCmd = args[0];
        if (!subCmd || subCmd === "status") {
          const s = this.config.slack;
          const sEnabled = s?.enabled ?? false;
          const sUrl = s?.webhookUrl ? maskWebhookUrl(s.webhookUrl) : "未設定";
          const sBotToken = s?.botToken ? chalk.green("設定済み") : chalk.yellow("未設定");
          const sAppToken = s?.appToken ? chalk.green("設定済み") : chalk.yellow("未設定");
          console.log(chalk.bold("\n  === Slack 連携の状態 ==="));
          console.log(chalk.dim(`  通知 (Webhook): ${sEnabled ? chalk.green("オン") : chalk.yellow("オフ")}`));
          console.log(chalk.dim(`  Webhook URL:    ${sUrl}`));
          console.log(chalk.dim(`  Bot Token:      ${sBotToken}`));
          console.log(chalk.dim(`  App Token:      ${sAppToken}`));
          console.log(chalk.dim(`  --slack モード:  bot-token + app-token 設定後に 'npm run start -- --slack' で起動`));
          console.log();
        } else if (subCmd === "enable") {
          if (!this.config.slack) this.config.slack = { enabled: false, webhookUrl: "" };
          if (!this.config.slack.webhookUrl) {
            console.log(
              chalk.yellow(
                "  注意: 通知の送り先 (Webhook URL) が未設定です。/integrations の Slack 連携メニューから設定してください。",
              ),
            );
          }
          this.config.slack.enabled = true;
          saveConfig(this.config);
          console.log(chalk.green("  Slack 通知を有効化しました。"));
        } else if (subCmd === "disable") {
          if (!this.config.slack) this.config.slack = { enabled: false, webhookUrl: "" };
          this.config.slack.enabled = false;
          saveConfig(this.config);
          console.log(chalk.yellow("  Slack 通知を無効化しました。"));
        } else if (subCmd === "url") {
          const urlStr = args[1];
          if (!urlStr) {
            console.log(chalk.yellow("  使い方: /slack url <webhook-url>"));
            console.log(chalk.dim("  例: /slack url https://hooks.slack.com/services/T.../B.../..."));
          } else if (!isValidSlackWebhookUrl(urlStr)) {
            console.log(chalk.red("  無効なWebhook URLです。"));
            console.log(chalk.yellow("  正しい形式: https://hooks.slack.com/services/T.../B.../..."));
            console.log(chalk.dim("  Slack App設定 → Incoming Webhooks で取得してください。"));
          } else {
            if (!this.config.slack) this.config.slack = { enabled: false, webhookUrl: "" };
            this.config.slack.webhookUrl = urlStr;
            saveConfig(this.config);
            console.log(chalk.green(`  Slack Webhook URL を設定しました。`));
            console.log(chalk.dim(`  URL: ${maskWebhookUrl(urlStr)}`));
            console.log(chalk.dim("  「テスト通知を送ってみる」で動作確認できます。"));
          }
        } else if (subCmd === "test") {
          const webhookUrl = this.config.slack?.webhookUrl ?? "";
          if (!webhookUrl) {
            console.log(
              chalk.yellow(
                "  通知の送り先 (Webhook URL) が未設定です。/integrations の Slack 連携メニューから設定してください。",
              ),
            );
          } else if (!isValidSlackWebhookUrl(webhookUrl)) {
            console.log(
              chalk.red(
                "  設定されている URL が無効です。/integrations の Slack 連携メニューから正しい Webhook URL を設定してください。",
              ),
            );
          } else {
            console.log(chalk.dim("  Slack にテストメッセージを送信中..."));
            const result = await sendSlackNotification(
              webhookUrl,
              "lllmAgents テスト通知\nSlack通知が正常に動作しています！",
            );
            if (result.success) {
              console.log(chalk.green("  テストメッセージを送信しました。Slackを確認してください。"));
            } else {
              console.log(chalk.red(`  送信失敗: ${result.error}`));
            }
          }
        } else if (subCmd === "bot-token") {
          const token = args[1];
          if (!token) {
            console.log(chalk.yellow("  使い方: /slack bot-token <xoxb-...>"));
            console.log(chalk.dim("  Slack App → OAuth & Permissions → Bot User OAuth Token"));
          } else {
            if (!this.config.slack) this.config.slack = { enabled: false, webhookUrl: "" };
            this.config.slack.botToken = token;
            saveConfig(this.config);
            console.log(chalk.green("  Bot Token を設定しました。"));
          }
        } else if (subCmd === "app-token") {
          const token = args[1];
          if (!token) {
            console.log(chalk.yellow("  使い方: /slack app-token <xapp-...>"));
            console.log(chalk.dim("  Slack App → Basic Information → App-Level Tokens"));
          } else {
            if (!this.config.slack) this.config.slack = { enabled: false, webhookUrl: "" };
            this.config.slack.appToken = token;
            saveConfig(this.config);
            console.log(chalk.green("  App-Level Token を設定しました。"));
          }
        } else if (subCmd === "user-add" || subCmd === "user-remove" || subCmd === "users") {
          // A-2: 利用許可ユーザーの管理 (docs/channel-interaction-bridge-design.md §6)
          if (!this.config.slack) this.config.slack = { enabled: false, webhookUrl: "" };
          const list = this.config.slack.allowedUserIds ?? [];
          if (subCmd === "users") {
            if (list.length === 0) {
              console.log(chalk.dim("  許可ユーザー: 未設定 (全員が利用可能。確認ボタンは常に依頼者のみ有効)"));
            } else {
              console.log(chalk.bold("  許可ユーザー:"));
              for (const id of list) console.log(chalk.dim(`    - ${id}`));
            }
          } else {
            const id = args[1];
            if (!id) {
              console.log(chalk.yellow(`  使い方: /slack ${subCmd} <SlackユーザーID (例: U01234567)>`));
            } else if (subCmd === "user-add") {
              if (!list.includes(id)) list.push(id);
              this.config.slack.allowedUserIds = list;
              saveConfig(this.config);
              console.log(chalk.green(`  許可ユーザーに ${id} を追加しました (${list.length} 名)。`));
            } else {
              this.config.slack.allowedUserIds = list.filter((u) => u !== id);
              saveConfig(this.config);
              console.log(chalk.yellow(`  許可ユーザーから ${id} を削除しました。`));
            }
          }
        } else {
          console.log(chalk.yellow("  使い方: /slack <サブコマンド>"));
          console.log(chalk.dim("  通知系:    status | enable | disable | url <URL> | test"));
          console.log(chalk.dim("  Bot設定:   bot-token <xoxb-...> | app-token <xapp-...>"));
          console.log(chalk.dim("  認可:      user-add <ID> | user-remove <ID> | users"));
          console.log(chalk.dim("  起動:      npm run start -- --slack"));
        }
        break;
      }

      case "/search": {
        const subCmd = args[0];
        if (!subCmd || subCmd === "status") {
          const s = this.config.search ?? { provider: "duckduckgo" };
          console.log(chalk.bold("  Web検索設定:"));
          console.log(`    プロバイダー: ${chalk.cyan(s.provider)}`);
          if (s.provider === "searxng") {
            console.log(`    SearXNG URL:  ${chalk.cyan(s.searxngUrl ?? "http://localhost:8888")}`);
          }
        } else if (subCmd === "searxng") {
          const url = args[1] ?? "http://localhost:8888";
          if (!this.config.search) this.config.search = { provider: "searxng", searxngUrl: url };
          else {
            this.config.search.provider = "searxng";
            this.config.search.searxngUrl = url;
          }
          saveConfig(this.config);
          console.log(chalk.green(`  検索プロバイダーを SearXNG に変更しました (${url})`));
          console.log(chalk.dim("  反映には再起動が必要です。"));
        } else if (subCmd === "duckduckgo" || subCmd === "ddg") {
          if (!this.config.search) this.config.search = { provider: "duckduckgo" };
          else this.config.search.provider = "duckduckgo";
          saveConfig(this.config);
          console.log(chalk.green("  検索プロバイダーを DuckDuckGo に変更しました。"));
          console.log(chalk.dim("  反映には再起動が必要です。"));
        } else if (subCmd === "test") {
          const s = this.config.search ?? { provider: "duckduckgo" };
          console.log(chalk.dim(`  ${s.provider} でテスト検索中...`));
          try {
            const { createWebSearchTool } = await import("../tools/definitions/web-search.js");
            const tool = createWebSearchTool(this.config.search);
            const result = await tool.execute({ query: "test", max_results: 3 });
            if (result.success) {
              console.log(chalk.green("  テスト成功:"));
              console.log(
                result.output
                  .split("\n")
                  .map((l: string) => `    ${l}`)
                  .join("\n"),
              );
            } else {
              console.log(chalk.red(`  テスト失敗: ${result.error}`));
            }
          } catch (e) {
            console.log(chalk.red(`  エラー: ${e}`));
          }
        } else {
          console.log(chalk.yellow("  使い方: /search <サブコマンド>"));
          console.log(chalk.dim("  status               現在の設定を表示"));
          console.log(chalk.dim("  searxng [url]         SearXNG に切替 (デフォルト: http://localhost:8888)"));
          console.log(chalk.dim("  duckduckgo | ddg      DuckDuckGo に切替"));
          console.log(chalk.dim("  test                  テスト検索を実行"));
        }
        break;
      }

      case "/permission": {
        // 2026-05-28: 引数なしは対話 picker (Phase optimize #1)。 引数付きは互換のため legacy 経路。
        if (args.length === 0) {
          await this.handlePermissionInteractive();
          break;
        }
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
                const icon =
                  action === "deny" ? chalk.red("✗") : action === "allow" ? chalk.green("✓") : chalk.yellow("?");
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
          this.config.security.requireApprovalTools = this.config.security.requireApprovalTools.filter(
            (t) => t !== toolName,
          );
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
            this.config.security.discordAutoApproveTools = this.config.security.discordAutoApproveTools.filter(
              (t) => t !== toolName,
            );
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

      // /parallel は src/cli/commands/parallel.ts へ移設 (PR-10)

      case "/knowledge": {
        const subCmd = args[0];
        if (!subCmd || subCmd === "status") {
          const obs = this.config.obsidian;
          if (!obs?.vaultPath) {
            console.log(chalk.yellow("  Obsidian Vault が未設定です。"));
            console.log(chalk.dim("  設定: /knowledge vault <パス>"));
          } else {
            console.log(chalk.bold("  Obsidian ナレッジベース:"));
            console.log(`    Vault:    ${chalk.cyan(obs.vaultPath)}`);
            const knDir = obs.knowledgeDir ?? "Knowledge";
            const knPath = path.join(obs.vaultPath, knDir);
            console.log(`    保存先:   ${chalk.cyan(knPath)}`);
            console.log(`    デフォルトタグ: ${chalk.cyan((obs.defaultTags ?? ["lllmagents"]).join(", "))}`);
            try {
              const { getKnowledgeBasePath } = await import("../tools/definitions/knowledge-save.js");
              const basePath = getKnowledgeBasePath();
              if (basePath) {
                const countMd = (dir: string): number => {
                  if (!fs.existsSync(dir)) return 0;
                  let count = 0;
                  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (e.isDirectory()) count += countMd(path.join(dir, e.name));
                    else if (e.name.endsWith(".md")) count++;
                  }
                  return count;
                };
                console.log(`    ノート数: ${chalk.yellow(String(countMd(basePath)))}`);
              }
            } catch {
              /* ignore */
            }
          }
        } else if (subCmd === "vault") {
          const vaultPath = args.slice(1).join(" ").trim();
          if (!vaultPath) {
            console.log(chalk.yellow("  使い方: /knowledge vault <Obsidian Vaultのパス>"));
            break;
          }
          const resolved = path.resolve(vaultPath);
          if (!fs.existsSync(resolved)) {
            console.log(chalk.red(`  パスが存在しません: ${resolved}`));
            break;
          }
          if (!this.config.obsidian) {
            this.config.obsidian = { vaultPath: resolved };
          } else {
            this.config.obsidian.vaultPath = resolved;
          }
          saveConfig(this.config);
          const { setObsidianConfig, knowledgeSaveTool } = await import("../tools/definitions/knowledge-save.js");
          const { knowledgeSearchTool } = await import("../tools/definitions/knowledge-search.js");
          setObsidianConfig(this.config.obsidian);
          const registry = this.agent.getToolRegistry();
          if (!registry.get("knowledge_save")) {
            registry.register(knowledgeSaveTool);
            registry.register(knowledgeSearchTool);
          }
          console.log(chalk.green(`  Vault パスを設定しました: ${resolved}`));
          console.log(chalk.dim("  ナレッジツール (knowledge_save, knowledge_search) が利用可能になりました。"));
        } else if (subCmd === "tags") {
          const obs = this.config.obsidian;
          if (!obs?.vaultPath) {
            console.log(chalk.yellow("  Vault が未設定です。/knowledge vault <パス> で設定してください。"));
            break;
          }
          try {
            const { getKnowledgeBasePath } = await import("../tools/definitions/knowledge-save.js");
            const basePath = getKnowledgeBasePath();
            if (!basePath) {
              console.log(chalk.yellow("  ナレッジディレクトリがありません。"));
              break;
            }
            const tagCounts = new Map<string, number>();
            const walkAndCountTags = (dir: string) => {
              if (!fs.existsSync(dir)) return;
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, e.name);
                if (e.isDirectory()) {
                  walkAndCountTags(fp);
                  continue;
                }
                if (!e.name.endsWith(".md")) continue;
                const head = fs.readFileSync(fp, "utf-8").slice(0, 1500);
                const tagMatch = head.match(/tags:\n((?:\s+-\s+.+\n?)+)/);
                if (tagMatch) {
                  for (const line of tagMatch[1].split("\n")) {
                    const m = line.match(/^\s+-\s+(.+)/);
                    if (m) tagCounts.set(m[1].trim(), (tagCounts.get(m[1].trim()) ?? 0) + 1);
                  }
                }
              }
            };
            walkAndCountTags(basePath);
            if (tagCounts.size === 0) {
              console.log(chalk.dim("  タグはまだありません。"));
            } else {
              const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
              console.log(chalk.bold("  タグ一覧:"));
              for (const [tag, count] of sorted) {
                console.log(`    ${chalk.cyan(tag)} (${count})`);
              }
            }
          } catch (e) {
            console.log(chalk.red(`  エラー: ${e}`));
          }
        } else if (subCmd === "recent") {
          const obs = this.config.obsidian;
          if (!obs?.vaultPath) {
            console.log(chalk.yellow("  Vault が未設定です。"));
            break;
          }
          const limit = parseInt(args[1] ?? "10", 10);
          try {
            const { getKnowledgeBasePath } = await import("../tools/definitions/knowledge-save.js");
            const basePath = getKnowledgeBasePath();
            if (!basePath) {
              console.log(chalk.dim("  ナレッジノートはまだありません。"));
              break;
            }
            const files: { path: string; mtime: number }[] = [];
            const walk = (dir: string) => {
              if (!fs.existsSync(dir)) return;
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, e.name);
                if (e.isDirectory()) {
                  walk(fp);
                  continue;
                }
                if (e.name.endsWith(".md")) files.push({ path: fp, mtime: fs.statSync(fp).mtimeMs });
              }
            };
            walk(basePath);
            files.sort((a, b) => b.mtime - a.mtime);
            const recent = files.slice(0, limit);
            if (recent.length === 0) {
              console.log(chalk.dim("  ナレッジノートはまだありません。"));
            } else {
              console.log(chalk.bold(`  最近のナレッジ (${recent.length}件):`));
              for (const f of recent) {
                const rel = path.relative(obs.vaultPath, f.path).replace(/\\/g, "/");
                const head = fs.readFileSync(f.path, "utf-8").slice(0, 500);
                const titleMatch = head.match(/title:\s*"?([^"\n]+)"?/);
                const title = titleMatch ? titleMatch[1] : path.basename(f.path, ".md");
                console.log(`    ${chalk.cyan(title)} — ${chalk.dim(rel)}`);
              }
            }
          } catch (e) {
            console.log(chalk.red(`  エラー: ${e}`));
          }
        } else if (subCmd === "search") {
          const query = args.slice(1).join(" ").trim();
          if (!query) {
            console.log(chalk.yellow("  使い方: /knowledge search <キーワード>"));
            break;
          }
          try {
            const { knowledgeSearchTool } = await import("../tools/definitions/knowledge-search.js");
            const result = await knowledgeSearchTool.execute({ query, limit: 10 });
            if (result.success) {
              console.log("\n" + result.output);
            } else {
              console.log(chalk.red(`  ${result.error}`));
            }
          } catch (e) {
            console.log(chalk.red(`  エラー: ${e}`));
          }
        } else if (subCmd === "open") {
          const obs = this.config.obsidian;
          if (!obs?.vaultPath) {
            console.log(chalk.yellow("  Vault が未設定です。"));
            break;
          }
          const knPath = path.join(obs.vaultPath, obs.knowledgeDir ?? "Knowledge");
          try {
            const { exec } = await import("node:child_process");
            if (process.platform === "win32") exec(`explorer "${knPath}"`);
            else if (process.platform === "darwin") exec(`open "${knPath}"`);
            else exec(`xdg-open "${knPath}"`);
            console.log(chalk.green(`  フォルダを開きました: ${knPath}`));
          } catch (e) {
            console.log(chalk.red(`  エラー: ${e}`));
          }
        } else {
          console.log(chalk.bold("  /knowledge サブコマンド:"));
          console.log(chalk.dim("    (引数なし)          設定状態を表示"));
          console.log(chalk.dim("    vault <path>        Obsidian Vault パスを設定"));
          console.log(chalk.dim("    tags                タグ一覧と使用数"));
          console.log(chalk.dim("    recent [N]          最近のナレッジノート (デフォルト10件)"));
          console.log(chalk.dim("    search <query>      キーワード検索"));
          console.log(chalk.dim("    open                フォルダをエクスプローラーで開く"));
        }
        break;
      }

      // /autorun は src/cli/commands/autorun.ts へ移設 (PR-10)

      case "/compress-input": {
        // opt-in 入力圧縮モード。 docs/input-compression-design.md
        const subArg = args[0];
        const turnOn = async () => {
          this.config.inputCompression = true;
          saveConfig(this.config);
          console.log(chalk.green("  入力圧縮モード ON (設定に保存)"));
          console.log(chalk.dim("  project指示/メモが tier別閾値を超えたら、意図保持で圧縮します (縮まなければ原文)"));
          console.log(chalk.dim("  圧縮中..."));
          await this.agent.applyInputCompression(true);
          const st = this.agent.getCompressionState();
          if (st.length === 0) {
            console.log(chalk.dim("  閾値超過なし: 圧縮対象はありませんでした (全量のまま)"));
          } else {
            for (const s of st) {
              if (s.applied) {
                console.log(chalk.dim(`  ✓ ${s.label}: ${s.beforeTokens} → ${s.afterTokens} tokens (原文は保持)`));
              } else {
                console.log(chalk.dim(`  - ${s.label}: 圧縮見送り (${s.note ?? "原文使用"})`));
              }
            }
          }
        };
        const turnOff = async () => {
          this.config.inputCompression = false;
          saveConfig(this.config);
          await this.agent.applyInputCompression(false);
          console.log(chalk.yellow("  入力圧縮モード OFF (設定に保存・全量に復帰)"));
        };
        if (subArg === "on") {
          await turnOn();
        } else if (subArg === "off") {
          await turnOff();
        } else {
          if (this.agent.getInputCompressionEnabled()) await turnOff();
          else await turnOn();
        }
        break;
      }

      case "/chatlog": {
        const subArg = args[0];
        if (!subArg || subArg === "status") {
          const cl = this.config.chatLog;
          if (!cl?.vaultPath) {
            console.log(chalk.yellow("  チャットログが未設定です。"));
            console.log(chalk.dim("  設定: /chatlog vault <Obsidian Vaultのパス>"));
          } else {
            console.log(chalk.bold("  チャットログ:"));
            console.log(`    状態:   ${cl.enabled ? chalk.green("ON") : chalk.yellow("OFF")}`);
            console.log(`    Vault:  ${chalk.cyan(cl.vaultPath)}`);
            const logDir = path.join(cl.vaultPath, "ChatLogs");
            if (fs.existsSync(logDir)) {
              const countMd = (dir: string): number => {
                if (!fs.existsSync(dir)) return 0;
                let count = 0;
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                  if (e.isDirectory()) count += countMd(path.join(dir, e.name));
                  else if (e.name.endsWith(".md")) count++;
                }
                return count;
              };
              console.log(`    ログ数: ${chalk.yellow(String(countMd(logDir)))}`);
            }
            const chatLogger = this.agent.getChatLogger();
            if (chatLogger) {
              console.log(
                `    現在:   ${chalk.dim(chatLogger.getCurrentFilePath())} (Part ${chatLogger.getPartNumber()})`,
              );
            }
          }
        } else if (subArg === "vault") {
          const vaultPath = args.slice(1).join(" ").trim();
          if (!vaultPath) {
            console.log(chalk.yellow("  使い方: /chatlog vault <Obsidian Vaultのパス>"));
            break;
          }
          const resolved = path.resolve(vaultPath);
          if (!fs.existsSync(resolved)) {
            console.log(chalk.red(`  パスが存在しません: ${resolved}`));
            break;
          }
          if (!this.config.chatLog) {
            this.config.chatLog = { enabled: true, vaultPath: resolved };
          } else {
            this.config.chatLog.vaultPath = resolved;
          }
          saveConfig(this.config);
          // ChatLogger を起動/再作成
          const { ChatLogger } = await import("../agent/chat-logger.js");
          const cl2 = new ChatLogger(this.config.chatLog);
          this.agent.setChatLogger(cl2);
          console.log(chalk.green(`  チャットログ Vault を設定しました: ${resolved}`));
          console.log(chalk.dim(`  ログは ${resolved}/ChatLogs/ に保存されます。`));
        } else if (subArg === "enable" || subArg === "on") {
          if (!this.config.chatLog?.vaultPath) {
            console.log(chalk.yellow("  Vault が未設定です。/chatlog vault <パス> で設定してください。"));
            break;
          }
          this.config.chatLog.enabled = true;
          saveConfig(this.config);
          // ChatLogger がなければ作成
          if (!this.agent.getChatLogger()) {
            const { ChatLogger } = await import("../agent/chat-logger.js");
            const cl2 = new ChatLogger(this.config.chatLog);
            this.agent.setChatLogger(cl2);
          } else {
            this.agent.getChatLogger()!.setEnabled(true);
          }
          console.log(chalk.green("  チャットログ ON (設定に保存)"));
        } else if (subArg === "disable" || subArg === "off") {
          if (this.config.chatLog) {
            this.config.chatLog.enabled = false;
            saveConfig(this.config);
          }
          const chatLogger = this.agent.getChatLogger();
          if (chatLogger) chatLogger.setEnabled(false);
          console.log(chalk.yellow("  チャットログ OFF (設定に保存)"));
        } else {
          console.log(chalk.dim("  使い方: /chatlog [status|vault <path>|enable|disable]"));
        }
        break;
      }

      case "/sessions": {
        // 2026-05-28: /sessions は /resume list の alias に集約 (Phase optimize #2)。
        console.log(chalk.dim("  ℹ /sessions は /resume list に統合されました (alias として動作中)。"));
        await this.handleResumeCommand(["list", ...args]);
        break;
      }

      case "/continue": {
        // 2026-05-28: /continue は /resume latest の alias に集約 (Phase optimize #2)。
        console.log(chalk.dim("  ℹ /continue は /resume latest に統合されました (alias として動作中)。"));
        await this.handleResumeCommand(["latest"]);
        break;
      }

      case "/resume": {
        await this.handleResumeCommand(args);
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

      // /loglevel は src/cli/commands/loglevel.ts へ移設 (PR-10)

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
        const { execFileSync } = await import("node:child_process");
        try {
          // Security: Use execFileSync instead of execSync to prevent command injection
          const diff = execFileSync("git", ["diff", "--stat"], {
            encoding: "utf-8",
            cwd: process.cwd(),
          });
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
          await this.processInput(
            "このタスクの実装計画を立てたい。enter_plan_modeを使ってプランモードに入ってください。",
          );
        }
        break;

      // 旧 /skills 一覧表示 case はここにあったが、上部の case "/skills" (status/on/off/toggle 版) と
      // 重複し到達不能な dead code だったため削除 (cleanup 2026-06-20)。スキル一覧は /skills status で表示。

      case "/status": {
        // 2026-05-28: /metrics / /cost / /capability を /status に集約 (Phase optimize #4)。
        // 旧 3 コマンドは alias を作らずそのまま削除。
        const messages = this.agent.getHistory().getMessages();
        const tokens = estimateMessageTokens(messages);
        const ctxWindow = this.config.mainLLM.contextWindow ?? 4096;
        const pct = Math.round((tokens / ctxWindow) * 100);
        const planState = this.planManager?.getState() ?? "idle";
        const todoSummary = formatTodos();
        const m = this.agent.getMetrics();
        const cap = this.agent.getCapability();
        const tok = globalTokenTracker.getSessionTotal();
        const flag = (b: boolean): string => (b ? chalk.yellow("●") : chalk.dim("○"));
        const ctxK = cap.contextWindow >= 1000 ? `${Math.round(cap.contextWindow / 1000)}K` : `${cap.contextWindow}`;

        console.log(chalk.bold("\n  === Session Status ==="));

        // ─── Room ───
        if (this.roomManager) {
          const cur = this.roomManager.current();
          console.log(chalk.dim("\n  ── Room ──"));
          console.log(chalk.dim(`  現在: ${cur ? chalk.cyan(`Room ${cur}`) : "(未確定)"}  (詳細・移動は /room)`));
        }

        // ─── Slots ───
        console.log(chalk.dim("\n  ── Slots ──"));
        // Main は「設定値」 と「実行中」 を分けて出す (docs/model-apply-immediacy.md §3.3)
        this.printMainLLMBinding("Main", "  ");
        if (this.config.secondLLM) {
          const sec = this.config.secondLLM.endpoint;
          const secLoc = sec.baseUrl ?? sec.endpoint ?? "(クラウド)";
          const secState = this.config.secondLLM.enabled
            ? this.secondLLMManager?.isAvailable()
              ? chalk.green("有効")
              : chalk.yellow("有効 (接続失敗)")
            : chalk.red("無効");
          console.log(chalk.dim(`  Second:  ${sec.providerType}:${sec.model} @ ${secLoc}  [${secState}]`));
        } else {
          console.log(chalk.dim(`  Second:  ${chalk.yellow("未設定")}`));
        }
        if (this.config.visionLLM) {
          const v = this.config.visionLLM;
          const vLoc = v.baseUrl ?? v.endpoint ?? "(クラウド)";
          console.log(chalk.dim(`  Vision:  ${v.providerType}:${v.model} @ ${vLoc}`));
        } else {
          console.log(chalk.dim(`  Vision:  ${chalk.yellow("未設定")} (main にフォールバック)`));
        }

        // ─── Context ───
        console.log(chalk.dim("\n  ── Context ──"));
        console.log(chalk.dim(`  Messages:  ${messages.length}`));
        console.log(chalk.dim(`  Tokens:    ${progressBar(pct)}  ~${tokens.toLocaleString()} / ${ctxK}`));
        console.log(chalk.dim(`  Plan mode: ${planState}`));

        // ─── Capability (main) ───
        console.log(chalk.dim("\n  ── Capability (main) ──"));
        console.log(
          chalk.dim(
            `  tier=${cap.tier}  promptStyle=${cap.promptStyle}  toolCalling=${cap.supportsToolCalling}  parallel=${cap.supportsParallelTools}`,
          ),
        );
        console.log(
          chalk.dim(
            `  maxIterations=${cap.maxIterations}  compress@${Math.round(cap.compressionThreshold * 100)}%  truncate>${Math.round(cap.toolResultTruncateBytes / 1024)}KB  keepRecent=${cap.keepRecentMessages}`,
          ),
        );
        console.log(chalk.dim(`  判定根拠: ${cap.reason}`));

        // ─── Metrics ───
        console.log(chalk.dim("\n  ── Metrics (this session) ──"));
        console.log(
          chalk.dim(
            `  iteration=${m.iteration} / softCap=${m.softCap} / hardCap=${m.hardCap}  register=${m.register}  mode=${m.mode === "goal-seek" ? chalk.cyan(m.mode) : m.mode}`,
          ),
        );
        console.log(
          chalk.dim(
            `  warnings:  softCap=${flag(m.softCapWarned)}  bash=${flag(m.bashWarned)} (${Math.round(m.bashCumulativeMs / 1000)}s)  plan/todo=${flag(m.planTodoWarned)}  stuck-loop=${m.recentFailures}/10`,
          ),
        );

        // ─── Cost ───
        console.log(chalk.dim("\n  ── Cost ──"));
        console.log(
          chalk.dim(
            `  Requests: ${tok.recordCount}  /  tokens in=${tok.totalInputTokens.toLocaleString()}  out=${tok.totalOutputTokens.toLocaleString()}  /  estimated: ${fmtMoney(tok.totalCostUsd, this.config.jpyPerUsd)}`,
          ),
        );

        // ─── Tasks ───
        if (todoSummary.includes("pending") || todoSummary.includes("in_progress")) {
          console.log(chalk.dim("\n  ── Tasks ──"));
          console.log(chalk.dim(todoSummary));
        }

        console.log(chalk.dim("\n  詳細レポート: npm run analyze:loop  /  Goal-seek: /goal-seek"));
        console.log(chalk.dim("  コスト詳細 (モデル/provider/期間別): /cost"));
        console.log();
        break;
      }

      // /cost (alias /token): クラウド/ローカル LLM 使用量の可視化。
      // 設計: docs/cost-token-command-design.md
      case "/cost":
      case "/token": {
        const lower = args.map((a) => a.toLowerCase());
        const a0 = lower[0] ?? "";
        const subs = ["models", "model", "providers", "provider", "reset", "export", "rate"];
        const sub = subs.includes(a0) ? a0 : "";
        // 期間トークンを引数のどこからでも拾う (session/window/all/today/yesterday/month/lastmonth/YYYY-MM-DD/YYYY-MM)。
        // 無指定なら window (計測窓)。
        let period: PeriodSpec = { type: "window" };
        for (const tok of lower) {
          const p = resolvePeriod(tok);
          if (p) {
            period = p;
            break;
          }
        }
        const sessionRecords = globalTokenTracker.getRecords();

        if (sub === "rate") {
          // 為替レート (1ドルあたりの円) の設定/表示/リセット。
          // 設定時は /cost 表示やセッション終了サマリのコストが円のみ表示に切り替わる。
          const arg = lower[1] ?? "";
          if (arg === "") {
            // 引数なし: 現在のレートを表示
            if (this.config.jpyPerUsd && this.config.jpyPerUsd > 0) {
              console.log(chalk.green(`\n  現在の為替レート: 1ドル = ${this.config.jpyPerUsd}円 (コストは円表示)`));
              console.log(chalk.dim("  ドル表示に戻す: /cost rate off    変更: /cost rate <円>\n"));
            } else {
              console.log(chalk.dim("\n  為替レート未設定 (コストはドル表示中)。"));
              console.log(chalk.dim("  円表示にする: /cost rate <円>  例) /cost rate 150\n"));
            }
            break;
          }
          if (arg === "off" || arg === "reset" || arg === "none" || arg === "0") {
            // リセット: ドル表示に戻す
            delete this.config.jpyPerUsd;
            setDisplayJpyRate(undefined);
            saveConfig(this.config);
            console.log(chalk.green("\n  為替レートをリセットしました。 コストはドル表示に戻ります。\n"));
            break;
          }
          const rate = Number(arg);
          if (!Number.isFinite(rate) || rate <= 0) {
            console.log(chalk.red(`\n  無効な値: ${args[1] ?? ""}`));
            console.log(chalk.dim("  1ドルあたりの円を正の数で指定してください。 例) /cost rate 150\n"));
            break;
          }
          this.config.jpyPerUsd = rate;
          setDisplayJpyRate(rate);
          saveConfig(this.config);
          console.log(chalk.green(`\n  為替レートを 1ドル = ${rate}円 に設定しました。 コストを円表示します。`));
          console.log(chalk.dim("  ドル表示に戻す: /cost rate off\n"));
          break;
        }

        if (sub === "reset") {
          const ts = resetWindow();
          globalTokenTracker.clearSession();
          console.log(chalk.green(`\n  計測窓をリセットしました (${new Date(ts).toLocaleString()})。`));
          console.log(
            chalk.dim(
              "  履歴 jsonl (~/.localllm/usage/) は保持されています。 過去は /cost all や /cost yesterday, /cost 2026-05 等で参照可。\n",
            ),
          );
          break;
        }

        if (sub === "export") {
          const format: "jsonl" | "csv" = lower.includes("csv") ? "csv" : "jsonl";
          try {
            const outPath = exportUsage(period, format, sessionRecords);
            console.log(chalk.green(`\n  使用量を出力しました (${format}):`));
            console.log(chalk.dim(`  ${outPath}\n`));
          } catch (e) {
            console.log(chalk.red(`\n  出力に失敗しました: ${String(e)}\n`));
          }
          break;
        }

        const jpyPerUsd = this.config.jpyPerUsd;
        let lines: string[];
        if (sub === "models" || sub === "model") {
          lines = formatModels(period, sessionRecords, jpyPerUsd);
        } else if (sub === "providers" || sub === "provider") {
          lines = formatProviders(period, sessionRecords, jpyPerUsd);
        } else {
          lines = formatSummary(period, sessionRecords, jpyPerUsd);
        }
        for (const l of lines) console.log(l);
        console.log();
        break;
      }

      // /image: 画像生成機能 (Azure GPT Images / SD WebUI / ComfyUI)。
      // 設計: docs/image-generation.md §7
      case "/image": {
        await this.handleImageCommand(args);
        break;
      }

      case "/loop": {
        const subCmd = args[0]?.toLowerCase();

        // /loop status (新): アクティブループ一覧 + 各ループに対する Stop checkbox の picker。
        // /loop list は status の alias として残す (引数なし表示のみ)。
        if (subCmd === "status" || subCmd === "list") {
          const entries = this.loopManager.list();
          if (entries.length === 0) {
            console.log(chalk.dim("  アクティブなループはありません。"));
            break;
          }
          console.log(chalk.bold(`\n  アクティブなループ (${entries.length} 件):`));
          for (const e of entries) {
            const lastRun = e.lastRunAt ? e.lastRunAt.toLocaleTimeString() : "未実行";
            console.log(
              chalk.cyan(`    [${e.id}]`) +
                chalk.dim(` 間隔: ${e.intervalStr}`) +
                chalk.dim(` | 実行数: ${e.runCount}`) +
                chalk.dim(` | 最終実行: ${lastRun}`) +
                `\n        ${chalk.white(e.prompt)}`,
            );
          }
          console.log();
          // /loop list は一覧表示のみで終了 (旧挙動)。
          // /loop status は続けて停止 picker を出す。
          if (subCmd === "list") break;
          try {
            const toStop = await checkbox<string>({
              message: "停止するループを選択 (スペースで選択、 Enter で確定、 Esc で何もしない):",
              choices: entries.map((e) => ({
                name: `[${e.id}] ${e.intervalStr}  ${e.prompt.slice(0, 50)}${e.prompt.length > 50 ? "..." : ""}`,
                value: e.id,
              })),
              pageSize: Math.min(15, entries.length),
            });
            if (toStop.length === 0) {
              console.log(chalk.dim("  停止対象が選択されませんでした。"));
              break;
            }
            let stopped = 0;
            for (const id of toStop) if (this.loopManager.stop(id)) stopped++;
            console.log(chalk.green(`  ${stopped} 件のループを停止しました。`));
          } catch {
            console.log(chalk.dim("  キャンセルしました。"));
          }
          break;
        }

        // /loop stop [id|all] (旧形式): dispatcher 互換維持
        if (subCmd === "stop") {
          const target = args[1];
          if (!target || target === "all") {
            const count = this.loopManager.stopAll();
            console.log(
              count > 0
                ? chalk.dim(`  全ループを停止しました (${count} 件)。`)
                : chalk.dim("  停止するループがありません。"),
            );
          } else {
            const ok = this.loopManager.stop(target);
            console.log(
              ok
                ? chalk.dim(`  ループ [${target}] を停止しました。`)
                : chalk.yellow(`  ループ [${target}] が見つかりません。`),
            );
          }
          break;
        }

        // /loop [interval] <prompt>
        const argsStr = args.join(" ");
        if (!argsStr) {
          console.log(chalk.yellow("  使い方: /loop [間隔] <プロンプト>"));
          console.log(chalk.dim("  例: /loop 5m /pr-review"));
          console.log(chalk.dim("  例: /loop 30m デプロイ状況を確認"));
          console.log(chalk.dim("  間隔: 10s, 5m, 2h, 1d (省略時: 10m)"));
          console.log(chalk.dim("  /loop status  - 一覧 + 停止 picker"));
          break;
        }

        const { intervalMs, intervalStr, prompt: loopPrompt } = parseLoopArgs(argsStr);

        if (!loopPrompt) {
          console.log(chalk.yellow("  プロンプトを指定してください。"));
          break;
        }

        const loopId = this.loopManager.start(loopPrompt, intervalMs, intervalStr, async (p: string) => {
          if (this.agentBusy) {
            console.log(
              chalk.dim(`\n  [Loop ${loopId}] エージェント実行中のためスキップ (${new Date().toLocaleTimeString()})`),
            );
            return;
          }
          console.log(
            chalk.bold(`\n  [Loop ${loopId}] 実行開始 (${new Date().toLocaleTimeString()}): `) + chalk.white(p),
          );
          if (p.startsWith("/")) {
            await this.handleCommand(p);
          } else {
            await this.processInput(p);
          }
        });

        console.log(
          chalk.green(`  ✅ ループ [${loopId}] を開始しました。`) +
            chalk.dim(` 間隔: ${intervalStr} | プロンプト: "${loopPrompt}"`),
        );
        break;
      }

      default:
        console.log(chalk.yellow(`  Unknown command: ${cmd}`));
        console.log(chalk.dim("  /help でコマンド一覧を表示"));
    }
  }
}

/** ISO8601 → 「3分前」 「2時間前」 「5日前」 のような相対表示。 1 年以上前は日付そのもの */
function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "たった今";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}日前`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}ヶ月前`;
  return new Date(t).toISOString().slice(0, 10);
}

/** /models 一覧でサンプリングパラメータを 1 行ヒントとして整形 (空なら空文字)。 */
function formatSamplingHint(ep: LLMEndpoint): string {
  const parts: string[] = [];
  if (ep.temperature !== undefined) parts.push(`temp=${ep.temperature}`);
  if (ep.top_p !== undefined) parts.push(`top_p=${ep.top_p}`);
  if (ep.top_k !== undefined) parts.push(`top_k=${ep.top_k}`);
  if (ep.repetition_penalty !== undefined) parts.push(`rep_p=${ep.repetition_penalty}`);
  return parts.join(" ");
}

/** プロファイルが endpoint と「同じ接続」 を指しているか判定 */
function profileMatchesEndpoint(profile: LLMProfile, ep: LLMEndpoint): boolean {
  const a = profile.endpoint;
  return (
    a.providerType === ep.providerType &&
    (a.model ?? "") === (ep.model ?? "") &&
    (a.baseUrl ?? "") === (ep.baseUrl ?? "") &&
    (a.endpoint ?? "") === (ep.endpoint ?? "") &&
    (a.deploymentName ?? "") === (ep.deploymentName ?? "")
  );
}

function progressBar(pct: number): string {
  const width = 30;
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const color = pct > 80 ? chalk.red : pct > 60 ? chalk.yellow : chalk.green;
  const overflow = pct > 100 ? chalk.red(" ⚠ over") : "";
  return `[${color("█".repeat(filled))}${chalk.dim("░".repeat(empty))}] ${pct}%${overflow}`;
}
