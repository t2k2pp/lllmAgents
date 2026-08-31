#!/usr/bin/env node

import chalk from "chalk";
import { configExists, loadConfig, saveConfig } from "./config/config-manager.js";
import { setDisplayJpyRate } from "./cost/money-format.js";
import { reconcileSlotsFromConfig } from "./config/model-registry.js";
import { setResolverPassphrase } from "./config/model-resolver.js";
import { runSetupWizard } from "./config/setup-wizard.js";
import { createProvider } from "./providers/provider-factory.js";
import { AgentLoop } from "./agent/agent-loop.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { PermissionManager } from "./security/permission-manager.js";
import { PlaywrightManager } from "./browser/playwright-manager.js";
import { VisionService, createVisionTool } from "./tools/definitions/vision.js";
import { ImageService } from "./image/image-service.js";
import { createImageGenerateTool } from "./tools/definitions/image-generate.js";
import { PlanManager } from "./agent/plan-mode.js";
import { SubAgentManager } from "./agent/sub-agent.js";
import { SkillRegistry } from "./skills/skill-registry.js";
import { loadAllSkills } from "./skills/skill-loader.js";
import { AgentDefinitionLoader } from "./agents/agent-loader.js";
import {
  collectPluginDirs,
  getPluginAgentSources,
  getPluginHookSources,
  getPluginMcpSources,
  loadPluginBundles,
  loadPluginSkills,
} from "./plugins/plugin-loader.js";
import type { LoadedPlugin } from "./plugins/plugin-loader.js";

// Tool imports
import { fileReadTool } from "./tools/definitions/file-read.js";
import { fileWriteTool } from "./tools/definitions/file-write.js";
import { fileEditTool } from "./tools/definitions/file-edit.js";
import { globTool } from "./tools/definitions/glob.js";
import { grepTool } from "./tools/definitions/grep.js";
import { bashTool } from "./tools/definitions/bash.js";
import { webFetchTool } from "./tools/definitions/web-fetch.js";
import { createWebSearchTool } from "./tools/definitions/web-search.js";
import { sandboxInfoTool } from "./tools/definitions/sandbox-info.js";
import { todoWriteTool, todoAppendTool, todoMarkTool, todoDeleteTool } from "./tools/definitions/todo-write.js";
import { askUserTool } from "./tools/definitions/ask-user.js";
import { createBrowserTools } from "./tools/definitions/browser.js";
import { createComputerTools } from "./tools/definitions/computer.js";
import { createGameSmokeTool } from "./tools/definitions/game-smoke.js";
import { createDesktopDriver, detectComputerUseCapability, probeComputerUseCapability } from "./computer-use/index.js";
import {
  taskTool,
  taskOutputTool,
  taskListTool,
  taskSendTool,
  taskCancelTool,
  taskDiffTool,
  taskApplyTool,
  taskDiscardTool,
  setSubAgentManager,
} from "./tools/definitions/task.js";
import { enterPlanModeTool, exitPlanModeTool, setPlanManager } from "./tools/definitions/plan-mode.js";
import {
  skillTool,
  setSkillRegistry,
  setSkillPermissionManager,
  setSkillSubAgentManager,
} from "./tools/definitions/skill.js";
import { secondLLMAgentTool, setSecondLLMManager } from "./tools/definitions/second-llm.js";
import { federatedDelegateTool, setFederatedSecondLLMManager } from "./tools/definitions/federated-delegate.js";
import { knowledgeSaveTool, setObsidianConfig } from "./tools/definitions/knowledge-save.js";
import { knowledgeSearchTool } from "./tools/definitions/knowledge-search.js";
import { responseCompleteTool } from "./tools/definitions/response-complete.js";
import { createScheduleTools } from "./tools/definitions/schedule.js";
import { createWorkflowLearningTools } from "./tools/definitions/workflow-learn.js";
import { WorkflowLearner } from "./workflow-learning/workflow-learner.js";
import { LoopManager } from "./loop/loop-manager.js";

import { displayWelcome } from "./cli/renderer.js";
import { REPL } from "./cli/repl.js";
import { screen } from "./cli/screen-manager.js";
import { installOutputRouter, uninstallOutputRouter } from "./cli/output-router.js";
import { withPrompt } from "./cli/prompt-gate.js";
import { PROVIDER_LABELS } from "./config/types.js";
import { buildLLMProfiles } from "./agent/llm-profiles.js";
import { DiscordInteractionServer } from "./discord/interaction-server.js";
import { CredentialVault } from "./security/credential-vault.js";
import { getLatestSession } from "./agent/session-manager.js";
import { RoomManager } from "./agent/room-manager.js";
import { RoomRunQueue } from "./agent/room-run-queue.js";
import { HookManager } from "./hooks/hook-manager.js";
import { MCPManager } from "./mcp/mcp-manager.js";
import { SecondLLMManager } from "./second-llm/second-llm-manager.js";
import { ChatLogger } from "./agent/chat-logger.js";
import { createSessionId } from "./agent/llm-logger.js";
import { initOpsLogger, getOpsLogger, parseOpsLogLevel } from "./utils/ops-logger.js";
import { shutdownHttpClient } from "./utils/http-client.js";
import { installCrashHandlers, setCrashContext, setTerminalRestore } from "./utils/crash-handler.js";
import { applyLogRetention } from "./utils/log-rotation.js";
import { checkForUpdate } from "./utils/update-check.js";
import { inferContextLength } from "./providers/utils/context-length.js";
import { resolveStartupMode } from "./cli/startup-mode.js";

