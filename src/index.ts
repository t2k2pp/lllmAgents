#!/usr/bin/env node

import { configExists, loadConfig } from "./config/config-manager.js";
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
import { webSearchTool } from "./tools/definitions/web-search.js";
import { todoWriteTool } from "./tools/definitions/todo-write.js";
import { askUserTool } from "./tools/definitions/ask-user.js";
import { createBrowserTools } from "./tools/definitions/browser.js";
import { taskTool, taskOutputTool, setSubAgentManager } from "./tools/definitions/task.js";
import { enterPlanModeTool, exitPlanModeTool, setPlanManager } from "./tools/definitions/plan-mode.js";
import { skillTool, setSkillRegistry } from "./tools/definitions/skill.js";
import { secondLLMConsultTool, secondLLMAgentTool, setSecondLLMManager } from "./tools/definitions/second-llm.js";

import { displayWelcome } from "./cli/renderer.js";
import { REPL } from "./cli/repl.js";
import { PROVIDER_LABELS } from "./config/types.js";
import { CredentialVault } from "./security/credential-vault.js";
import { getLatestSession } from "./agent/session-manager.js";
import { ContextModeManager } from "./context/context-mode.js";
import { HookManager } from "./hooks/hook-manager.js";
import { MCPManager } from "./mcp/mcp-manager.js";
import { SecondLLMManager } from "./second-llm/second-llm-manager.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

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
  toolRegistry.register(bashTool);

  // Web tools
  toolRegistry.register(webFetchTool);
  toolRegistry.register(webSearchTool);

  // Interactive tools
  toolRegistry.register(todoWriteTool);
  toolRegistry.register(askUserTool);

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
  const permissions = new PermissionManager(config.security);

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

  // Context mode
  const contextModeManager = new ContextModeManager();

  // Agent loop
  const agent = new AgentLoop(
    provider,
    config.mainLLM.model,
    toolRegistry,
    permissions,
    contextWindow,
    config.context.compressionThreshold,
    contextModeManager,
    hookManager,
  );

  // Plan manager
  const planManager = new PlanManager();
  agent.setPlanManager(planManager);
  setPlanManager(planManager);

  // Sub-agent manager
  const subAgentManager = new SubAgentManager(provider, config.mainLLM.model, toolRegistry, permissions);
  setSubAgentManager(subAgentManager);

  // Skill registry
  const skillRegistry = new SkillRegistry();
  const skills = loadAllSkills();
  for (const skill of skills) {
    skillRegistry.register(skill);
  }
  setSkillRegistry(skillRegistry);

  // Second LLM
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

  // Display welcome
  displayWelcome(
    config.mainLLM.model,
    config.mainLLM.baseUrl,
    PROVIDER_LABELS[config.mainLLM.providerType],
    contextWindow,
    skills.length,
    secondLlmConfig
  );

  // Start REPL
  const repl = new REPL(agent, config, skillRegistry, planManager, contextModeManager, secondLLMManager);
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
