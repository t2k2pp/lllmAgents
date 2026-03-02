import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { Config, ProviderType, DEFAULT_PORTS, PROVIDER_LABELS, getDefaultConfig } from "./types.js";
import { saveConfig } from "./config-manager.js";
import { createProviderByType } from "../providers/provider-factory.js";
import type { ModelInfo } from "./types.js";

export async function runSetupWizard(): Promise<Config> {
  console.log(chalk.bold("\n  LocalLLM Agent - Setup Wizard\n"));

  const config = getDefaultConfig();

  // 1. Provider type
  const { providerType } = await inquirer.prompt<{ providerType: ProviderType }>([
    {
      type: "list",
      name: "providerType",
      message: "LLMサーバーの種類を選択してください:",
      choices: (Object.keys(PROVIDER_LABELS) as ProviderType[]).map((key) => ({
        name: PROVIDER_LABELS[key],
        value: key,
      })),
    },
  ]);

  // 2. Server address
  const defaultPort = DEFAULT_PORTS[providerType];
  const { host } = await inquirer.prompt<{ host: string }>([
    {
      type: "input",
      name: "host",
      message: "サーバーのIPアドレスまたはホスト名:",
      default: "localhost",
    },
  ]);

  const { port } = await inquirer.prompt<{ port: number }>([
    {
      type: "number",
      name: "port",
      message: "ポート番号:",
      default: defaultPort,
    },
  ]);

  const baseUrl = `http://${host}:${port}`;

  // 3. Connection test + model list
  const spinner = ora("サーバーに接続中...").start();
  const provider = createProviderByType(providerType, baseUrl);

  const connected = await provider.testConnection();
  if (!connected) {
    spinner.fail(`${baseUrl} に接続できませんでした`);
    console.log(chalk.yellow("サーバーが起動しているか確認してください。"));
    process.exit(1);
  }
  spinner.succeed("接続成功");

  const modelSpinner = ora("モデル一覧を取得中...").start();
  let models: ModelInfo[];
  try {
    models = await provider.listModels();
  } catch (e) {
    modelSpinner.fail("モデル一覧の取得に失敗しました");
    console.error(String(e));
    process.exit(1);
  }

  if (models.length === 0) {
    modelSpinner.fail("利用可能なモデルがありません");
    process.exit(1);
  }
  modelSpinner.succeed(`${models.length} 個のモデルが見つかりました`);

  // 4. Model selection
  const { modelName } = await inquirer.prompt<{ modelName: string }>([
    {
      type: "list",
      name: "modelName",
      message: "メインモデルを選択してください:",
      choices: models.map((m) => {
        const ctxLabel = m.contextLength > 0 ? ` (ctx: ${formatContextSize(m.contextLength)})` : "";
        const visionLabel = m.supportsVision ? " [Vision]" : "";
        const sizeLabel = m.size > 0 ? ` ${formatSize(m.size)}` : "";
        return {
          name: `${m.name}${sizeLabel}${ctxLabel}${visionLabel}`,
          value: m.name,
        };
      }),
    },
  ]);

  const selectedModel = models.find((m) => m.name === modelName)!;

  // 5. Context window
  const defaultCtx = selectedModel.contextLength > 0 ? selectedModel.contextLength : 4096;
  const { contextWindow } = await inquirer.prompt<{ contextWindow: number }>([
    {
      type: "number",
      name: "contextWindow",
      message: `コンテキストウインドウサイズ (トークン数):`,
      default: defaultCtx,
    },
  ]);

  config.mainLLM = {
    providerType,
    baseUrl,
    model: modelName,
    contextWindow: contextWindow || defaultCtx,
    temperature: 0.7,
  };

  // 6. Vision sub-LLM
  const { useVisionLLM } = await inquirer.prompt<{ useVisionLLM: boolean }>([
    {
      type: "confirm",
      name: "useVisionLLM",
      message: "画像認識用に別のLLMを使いますか？",
      default: false,
    },
  ]);

  if (useVisionLLM) {
    const visionConfig = await setupVisionLLM();
    config.visionLLM = visionConfig;
  } else {
    config.visionLLM = null;
  }

  // 7. Save
  saveConfig(config);
  console.log(chalk.green("\n  設定を保存しました。\n"));
  console.log(chalk.dim(`  Model: ${config.mainLLM.model} @ ${config.mainLLM.baseUrl}`));
  console.log(chalk.dim(`  Context: ${formatContextSize(config.mainLLM.contextWindow ?? defaultCtx)}`));
  if (config.visionLLM) {
    console.log(chalk.dim(`  Vision: ${config.visionLLM.model} @ ${config.visionLLM.baseUrl}`));
  }
  console.log();

  return config;
}

async function setupVisionLLM() {
  console.log(chalk.dim("\n  --- 画像認識用LLM設定 ---\n"));

  const { visionProviderType } = await inquirer.prompt<{ visionProviderType: ProviderType }>([
    {
      type: "list",
      name: "visionProviderType",
      message: "画像認識LLMサーバーの種類:",
      choices: (Object.keys(PROVIDER_LABELS) as ProviderType[]).map((key) => ({
        name: PROVIDER_LABELS[key],
        value: key,
      })),
    },
  ]);

  const defaultPort = DEFAULT_PORTS[visionProviderType];
  const { visionHost } = await inquirer.prompt<{ visionHost: string }>([
    { type: "input", name: "visionHost", message: "サーバーのIPアドレス:", default: "localhost" },
  ]);
  const { visionPort } = await inquirer.prompt<{ visionPort: number }>([
    { type: "number", name: "visionPort", message: "ポート番号:", default: defaultPort },
  ]);

  const visionBaseUrl = `http://${visionHost}:${visionPort}`;
  const visionProvider = createProviderByType(visionProviderType, visionBaseUrl);

  const spinner = ora("Vision LLMに接続中...").start();
  const connected = await visionProvider.testConnection();
  if (!connected) {
    spinner.fail("接続失敗");
    process.exit(1);
  }
  spinner.succeed("接続成功");

  const models = await visionProvider.listModels();
  const visionModels = models.filter((m) => m.supportsVision);
  const modelList = visionModels.length > 0 ? visionModels : models;

  const { visionModel } = await inquirer.prompt<{ visionModel: string }>([
    {
      type: "list",
      name: "visionModel",
      message: "画像認識モデルを選択:",
      choices: modelList.map((m) => ({
        name: `${m.name}${m.supportsVision ? " [Vision]" : ""}`,
        value: m.name,
      })),
    },
  ]);

  return {
    providerType: visionProviderType,
    baseUrl: visionBaseUrl,
    model: visionModel,
  };
}

function formatContextSize(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return `${tokens}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}MB`;
  return `${bytes}B`;
}
