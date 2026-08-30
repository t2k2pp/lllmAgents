import chalk from "chalk";

import type { SecondLLMConfig } from "../config/types.js";
import { getVersionString } from "../version.js";
import { screen } from "./screen-manager.js";

export function displayWelcome(
  model: string,
  baseUrl: string | undefined,
  providerType: string,
  contextWindow: number,
  skillCount: number,
  secondLlmConfig?: SecondLLMConfig,
): void {
  const ctxLabel = contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}K` : `${contextWindow}`;
  console.log(chalk.bold(`\n  LocalLLM Agent ${getVersionString()}`));
  // クラウド系 (Azure/Vertex) は baseUrl を持たないため、 endpoint 部分を省略
  const location = baseUrl ? ` @ ${baseUrl}` : "";
  console.log(chalk.dim(`  Model: ${model}${location} (${providerType})`));
  if (secondLlmConfig && secondLlmConfig.enabled && secondLlmConfig.endpoint) {
    console.log(
      chalk.dim(`  Second LLM: ${secondLlmConfig.endpoint.model} (${secondLlmConfig.endpoint.providerType})`),
    );
  }
  console.log(chalk.dim(`  Context: ${ctxLabel} tokens | Skills: ${skillCount}`));
  console.log(chalk.dim(`  CWD: ${process.cwd()}`));
  console.log(chalk.dim(`  Type /help for commands, /quit to exit.`));
  if (screen.isAlternate()) {
    console.log(chalk.dim(`  TUI履歴: PgUp / PgDn（通常scrollback: 次回起動時 --no-alt-screen）`));
  }
  console.log(chalk.dim(`  マルチライン: Shift+Enter / Ctrl+J (代替入力: \`\`\`)\n`));
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface RegistryHelpEntry {
  name: string;
  summary: string;
}

