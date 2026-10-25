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
    console.log(
      chalk.dim(
        screen.isMouseTrackingEnabled()
          ? `  TUI履歴: マウスホイール / PgUp / PgDn | 選択: Shift+ドラッグ / /tui mouse off`
          : `  選択・コピー: マウスドラッグ | TUI履歴: PgUp / PgDn（ホイール: /tui mouse on）`,
      ),
    );
  } else {
    console.log(chalk.dim(`  表示: inline | 選択: マウスドラッグ | 履歴: 端末のホイール（全画面: --alt-screen）`));
  }
  console.log(chalk.dim(`  モード切替: Shift+Tab | マルチライン: Shift+Enter / Ctrl+J (代替入力: \`\`\`)\n`));
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface RegistryHelpEntry {
  name: string;
  summary: string;
}

/**
 * /help に載せる旧 switch 方式 (repl.ts) のコマンド一覧。
 * 補完 (completer.ts の BUILTIN_COMMAND_DEFS) と同じコマンドだけを載せる。
 * 両者の対応は tests/cli/help-consistency.test.ts が検査する
 * (補完にあってヘルプに無い / ヘルプにあって補完に無いコマンドがあると落ちる)。
 * レジストリ登録コマンド (src/cli/commands/) はここに書かず、 getRegistryHelpEntries() から自動生成する。
 */
export const BUILTIN_HELP_ENTRIES: ReadonlyArray<{ usage: string; summary: string }> = [
  { usage: "/help", summary: "このヘルプを表示" },
  { usage: "/quit", summary: "終了 (/exit も同じ)" },
  { usage: "/clear", summary: "会話履歴をクリア" },
  { usage: "/mcp", summary: "MCP サーバ管理 (status/on/off/reload/toggle <name>)" },
  { usage: "/skills", summary: "スキル管理 (引数なし=一覧。 status/on/off/reload/toggle <name>)" },
  { usage: "/model", summary: "main / second / vision の状態を表示" },
  { usage: "/model <name>", summary: "メインLLM のモデルを切り替え" },
  { usage: "/model list", summary: "利用可能なモデル一覧から選択" },
  { usage: "/model apply", summary: "設定値を実行中に反映 (設定と実行中がズレている時)" },
  { usage: "/model setup", summary: "メインLLM をウィザードで再設定" },
  { usage: "/model host", summary: "接続先のホスト or IP を変更 (ポートは保持)" },
  { usage: "/model port", summary: "接続先のポート番号を変更" },
  { usage: "/model provider", summary: "プロバイダー (ollama/vllm等) を変更" },
  { usage: "/model context", summary: "コンテキスト長を変更 (例: 128k)" },
  { usage: "/model description", summary: "モデル特性説明" },
  { usage: "/model temperature", summary: "温度設定 (top_p/top_k/rep_penalty も同様、 各コマンドで)" },
  {
    usage: "/model second",
    summary: "セカンドLLM 管理 (setup/enable/disable/list/context/host/port/provider/description 等)",
  },
  { usage: "/model vision", summary: "Vision LLM 管理 (setup/list/context/description/clear)" },
  { usage: "/swap", summary: "メインLLM ⇔ セカンドLLM を入れ替え (-y で確認スキップ)" },
  { usage: "/models", summary: "Model Registry: 登録済モデル一覧 → main/second に設定・編集・複製・削除・追加" },
  { usage: "/integrations", summary: "外部サービス連携の設定 (Discord / Slack / 会話ログ / Web検索)" },
  { usage: "/permission", summary: "権限の設定画面 (権限ルール。 すべての面 / CLI・Discord・Slack ごと)" },
  { usage: "/todo", summary: "タスクリスト (active のみ。 all / archive サブコマンドあり)" },
  { usage: "/goal-seek <goal>", summary: "Goal Seek mode 開始 — acceptance criteria を立て合格まで自律実行" },
  { usage: "/exit-goal-seek", summary: "Goal Seek mode を抜ける (acceptance 未達成でも user 明示で中断)" },
  { usage: "/resume [id]", summary: "セッションを復元 (引数なしで対話的選択 / latest = 最新 / list [N] = 一覧)" },
  { usage: "/fork [id]", summary: "会話を新しいセッションへ分岐 (元セッションは不変)" },
  { usage: "/room", summary: "会話 Room (A/B/C) の表示・移動・再開 (REPL=A/Discord=B/Slack=C)" },
  { usage: "/queue", summary: "待ち状況 ([処理中・追加入力]欄で文字+Enter、 command は turn 後)" },
  { usage: "/tui mouse on|off", summary: "全画面TUI内でホイール履歴と端末選択を明示切替 (既定off)" },
  { usage: "/stream", summary: "ストリーミング表示の現状表示と切り替え" },
  { usage: "/memory", summary: "自動メモリ表示" },
  { usage: "/remember <text>", summary: "メモリに追記" },
  { usage: "/plan", summary: "プランモードに入る" },
  { usage: "/status", summary: "全体ステータス" },
  { usage: "/checkpoint", summary: "自動チェックポイント (on/off/list/restore <n>/diff <n>/clear)" },
  {
    usage: "/sandbox",
    summary:
      "bash 封じ込めトグル (status/on/off/allow/deny。 Mac/Linux/WSL2内=OSサンドボックス。 Winネイティブは非対応)",
  },
  { usage: "/cost", summary: "LLM 使用量・コストの可視化 (画像生成コスト含む)" },
  { usage: "/image", summary: "画像生成 (on/off/setup <azure|sd-webui|comfyui>/use/list/test/gen <prompt>)" },
  { usage: "/knowledge", summary: "Obsidianナレッジベース (vault設定/検索/一覧)" },
  {
    usage: "/compress-input",
    summary: "入力圧縮モード切替 (project指示/メモが閾値超過時に意図保持で圧縮、 既定OFF)",
  },
  { usage: "/try [N] <プロンプト>", summary: "試行錯誤モード: 評価付きで最大N回自動リトライ (デフォルト3回)" },
  {
    usage: '/goal-loop [N] --check "<cmd>" <タスク>',
    summary: "決定的検証ゲート型ループ: cmd が exit 0 になるまで反復 (既定8回)",
  },
  { usage: "/loop <間隔> <プロンプト>", summary: "指定間隔でプロンプトを繰り返し実行" },
  { usage: "/loop status", summary: "アクティブなループ一覧 + 停止 picker" },
  { usage: "/loop stop [id|all]", summary: "ループを停止" },
];

export function displayHelp(skills?: SkillSummary[], registryEntries?: RegistryHelpEntry[]): void {
  // repl.ts の switch コマンドは BUILTIN_HELP_ENTRIES、 レジストリ登録コマンド (src/cli/commands/ — PR-10)
  // は registryEntries から自動生成する。
  const builtinSection = BUILTIN_HELP_ENTRIES.map((e) => {
    const usage = e.usage.length < 15 ? e.usage.padEnd(15) : e.usage;
    return `    ${chalk.cyan(usage)} ${e.summary}`;
  }).join("\n");
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
${builtinSection}
${registrySection}
${skillSection}
  ${chalk.bold("入力:")}
    マウスドラッグ inline既定表示で端末本来の選択・コピー
    ホイール     inlineでは端末履歴、全画面TUIのmouse ON時は内部履歴を上下
    PgUp/PgDn   全画面TUIの過去ログをページ移動する（LLM・ツール実行中も有効）
    Shift+Tab    通常 → Autorun → Plan → 通常を循環（編集中の文字は保持）
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
