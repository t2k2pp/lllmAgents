import chalk from "chalk";

export function displayWelcome(model: string, baseUrl: string, providerType: string, contextWindow: number, skillCount: number): void {
  const ctxLabel = contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}K` : `${contextWindow}`;
  console.log(chalk.bold(`\n  LocalLLM Agent v0.2.0`));
  console.log(chalk.dim(`  Model: ${model} @ ${baseUrl} (${providerType})`));
  console.log(chalk.dim(`  Context: ${ctxLabel} tokens | Skills: ${skillCount}`));
  console.log(chalk.dim(`  CWD: ${process.cwd()}`));
  console.log(chalk.dim(`  Type /help for commands, /quit to exit.`));
  console.log(chalk.dim(`  マルチライン入力: Shift+Enter (フォールバック: \`\`\`)\n`));
}

export function displayHelp(): void {
  console.log(`
  ${chalk.bold("コマンド:")}
    ${chalk.cyan("/help")}           このヘルプを表示
    ${chalk.cyan("/quit")}           終了
    ${chalk.cyan("/clear")}          会話履歴をクリア
    ${chalk.cyan("/context")}        コンテキスト使用状況
    ${chalk.cyan("/compact")}        コンテキストを手動圧縮
    ${chalk.cyan("/model")}          現在のモデル情報
    ${chalk.cyan("/model <name>")}   モデルを切り替え
    ${chalk.cyan("/model list")}     利用可能なモデル一覧
    ${chalk.cyan("/todo")}           タスクリスト表示
    ${chalk.cyan("/sessions")}       保存済みセッション一覧
    ${chalk.cyan("/resume <id>")}    セッション復元
    ${chalk.cyan("/continue")}       最新セッションを復元
    ${chalk.cyan("/memory")}         自動メモリ表示
    ${chalk.cyan("/remember <text>")} メモリに追記
    ${chalk.cyan("/diff")}           git diff表示
    ${chalk.cyan("/plan")}           プランモードに入る
    ${chalk.cyan("/skills")}         利用可能なスキル一覧
    ${chalk.cyan("/status")}         全体ステータス

  ${chalk.bold("スキル (直接呼び出し可能):")}
    ${chalk.cyan("/commit")}         コミットワークフロー
    ${chalk.cyan("/pr-review")}      PRコードレビュー
    ${chalk.cyan("/tdd")}            テスト駆動開発
    ${chalk.cyan("/build-fix")}      ビルドエラー修正

  ${chalk.bold("入力:")}
    Shift+Enter  改行を挿入（マルチライン入力）
    \`\`\`          マルチライン入力モード（フォールバック）
    @path        ファイル/フォルダの内容を参照
    Ctrl+C       現在の操作をキャンセル
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
