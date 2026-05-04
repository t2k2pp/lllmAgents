import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { AgentLoop } from "../agent/agent-loop.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import { bashTool } from "../tools/definitions/bash.js";
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
import { parseTokenCount } from "../config/types.js";
import type { Config, LLMEndpoint, SecondLLMEndpoint, SecondLLMProviderType } from "../config/types.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { PlanManager } from "../agent/plan-mode.js";
import { sendDiscordNotification, isValidDiscordWebhookUrl } from "../utils/discord.js";
import { sendSlackNotification, isValidSlackWebhookUrl } from "../utils/slack.js";
import { DiscordInteractionServer } from "../discord/interaction-server.js";
import { registerAskCommand } from "../discord/slash-commands.js";
import { select, input, password, confirm } from "@inquirer/prompts";
import { CredentialVault } from "../security/credential-vault.js";
import { AzureFoundryProvider } from "../providers/azure-foundry.js";
import { AzureAnthropicProvider } from "../providers/azure-anthropic.js";
import { AzureGPTProvider } from "../providers/azure-gpt.js";
import { AzureOpenAIProvider } from "../providers/azure-openai.js";
import { AzureClaudeProvider } from "../providers/azure-claude.js";
import { saveConfig } from "../config/config-manager.js";
import { runLocalLLMSetup, connectAndListModels } from "../config/setup-wizard.js";
import { nonTTYReader } from "../utils/non-tty-reader.js";
import { LoopManager, parseLoopArgs } from "../loop/loop-manager.js";
import { secondLLMConsultTool, secondLLMAgentTool, setSecondLLMManager } from "../tools/definitions/second-llm.js";
import { buildLLMProfiles } from "../agent/llm-profiles.js";
import { createProvider } from "../providers/provider-factory.js";
import { getOpsLogger, setOpsLogLevel, parseOpsLogLevel } from "../utils/ops-logger.js";
import { getSubAgentManager } from "../tools/definitions/task.js";
import { DEFAULT_PORTS } from "../config/types.js";
import type { ProviderType } from "../config/types.js";

export class REPL {
  private input: InteractiveInput;
  private multilineBuffer: string[] = [];
  private isMultiline = false;
  private lineNumber = 0;
  private interactionServer: DiscordInteractionServer | null = null;
  private loopManager = new LoopManager();
  private agentBusy = false;