const HELP_TEXT = `LocalLLM Agent

Usage:
  localllm [options]

Options:
  -h, --help          Show this help and exit
  --version           Show the version and exit
  --setup             Run the setup wizard
  --safe-mode         Start without customizations
  --no-mcp            Start without MCP servers
  --no-alt-screen     Disable the terminal alternate screen
  --install-browser   Install the browser runtime
  --check-browser     Verify the browser runtime
  --computer-use      Enable native OS window capture/input for this session
  --check-computer-use Verify native Computer Use dependencies and visible windows`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }
  if (args.includes("--version")) {
    const { getVersionString } = await import("./version.js");
    console.log(`localllm ${getVersionString()}`);
    return;
  }

  // 設定・ログ・MCP・代替画面へ触れない副作用なしの診断経路。
  if (args.includes("--check-computer-use")) {
    const capability = detectComputerUseCapability({ requested: true });
    if (!capability.ready || !capability.platform) {
      console.error(`[check-computer-use] NG — ${capability.reason}`);
      process.exitCode = 1;
      return;
    }
    try {
      const windows = await createDesktopDriver(capability.platform).listWindows();
      if (windows.length === 0) {
        throw new Error("操作対象にできる可視ウィンドウがありません。デスクトップセッションで再実行してください。");
      }
      // ウィンドウ名には機密情報が含まれ得るため、自己診断では件数だけを表示する。
      console.log(`[check-computer-use] OK — ${capability.reason}; visible windows=${windows.length}`);
    } catch (error) {
      console.error(`[check-computer-use] NG — ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  // CLIで明示要求された場合はsetupやlog作成より先にdependency不足を通知する。
  // config opt-inはconfig読込後に同じprobeを行う。
  if (args.includes("--computer-use")) {
    const capability = detectComputerUseCapability({ requested: true });
    if (!capability.ready) {
      console.error(`Native Computer Use initialization failed: ${capability.reason}`);
      process.exitCode = 1;
      return;
    }
  }

  // 未捕捉例外での即死時にセッション保存・端末復元・クラッシュログを行う
  // (docs/production-readiness.md PR-01)。最初に登録する。
  installCrashHandlers();

  // 端末出力を ScreenManager に集約する (docs/tui-alternate-screen.md §3.3)。
  // 以降の console.log / process.stdout.write はすべてこの経路に乗り、
  // プロンプト表示中 (排他所有中) は自動的にキューへ退避される。
  // 差し替えは起動直後の 1 回だけ。終了時・異常終了時に必ず元へ戻す (§8 / §11)。
  installOutputRouter();
  screen.start();
  const restoreOutput = (): void => {
    screen.stop();
    uninstallOutputRouter();
  };
  process.on("exit", restoreOutput);
  // 未捕捉例外 / unhandledRejection 経路でも代替画面から必ず抜ける (§8)。
  // 代替画面の中でスタックを出すと画面ごと消えて読めないため、crash-handler が
  // スタックを出す前にここを呼ぶ。
  setTerminalRestore(restoreOutput);
  // シグナルで落ちるとき (§8)。REPL 側にも SIGINT/SIGTERM の購読があるので、
  // 自分だけのときに限り後始末して終了する。REPL がいる場合はそちらに任せる
  // (二重に process.exit するとセッション保存が飛ぶ)。
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (process.listenerCount(sig) > 1) return;
      restoreOutput();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }

  const startupMode = resolveStartupMode(args);

  // イベントリスナーのメモリリーク警告対策 (inquirer等が多用されるため)
  process.stdin.setMaxListeners(100);
  process.stdout.setMaxListeners(100);

  // ブラウザ機能セットアップ (exe リーン配布向け)。モデル設定不要なので最初に処理。
  // docs/exe-playwright-externalization.md §3.3
  if (args.includes("--install-browser")) {
    const { installPlaywright } = await import("./browser/install-playwright.js");
    process.exit(installPlaywright());
  }

  // ブラウザ機能の健全性チェック (実機検証 / ユーザーの自己診断)。
  // playwright をロード→headless 起動→終了し、OK か誘導メッセージを表示。
  if (args.includes("--check-browser")) {
    try {
      const pm = new PlaywrightManager();
      await pm.ensureBrowser();
      await pm.close();
      console.log("[check-browser] OK — Playwright で Chromium を起動できました。");
      process.exit(0);
    } catch (e) {
      console.error(`[check-browser] NG — ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  // Setup wizard
  if (args.includes("--setup") || !configExists()) {
    await runSetupWizard();
    if (args.includes("--setup")) {
      process.exit(0);
    }
  }

  const config = loadConfig();

  if (startupMode.safeMode) {
    console.log(chalk.yellow("  Safe mode: customizations are disabled for this session."));
  }

  // Plugin bundles are never auto-discovered because hooks and MCP may execute
  // commands. Only config.pluginDirs / --plugin-dir paths are trusted and loaded.
  let plugins: LoadedPlugin[];
  try {
    const pluginDirs = startupMode.customizations.plugins
      ? collectPluginDirs(args, config.pluginDirs, process.cwd())
      : [];
    plugins = loadPluginBundles(pluginDirs);
  } catch (error) {
    console.error(`Plugin initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (plugins.length > 0) {
    console.log(chalk.dim(`  Plugins: ${plugins.map((plugin) => plugin.name).join(", ")}`));
  }

  // コスト表示の日本円換算レート (/cost rate) をプロセス全体で共有する。
  // Discord/Slack 通知や画像生成コストなど config を直接参照できない箇所も
  // このモジュール状態を見て円/ドルを切り替える (cost/money-format.ts)。
  setDisplayJpyRate(config.jpyPerUsd);

  if (!config.mainLLM.model) {
    console.error("Model not configured. Run: localllm --setup");
    process.exit(1);
  }

  // Model Registry (docs/model-registry.md): config.mainLLM / secondLLM を
  // registry に同期し、 main/second slot を確定させる。 旧 llm-profiles.json から
  // の透過移行もここで完了する (本処理は失敗しても起動を止めない)。
  try {
    reconcileSlotsFromConfig(config);
  } catch {
    /* ignore */
  }

  // メインLLM が暗号化された apiKey を持つクラウド系の場合、起動時に合言葉を取得する。
  // セカンドLLM 側でも同じパスフレーズを使い回せるよう shared scope で保持。
  let sharedPassphrase: string | undefined = undefined;
  if (config.mainLLM.apiKey && CredentialVault.isEncrypted(config.mainLLM.apiKey)) {
    const { inquirer } = await import("./cli/prompt-gate.js");
    const { secret } = await withPrompt(() =>
      inquirer.prompt([
        {
          type: "password",
          name: "secret",
          message: `メインLLM (${config.mainLLM.providerType})の暗号化キーを復号するための合言葉:\n >`,
          mask: "*",
        },
      ]),
    );
    sharedPassphrase = secret;
  }

  // Create provider (クラウド系は passphrase で apiKey を復号、ローカル系は無視される)
  let provider;
  try {
    provider = createProvider(config.mainLLM, sharedPassphrase);
  } catch (e) {
    console.error(
      `\nメインLLMの初期化に失敗しました: ${e instanceof Error ? e.message : String(e)}\n` +
        `  /model setup または config.json で設定を確認してください。\n` +
        `  暗号化キーの場合、合言葉が間違っている可能性があります。\n`,
    );
    process.exit(1);
  }

  // ModelResolver に合言葉を預ける (docs/model-orchestration.md §3.4)。
  // named slot 経由でサブエージェントを別モデルで起動する際、 暗号化 apiKey の復号に使う。
  // ここで渡さないと、 ツール実行中に合言葉を聞く羽目になり描画が壊れる。
  setResolverPassphrase(sharedPassphrase);

  // Create tool registry with ALL tools
  const toolRegistry = new ToolRegistry();
  const workflowLearner = new WorkflowLearner(
    process.cwd(),
    startupMode.customizations.skills && !args.includes("--no-skills") && config.skillsEnabled !== false,
  );

  // File tools
  toolRegistry.register(fileReadTool);
  toolRegistry.register(fileWriteTool);
  toolRegistry.register(fileEditTool);
  toolRegistry.register(globTool);
  toolRegistry.register(grepTool);

  // System tools
  if (config.security.streamCommandOutput !== false) {
    bashTool.setStreamOutput(true);
  }
  toolRegistry.register(bashTool);

  // Web & Utility tools
  toolRegistry.register(sandboxInfoTool);
  toolRegistry.register(webFetchTool);
  toolRegistry.register(createWebSearchTool(config.search));
  // current_datetime は不要（システムプロンプトの環境情報に現在日時を含めているため）

  // Knowledge (Obsidian) tools
  setObsidianConfig(config.obsidian ?? null);
  if (config.obsidian?.vaultPath) {
    toolRegistry.register(knowledgeSaveTool);
    toolRegistry.register(knowledgeSearchTool);
  }

  // Interactive tools
  toolRegistry.register(todoWriteTool);
  // 戦略 ToDo Phase 1 (docs/strategic-todo-design.md §3.2): 分離 tool 群
  toolRegistry.register(todoAppendTool);
  toolRegistry.register(todoMarkTool);
  toolRegistry.register(todoDeleteTool);
  toolRegistry.register(askUserTool);
  toolRegistry.register(responseCompleteTool);

  // Plan mode tools
  toolRegistry.register(enterPlanModeTool);
  toolRegistry.register(exitPlanModeTool);

  // Sub-agent tools
  toolRegistry.register(taskTool);
  toolRegistry.register(taskOutputTool);
  toolRegistry.register(taskListTool);
  toolRegistry.register(taskSendTool);
  toolRegistry.register(taskCancelTool);
  toolRegistry.register(taskDiffTool);
  toolRegistry.register(taskApplyTool);
  toolRegistry.register(taskDiscardTool);

  // Skill tool
  toolRegistry.register(skillTool);

  // Browser tools — capability ゲート (docs/exe-playwright-externalization.md §B)。
  // playwright+chromium が準備済みのときだけ登録する。未準備ならツールを出さない＝
  // エージェントが試行して失敗を繰り返すことを防ぐ。
  const { probeBrowserCapability } = await import("./browser/browser-capability.js");
  const browserCap = await probeBrowserCapability(config);
  let playwrightManager: PlaywrightManager | null = null;
  if (browserCap.ready) {
    playwrightManager = new PlaywrightManager();
    const browserTools = createBrowserTools(playwrightManager);
    for (const tool of browserTools) {
      toolRegistry.register(workflowLearner.wrapTool(tool));
    }
    // ランタイムスモーク (ブラウザ成果物の破滅的失敗を検知)。 docs/checkpoint-and-smoke-design.md §5
    toolRegistry.register(createGameSmokeTool(playwrightManager));
  } else {
    console.log(chalk.dim(`ℹ ブラウザ機能 (browser_*/game_smoke) は無効: ${browserCap.reason}`));
  }

  // Native Computer Use は明示 opt-in のときだけ公開する。要求されたのに
  // OS 能力が不足する場合はブラウザへ暗黙代替せず、回復方法つきで起動を止める。
  const computerCap = probeComputerUseCapability(config, args.includes("--computer-use"));
  if (computerCap.ready && computerCap.platform) {
    for (const tool of createComputerTools(createDesktopDriver(computerCap.platform))) {
      toolRegistry.register(workflowLearner.wrapTool(tool));
    }
    console.log(chalk.yellow(`  Native Computer Use: enabled (${computerCap.reason})`));
  } else if (computerCap.source !== "disabled") {
    console.error(`Native Computer Use initialization failed: ${computerCap.reason}`);
    process.exit(1);
  }

  // Vision tool
  const visionProvider = config.visionLLM ? createProvider(config.visionLLM, sharedPassphrase) : provider;
  const visionModel = config.visionLLM?.model ?? config.mainLLM.model;
  const visionService = new VisionService(visionProvider, visionModel);
  toolRegistry.register(createVisionTool(visionService));

  // Image generation tool — imageGen.enabled かつ active profile があるときのみ登録
  // (browser ゲートと同型。 無効時はツールを出さない)。 docs/image-generation.md §8
  const imageService = new ImageService(config, sharedPassphrase);
  if (config.imageGen) {
    if (imageService.isEnabled()) {
      toolRegistry.register(createImageGenerateTool(imageService, config));
    } else {
      console.log(chalk.dim("ℹ 画像生成機能 (image_generate) は無効: /image on または /image setup で有効化"));
    }
  }
  // imageGen 未設定 (undefined) なら何も表示しない (初心者ノイズ回避)

  // MCP servers
  // Phase F-1b: 起動時 --no-mcp フラグ / config.mcpEnabled で全体 ON/OFF を制御。
  // 設定ファイル (mcp-servers.json) は残したまま、 接続だけスキップできる。
  const mcpManager = new MCPManager(process.cwd(), getPluginMcpSources(plugins));
  const mcpDisabledBySafeMode = !startupMode.customizations.mcp;
  const mcpDisabledByCli = args.includes("--no-mcp");
  const mcpDisabledByCfg = config.mcpEnabled === false;
  if (mcpDisabledBySafeMode || mcpDisabledByCli || mcpDisabledByCfg) {
    const disabledBy = mcpDisabledBySafeMode ? "--safe-mode" : mcpDisabledByCli ? "--no-mcp" : "config";
    if (mcpDisabledBySafeMode) {
      mcpManager.disableForSession(disabledBy);
    } else {
      mcpManager.setGlobalEnabled(false);
    }
    console.log(chalk.dim(`  MCP: disabled by ${disabledBy}`));
  }
  // Phase F: REPL から個別 disable した server を再起動後も維持
  if (Array.isArray(config.disabledMcpServers)) {
    for (const name of config.disabledMcpServers) {
      mcpManager.disableServer(name);
    }
    if (config.disabledMcpServers.length > 0) {
      console.log(
        chalk.dim(`  MCP: ${config.disabledMcpServers.length} server(s) skipped by config.disabledMcpServers`),
      );
    }
  }
  await mcpManager.connectAll(toolRegistry);

  // Permissions
  const permissions = new PermissionManager(config.security, (tool) => {
    // "許可 (設定に保存)" 選択時にconfig.jsonを更新
    if (!config.security.autoApproveTools.includes(tool)) {
      config.security.autoApproveTools.push(tool);
      saveConfig(config);
    }
  });

  // Hooks
  const hookManager = new HookManager();
  hookManager.loadHooks(process.cwd(), getPluginHookSources(plugins), {
    enabled: startupMode.customizations.hooks,
  });

  // Context window: 明示設定 > プロバイダ getModelInfo > モデル名ヒューリスティック。解決不能なら起動を止める。
  let contextWindow = config.mainLLM.contextWindow ?? 0;
  let ctxSource = contextWindow > 0 ? "config" : "";
  if (!ctxSource) {
    try {
      const modelInfo = await provider.getModelInfo(config.mainLLM.model);
      if (modelInfo.contextLength > 0) {
        contextWindow = modelInfo.contextLength;
        ctxSource = "provider";
      }
    } catch (e) {
      getOpsLogger().warn("config", "getModelInfo failed for contextWindow resolution", {
        model: config.mainLLM.model,
        provider: config.mainLLM.providerType,
        error: String(e),
      });
    }
  }
  if (!ctxSource) {
    const inferred = inferContextLength(config.mainLLM.model);
    if (inferred > 0) {
      contextWindow = inferred;
      ctxSource = "heuristic";
    }
  }
  if (!ctxSource) {
    throw new Error(
      `mainLLM.contextWindowを解決できません (provider=${config.mainLLM.providerType}, model=${config.mainLLM.model})。` +
        " config.jsonのmainLLM.contextWindowへ実際のトークン数を設定してください。推測値では起動しません。",
    );
  }
  getOpsLogger().info("config", "contextWindow resolved", {
    contextWindow,
    source: ctxSource,
    model: config.mainLLM.model,
    provider: config.mainLLM.providerType,
  });

  const restoredStates: string[] = [];

  // Autorun mode (保存された状態があれば復元)
  if (config.autorunMode) {
    permissions.setAutorunMode(true);
    restoredStates.push("autorun: ON");
  }

  // maxParallelTools がデフォルト(3)以外なら表示
  if (config.maxParallelTools && config.maxParallelTools !== 3) {
    restoredStates.push(`parallel: ${config.maxParallelTools}`);
  }

  // Skill registry (before AgentLoop to inject into system prompt)
  const skillRegistry = new SkillRegistry();
  const skills = startupMode.customizations.skills ? [...loadAllSkills(), ...loadPluginSkills(plugins)] : [];
  for (const skill of skills) {
    skillRegistry.register(skill);
  }
  // Phase F (Skills ON/OFF): 起動時の --no-skills フラグ / config.skillsEnabled / config.disabledSkills を反映
  const skillsDisabledByCli = args.includes("--no-skills");
  if (skillsDisabledByCli || config.skillsEnabled === false) {
    skillRegistry.setGlobalEnabled(false);
    console.log(chalk.dim(`  Skills: disabled by ${skillsDisabledByCli ? "--no-skills" : "config"}`));
  }
  if (Array.isArray(config.disabledSkills)) {
    for (const name of config.disabledSkills) {
      skillRegistry.disableSkill(name);
    }
    if (config.disabledSkills.length > 0) {
      console.log(chalk.dim(`  Skills: ${config.disabledSkills.length} skill(s) skipped by config.disabledSkills`));
    }
  }
  setSkillRegistry(skillRegistry);
  setSkillPermissionManager(permissions);
  for (const tool of createWorkflowLearningTools(workflowLearner, skillRegistry)) {
    toolRegistry.register(tool);
  }

  // Second LLM (Agent Loop作成前に初期化 — システムプロンプトに反映するため)
  const secondLLMManager = new SecondLLMManager(toolRegistry, permissions);
  const secondLlmConfig = config.secondLLM ?? undefined;
  if (secondLlmConfig && secondLlmConfig.enabled && secondLlmConfig.endpoint) {
    // メインLLMで合言葉を取得済みなら使い回す。それでも復号失敗時のみ再プロンプト。
    let passphrase: string | undefined = sharedPassphrase;
    if (secondLlmConfig.endpoint.apiKey && CredentialVault.isEncrypted(secondLlmConfig.endpoint.apiKey)) {
      // メイン側パスフレーズで復号できるかテスト
      const testDecrypt = passphrase ? CredentialVault.resolve(secondLlmConfig.endpoint.apiKey, passphrase) : "";
      if (!testDecrypt) {
        // メイン用と異なる、もしくは未設定なので別途プロンプト
        const { inquirer } = await import("./cli/prompt-gate.js");
        const { secret } = await withPrompt(() =>
          inquirer.prompt([
            {
              type: "password",
              name: "secret",
              message: `Second LLM (${secondLlmConfig.endpoint.providerType})の暗号化キーを復号するための合言葉:\n >`,
              mask: "*",
            },
          ]),
        );
        passphrase = secret;
      }
    }
    // 初期化失敗（設定不備など）でアプリ自体が起動不能になるのを防ぐ。
    // セカンドLLMは無効化したまま起動を続行し、ユーザーが /second-llm で設定を直せるようにする。
    try {
      if (passphrase) {
        secondLLMManager.initialize(secondLlmConfig, passphrase);
      } else {
        secondLLMManager.initialize(secondLlmConfig);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `\n⚠️  セカンドLLMの初期化に失敗しました: ${msg}\n` +
          `   セカンドLLMを無効化して起動を続行します。/second で設定を確認してください。\n`,
      );
    }
    if (secondLLMManager.isAvailable()) {
      setSecondLLMManager(secondLLMManager);
      setFederatedSecondLLMManager(secondLLMManager);
      toolRegistry.register(secondLLMAgentTool);
      // Phase E-2: federated_delegate (期待出力の自動 validation 付き委譲)
      toolRegistry.register(federatedDelegateTool);
    }
  }
  const hasSecondLLM = secondLLMManager.isAvailable();

  // Build skill infos for system prompt
  const skillInfos = skillRegistry.list().map((s) => ({
    name: s.name,
    trigger: s.trigger,
    description: s.description,
    disableModelInvocation: s.disableModelInvocation,
  }));

  // Agent loop
  // サンプリングパラメータ: 設定にあれば渡す、なければ空（サーバー側デフォルトに委ねる）
  const samplingParams = {
    ...(config.mainLLM.temperature !== undefined && { temperature: config.mainLLM.temperature }),
    ...(config.mainLLM.top_p !== undefined && { top_p: config.mainLLM.top_p }),
    ...(config.mainLLM.top_k !== undefined && { top_k: config.mainLLM.top_k }),
    ...(config.mainLLM.repetition_penalty !== undefined && { repetition_penalty: config.mainLLM.repetition_penalty }),
  };

  const llmProfiles = buildLLMProfiles(config, hasSecondLLM);

  // セッションID と運用ログを初期化 (セッションJSONL と運用ログでファイル名を揃える)
  const sessionId = createSessionId();
  const opsCfg = config.logging?.ops;
  // 環境変数 LLM_LOG_LEVEL が設定されていれば config を上書き (CIや調査時の即時切替用)
  const envLevel = process.env.LLM_LOG_LEVEL ? parseOpsLogLevel(process.env.LLM_LOG_LEVEL) : null;
  initOpsLogger({
    sessionId,
    level: envLevel ?? opsCfg?.level ?? "info",
    enabled: opsCfg?.enabled ?? true,
    pathOverride: opsCfg?.path,
  });
  getOpsLogger().info("session", "session started", {
    sessionId,
    mainModel: config.mainLLM.model,
    provider: config.mainLLM.providerType,
  });
  setCrashContext({ sessionId });

  // 古いログ・セッションの世代管理 (PR-15)。削除したら1行で告知する
  try {
    const retention = applyLogRetention(config.logging?.retention);
    for (const notice of retention.notices) {
      console.log(chalk.gray(notice));
      getOpsLogger().info("retention", notice, {
        deletedLogs: retention.deletedLogs,
        deletedSessions: retention.deletedSessions,
      });
    }
  } catch (e) {
    // 掃除の失敗で起動を止めない
    getOpsLogger().warn("retention", "log retention failed", { error: String(e) });
  }

  // 更新通知 (PR-14)。対話セッションのみ・非同期・失敗は黙ってスキップ。
  // await しない (起動をネットワーク待ちにしない)。
  if (process.stdout.isTTY && config.updateCheck?.enabled !== false) {
    void checkForUpdate().then((notice) => {
      if (notice) console.log(chalk.yellow(`  ${notice}`));
    });
  }

  const agent = new AgentLoop(
    provider,
    config.mainLLM.model,
    toolRegistry,
    permissions,
    contextWindow,
    config.context.compressionThreshold,
    hookManager,
    skillInfos,
    "main",
    sessionId,
    config.streamingDisplay ?? false,
    config.maxParallelTools ?? 3,
    hasSecondLLM,
    samplingParams,
    !!config.obsidian?.vaultPath,
    secondLLMManager,
    llmProfiles,
    startupMode.safeMode,
  );

  // 起動時の provider は config.mainLLM から作っているので、実行中バインディングとして記録する
  // (docs/model-apply-immediacy.md §3.1)。これが無いと「設定したのに反映されていない」を検出できない。
  agent.setLiveBinding(config.mainLLM);

  // クラッシュ時の緊急セッション保存 (agent 確定後に登録)。saveCurrentSession は同期処理。
  setCrashContext({ saveSession: () => agent.saveCurrentSession() });

  // opt-in 入力圧縮モード: 有効時のみ、起動時に一度だけ project指示/メモを圧縮 (閾値超過時)。
  // docs/input-compression-design.md
  if (config.inputCompression && !startupMode.safeMode) {
    await agent.applyInputCompression(true);
  }

  // Plan manager
  const planManager = new PlanManager();
  agent.setPlanManager(planManager);
  setPlanManager(planManager);

  // Chat logger (Obsidian Vault にチャットログを保存)
  if (config.chatLog?.enabled && config.chatLog.vaultPath) {
    const chatLogger = new ChatLogger(config.chatLog);
    agent.setChatLogger(chatLogger);
    restoredStates.push(`chatlog: ${config.chatLog.vaultPath}`);
  }

  // Sub-agent manager
  const pluginAgentLoader = new AgentDefinitionLoader(getPluginAgentSources(plugins), {
    includeCustomizations: startupMode.customizations.customAgents,
  });
  const subAgentManager = new SubAgentManager(
    provider,
    config.mainLLM.model,
    toolRegistry,
    permissions,
    skillRegistry,
    pluginAgentLoader,
  );
  subAgentManager.initializeWorktreeRecovery();
  setSubAgentManager(subAgentManager);
  setSkillSubAgentManager(subAgentManager);

  // Check for --resume flag
  const resumeIdx = args.indexOf("--resume");
  if (resumeIdx !== -1) {
    const sessionId = args[resumeIdx + 1];
    if (sessionId) {
      const { loadSession } = await import("./agent/session-manager.js");
      const session = loadSession(sessionId);
      if (session) {
        agent.restoreSession(session);
        console.log(`  Resumed session: ${sessionId}`);
      }
    }
  } else if (args.includes("--continue")) {
    const latest = getLatestSession();
    if (latest) {
      agent.restoreSession(latest);
      console.log(`  Resumed latest session: ${latest.meta.id}`);
    }
  }

  // Room モデル (docs/room-model-design.md): 固定 3 Room の管理と受信順グローバル FIFO キュー。
  // 各サーフェス (REPL/Discord/Slack) はこれを共有する。
  const roomManager = new RoomManager(config, agent);
  const roomQueue = new RoomRunQueue();

  // チェックポイントの古いセッション掃除は、 resume 解決後 (= 現在セッションが確定し
  // 保護対象になった後) に実行する。 復元対象のチェックポイントを誤って消さないため。
  agent.runCheckpointMaintenance();
  // 有効なのに git が無いと「ON のつもりで実は記録ゼロ」 になる (見かけ倒し)。 起動時に一度警告。
  {
    const cp = agent.getCheckpointManager();
    if (cp.getStatus().enabled && !(await cp.isGitReady())) {
      throw new Error(
        "チェックポイントは有効ですがGit capabilityを利用できません。" +
          "Gitをインストールして再起動するか、configのcheckpoints.enabledをfalseにしてください。" +
          "スナップショット0件のまま起動は継続しません。",
      );
    }
  }

  // Run session start hooks
  await hookManager.runSessionHooks("start");

  // ── バックグラウンドモード (--background): REPL を起動せず Discord 受信 (Gateway 接続) のみ実行 ──
  if (args.includes("--background")) {
    const discord = config.discord;
    if (!discord?.applicationId || !discord?.botToken) {
      console.error("  --background モードには Discord の applicationId と botToken が必要です。");
      console.error("  通常モードで起動して /discord app-id と /discord bot-token を設定してください。");
      process.exit(1);
    }
    // Room モデル: --background は REPL なしで Discord(Room B) を resting room とする。
    roomManager.initBackgroundSurface("discord");
    const server = new DiscordInteractionServer(discord, agent, roomManager, roomQueue, skillRegistry, mcpManager, () =>
      saveConfig(config),
    );
    try {
      await server.start();
      console.log(`  [Background Mode] Discord に接続しました${server.botUser ? ` (Bot: ${server.botUser})` : ""}`);
      console.log("  Ctrl+C で終了します。");
    } catch (e) {
      console.error(`  Discord への接続に失敗しました: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    // SIGINT でグレースフルシャットダウン
    process.on("SIGINT", async () => {
      console.log("\n  シャットダウン中...");
      server.stop();
      await hookManager.runSessionHooks("stop");
      agent.saveCurrentSession();
      await mcpManager.disconnectAll();
      await playwrightManager?.close();
      process.exit(0);
    });
    // プロセスを生かしておく (WS 接続と heartbeat タイマーがイベントループを維持する)
    return;
  }

  // ── Slackモード (--slack): REPL の代わりに Slack Bot を起動 ──
  if (args.includes("--slack")) {
    const slackConfig = config.slack;
    if (!slackConfig?.botToken || !slackConfig?.appToken) {
      console.error("  --slack モードには Slack の botToken と appToken が必要です。");
      console.error("  通常モードで起動して /slack bot-token と /slack app-token を設定してください。");
      process.exit(1);
    }

    const { SlackBot } = await import("./slack/slack-bot.js");
    // Room モデル: --slack は REPL なしで Slack(Room C) を resting room とする。
    roomManager.initBackgroundSurface("slack");
    const slackBot = new SlackBot(slackConfig, agent, roomManager, roomQueue, skillRegistry, mcpManager);

    try {
      await slackBot.start();
      console.log("  [Slack Mode] Slack Bot 起動 (Socket Mode)");
      console.log("  Slack でメンションまたは DM でメッセージを送信してください。");
      console.log("  CLI: exit / status のみ受付。Ctrl+C で終了。");
    } catch (e) {
      console.error(`  Slack Bot 起動失敗: ${e}`);
      process.exit(1);
    }

    // 最小CLI（exit/status のみ）
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line: string) => {
      const cmd = line.trim().toLowerCase();
      if (cmd === "exit" || cmd === "quit") {
        slackBot.stop().then(() => process.exit(0));
      } else if (cmd === "status") {
        console.log(`  Slack Bot: ${slackBot.running ? "running" : "stopped"}`);
        console.log(`  Agent processing: ${agent.isProcessing}`);
      } else {
        console.log("  Commands: exit, status");
      }
    });

    // SIGINT でグレースフルシャットダウン
    process.on("SIGINT", async () => {
      console.log("\n  シャットダウン中...");
      await slackBot.stop();
      await hookManager.runSessionHooks("stop");
      agent.saveCurrentSession();
      await mcpManager.disconnectAll();
      await playwrightManager?.close();
      process.exit(0);
    });

    return;
  }

  // Display welcome
  displayWelcome(
    config.mainLLM.model,
    // クラウド系は baseUrl が無いので endpoint を表示
    config.mainLLM.baseUrl ?? config.mainLLM.endpoint,
    PROVIDER_LABELS[config.mainLLM.providerType],
    contextWindow,
    skills.length,
    secondLlmConfig,
  );

  // 復元された状態を表示
  if (restoredStates.length > 0) {
    console.log(`  Restored: ${restoredStates.join(", ")}`);
  }

  // Room モデル: REPL の現セッション (新規 or resume 済み) を Room A にバインドする。
  roomManager.initReplSession();

  // Start REPL (sharedPassphrase は /swap や /second setup 後の Provider 再生成で使い回す)
  const loopManager = new LoopManager();
  const repl = new REPL(
    agent,
    config,
    skillRegistry,
    planManager,
    secondLLMManager,
    sharedPassphrase,
    mcpManager,
    visionService,
    imageService,
    roomManager,
    roomQueue,
    loopManager,
    workflowLearner,
  );
  // schedule toolsはREPL sessionだけに登録する。background Discord/Slack面では公開しない。
  for (const tool of createScheduleTools(loopManager, (prompt, id) => repl.runScheduledPrompt(prompt, id))) {
    toolRegistry.register(tool);
  }
  await repl.start();

  // Cleanup
  await hookManager.runSessionHooks("stop");
  agent.saveCurrentSession();
  await mcpManager.disconnectAll();
  await playwrightManager?.close();
  // LLM サーバへの undici keep-alive ソケットを明示的に閉じる。
  // undici Agent / グローバル dispatcher は仕様上コネクションをプールし
  // keepAliveMaxTimeout (既定10分) までソケットを開いたまま保持する。これを閉じないと
  // プール済みソケットが open handle として残り、/quit 後にイベントループが枯渇せず
  // プロセスが終了しない (= "Goodbye!" 表示後ターミナルに戻らない) 原因になる。
  await shutdownHttpClient();

  // 出力の差し替えを元に戻す (process.on("exit") でも保険をかけてある)
  restoreOutput();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
