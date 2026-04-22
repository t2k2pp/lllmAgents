#!/usr/bin/env node

import { configExists, loadConfig, saveConfig } from "./config/config-manager.js";
import { runSetupWizard } from "./config/setup-wizard.js";
import { createProvider } from "./providers/provider-factory.js";
import { AgentLoop } from "./agent/agent-loop.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { PermissionManager } from "./security/permission-manager.js";
import { PlaywrightManager } from "./browser/playwright-manager.js";
import { VisionService, createVisionTool } from "./tools/definitions/vision.js";
import { PlanManager } from "./agent/plan-mode.js";
import { SubAgentManager } from "./agent/sub-agent.js";
import { SkillRegistry } from "./skills/skill-registry.js";
import { loadAllSkills } from "./skills/skill-loader.js";

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
import { todoWriteTool } from "./tools/definitions/todo-write.js";
import { askUserTool } from "./tools/definitions/ask-user.js";
import { createBrowserTools } from "./tools/definitions/browser.js";
import { taskTool, taskOutputTool, setSubAgentManager } from "./tools/definitions/task.js";
import { enterPlanModeTool, exitPlanModeTool, setPlanManager } from "./tools/definitions/plan-mode.js";
import { skillTool, setSkillRegistry, setSkillPermissionManager, setSkillSubAgentManager } from "./tools/definitions/skill.js";
import { secondLLMConsultTool, secondLLMAgentTool, setSecondLLMManager } from "./tools/definitions/second-llm.js";
import { knowledgeSaveTool, setObsidianConfig } from "./tools/definitions/knowledge-save.js";
import { knowledgeSearchTool } from "./tools/definitions/knowledge-search.js";
import { responseCompleteTool } from "./tools/definitions/response-complete.js";

