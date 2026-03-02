import chalk from "chalk";

export function displayWelcome(model: string, baseUrl: string, providerType: string, contextWindow: number): void {
  const ctxLabel = contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}K` : `${contextWindow}`;
  console.log(chalk.bold(`\n  LocalLLM Agent v0.1.0`));
  console.log(chalk.dim(`  Model: ${model} @ ${baseUrl} (${providerType})`));
  console.log(chalk.dim(`  Context: ${ctxLabel} tokens`));
  console.log(chalk.dim(`  CWD: ${process.cwd()}`));
  console.log(chalk.dim(`  Type /help for commands, /quit to exit.`));
  console.log(chalk.dim(`  マルチライン入力: \`\`\` で開始・終了\n`));
}

export function displayHelp(): void {
  console.log(`
  ${chalk.bold("コマンド:")}
    ${chalk.cyan("/help")}        このヘルプを表示
    ${chalk.cyan("/quit")}        終了
    ${chalk.cyan("/clear")}       会話履歴をクリア
    ${chalk.cyan("/context")}     コンテキスト使用状況 (プログレスバー付き)
    ${chalk.cyan("/compact")}     コンテキストを手動圧縮
    ${chalk.cyan("/model")}       現在のモデル情報
    ${chalk.cyan("/todo")}        タスクリスト表示
    ${chalk.cyan("/sessions")}    保存済みセッション一覧
    ${chalk.cyan("/resume <id>")} セッション復元
    ${chalk.cyan("/memory")}      自動メモリ表示
    ${chalk.cyan("/remember")}    メモリに追記
    ${chalk.cyan("/diff")}        git diff表示

  ${chalk.bold("入力:")}
    \`\`\`  マルチライン入力モード開始/終了
    Ctrl+C  現在の操作をキャンセル
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

  // Simple line-level diff
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
