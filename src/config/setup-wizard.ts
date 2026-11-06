import { inquirer, withPrompt } from "../cli/prompt-gate.js";
import chalk from "chalk";
import { createSpinner } from "../utils/spinner.js";
import {
  type Config,
  type LLMEndpoint,
  type ProviderType,
  DEFAULT_PORTS,
  PROVIDER_LABELS,
  LOCAL_PROVIDER_TYPES,
  getDefaultConfig,
} from "./types.js";
import { saveConfig } from "./config-manager.js";
import { createProviderByType } from "../providers/provider-factory.js";
import type { ModelInfo, SecondLLMProviderType } from "./types.js";
import { CONTEXT_SIZE_HINT, formatContextSize, parseContextSize } from "./context-size.js";

/** ローカル系プロバイダーのみを対象としたセットアップ結果 */
export interface LocalLLMSetupResult {
  endpoint: LLMEndpoint;
  /** 取得したモデル一覧 (UI 表示の補助に使う) */
  models: ModelInfo[];
}

export interface LocalLLMSetupOptions {
  /** プロンプト時に既定値として表示する現行設定 (REPL 再設定時に使う) */
  current?: Partial<Pick<LLMEndpoint, "providerType" | "baseUrl" | "model" | "contextWindow" | "description">>;
  /** 見出し表示用ラベル ("初回セットアップ" / "メインLLM 再設定" など) */
  headline?: string;
  /**
   * サーバーの種類が決まっている時 (/models Add new で選び済み) に渡す。 渡せば種類をもう一度聞かない。
   * current の種類と違う時は、 current の URL・モデル・枠を既定値に使わない。
   */
  providerType?: ProviderType;
}

/**
 * 初回セットアップ。 失敗時は process.exit(1) する (CLI 起動フローからのみ呼ぶこと)。
 * REPL からの再設定は runLocalLLMSetup を直接呼ぶ。
 */