import { displayWelcome } from "./cli/renderer.js";
import { REPL } from "./cli/repl.js";
import { PROVIDER_LABELS } from "./config/types.js";
import { buildLLMProfiles } from "./agent/llm-profiles.js";
import { DiscordInteractionServer } from "./discord/interaction-server.js";
import { CredentialVault } from "./security/credential-vault.js";
import { getLatestSession } from "./agent/session-manager.js";
import { HookManager } from "./hooks/hook-manager.js";
import { MCPManager } from "./mcp/mcp-manager.js";
import { SecondLLMManager } from "./second-llm/second-llm-manager.js";
import { ChatLogger } from "./agent/chat-logger.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // イベントリスナーのメモリリーク警告対策 (inquirer等が多用されるため)
  process.stdin.setMaxListeners(100);
  process.stdout.setMaxListeners(100);

  // Setup wizard
  if (args.includes("--setup") || !configExists()) {
    await runSetupWizard();
    if (args.includes("--setup")) {
      process.exit(0);
    }
  }

  const config = loadConfig();

  if (!config.mainLLM.model) {
    console.error("Model not configured. Run: localllm --setup");
    process.exit(1);
  }

  // Create provider
  const provider = createProvider(config.mainLLM);

  // Create tool registry with ALL tools
  const toolRegistry = new ToolRegistry();

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
  toolRegistry.register(askUserTool);
  toolRegistry.register(responseCompleteTool);

  // Plan mode tools
  toolRegistry.register(enterPlanModeTool);
  toolRegistry.register(exitPlanModeTool);

  // Sub-agent tools
  toolRegistry.register(taskTool);
  toolRegistry.register(taskOutputTool);

  // Skill tool
  toolRegistry.register(skillTool);

  // Browser tools
  const playwrightManager = new PlaywrightManager();
  const browserTools = createBrowserTools(playwrightManager);
  for (const tool of browserTools) {
    toolRegistry.register(tool);
  }

  // Vision tool
  const visionProvider = config.visionLLM
    ? createProvider(config.visionLLM)
    : provider;
  const visionModel = config.visionLLM?.model ?? config.mainLLM.model;
  const visionService = new VisionService(visionProvider, visionModel);
  toolRegistry.register(createVisionTool(visionService));

  // MCP servers
  const mcpManager = new MCPManager(process.cwd());
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
  hookManager.loadHooks(process.cwd());

  // Context window
  let contextWindow = config.mainLLM.contextWindow ?? 4096;
  if (!config.mainLLM.contextWindow) {
    try {
      const modelInfo = await provider.getModelInfo(config.mainLLM.model);
      if (modelInfo.contextLength > 0) {
        contextWindow = modelInfo.contextLength;
      }
    } catch {
      // Use default
    }
  }

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
  const skills = loadAllSkills();
  for (const skill of skills) {
    skillRegistry.register(skill);
  }
  setSkillRegistry(skillRegistry);
  setSkillPermissionManager(permissions);

  // Second LLM (Agent Loop作成前に初期化 — システムプロンプトに反映するため)
  const secondLLMManager = new SecondLLMManager(toolRegistry, permissions);
  const secondLlmConfig = config.secondLLM ?? undefined;
  if (secondLlmConfig && secondLlmConfig.enabled && secondLlmConfig.endpoint) {
    let passphrase: string | undefined = undefined;
    if (secondLlmConfig.endpoint.apiKey && CredentialVault.isEncrypted(secondLlmConfig.endpoint.apiKey)) {
      const { default: inquirer } = await import("inquirer");
      const { secret } = await inquirer.prompt([
        {
          type: "password",
          name: "secret",
          message: `Second LLM (${secondLlmConfig.endpoint.providerType})の暗号化キーを復号するための合言葉:\n >`,
          mask: "*",
        },
      ]);
      passphrase = secret;
    }
    if (passphrase) {
      secondLLMManager.initialize(secondLlmConfig, passphrase);
    } else {
      secondLLMManager.initialize(secondLlmConfig);
    }
    if (secondLLMManager.isAvailable()) {
      setSecondLLMManager(secondLLMManager);
      toolRegistry.register(secondLLMConsultTool);
      toolRegistry.register(secondLLMAgentTool);
    }
  }
  const hasSecondLLM = secondLLMManager.isAvailable();

  // Build skill infos for system prompt
  const skillInfos = skillRegistry.list().map((s) => ({
    name: s.name,
    trigger: s.trigger,
    description: s.description,
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
    undefined,
    config.streamingDisplay ?? false,
    config.maxParallelTools ?? 3,
    hasSecondLLM,
    samplingParams,
    !!config.obsidian?.vaultPath,
    secondLLMManager,
    llmProfiles,
  );

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
  const subAgentManager = new SubAgentManager(provider, config.mainLLM.model, toolRegistry, permissions);
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

  // Run session start hooks
  await hookManager.runSessionHooks("start");

  // ── バックグラウンドモード (--background): REPL を起動せず Discord Interaction Server のみ実行 ──
  if (args.includes("--background")) {
    const discord = config.discord;
    if (!discord?.applicationId || !discord?.publicKey) {
      console.error("  --background モードには Discord の applicationId と publicKey が必要です。");
      console.error("  通常モードで起動して /discord app-id と /discord public-key を設定してください。");
      process.exit(1);
    }
    const port = discord.interactionPort ?? 3003;
    const server = new DiscordInteractionServer(discord, agent);
    try {
      await server.start();
      console.log(`  [Background Mode] Discord Interaction Server 起動 (port ${port})`);
      console.log("  Ctrl+C で終了します。");
    } catch (e) {
      console.error(`  Interaction Server 起動失敗: ${e}`);
      process.exit(1);
    }
    // SIGINT でグレースフルシャットダウン
    process.on("SIGINT", async () => {
      console.log("\n  シャットダウン中...");
      server.stop();
      await hookManager.runSessionHooks("stop");
      agent.saveCurrentSession();
      await mcpManager.disconnectAll();
      await playwrightManager.close();
      process.exit(0);
    });
    // プロセスを生かしておく (サーバーが listen しているので自動的に続く)
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
    const slackBot = new SlackBot(slackConfig, agent);

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
      await playwrightManager.close();
      process.exit(0);
    });

    return;
  }

  // Display welcome
  displayWelcome(
    config.mainLLM.model,
    config.mainLLM.baseUrl,
    PROVIDER_LABELS[config.mainLLM.providerType],
    contextWindow,
    skills.length,
    secondLlmConfig
  );

  // 復元された状態を表示
  if (restoredStates.length > 0) {
    console.log(`  Restored: ${restoredStates.join(", ")}`);
  }

  // Start REPL
  const repl = new REPL(agent, config, skillRegistry, planManager, secondLLMManager);
  await repl.start();

  // Cleanup
  await hookManager.runSessionHooks("stop");
  agent.saveCurrentSession();
  await mcpManager.disconnectAll();
  await playwrightManager.close();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