  constructor(
    private agent: AgentLoop,
    private config: Config,
    private skillRegistry?: SkillRegistry,
    private planManager?: PlanManager,
    private secondLLMManager?: SecondLLMManager,
    private passphrase?: string,
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
    // Ctrl+C 中断ハンドラー: エージェント処理中は abort()、そうでなければ案内
    // Ctrl+C ハンドラー:
    //   処理中1回目 → ソフト中断 (abort) + "もう一度で終了" 案内
    //   処理中2回目 → プロセス終了（強制脱出手段を保持）
    //   待機中      → プロセス終了（通常動作）
    let ctrlCCount = 0;
    let ctrlCResetTimer: ReturnType<typeof setTimeout> | null = null;
    const sigintHandler = () => {
      if (this.agentBusy) {
        ctrlCCount++;
        if (ctrlCResetTimer) clearTimeout(ctrlCResetTimer);
        if (ctrlCCount === 1) {
          this.agent.abort();
          bashTool.killRunningProcess();
          console.log(chalk.yellow("\n  (Ctrl+C) 処理を中断中... もう一度 Ctrl+C でプロセス終了"));
          // 3秒以内に2回目が来なければリセット
          ctrlCResetTimer = setTimeout(() => { ctrlCCount = 0; }, 3000);
        } else {
          // 2回目: 強制終了
          console.log(chalk.yellow("\n  強制終了します..."));
          process.exit(1);
        }
      } else {
        // 待機中: 通常通り終了
        process.exit(0);
      }
    };
    process.on("SIGINT", sigintHandler);

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
      }
    } finally {
      this.agent.saveCurrentSession();
      // アクティブなループタイマーを全停止
      const stoppedLoops = this.loopManager.stopAll();
      if (stoppedLoops > 0) {
        console.log(chalk.dim(`  ループ ${stoppedLoops} 件を停止しました。`));
      }
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
    this.passphrase = secret;
  }

  /**
   * メインLLMの接続先 (providerType / baseUrl / model) 変更を実行時に反映する。
   * Configを保存後に呼ぶと、新しいProviderインスタンスを作成して AgentLoop と
   * SubAgentManager に注入し、システムプロンプトのプロファイル情報も更新する。
   * 接続テストを行い、失敗時は警告を出すが処理は続行する（ユーザーがリトライできる）。
   */
  private async applyMainLLMEndpoint(): Promise<void> {
    await this.ensurePassphraseFor(
      this.config.mainLLM.apiKey,
      "メインLLM",
      this.config.mainLLM.providerType,
    );
    let newProvider;
    try {
      newProvider = createProvider(this.config.mainLLM, this.passphrase);
    } catch (e) {
      console.log(chalk.red(`  Provider生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    // 接続テスト
    try {
      const ok = await newProvider.testConnection();
      if (!ok) {
        console.log(chalk.yellow(`  ⚠ ${this.config.mainLLM.baseUrl} への接続テストに失敗しました。設定は反映しましたが次の応答でエラーになる可能性があります。`));
      }
    } catch {
      console.log(chalk.yellow(`  ⚠ 接続テスト中にエラーが発生しました。設定は反映済み。`));
    }

    this.agent.setProvider(newProvider, this.config.mainLLM.model);
    const subAgentMgr = getSubAgentManager();
    if (subAgentMgr) {
      subAgentMgr.setProvider(newProvider, this.config.mainLLM.model);
    }
    this.refreshLLMProfiles();
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
    target: "main" | "second",
    provider: "azure-openai" | "azure-gpt" | "azure-claude" | "azure-foundry" | "azure-anthropic",
  ): Promise<void> {
    const targetLabel = target === "main" ? "メインLLM" : "セカンドLLM";
    console.log(chalk.bold(`\n  ── ${targetLabel} ${provider} セットアップ ──`));
    console.log(chalk.dim("  キャンセルは Ctrl+C\n"));

    const existing =
      target === "main" ? this.config.mainLLM : this.config.secondLLM?.endpoint;
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
      default: existingIsAzure ? existing?.model : (skipDeployment ? undefined : deploymentName),
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
    let needsRestart = false;

    if (storageMode === "env") {
      const envName = await input({
        message: "環境変数名 (例: AZURE_OPENAI_API_KEY):",
        validate: (v: string) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) || "有効な環境変数名を入力してください",
      });
      storedApiKey = `env:${envName.trim()}`;
      if (!process.env[envName.trim()]) {
        console.log(chalk.yellow(`  ⚠ 環境変数 ${envName.trim()} は現在未設定です。アプリ起動時にセットしてください。`));
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
      needsRestart = true; // 暗号化済みは初回起動時に合言葉を聞くため再起動が必要
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
    console.log(chalk.dim(`    API Key:         ${storageMode === "encrypt" ? "暗号化保存" : storageMode === "env" ? `環境変数 (${storedApiKey})` : "平文保存"}`));

    if (needsRestart) {
      console.log(chalk.yellow("\n  ⚠ 暗号化保存のため、反映にはアプリの再起動と合言葉入力が必要です。"));
    } else {
      // 平文 / 環境変数参照 ならその場で反映可能
      if (target === "main") {
        await this.applyMainLLMEndpoint();
        console.log(chalk.green("  実行時に反映しました。"));
      } else {
        await this.applySecondLLMEndpoint();
        const isAvail = this.secondLLMManager?.isAvailable() ?? false;
        if (isAvail) {
          console.log(chalk.green("  実行時に反映しました。"));
        } else {
          console.log(chalk.yellow("  反映時に接続失敗しました。/second status で確認してください。"));
        }
      }
    }
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
    // 起動時に secondLLM が無効/失敗だった場合、 second_llm_consult / second_llm_agent ツールが
    // 未登録のまま起動している可能性がある。 利用可能になったタイミングで遅延登録する。
    // (ToolRegistry.register は Map.set ベースで冪等なので再呼び出しは無害)
    if (this.secondLLMManager.isAvailable()) {
      setSecondLLMManager(this.secondLLMManager);
      const reg = this.agent.getToolRegistry();
      reg.register(secondLLMConsultTool);
      reg.register(secondLLMAgentTool);
    }
    this.refreshLLMProfiles();
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
    if (providerType !== "ollama" && providerType !== "lmstudio" && providerType !== "llamacpp" && providerType !== "vllm") {
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
      console.log(chalk.dim(`  ※ ポートは現状値を維持します。 ポートも変えるなら /model port、 全部やり直すなら /model setup`));
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
  private async handleModelSetupLocal(): Promise<void> {
    const cur = this.config.mainLLM;
    const isCloud = ["vertex-ai", "azure-openai", "azure-gpt", "azure-claude", "azure-foundry", "azure-anthropic"]
      .includes(cur.providerType);
    try {
      const result = await runLocalLLMSetup({
        headline: "メインLLM 再設定",
        current: isCloud ? undefined : {
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
        console.log(chalk.dim("  設定は変更されていません。 サーバー側を確認してから再度 /model setup を実行してください。"));
      }
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
    if (this.agent.getPermissions().isAutorunMode()) {
      return chalk.magenta("[autorun] > ");
    }
    return chalk.green("> ");
  }

  // ─── 入力処理 ──────────────────────────────────────

  private async processInput(input: string): Promise<void> {
    this.agentBusy = true;
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

      // LLMの応答が完了した後、通知設定が有効なら送信する
      const historyMsgs = this.agent.getHistory().getMessages();
      const lastMsg = historyMsgs[historyMsgs.length - 1];
      if (lastMsg && lastMsg.role === "assistant" && typeof lastMsg.content === "string" && lastMsg.content.trim() !== "") {
        if (this.config.discord?.enabled && this.config.discord?.webhookUrl) {
          console.log(chalk.dim("  Sending response to Discord..."));
          await sendDiscordNotification(this.config.discord.webhookUrl, lastMsg.content);
        }
        if (this.config.slack?.enabled && this.config.slack?.webhookUrl) {
          console.log(chalk.dim("  Sending response to Slack..."));
          await sendSlackNotification(this.config.slack.webhookUrl, lastMsg.content);
        }
      }

    } catch (e) {
      console.error(
        chalk.red(`\n  Error: ${e instanceof Error ? e.message : String(e)}\n`),
      );
    } finally {
      this.agentBusy = false;
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

      case "/clear":
        this.agent.getHistory().clear();
        console.log(chalk.dim("  会話履歴をクリアしました。"));
        break;

      case "/context": {
        const messages = this.agent.getHistory().getMessages();
        const tokens = estimateMessageTokens(messages);
        const ctxWindow = this.agent.getContextWindow();
        const pct = ctxWindow > 0 ? Math.round((tokens / ctxWindow) * 100) : 0;
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

            const promptForAttempt = tryAttempt === 1
              ? tryResolved
              : `${tryResolved}\n\n---\n**再試行 (${tryAttempt}回目):** 前回の試行の問題点:\n${tryLastFeedback}\n\n` +
                `上記を踏まえて再実装してください。特に file_write ツールを呼び出して実際にファイルを保存してください。`;

            await this.agent.run(promptForAttempt);

            if (this.agent.isAborted()) break;

            // file_write が呼ばれたか: ツール結果メッセージで "File written:" を確認
            const allMsgs = this.agent.getHistory().getMessages();
            const fileWritten = allMsgs.some(m =>
              m.role === "tool" &&
              typeof m.content === "string" &&
              m.content.startsWith("File written:")
            );

            if (fileWritten) {
              // 書かれたファイルパスを表示
              const writtenPaths = allMsgs
                .filter(m => m.role === "tool" && typeof m.content === "string" && m.content.startsWith("File written:"))
                .map(m => (m.content as string).replace("File written: ", "").trim());
              console.log(chalk.green(`\n  ✓ 試行 ${tryAttempt} 回目で完了`));
              writtenPaths.forEach(p => console.log(chalk.green(`    → ${p}`)));
              console.log();
              trySucceeded = true;
              break;
            }

            // 失敗した場合: 最後のアシスタント応答をフィードバックとして次回に渡す
            const lastAssistant = [...allMsgs].reverse().find(m => m.role === "assistant");
            tryLastFeedback = typeof lastAssistant?.content === "string"
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

      case "/stream": {
        if (args.length === 0) {
          const current = this.agent.getStreamingDisplay();
          console.log(chalk.dim(`  表示モード: ${current ? "ストリーミング表示" : "スピナー+Markdownレンダリング"}`));
          console.log(chalk.dim("  切り替え: /stream on  または  /stream off"));
        } else if (args[0] === "on") {
          this.agent.setStreamingDisplay(true);
          this.config.streamingDisplay = true;
          saveConfig(this.config);
          console.log(chalk.dim("  ストリーミング表示モードに切り替えました。（設定を保存しました）"));
        } else if (args[0] === "off") {
          this.agent.setStreamingDisplay(false);
          this.config.streamingDisplay = false;
          saveConfig(this.config);
          console.log(chalk.dim("  スピナー+Markdownレンダリングモードに切り替えました。（設定を保存しました）"));
        } else {
          console.log(chalk.yellow("  使用方法: /stream [on|off]"));
        }
        break;
      }

      case "/model": {
        if (args.length === 0 || args[0] === "info") {
          // --- 基本情報 ---
          const modelName = this.agent.getModel();
          const ctxWindow = this.agent.getContextWindow();
          const ctxLabel = ctxWindow >= 1000 ? `${Math.round(ctxWindow / 1000)}K` : `${ctxWindow}`;
          console.log(chalk.bold("\n  ── モデル情報 ──"));
          console.log(chalk.dim(`  モデル:         ${chalk.cyan(modelName)}`));
          {
            const m = this.config.mainLLM;
            const loc = m.baseUrl ?? m.endpoint ?? "(クラウド)";
            console.log(chalk.dim(`  プロバイダー:   ${m.providerType} @ ${loc}`));
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
          const fmt = (v: number | undefined) => v !== undefined ? String(v) : chalk.gray("auto");
          console.log(chalk.dim(`  temperature:    ${fmt(sp.temperature)}    ${chalk.gray("(/model temperature <値> で変更)")}`));
          console.log(chalk.dim(`  top_p:          ${fmt(sp.top_p)}    ${chalk.gray("(/model top_p <値>)")}`));
          console.log(chalk.dim(`  top_k:          ${fmt(sp.top_k)}    ${chalk.gray("(/model top_k <値>)")}`));
          console.log(chalk.dim(`  rep_penalty:    ${fmt(sp.repetition_penalty)}    ${chalk.gray("(/model rep_penalty <値>)")}`));
          console.log(chalk.dim(`  ストリーミング: ${this.agent.getStreamingDisplay() ? "ON" : "OFF"}`));

          // --- サーバーからモデル詳細を取得 ---
          try {
            const detail = await this.agent.getProvider().getModelInfo(modelName);
            if (detail.contextLength > 0 || detail.size > 0 || detail.parameterSize || detail.quantizationLevel) {
              console.log(chalk.bold("\n  ── サーバー報告 ──"));
              if (detail.contextLength > 0) {
                const serverCtx = detail.contextLength >= 1000 ? `${Math.round(detail.contextLength / 1000)}K` : `${detail.contextLength}`;
                const mismatch = detail.contextLength !== ctxWindow;
                console.log(chalk.dim(`  コンテキスト長: ${mismatch ? chalk.red(serverCtx) : chalk.green(serverCtx)} トークン${mismatch ? chalk.red(" ⚠ 設定値と不一致!") : ""}`));
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
            console.log(chalk.dim(`  モデル: ${v.model} @ ${v.baseUrl ?? v.endpoint ?? "(クラウド)"}`));
          }
          if (this.config.secondLLM?.enabled) {
            console.log(chalk.bold("\n  ── セカンドLLM ──"));
            console.log(chalk.dim(`  モデル: ${this.config.secondLLM.endpoint.model} (${this.config.secondLLM.endpoint.providerType})`));
            const secDesc = this.config.secondLLM.endpoint.description?.trim();
            if (secDesc) {
              console.log(chalk.dim(`  特性:   ${chalk.cyan(secDesc)}`));
            }
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
            console.log(chalk.dim(`    "MoE 32B。日本語堅牢で推論・企画・対話が得意。応答は中速。マルチモーダル非対応"`));
            console.log(chalk.dim(`    "Dense 13B。高速でコード生成が得意。日本語はやや不自然。長文要約やリファクタリング向き"`));
            console.log(chalk.dim(`    "Vision対応27B。画像解析+日本語OK。スクリーンショット/図表の読み取りに最適。やや遅い"`));
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
            console.log(chalk.dim(`  コンテキスト長: ${chalk.yellow(oldLabel)} → ${chalk.cyan(newLabel)} トークン (max_tokensも連動)`));
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
        } else if (args[0] === "temperature" || args[0] === "top_p" || args[0] === "top_k" || args[0] === "rep_penalty") {
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
              console.log(chalk.green(`  ${args[0]} を ${chalk.cyan(String(num))} に設定しました (次のLLM呼び出しから反映)`));
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
          const cloudProviders = ["vertex-ai", "azure-openai", "azure-gpt", "azure-claude", "azure-foundry", "azure-anthropic"];
          const validProviders = [...localProviders, ...cloudProviders];
          if (!newProvider) {
            console.log(chalk.dim(`  現在のプロバイダー: ${this.config.mainLLM.providerType}`));
            console.log(chalk.dim(`  使い方: /model provider <タイプ> [<URL>]   (ローカル系)`));
            console.log(chalk.dim(`         /model setup azure-foundry        (クラウド系は対話セットアップ)`));
            console.log(chalk.dim(`  ローカル: ${localProviders.join(", ")}`));
            console.log(chalk.dim(`  クラウド: ${cloudProviders.join(", ")}`));
            console.log(chalk.dim(`  デフォルトポート: ${localProviders.map((p) => `${p}=${DEFAULT_PORTS[p]}`).join(", ")}`));
          } else if (!validProviders.includes(newProvider)) {
            console.log(chalk.red(`  無効なプロバイダー: ${newProvider}`));
            console.log(chalk.dim(`  選択肢: ${validProviders.join(", ")}`));
          } else if (cloudProviders.includes(newProvider)) {
            // クラウド系は endpoint/apiKey 等の追加情報が必要 → setup フローへ誘導
            console.log(chalk.yellow(`  ${newProvider} はクラウド系です。endpoint/apiKey 設定が必要なので /model setup ${newProvider} を実行してください。`));
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
            console.log(chalk.dim(`  メインLLMプロバイダー: ${chalk.yellow(oldProvider)} → ${chalk.cyan(newProvider)}`));
            if (newUrl) {
              console.log(chalk.dim(`  URL: ${chalk.cyan(newUrl)}`));
            } else {
              const port = DEFAULT_PORTS[newProvider as ProviderType];
              console.log(chalk.dim(`  URL: ${this.config.mainLLM.baseUrl ?? "(未設定)"} (必要なら /model host / /model port で更新。${newProvider}のデフォルトポートは ${port})`));
            }
            await this.applyMainLLMEndpoint();
            console.log(chalk.green(`  実行時に反映しました。`));
          }
        } else if (args[0] === "setup") {
          const targetProvider = args[1]?.trim();
          if (!targetProvider || targetProvider === "local") {
            // 引数なし or "local" → ローカル系ウィザード (npm run setup と同等の流れ)
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
          } else {
            console.log(chalk.red(`  対話セットアップ未対応のプロバイダー: ${targetProvider}`));
            console.log(chalk.dim("  使い方:"));
            console.log(chalk.dim("    /model setup                  ローカル系LLM (ollama/lmstudio/llamacpp/vllm) ウィザード"));
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
        const subCmd = args[0];
        // セカンドLLM未設定 かつ setup 以外のサブコマンドの場合
        if (!subCmd || subCmd === "status") {
          // status は設定の有無にかかわらず表示
          const cfg = this.config.secondLLM;
          console.log(chalk.bold("\n  ── セカンドLLM ──"));
          if (!cfg) {
            console.log(chalk.dim(`  状態: ${chalk.red("未設定")}`));
            console.log(chalk.dim(`  設定するには: /second setup`));
          } else {
            const isAvail = this.secondLLMManager?.isAvailable() ?? false;
            console.log(chalk.dim(`  状態:         ${cfg.enabled ? (isAvail ? chalk.green("有効 (接続OK)") : chalk.yellow("有効 (接続失敗)")) : chalk.red("無効")}`));
            console.log(chalk.dim(`  プロバイダー: ${cfg.endpoint.providerType}`));
            console.log(chalk.dim(`  URL:          ${cfg.endpoint.baseUrl ?? "(なし)"}`));
            console.log(chalk.dim(`  モデル:       ${cfg.endpoint.model}`));
            const ctxW = cfg.endpoint.contextWindow;
            const ctxLabel = ctxW ? (ctxW >= 1000 ? `${Math.round(ctxW / 1000)}K` : `${ctxW}`) : "(未設定 — サーバ側デフォルト)";
            console.log(chalk.dim(`  コンテキスト: ${ctxLabel}  ${chalk.gray("※会話履歴はメインと独立")}`));
            const secDesc = cfg.endpoint.description?.trim();
            console.log(chalk.dim(`  特性:         ${secDesc ? chalk.cyan(secDesc) : chalk.yellow("(未設定 — /second description で設定)")}`));
            const sp = cfg.endpoint;
            const fmt = (v: number | undefined) => v !== undefined ? chalk.cyan(String(v)) : chalk.gray("auto");
            console.log(chalk.dim(`  temperature:  ${fmt(sp.temperature)}    ${chalk.gray("(/second temperature <値>)")}`));
            console.log(chalk.dim(`  top_p:        ${fmt(sp.top_p)}    ${chalk.gray("(/second top_p <値>)")}`));
            console.log(chalk.dim(`  top_k:        ${fmt(sp.top_k)}    ${chalk.gray("(/second top_k <値>)")}`));
            console.log(chalk.dim(`  rep_penalty:  ${fmt(sp.repetition_penalty)}    ${chalk.gray("(/second rep_penalty <値>)")}`));
          }
          console.log();
        } else if (subCmd === "description") {
          const text = args.slice(1).join(" ").trim();
          if (!this.config.secondLLM) {
            console.log(chalk.red("  Second LLM の設定が存在しません。/second setup で初期設定してください。"));
          } else if (!text) {
            const cur = this.config.secondLLM.endpoint.description?.trim();
            console.log(chalk.bold("\n  ── セカンドLLM特性説明 ──"));
            console.log(chalk.dim(`  現在: ${cur ? chalk.cyan(cur) : chalk.yellow("(未設定)")}`));
            console.log(chalk.dim(`  使い方: /second description <説明文>`));
            console.log(chalk.dim(`  クリア: /second description clear`));
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
             console.log(chalk.green("  Second LLM を有効化しました (設定に保存)。（再起動後に完全適用される場合があります）"));
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
            console.log(chalk.red("  Second LLM の設定が存在しません。/second setup で初期設定してください。"));
          } else if (!newModel) {
            // 引数なし or /second list: サーバーからモデル一覧を取得して選択
            const provider = this.secondLLMManager?.getProvider();
            if (!provider) {
              console.log(chalk.dim(`  現在のモデル: ${this.config.secondLLM.endpoint.model ?? "(未設定)"}`));
              console.log(chalk.dim(`  プロバイダーに接続できません。直接指定: /second model <モデル名>`));
            } else {
              try {
                const models = await provider.listModels();
                if (models.length === 0) {
                  console.log(chalk.dim("  利用可能なモデルはありません。直接指定: /second model <モデル名>"));
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
                  console.log(chalk.dim(`  直接指定: /second model <モデル名>`));
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
          // /second context <数値|128k> — セカンドLLMのコンテキストウィンドウ変更
          const val = args[1] ? parseTokenCount(args[1]) : NaN;
          if (!this.config.secondLLM) {
            console.log(chalk.red("  Second LLM の設定が config.json に存在しません。"));
          } else if (isNaN(val) || val <= 0) {
            const cur = this.config.secondLLM.endpoint.contextWindow;
            const curLabel = cur ? (cur >= 1000 ? `${Math.round(cur / 1000)}K` : `${cur}`) : "(未設定 — サーバ側デフォルト)";
            console.log(chalk.dim(`  セカンドLLMコンテキスト長: ${curLabel}`));
            console.log(chalk.dim(`  使い方: /second context <トークン数>`));
            console.log(chalk.dim(`  例: /second context 128k  /second context 32000`));
          } else {
            const old = this.config.secondLLM.endpoint.contextWindow;
            const oldLabel = old ? (old >= 1000 ? `${Math.round(old / 1000)}K` : `${old}`) : "(未設定)";
            this.config.secondLLM.endpoint.contextWindow = val;
            saveConfig(this.config);
            await this.applySecondLLMEndpoint();
            const newLabel = val >= 1000 ? `${Math.round(val / 1000)}K` : `${val}`;
            console.log(chalk.dim(`  セカンドLLMコンテキスト長: ${chalk.yellow(oldLabel)} → ${chalk.cyan(newLabel)} トークン`));
          }
        } else if (subCmd === "url") {
          const newUrl = args.slice(1).join(" ").trim();
          if (!newUrl) {
            console.log(chalk.dim(`  現在のURL: ${this.config.secondLLM?.endpoint.baseUrl ?? "(未設定)"}`));
            console.log(chalk.dim(`  使い方: /second url <URL>`));
            console.log(chalk.dim(`  例: /second url http://192.168.1.201:8000`));
          } else if (this.config.secondLLM) {
            const oldUrl = this.config.secondLLM.endpoint.baseUrl ?? "(未設定)";
            this.config.secondLLM.endpoint.baseUrl = newUrl;
            saveConfig(this.config);
            await this.applySecondLLMEndpoint();
            console.log(chalk.dim(`  URL: ${chalk.yellow(oldUrl)} → ${chalk.cyan(newUrl)}`));
            console.log(chalk.green(`  実行時に反映しました。`));
          } else {
            console.log(chalk.red("  Second LLM の設定が存在しません。/second setup で初期設定してください。"));
          }
        } else if (subCmd === "provider") {
          const newProvider = args[1]?.trim();
          const validProviders = ["ollama", "lmstudio", "llamacpp", "vllm", "vertex-ai", "azure-openai", "azure-gpt", "azure-claude", "azure-foundry", "azure-anthropic"];
          if (!newProvider) {
            console.log(chalk.dim(`  現在のプロバイダー: ${this.config.secondLLM?.endpoint.providerType ?? "(未設定)"}`));
            console.log(chalk.dim(`  使い方: /second provider <タイプ>`));
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
            const isCloud = ["vertex-ai", "azure-openai", "azure-gpt", "azure-claude", "azure-foundry", "azure-anthropic"].includes(newProvider);
            if (isCloud) {
              console.log(chalk.dim(`  クラウドプロバイダーは追加の認証情報が必要な場合があります。/second status で確認してください。`));
            } else {
              console.log(chalk.green(`  実行時に反映しました。`));
            }
          } else {
            console.log(chalk.red("  Second LLM の設定が存在しません。/second setup で初期設定してください。"));
          }
        } else if (subCmd === "setup") {
          // 最小限の初期設定を作成
          const provider = (args[1] ?? "vllm") as SecondLLMProviderType;
          if (provider === "azure-openai" || provider === "azure-gpt" || provider === "azure-claude" || provider === "azure-foundry" || provider === "azure-anthropic") {
            try {
              await this.setupAzureLLM("second", provider);
            } catch (e) {
              if (!(e instanceof Error && e.message.includes("User force closed"))) {
                console.log(chalk.red(`  Azure セットアップ中にエラー: ${e instanceof Error ? e.message : String(e)}`));
              } else {
                console.log(chalk.yellow("  セットアップを中止しました。"));
              }
            }
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
            console.log(chalk.dim(`  モデル:       ${model || "(未指定 — /second model で設定)"}`));
            console.log(chalk.dim(`  (反映には再起動が必要です)`));
          }
        } else if (subCmd === "temperature" || subCmd === "top_p" || subCmd === "top_k" || subCmd === "rep_penalty") {
          // /second temperature [<値>|auto|clear] — メインLLMの /model XXX と同一仕様
          if (!this.config.secondLLM) {
            console.log(chalk.red("  Second LLM の設定が存在しません。/second setup で初期設定してください。"));
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
            const curStr = cur !== undefined ? String(cur) : chalk.gray("auto (consult=0.2 / agent=0.2 / evaluator=0.1 を内部既定として使用)");

            if (!valArg) {
              console.log(chalk.bold(`\n  ── セカンドLLM ${subCmd} ──`));
              console.log(chalk.dim(`  現在値: ${curStr}`));
              console.log(chalk.dim(`  推奨値: ${r.recommended}`));
              console.log(chalk.dim(`  範囲:   ${r.min} 〜 ${r.max}${r.integer ? " (整数)" : ""}`));
              console.log(chalk.dim(`  使い方: /second ${subCmd} <値>`));
              console.log(chalk.dim(`  クリア: /second ${subCmd} auto  (または clear)`));
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
                console.log(chalk.green(`  セカンドLLM ${subCmd} を ${chalk.cyan(String(num))} に設定しました (次のLLM呼び出しから反映)`));
              }
            }
          }
        } else {
           console.log(chalk.yellow("  使い方:"));
           console.log(chalk.dim("    /second                       状態確認"));
           console.log(chalk.dim("    /second setup [provider] [url] [model]  初期設定 (ローカル系)"));
           console.log(chalk.dim("    /second setup azure-openai             Azure OpenAI (Chat Completions API) 対話セットアップ"));
           console.log(chalk.dim("    /second setup azure-gpt                Azure OpenAI (Responses API、 gpt-5/codex系) 対話セットアップ"));
           console.log(chalk.dim("    /second setup azure-claude             Azure Claude (OpenAI互換ルート) 対話セットアップ"));
           console.log(chalk.dim("    /second setup azure-foundry            Azure AI Foundry (Kimi/Mistral等) 対話セットアップ"));
           console.log(chalk.dim("    /second setup azure-anthropic          Azure Claude (Anthropic Messages API) 対話セットアップ"));
           console.log(chalk.dim("    /second enable / disable      有効化・無効化"));
           console.log(chalk.dim("    /second model <名前>          モデル変更"));
           console.log(chalk.dim("    /second url <URL>             エンドポイントURL変更"));
           console.log(chalk.dim("    /second provider <タイプ>     プロバイダー変更"));
           console.log(chalk.dim("    /second context <128k>        コンテキスト長変更"));
           console.log(chalk.dim("    /second temperature <値>      サンプリング温度 (auto/clear で内部既定に戻す)"));
           console.log(chalk.dim("    /second top_p <値>            Top-p"));
           console.log(chalk.dim("    /second top_k <値>            Top-k"));
           console.log(chalk.dim("    /second rep_penalty <値>      繰り返しペナルティ"));
           console.log(chalk.dim("    /second description <text>    特性説明 (サブエージェント選択の材料)"));
        }
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
          console.log(chalk.red("\n  セカンドLLM のモデル/プロバイダーが未設定です。先に /second model 等で設定してください。\n"));
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
          console.log(chalk.yellow("  ※ セカンドLLM の接続テストに失敗しています。/second status で確認してください。"));
        }
        console.log();
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

      case "/slack": {
        const subCmd = args[0];
        if (!subCmd || subCmd === "status") {
          const s = this.config.slack;
          const sEnabled = s?.enabled ?? false;
          const sUrl = s?.webhookUrl || "未設定";
          const sBotToken = s?.botToken ? chalk.green("設定済み") : chalk.yellow("未設定");
          const sAppToken = s?.appToken ? chalk.green("設定済み") : chalk.yellow("未設定");
          console.log(chalk.bold("\n  === Slack Status ==="));
          console.log(chalk.dim(`  通知 (Webhook): ${sEnabled ? chalk.green("有効") : chalk.yellow("無効")}`));
          console.log(chalk.dim(`  Webhook URL:    ${sUrl}`));
          console.log(chalk.dim(`  Bot Token:      ${sBotToken}`));
          console.log(chalk.dim(`  App Token:      ${sAppToken}`));
          console.log(chalk.dim(`  --slack モード:  bot-token + app-token 設定後に 'npm run start -- --slack' で起動`));
          console.log();
        } else if (subCmd === "enable") {
          if (!this.config.slack) this.config.slack = { enabled: false, webhookUrl: "" };
          if (!this.config.slack.webhookUrl) {
            console.log(chalk.yellow("  注意: Webhook URL が設定されていません。先に '/slack url <URL>' を実行してください。"));
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
            console.log(chalk.dim(`  URL: ${urlStr}`));
            console.log(chalk.dim("  /slack test でテスト送信できます。"));
          }
        } else if (subCmd === "test") {
          const webhookUrl = this.config.slack?.webhookUrl ?? "";
          if (!webhookUrl) {
            console.log(chalk.yellow("  Webhook URL が設定されていません。先に '/slack url <URL>' を実行してください。"));
          } else if (!isValidSlackWebhookUrl(webhookUrl)) {
            console.log(chalk.red("  設定されているURLが無効です。'/slack url <URL>' で正しいWebhook URLを設定してください。"));
          } else {
            console.log(chalk.dim("  Slack にテストメッセージを送信中..."));
            const result = await sendSlackNotification(webhookUrl, "lllmAgents テスト通知\nSlack通知が正常に動作しています！");
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
        } else {
          console.log(chalk.yellow("  使い方: /slack <サブコマンド>"));
          console.log(chalk.dim("  通知系:    status | enable | disable | url <URL> | test"));
          console.log(chalk.dim("  Bot設定:   bot-token <xoxb-...> | app-token <xapp-...>"));
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
          else { this.config.search.provider = "searxng"; this.config.search.searxngUrl = url; }
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
              console.log(result.output.split("\n").map((l: string) => `    ${l}`).join("\n"));
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

      case "/parallel": {
        const n = parseInt(args[0], 10);
        if (isNaN(n)) {
          console.log(chalk.dim(`  現在の並列実行上限: ${this.agent.getMaxParallelTools()}`));
          console.log(chalk.dim("  変更: /parallel <数値>"));
        } else {
          this.agent.setMaxParallelTools(n);
          this.config.maxParallelTools = this.agent.getMaxParallelTools();
          saveConfig(this.config);
          console.log(chalk.green(`  並列実行上限を ${this.agent.getMaxParallelTools()} に設定しました (設定に保存)`));
        }
        break;
      }

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
            } catch { /* ignore */ }
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
            if (!basePath) { console.log(chalk.yellow("  ナレッジディレクトリがありません。")); break; }
            const tagCounts = new Map<string, number>();
            const walkAndCountTags = (dir: string) => {
              if (!fs.existsSync(dir)) return;
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, e.name);
                if (e.isDirectory()) { walkAndCountTags(fp); continue; }
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
          if (!obs?.vaultPath) { console.log(chalk.yellow("  Vault が未設定です。")); break; }
          const limit = parseInt(args[1] ?? "10", 10);
          try {
            const { getKnowledgeBasePath } = await import("../tools/definitions/knowledge-save.js");
            const basePath = getKnowledgeBasePath();
            if (!basePath) { console.log(chalk.dim("  ナレッジノートはまだありません。")); break; }
            const files: { path: string; mtime: number }[] = [];
            const walk = (dir: string) => {
              if (!fs.existsSync(dir)) return;
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, e.name);
                if (e.isDirectory()) { walk(fp); continue; }
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
          if (!query) { console.log(chalk.yellow("  使い方: /knowledge search <キーワード>")); break; }
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
          if (!obs?.vaultPath) { console.log(chalk.yellow("  Vault が未設定です。")); break; }
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

      case "/autorun": {
        const permissions = this.agent.getPermissions();
        const subArg = args[0];
        if (subArg === "on") {
          permissions.setAutorunMode(true);
          this.config.autorunMode = true;
          saveConfig(this.config);
          console.log(chalk.green("  自律実行モード ON (設定に保存)"));
          console.log(chalk.dim("  作業フォルダ内の操作は削除以外すべて自動承認されます"));
          console.log(chalk.dim("  中断: Ctrl+C / 停止: /autorun off"));
        } else if (subArg === "off") {
          permissions.setAutorunMode(false);
          this.config.autorunMode = false;
          saveConfig(this.config);
          console.log(chalk.yellow("  自律実行モード OFF (設定に保存)"));
        } else {
          const current = permissions.isAutorunMode();
          if (current) {
            permissions.setAutorunMode(false);
            this.config.autorunMode = false;
            saveConfig(this.config);
            console.log(chalk.yellow("  自律実行モード OFF (設定に保存)"));
          } else {
            permissions.setAutorunMode(true);
            this.config.autorunMode = true;
            saveConfig(this.config);
            console.log(chalk.green("  自律実行モード ON (設定に保存)"));
            console.log(chalk.dim("  作業フォルダ内の操作は削除以外すべて自動承認されます"));
            console.log(chalk.dim("  中断: Ctrl+C / 停止: /autorun off"));
          }
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
              console.log(`    現在:   ${chalk.dim(chatLogger.getCurrentFilePath())} (Part ${chatLogger.getPartNumber()})`);
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
        const limitArg = parseInt(args[0] ?? "", 10);
        const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 20;
        const sessions = listSessions(limit);
        if (sessions.length === 0) {
          console.log(chalk.dim("  保存されたセッションはありません。"));
          console.log(chalk.dim("  会話を 1 ターン以上行ったあと /quit すると保存されます。"));
        } else {
          console.log(chalk.bold(`\n  保存されたセッション (新しい順、 上位 ${sessions.length} 件):`));
          for (const s of sessions) {
            const date = new Date(s.updatedAt).toLocaleString();
            const title = (s.title || "(タイトルなし)").replace(/\s+/g, " ").slice(0, 60);
            console.log(
              `    ${chalk.cyan(s.id)}  ${chalk.dim(date)}  ${chalk.dim(`(${s.messageCount}msgs)`)}  ${title}`,
            );
          }
          console.log(chalk.dim(`\n  復元方法:`));
          console.log(chalk.dim(`    /resume                   ← 対話的にリストから選ぶ`));
          console.log(chalk.dim(`    /resume <session-id>      ← ID 直接指定`));
          console.log(chalk.dim(`    /continue                 ← 一番新しいセッションを即復元`));
          console.log(chalk.dim(`    起動時: --resume <id> / --continue\n`));
        }
        break;
      }

      case "/resume": {
        let sessionId = args[0];
        // 無引数なら対話的に選択させる (Claude Code 流儀)
        if (!sessionId) {
          const sessions = listSessions(20);
          if (sessions.length === 0) {
            console.log(chalk.dim("  保存されたセッションはありません。"));
            console.log(chalk.dim("  会話を 1 ターン以上行ったあと /quit すると保存されます。"));
            break;
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
            break;
          }
        }
        const session = loadSession(sessionId);
        if (!session) {
          console.log(chalk.red(`  セッション ${sessionId} が見つかりません。`));
          console.log(chalk.dim(`  /sessions で一覧を表示できます。`));
          break;
        }
        this.agent.restoreSession(session);
        console.log(
          chalk.dim(
            `  セッション ${chalk.cyan(sessionId)} を復元しました (${session.meta.messageCount} messages)`,
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

      case "/loglevel": {
        const opsLogger = getOpsLogger();
        const filePath = opsLogger.getFilePath();
        if (args.length === 0) {
          console.log(chalk.dim(`  運用ログ level: ${opsLogger.getLevel()}`));
          console.log(chalk.dim(`  出力先: ${filePath ?? "(disabled)"}`));
          console.log(chalk.dim("  変更: /loglevel [trace|debug|info|warn|error]"));
        } else {
          const level = parseOpsLogLevel(args[0]);
          if (!level) {
            console.log(chalk.yellow("  無効な level。 trace|debug|info|warn|error から選択してください。"));
            break;
          }
          setOpsLogLevel(level);
          console.log(chalk.dim(`  運用ログ level を ${level} に変更しました (このセッションのみ)`));
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
        const { execFileSync } = await import("node:child_process");
        try {
          // Security: Use execFileSync instead of execSync to prevent command injection
          const diff = execFileSync("git", ["diff", "--stat"], {
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

      case "/loop": {
        const subCmd = args[0]?.toLowerCase();

        // /loop list
        if (subCmd === "list") {
          const entries = this.loopManager.list();
          if (entries.length === 0) {
            console.log(chalk.dim("  アクティブなループはありません。"));
          } else {
            console.log(chalk.bold(`\n  アクティブなループ (${entries.length} 件):`));
            for (const e of entries) {
              const lastRun = e.lastRunAt
                ? e.lastRunAt.toLocaleTimeString()
                : "未実行";
              console.log(
                chalk.cyan(`    [${e.id}]`) +
                  chalk.dim(` 間隔: ${e.intervalStr}`) +
                  chalk.dim(` | 実行数: ${e.runCount}`) +
                  chalk.dim(` | 最終実行: ${lastRun}`) +
                  `\n        ${chalk.white(e.prompt)}`,
              );
            }
            console.log();
          }
          break;
        }

        // /loop stop [id|all]
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
          console.log(chalk.dim("  /loop list  - 一覧表示"));
          console.log(chalk.dim("  /loop stop [id|all]  - 停止"));
          break;
        }

        const { intervalMs, intervalStr, prompt: loopPrompt } = parseLoopArgs(argsStr);

        if (!loopPrompt) {
          console.log(chalk.yellow("  プロンプトを指定してください。"));
          break;
        }

        const loopId = this.loopManager.start(
          loopPrompt,
          intervalMs,
          intervalStr,
          async (p: string) => {
            if (this.agentBusy) {
              console.log(
                chalk.dim(`\n  [Loop ${loopId}] エージェント実行中のためスキップ (${new Date().toLocaleTimeString()})`),
              );
              return;
            }
            console.log(
              chalk.bold(`\n  [Loop ${loopId}] 実行開始 (${new Date().toLocaleTimeString()}): `) +
                chalk.white(p),
            );
            if (p.startsWith("/")) {
              await this.handleCommand(p);
            } else {
              await this.processInput(p);
            }
          },
        );

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

function progressBar(pct: number): string {
  const width = 30;
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const color =
    pct > 80 ? chalk.red : pct > 60 ? chalk.yellow : chalk.green;
  const overflow = pct > 100 ? chalk.red(" ⚠ over") : "";
  return `[${color("█".repeat(filled))}${chalk.dim("░".repeat(empty))}] ${pct}%${overflow}`;
}