export function displayHelp(skills?: SkillSummary[], registryEntries?: RegistryHelpEntry[]): void {
  // レジストリ登録コマンド (src/cli/commands/ — PR-10) の行は自動生成する。
  // ここに手書きで行を足すのは旧 switch 方式のコマンドだけ。
  const registrySection = (registryEntries ?? [])
    .map((e) => `    ${chalk.cyan(e.name.padEnd(15))} ${e.summary}`)
    .join("\n");
  let skillSection: string;
  if (skills && skills.length > 0) {
    const lines = skills
      .map((s) => {
        const padded = `/${s.name}`.padEnd(20);
        return `    ${chalk.cyan(padded)} ${s.description}`;
      })
      .join("\n");
    skillSection = `\n  ${chalk.bold("スキル (直接呼び出し可能):")}\n${lines}\n`;
  } else {
    skillSection = `
  ${chalk.bold("スキル (直接呼び出し可能):")}
    ${chalk.cyan("/commit")}             コミットワークフロー
    ${chalk.cyan("/pr-review")}          PRコードレビュー
    ${chalk.cyan("/tdd")}                テスト駆動開発
    ${chalk.cyan("/build-fix")}          ビルドエラー修正
`;
  }

  console.log(`
  ${chalk.bold("コマンド:")}
    ${chalk.cyan("/help")}           このヘルプを表示
    ${chalk.cyan("/quit")}           終了
    ${chalk.cyan("/clear")}          会話履歴をクリア
    ${chalk.cyan("/context")}        コンテキスト使用状況の内訳 (引数で中身をダンプ: system|memory|skills|tools|messages)
    ${chalk.cyan("/compact")}        コンテキストを手動圧縮
    ${chalk.cyan("/capability")}     現在のLLM能力ティア (T1/T2/T3) と profile を表示
    ${chalk.cyan("/metrics")}        現セッションのテレメトリ (反復・bash累積・stuck-loop・トークン)
    ${chalk.cyan("/mcp")}            MCP サーバ管理 (status/on/off/reload/toggle <name>)
    ${chalk.cyan("/skills")}         スキル管理 (status/on/off/reload/toggle <name>)
    ${chalk.cyan("/model")}          現在のモデル情報
    ${chalk.cyan("/model <name>")}   モデルを切り替え
    ${chalk.cyan("/model list")}     利用可能なモデル一覧
    ${chalk.cyan("/model apply")}    設定値を実行中に反映 (設定と実行中がズレている時)
    ${chalk.cyan("/model setup")}    ローカル系LLMをウィザードで再設定 (npm run setup と同等)
    ${chalk.cyan("/model host")}     接続先のホスト or IP を変更（ポートは保持）
    ${chalk.cyan("/model port")}     接続先のポート番号を変更
    ${chalk.cyan("/model provider")} プロバイダー(ollama/vllm等)を変更
    ${chalk.cyan("/model description")} モデル特性説明
    ${chalk.cyan("/model temperature")} 温度設定 (top_p/top_k/rep_penaltyも同様、各コマンドで)
    ${chalk.cyan("/second")}         セカンドLLM管理 (status/url/provider/model/description/temperature等、/secondで全表示)
    ${chalk.cyan("/swap")}           メインLLM ⇔ セカンドLLM を入れ替え (-y で確認スキップ。alias: /switch)
    ${chalk.cyan("/profiles")}       LLM 接続プロファイル履歴 (矢印+スペース選択。 list / delete / help)
    ${chalk.cyan("/integrations")}   外部サービス連携の設定 (Discord / Slack / 会話ログ / Web検索)
    ${chalk.cyan("/todo")}           タスクリスト (active のみ。 all / archive サブコマンドあり)
    ${chalk.cyan("/goal-seek <goal>")} Goal Seek mode 開始 — acceptance criteria を立て合格まで自律実行
    ${chalk.cyan("/exit-goal-seek")}  Goal Seek mode を抜ける (acceptance 未達成でも user 明示で中断)
    ${chalk.cyan("/sessions [N]")}   保存済みセッション一覧 (デフォルト 20 件)
    ${chalk.cyan("/resume [id]")}    セッション復元 (引数なしで対話的選択)
    ${chalk.cyan("/fork [id]")}      会話を新しいセッションへ分岐 (元セッションは不変)
    ${chalk.cyan("/continue")}       最新セッションを復元
    ${chalk.cyan("/room")}           会話 Room (A/B/C) の表示・移動・再開 (REPL=A/Discord=B/Slack=C)
    ${chalk.cyan("/queue")}          受信順キューの待ち状況 (/queue clear で type-ahead 破棄)
    ${chalk.cyan("/memory")}         自動メモリ表示
    ${chalk.cyan("/remember <text>")} メモリに追記
    ${chalk.cyan("/plan")}           プランモードに入る
    ${chalk.cyan("/skills")}         利用可能なスキル一覧
    ${chalk.cyan("/status")}         全体ステータス
    ${chalk.cyan("/checkpoint")}     自動チェックポイント (status/on/off/list/restore <n>/diff <n>/clear)
    ${chalk.cyan("/sandbox")}        bash 封じ込めトグル (status/on/off。Mac/Linux/WSL2内=OSサンドボックス。Winネイティブは非対応)
    ${chalk.cyan("/cost")}           LLM 使用量・コストの可視化 (画像生成コスト含む)
    ${chalk.cyan("/image")}          画像生成 (on/off/setup <azure|sd-webui|comfyui>/use/list/test/gen <prompt>)
    ${chalk.cyan("/knowledge")}      Obsidianナレッジベース (vault設定/検索/一覧)
    ${chalk.cyan("/compress-input")}  入力圧縮モード切替（project指示/メモが閾値超過時に意図保持で圧縮、既定OFF）
    ${chalk.cyan("/try [N] <プロンプト>")}  試行錯誤モード: 評価付きで最大N回自動リトライ（デフォルト3回）
    ${chalk.cyan('/goal-loop [N] --check "<cmd>" <タスク>')}  決定的検証ゲート型ループ: cmd が exit 0 になるまで反復（既定8回）
    ${chalk.cyan("/loop [間隔] <プロンプト>")}  指定間隔でプロンプトを繰り返し実行
    ${chalk.cyan("/loop list")}      アクティブなループ一覧
    ${chalk.cyan("/loop stop [id|all]")}  ループを停止
${registrySection}
${skillSection}
  ${chalk.bold("入力:")}
    PgUp/PgDn   TUIの過去ログを遡る / 最新へ戻る（LLM・ツール実行中も有効）
    Shift+Enter  改行を挿入（マルチライン入力）
    Ctrl+J       改行を挿入（Shift+Enter非対応ターミナル用）
    \`\`\`          マルチライン入力モード（明示的な代替入力）
    @path        ファイル/フォルダの内容を参照
    Esc          処理を中断 / 入力中テキストをクリア
    Ctrl+C       現在の操作をキャンセル（2回でプロセス終了）
`);
}

export function displayError(message: string): void {
  console.log(chalk.red(`\n  Error: ${message}\n`));
}

export function displayDiff(oldText: string, newText: string, filePath: string): void {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  console.log(chalk.bold(`\n  --- ${filePath}`));
  console.log(chalk.bold(`  +++ ${filePath} (modified)`));

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === newLine) continue;

    if (oldLine !== undefined && newLine === undefined) {
      console.log(chalk.red(`  - ${oldLine}`));
    } else if (oldLine === undefined && newLine !== undefined) {
      console.log(chalk.green(`  + ${newLine}`));
    } else if (oldLine !== newLine) {
      console.log(chalk.red(`  - ${oldLine}`));
      console.log(chalk.green(`  + ${newLine}`));
    }
  }
  console.log();
}
