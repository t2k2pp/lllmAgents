import chalk from "chalk";

export function displayWelcome(model: string, baseUrl: string, providerType: string, contextWindow: number): void {
  const ctxLabel = contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}K` : `${contextWindow}`;
  console.log(chalk.bold(`\n  LocalLLM Agent v0.1.0`));
  console.log(chalk.dim(`  Model: ${model} @ ${baseUrl} (${providerType})`));
  console.log(chalk.dim(`  Context: ${ctxLabel} tokens`));
  console.log(chalk.dim(`  Type /help for commands, /quit to exit.\n`));
}

export function displayHelp(): void {
  console.log(`
  ${chalk.bold("Commands:")}
    /help     このヘルプを表示
    /quit     終了
    /setup    設定ウィザードを再実行
    /clear    会話履歴をクリア
    /context  コンテキスト使用状況を表示
`);
}

export function displayError(message: string): void {
  console.log(chalk.red(`\n  Error: ${message}\n`));
}

export function displayToolCall(toolName: string, params: Record<string, unknown>): void {
  console.log(chalk.dim(`  > ${toolName}: ${JSON.stringify(params).slice(0, 120)}`));
}