export async function runSetupWizard(): Promise<Config> {
  console.log(chalk.bold("\n  LocalLLM Agent - Setup Wizard\n"));

  const config = getDefaultConfig();
  let mainResult: LocalLLMSetupResult;
  try {
    mainResult = await runLocalLLMSetup({ headline: "メインLLM" });
  } catch (e) {
    console.error(chalk.red(`  セットアップに失敗しました: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
  config.mainLLM = mainResult.endpoint;

  // Vision sub-LLM (初回 wizard のみ)
  const { useVisionLLM } = await withPrompt(() =>
    inquirer.prompt<{ useVisionLLM: boolean }>([
      {
        type: "confirm",
        name: "useVisionLLM",
        message: "画像認識用に別のLLMを使いますか？",
        default: false,
      },
    ]),
  );

  if (useVisionLLM) {
    try {
      const visionConfig = await setupVisionLLM();
      config.visionLLM = visionConfig;
    } catch (e) {
      console.error(
        chalk.red(`  Vision LLM セットアップに失敗しました: ${e instanceof Error ? e.message : String(e)}`),
      );
      process.exit(1);
    }
  } else {
    config.visionLLM = null;
  }

  saveConfig(config);
  console.log(chalk.green("\n  設定を保存しました。\n"));
  console.log(chalk.dim(`  Model: ${config.mainLLM.model} @ ${config.mainLLM.baseUrl}`));
  if (config.mainLLM.contextWindow) {
    console.log(chalk.dim(`  Context: ${formatContextSize(config.mainLLM.contextWindow)}`));
  }
  if (config.mainLLM.description) {
    console.log(chalk.dim(`  特性:  ${config.mainLLM.description}`));
  }
  if (config.visionLLM) {
    console.log(chalk.dim(`  Vision: ${config.visionLLM.model} @ ${config.visionLLM.baseUrl}`));
  }
  console.log();

  return config;
}

/**
 * ローカル系LLM (ollama/lmstudio/llamacpp/vllm) のセットアップフロー。
 * REPL の `/models` Add new と初回 wizard の両方から呼ばれる。
 * 失敗時は throw する。 呼び出し側で catch してメッセージ表示すること。
 *
 * クラウド系 (azure-* / vertex-ai) はこの関数の対象外。 REPL 側の setupAzureLLM 等を使うこと。
 */
export async function runLocalLLMSetup(opts: LocalLLMSetupOptions = {}): Promise<LocalLLMSetupResult> {
  if (opts.headline) {
    console.log(chalk.bold(`\n  ── ${opts.headline} セットアップ ──\n`));
  }

  // 1. Provider type (呼び出し側で選び済みなら聞き直さない)
  // 選び済みの種類が今の設定と違う時、 今の設定の URL・モデル・枠は別のサーバーの値なので既定値に使わない
  const current =
    opts.providerType && opts.current?.providerType && opts.current.providerType !== opts.providerType
      ? undefined
      : opts.current;
  const providerType = opts.providerType ?? (await askLocalProviderType(current?.providerType));
  if (opts.providerType) {
    console.log(chalk.dim(`  LLMサーバーの種類: ${PROVIDER_LABELS[opts.providerType]}`));
  }

  // 2. Host
  const currentHost = parseHostPort(current?.baseUrl);
  const { host } = await withPrompt(() =>
    inquirer.prompt<{ host: string }>([
      {
        type: "input",
        name: "host",
        message: "サーバーのIPアドレスまたはホスト名:",
        default: currentHost.host ?? "localhost",
      },
    ]),
  );

  // 3. Port (provider 既定値、または現行値)
  const defaultPort = currentHost.port ?? DEFAULT_PORTS[providerType];
  const { port } = await withPrompt(() =>
    inquirer.prompt<{ port: number }>([
      {
        type: "number",
        name: "port",
        message: "ポート番号:",
        default: defaultPort,
      },
    ]),
  );

  const baseUrl = `http://${host}:${port}`;

  // 4. 接続テスト + モデル一覧
  const models = await connectAndListModels(providerType, baseUrl);

  // 5. モデル選択
  const { modelName } = await withPrompt(() =>
    inquirer.prompt<{ modelName: string }>([
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
        default: current?.model,
      },
    ]),
  );

  const selectedModel = models.find((m) => m.name === modelName)!;

  // 6. Context window
  // 前の枠を既定にするのは同じモデルを選び直した時だけ (別のモデルなら、 そのモデルの上限)
  const defaultCtx =
    (current?.model === modelName ? current?.contextWindow : undefined) ??
    (selectedModel.contextLength > 0 ? selectedModel.contextLength : 4096);
  // 一覧と同じ「131K」「1M」でも入力できる (K=1,000。 解釈できない入力は既定値に置き換えず、 もう一度聞く)
  const { contextWindowText } = await withPrompt(() =>
    inquirer.prompt<{ contextWindowText: string }>([
      {
        type: "input",
        name: "contextWindowText",
        message: `コンテキストウインドウサイズ (トークン数。 131072 / 131K / 1M など):`,
        default: String(defaultCtx),
        validate: (v: string) => parseContextSize(v) !== null || CONTEXT_SIZE_HINT,
      },
    ]),
  );
  const contextWindow = parseContextSize(contextWindowText) as number;
  console.log(chalk.dim(`  → ${contextWindow.toLocaleString("en-US")} トークン`));

  // 7. 特性説明 (任意)
  console.log(chalk.dim("\n  モデルの特性を記述しておくと、サブエージェント委任時の判断材料になります。"));
  console.log(chalk.dim('  例: "MoE 32B。日本語堅牢で推論・企画に強い。中速"'));
  console.log(chalk.dim('      "Dense 13B。高速・コーディング特化・日本語苦手"'));
  console.log(chalk.dim("  (空のままEnterで後から /models → Edit で設定可)"));
  const { description } = await withPrompt(() =>
    inquirer.prompt<{ description: string }>([
      {
        type: "input",
        name: "description",
        message: "LLMの特性説明 (100〜300文字推奨、任意):",
        default: current?.description ?? "",
      },
    ]),
  );

  const endpoint: LLMEndpoint = {
    providerType,
    baseUrl,
    model: modelName,
    contextWindow,
  };
  if (description.trim()) {
    endpoint.description = description.trim();
  }

  return { endpoint, models };
}

/** ローカル系 LLM サーバーの種類を聞く (初回 wizard など、 種類が決まっていない時)。 */
async function askLocalProviderType(current: SecondLLMProviderType | undefined): Promise<ProviderType> {
  const { providerType } = await withPrompt(() =>
    inquirer.prompt<{ providerType: ProviderType }>([
      {
        type: "list",
        name: "providerType",
        message: "LLMサーバーの種類を選択してください:",
        choices: LOCAL_PROVIDER_TYPES.map((key) => ({
          name: PROVIDER_LABELS[key],
          value: key,
        })),
        default: current,
      },
    ]),
  );
  return providerType;
}

/**
 * 指定 URL に接続テストし、 モデル一覧を取得する。 失敗時は throw。
 * REPL の host/port 変更後の確認表示にも使う。
 */
export async function connectAndListModels(providerType: ProviderType, baseUrl: string): Promise<ModelInfo[]> {
  const provider = createProviderByType(providerType, baseUrl);

  const spinner = createSpinner(`${baseUrl} に接続中...`).start();
  const connected = await provider.testConnection();
  if (!connected) {
    spinner.fail(`${baseUrl} に接続できませんでした`);
    throw new Error(`${baseUrl} に接続できません。 サーバーが起動しているか確認してください。`);
  }
  spinner.succeed("接続成功");

  const modelSpinner = createSpinner("モデル一覧を取得中...").start();
  let models: ModelInfo[];
  try {
    models = await provider.listModels();
  } catch (e) {
    modelSpinner.fail("モデル一覧の取得に失敗しました");
    throw e instanceof Error ? e : new Error(String(e));
  }

  if (models.length === 0) {
    modelSpinner.fail("利用可能なモデルがありません");
    throw new Error("サーバーは応答しましたが、 利用可能なモデルがありません。");
  }
  modelSpinner.succeed(`${models.length} 個のモデルが見つかりました`);
  return models;
}

/** baseUrl から host/port を抽出。 パース失敗時は両方 undefined */
function parseHostPort(baseUrl: string | undefined): { host?: string; port?: number } {
  if (!baseUrl) return {};
  try {
    const u = new URL(baseUrl);
    const port = u.port ? parseInt(u.port, 10) : undefined;
    return { host: u.hostname, port: Number.isFinite(port) ? port : undefined };
  } catch {
    return {};
  }
}

async function setupVisionLLM() {
  console.log(chalk.dim("\n  --- 画像認識用LLM設定 ---\n"));

  const { visionProviderType } = await withPrompt(() =>
    inquirer.prompt<{ visionProviderType: ProviderType }>([
      {
        type: "list",
        name: "visionProviderType",
        message: "画像認識LLMサーバーの種類:",
        choices: (Object.keys(PROVIDER_LABELS) as ProviderType[]).map((key) => ({
          name: PROVIDER_LABELS[key],
          value: key,
        })),
      },
    ]),
  );

  const defaultPort = DEFAULT_PORTS[visionProviderType];
  const { visionHost } = await withPrompt(() =>
    inquirer.prompt<{ visionHost: string }>([
      { type: "input", name: "visionHost", message: "サーバーのIPアドレス:", default: "localhost" },
    ]),
  );
  const { visionPort } = await withPrompt(() =>
    inquirer.prompt<{ visionPort: number }>([
      { type: "number", name: "visionPort", message: "ポート番号:", default: defaultPort },
    ]),
  );

  const visionBaseUrl = `http://${visionHost}:${visionPort}`;
  const visionProvider = createProviderByType(visionProviderType, visionBaseUrl);

  const spinner = createSpinner("Vision LLMに接続中...").start();
  const connected = await visionProvider.testConnection();
  if (!connected) {
    spinner.fail("接続失敗");
    throw new Error(`${visionBaseUrl} に接続できません。`);
  }
  spinner.succeed("接続成功");

  const models = await visionProvider.listModels();
  const visionModels = models.filter((m) => m.supportsVision);
  const modelList = visionModels.length > 0 ? visionModels : models;

  const { visionModel } = await withPrompt(() =>
    inquirer.prompt<{ visionModel: string }>([
      {
        type: "list",
        name: "visionModel",
        message: "画像認識モデルを選択:",
        choices: modelList.map((m) => ({
          name: `${m.name}${m.supportsVision ? " [Vision]" : ""}`,
          value: m.name,
        })),
      },
    ]),
  );

  return {
    providerType: visionProviderType,
    baseUrl: visionBaseUrl,
    model: visionModel,
  };
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}MB`;
  return `${bytes}B`;
}
