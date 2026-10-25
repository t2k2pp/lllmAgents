/**
 * /integrations 画面 (Discord / Slack / 会話ログ / Web検索) の設定操作。
 *
 * 以前は /integrations 画面が `/discord <sub>` 等の直接コマンドを内部で呼んでいたが、
 * 設定の書き方を対話画面 1 つに揃えるため直接コマンドを削除し、 画面からは
 * ここにある関数を直接呼ぶ (docs/todo-legacy-ways-cleanup.md T3)。
 *
 * 各関数は設定 (Config) を書き換えて ctx.save() で保存し、 結果を画面に表示する。
 * Discord 受信の開始/停止は REPL が持つ接続オブジェクトを扱うため repl.ts 側に置く。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { ChatLogger } from "../agent/chat-logger.js";
import type { Config, DiscordConfig, SlackConfig } from "../config/types.js";
import { registerAskCommand } from "../discord/slash-commands.js";
import { isValidDiscordWebhookUrl, sendDiscordNotification } from "../utils/discord.js";
import { maskWebhookUrl } from "../utils/mask.js";
import { isValidSlackWebhookUrl, sendSlackNotification } from "../utils/slack.js";

export interface SettingsContext {
  config: Config;
  /** 設定ファイルへ保存する (通常は () => saveConfig(config)) */
  save: () => void;
}

/** 会話ログの保存先を差し替えるための窓口 (AgentLoop が満たす) */
export interface ChatLogHost {
  getChatLogger(): ChatLogger | null;
  setChatLogger(cl: ChatLogger | null): void;
}

function discordOf(config: Config): DiscordConfig {
  if (!config.discord) config.discord = { enabled: false, webhookUrl: "" };
  return config.discord;
}

function slackOf(config: Config): SlackConfig {
  if (!config.slack) config.slack = { enabled: false, webhookUrl: "" };
  return config.slack;
}

// ─── Discord ────────────────────────────────────────────

export function printDiscordStatus(config: Config, runtime: { listening: boolean; botUser?: string | null }): void {
  const d = config.discord;
  const dEnabled = d?.enabled ?? false;
  const dUrl = d?.webhookUrl ? maskWebhookUrl(d.webhookUrl) : "未設定";
  const dAppId = d?.applicationId ? chalk.dim(d.applicationId) : chalk.yellow("未設定");
  const dToken = d?.botToken ? chalk.green("設定済み") : chalk.yellow("未設定");
  const dAttach = (d?.attachGeneratedImages ?? true) !== false;
  const dAuto = d?.listenEnabled ?? false;
  const botName = runtime.botUser;
  console.log(chalk.bold("\n  === Discord 連携の状態 ==="));
  console.log(chalk.dim(`  通知 (Webhook): ${dEnabled ? chalk.green("オン") : chalk.yellow("オフ")}`));
  console.log(chalk.dim(`  Webhook URL:    ${dUrl}`));
  console.log(chalk.dim(`  生成画像の添付: ${dAttach ? chalk.green("オン") : chalk.yellow("オフ")}`));
  console.log(
    chalk.dim(
      `  Bot 接続:       ${runtime.listening ? chalk.green(`接続中${botName ? ` (${botName})` : ""}`) : chalk.yellow("停止中")}`,
    ),
  );
  console.log(chalk.dim(`  受信の自動開始: ${dAuto ? chalk.green("オン") : chalk.yellow("オフ")}`));
  console.log(chalk.dim(`  Application ID: ${dAppId}`));
  console.log(chalk.dim(`  Bot Token:      ${dToken}`));
  console.log();
}

export function setDiscordEnabled(ctx: SettingsContext, on: boolean): void {
  const d = discordOf(ctx.config);
  if (on && !d.webhookUrl) {
    console.log(
      chalk.yellow(
        "  注意: 通知の送り先 (Webhook URL) が未設定です。この画面の「通知の送り先を設定する」で設定してください。",
      ),
    );
  }
  d.enabled = on;
  ctx.save();
  console.log(on ? chalk.green("  Discord 通知を有効化しました。") : chalk.yellow("  Discord 通知を無効化しました。"));
}

/** Webhook URL を設定する。 形式が不正なら保存せず false を返す */
export function setDiscordWebhookUrl(ctx: SettingsContext, url: string): boolean {
  if (!isValidDiscordWebhookUrl(url)) {
    console.log(chalk.red("  ❌ 無効なWebhook URLです。"));
    console.log(chalk.yellow("  正しい形式: https://discord.com/api/webhooks/<id>/<token>"));
    console.log(chalk.dim("  Discordサーバー設定 → 連携サービス → ウェブフック で取得してください。"));
    return false;
  }
  discordOf(ctx.config).webhookUrl = url;
  ctx.save();
  console.log(chalk.green("  ✅ Discord Webhook URL を設定しました。"));
  console.log(chalk.dim(`  URL: ${maskWebhookUrl(url)}`));
  console.log(chalk.dim("  「テスト通知を送ってみる」で動作確認できます。"));
  return true;
}

export async function sendDiscordTest(config: Config): Promise<void> {
  const webhookUrl = config.discord?.webhookUrl ?? "";
  if (!webhookUrl) {
    console.log(
      chalk.yellow("  通知の送り先 (Webhook URL) が未設定です。先に「通知の送り先を設定する」で設定してください。"),
    );
    return;
  }
  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    console.log(
      chalk.red(
        "  ❌ 設定されている URL が無効です。「通知の送り先を設定する」で正しい Webhook URL を設定してください。",
      ),
    );
    return;
  }
  console.log(chalk.dim("  Discord にテストメッセージを送信中..."));
  const result = await sendDiscordNotification(
    webhookUrl,
    "🤖 lllmAgents テスト通知\nDiscord通知が正常に動作しています！",
  );
  if (result.success) console.log(chalk.green("  ✅ テストメッセージを送信しました。Discordを確認してください。"));
  else console.log(chalk.red(`  ❌ 送信失敗: ${result.error}`));
}

export function setDiscordApplicationId(ctx: SettingsContext, id: string): void {
  discordOf(ctx.config).applicationId = id;
  ctx.save();
  console.log(chalk.green(`  ✅ Application ID を設定しました: ${id}`));
}

export function setDiscordBotToken(ctx: SettingsContext, token: string): void {
  discordOf(ctx.config).botToken = token;
  ctx.save();
  console.log(chalk.green("  ✅ Bot Token を設定しました。"));
}

/** /ask を Discord に登録する。 guildId 省略時は全サーバー向け (反映に最大 1 時間) */
export async function registerDiscordAsk(config: Config, guildId?: string): Promise<void> {
  const appId = config.discord?.applicationId;
  const botToken = config.discord?.botToken;
  if (!appId || !botToken) {
    console.log(chalk.yellow("  Application ID と Bot Token が必要です。"));
    console.log(chalk.dim("  この画面の「Application ID を設定する」「Bot Token を設定する」で設定してください。"));
    return;
  }
  const scope = guildId ? `サーバー ${guildId} 限定` : "全サーバー向け";
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=2048`;
  console.log(chalk.dim(`  /ask コマンドを登録中 (${scope})...`));
  const result = await registerAskCommand(appId, botToken, guildId);
  if (result.success) {
    console.log(chalk.green(`  ✅ /ask コマンドを登録しました (ID: ${result.commandId})`));
    console.log(chalk.dim("  注意: /ask が使えるのは、この Bot を招待したサーバーだけです。"));
    console.log(chalk.dim("  まだ招待していなければ、下の URL を開いて招待してください:"));
    console.log(chalk.cyan(`    ${inviteUrl}`));
    if (!guildId) {
      console.log(chalk.dim("  全サーバー向けの登録は、反映まで最大 1 時間かかります。"));
      console.log(chalk.dim("  すぐ試したい場合は、もう一度登録を実行してサーバーIDを指定してください (即時反映)。"));
    }
  } else {
    console.log(chalk.red(`  ❌ 登録失敗: ${result.error}`));
    if (result.error?.includes("50001") || result.error?.includes("Missing Access")) {
      console.log(chalk.yellow("  原因: この Bot は指定したサーバーにまだ参加していません。"));
      console.log(chalk.dim("  下の URL を開いて Bot をサーバーに招待してから、もう一度お試しください:"));
      console.log(chalk.cyan(`    ${inviteUrl}`));
    }
  }
}

export function setDiscordListenAutoStart(ctx: SettingsContext, on: boolean): void {
  discordOf(ctx.config).listenEnabled = on;
  ctx.save();
  console.log(
    on
      ? chalk.green("  ✅ 次回起動時から自動で受信を開始します。")
      : chalk.yellow("  受信の自動開始をオフにしました。"),
  );
}

/** 生成画像の Discord 自動添付 (docs/image-generation.md §5.1) */
export function setDiscordAttachImages(ctx: SettingsContext, on: boolean): void {
  discordOf(ctx.config).attachGeneratedImages = on;
  ctx.save();
  console.log(
    on
      ? chalk.green("  ✅ 生成画像を Discord に自動添付します。")
      : chalk.yellow("  生成画像の自動添付をオフにしました (通知テキストは従来どおり)。"),
  );
}

export function printDiscordUsers(config: Config): void {
  printUserList(config.discord?.allowedUserIds ?? []);
}

export function addDiscordUser(ctx: SettingsContext, id: string): void {
  if (!/^\d{15,21}$/.test(id)) {
    // 失敗の典型: ユーザー名 (osia4782 等) を入れてしまう。 ID は数値 snowflake。
    console.log(chalk.yellow(`  ⚠ "${id}" は Discord ユーザー ID の形式 (15〜21桁の数字) ではありません。`));
    console.log(chalk.dim("    ユーザー名ではなく数値の ID を指定してください (一致せず利用できません)。"));
    console.log(chalk.dim("    ID 入力が面倒な場合は、相手に Discord から /ask を一度実行してもらい、"));
    console.log(chalk.dim("    この画面の「待機リストから利用申請を承認する」から承認する方法が確実です。"));
  }
  const d = discordOf(ctx.config);
  const list = d.allowedUserIds ?? [];
  if (!list.includes(id)) list.push(id);
  d.allowedUserIds = list;
  // 許可したユーザーは待機リストから取り除く。
  if (d.pendingUsers) d.pendingUsers = d.pendingUsers.filter((u) => u.id !== id);
  ctx.save();
  console.log(chalk.green(`  許可ユーザーに ${id} を追加しました (${list.length} 名)。`));
}

export function removeDiscordUser(ctx: SettingsContext, id: string): void {
  const d = discordOf(ctx.config);
  d.allowedUserIds = (d.allowedUserIds ?? []).filter((u) => u !== id);
  ctx.save();
  console.log(chalk.yellow(`  許可ユーザーから ${id} を削除しました。`));
}

/** 待機リストの申請を承認して許可ユーザーへ移す */
export function approveDiscordPending(ctx: SettingsContext, id: string): void {
  const d = discordOf(ctx.config);
  const allow = d.allowedUserIds ?? [];
  if (!allow.includes(id)) allow.push(id);
  d.allowedUserIds = allow;
  d.pendingUsers = (d.pendingUsers ?? []).filter((u) => u.id !== id);
  ctx.save();
  console.log(chalk.green(`  ✅ ${id} を許可しました (許可ユーザー ${allow.length} 名)。`));
}

/** 待機リストの申請を却下する (待機リストから削除するだけ) */
export function rejectDiscordPending(ctx: SettingsContext, id: string): void {
  const d = discordOf(ctx.config);
  d.pendingUsers = (d.pendingUsers ?? []).filter((u) => u.id !== id);
  ctx.save();
  console.log(chalk.yellow(`  待機リストから ${id} を削除しました。`));
}

// ─── Slack ──────────────────────────────────────────────

export function printSlackStatus(config: Config): void {
  const s = config.slack;
  const sEnabled = s?.enabled ?? false;
  const sUrl = s?.webhookUrl ? maskWebhookUrl(s.webhookUrl) : "未設定";
  const sBotToken = s?.botToken ? chalk.green("設定済み") : chalk.yellow("未設定");
  const sAppToken = s?.appToken ? chalk.green("設定済み") : chalk.yellow("未設定");
  console.log(chalk.bold("\n  === Slack 連携の状態 ==="));
  console.log(chalk.dim(`  通知 (Webhook): ${sEnabled ? chalk.green("オン") : chalk.yellow("オフ")}`));
  console.log(chalk.dim(`  Webhook URL:    ${sUrl}`));
  console.log(chalk.dim(`  Bot Token:      ${sBotToken}`));
  console.log(chalk.dim(`  App Token:      ${sAppToken}`));
  console.log(chalk.dim("  --slack モード:  bot-token + app-token 設定後に 'npm run start -- --slack' で起動"));
  console.log();
}

export function setSlackEnabled(ctx: SettingsContext, on: boolean): void {
  const s = slackOf(ctx.config);
  if (on && !s.webhookUrl) {
    console.log(
      chalk.yellow(
        "  注意: 通知の送り先 (Webhook URL) が未設定です。この画面の「通知の送り先を設定する」で設定してください。",
      ),
    );
  }
  s.enabled = on;
  ctx.save();
  console.log(on ? chalk.green("  Slack 通知を有効化しました。") : chalk.yellow("  Slack 通知を無効化しました。"));
}

/** Webhook URL を設定する。 形式が不正なら保存せず false を返す */
export function setSlackWebhookUrl(ctx: SettingsContext, url: string): boolean {
  if (!isValidSlackWebhookUrl(url)) {
    console.log(chalk.red("  無効なWebhook URLです。"));
    console.log(chalk.yellow("  正しい形式: https://hooks.slack.com/services/T.../B.../..."));
    console.log(chalk.dim("  Slack App設定 → Incoming Webhooks で取得してください。"));
    return false;
  }
  slackOf(ctx.config).webhookUrl = url;
  ctx.save();
  console.log(chalk.green("  Slack Webhook URL を設定しました。"));
  console.log(chalk.dim(`  URL: ${maskWebhookUrl(url)}`));
  console.log(chalk.dim("  「テスト通知を送ってみる」で動作確認できます。"));
  return true;
}

export async function sendSlackTest(config: Config): Promise<void> {
  const webhookUrl = config.slack?.webhookUrl ?? "";
  if (!webhookUrl) {
    console.log(
      chalk.yellow("  通知の送り先 (Webhook URL) が未設定です。先に「通知の送り先を設定する」で設定してください。"),
    );
    return;
  }
  if (!isValidSlackWebhookUrl(webhookUrl)) {
    console.log(
      chalk.red("  設定されている URL が無効です。「通知の送り先を設定する」で正しい Webhook URL を設定してください。"),
    );
    return;
  }
  console.log(chalk.dim("  Slack にテストメッセージを送信中..."));
  const result = await sendSlackNotification(webhookUrl, "lllmAgents テスト通知\nSlack通知が正常に動作しています！");
  if (result.success) console.log(chalk.green("  テストメッセージを送信しました。Slackを確認してください。"));
  else console.log(chalk.red(`  送信失敗: ${result.error}`));
}

export function setSlackBotToken(ctx: SettingsContext, token: string): void {
  slackOf(ctx.config).botToken = token;
  ctx.save();
  console.log(chalk.green("  Bot Token を設定しました。"));
}

export function setSlackAppToken(ctx: SettingsContext, token: string): void {
  slackOf(ctx.config).appToken = token;
  ctx.save();
  console.log(chalk.green("  App-Level Token を設定しました。"));
}

export function printSlackUsers(config: Config): void {
  printUserList(config.slack?.allowedUserIds ?? []);
}

export function addSlackUser(ctx: SettingsContext, id: string): void {
  const s = slackOf(ctx.config);
  const list = s.allowedUserIds ?? [];
  if (!list.includes(id)) list.push(id);
  s.allowedUserIds = list;
  ctx.save();
  console.log(chalk.green(`  許可ユーザーに ${id} を追加しました (${list.length} 名)。`));
}

export function removeSlackUser(ctx: SettingsContext, id: string): void {
  const s = slackOf(ctx.config);
  s.allowedUserIds = (s.allowedUserIds ?? []).filter((u) => u !== id);
  ctx.save();
  console.log(chalk.yellow(`  許可ユーザーから ${id} を削除しました。`));
}

function printUserList(list: string[]): void {
  if (list.length === 0) {
    console.log(chalk.dim("  許可ユーザー: 未設定 (全員拒否。利用するには許可ユーザーを追加してください)"));
    return;
  }
  console.log(chalk.bold("  許可ユーザー:"));
  for (const id of list) console.log(chalk.dim(`    - ${id}`));
}

// ─── 会話ログ (Obsidian) ─────────────────────────────────

export function printChatlogStatus(config: Config, host: ChatLogHost): void {
  const cl = config.chatLog;
  if (!cl?.vaultPath) {
    console.log(chalk.yellow("  会話ログの保存先が未設定です。「保存先フォルダを設定する」で設定してください。"));
    return;
  }
  console.log(chalk.bold("  会話ログ:"));
  console.log(`    状態:   ${cl.enabled ? chalk.green("ON") : chalk.yellow("OFF")}`);
  console.log(`    Vault:  ${chalk.cyan(cl.vaultPath)}`);
  const logDir = path.join(cl.vaultPath, "ChatLogs");
  if (fs.existsSync(logDir)) {
    const countMd = (dir: string): number => {
      let count = 0;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) count += countMd(path.join(dir, e.name));
        else if (e.name.endsWith(".md")) count++;
      }
      return count;
    };
    console.log(`    ログ数: ${chalk.yellow(String(countMd(logDir)))}`);
  }
  const chatLogger = host.getChatLogger();
  if (chatLogger) {
    console.log(`    現在:   ${chalk.dim(chatLogger.getCurrentFilePath())} (Part ${chatLogger.getPartNumber()})`);
  }
}

/** 保存先 Vault を設定し、 会話ログを作り直す。 フォルダが無ければ保存せず false */
export async function setChatlogVault(ctx: SettingsContext, host: ChatLogHost, vaultPath: string): Promise<boolean> {
  const resolved = path.resolve(vaultPath);
  if (!fs.existsSync(resolved)) {
    console.log(chalk.red(`  パスが存在しません: ${resolved}`));
    return false;
  }
  if (!ctx.config.chatLog) ctx.config.chatLog = { enabled: true, vaultPath: resolved };
  else ctx.config.chatLog.vaultPath = resolved;
  ctx.save();
  const { ChatLogger } = await import("../agent/chat-logger.js");
  host.setChatLogger(new ChatLogger(ctx.config.chatLog));
  console.log(chalk.green(`  会話ログの保存先を設定しました: ${resolved}`));
  console.log(chalk.dim(`  ログは ${path.join(resolved, "ChatLogs")} に保存されます。`));
  return true;
}

/** 会話ログの保存をオン/オフする。 オンは保存先が未設定なら何もせず false */
export async function setChatlogEnabled(ctx: SettingsContext, host: ChatLogHost, on: boolean): Promise<boolean> {
  if (!on) {
    if (ctx.config.chatLog) {
      ctx.config.chatLog.enabled = false;
      ctx.save();
    }
    host.getChatLogger()?.setEnabled(false);
    console.log(chalk.yellow("  会話ログ OFF (設定に保存)"));
    return true;
  }
  const cl = ctx.config.chatLog;
  if (!cl?.vaultPath) {
    console.log(chalk.yellow("  保存先が未設定です。先に「保存先フォルダを設定する」で設定してください。"));
    return false;
  }
  cl.enabled = true;
  ctx.save();
  const current = host.getChatLogger();
  if (current) current.setEnabled(true);
  else {
    const { ChatLogger } = await import("../agent/chat-logger.js");
    host.setChatLogger(new ChatLogger(cl));
  }
  console.log(chalk.green("  会話ログ ON (設定に保存)"));
  return true;
}

// ─── Web検索 ────────────────────────────────────────────

export const DEFAULT_SEARXNG_URL = "http://localhost:8888";

export function printSearchStatus(config: Config): void {
  const s = config.search ?? { provider: "duckduckgo" };
  console.log(chalk.bold("  Web検索設定:"));
  console.log(`    プロバイダー: ${chalk.cyan(s.provider)}`);
  if (s.provider === "searxng") {
    console.log(`    SearXNG URL:  ${chalk.cyan(s.searxngUrl ?? DEFAULT_SEARXNG_URL)}`);
  }
}

export function useDuckDuckGo(ctx: SettingsContext): void {
  if (!ctx.config.search) ctx.config.search = { provider: "duckduckgo" };
  else ctx.config.search.provider = "duckduckgo";
  ctx.save();
  console.log(chalk.green("  検索プロバイダーを DuckDuckGo に変更しました。"));
  console.log(chalk.dim("  反映には再起動が必要です。"));
}

/** SearXNG に切り替える。 url が空なら今の設定 (無ければ既定 URL) を使う */
export function useSearxng(ctx: SettingsContext, url?: string): void {
  const u = url?.trim() || ctx.config.search?.searxngUrl || DEFAULT_SEARXNG_URL;
  if (!ctx.config.search) ctx.config.search = { provider: "searxng", searxngUrl: u };
  else {
    ctx.config.search.provider = "searxng";
    ctx.config.search.searxngUrl = u;
  }
  ctx.save();
  console.log(chalk.green(`  検索プロバイダーを SearXNG に変更しました (${u})`));
  console.log(chalk.dim("  反映には再起動が必要です。"));
}

export async function runSearchTest(config: Config): Promise<void> {
  const s = config.search ?? { provider: "duckduckgo" };
  console.log(chalk.dim(`  ${s.provider} でテスト検索中...`));
  try {
    const { createWebSearchTool } = await import("../tools/definitions/web-search.js");
    const tool = createWebSearchTool(config.search);
    const result = await tool.execute({ query: "test", max_results: 3 });
    if (result.success) {
      console.log(chalk.green("  テスト成功:"));
      console.log(
        result.output
          .split("\n")
          .map((l: string) => `    ${l}`)
          .join("\n"),
      );
    } else {
      console.log(chalk.red(`  テスト失敗: ${result.error}`));
    }
  } catch (e) {
    console.log(chalk.red(`  エラー: ${e}`));
  }
}

// ─── 非TTY ──────────────────────────────────────────────

/**
 * 対話画面を出せない (stdin が端末でない) ときの案内文。
 * 設定コマンドは対話画面 1 つに揃えたため、 非TTY では config.json を直接編集してもらう。
 */
export function nonInteractiveSettingsNotice(command: "/permission" | "/integrations"): string[] {
  const head = [
    `  ${command} は対話画面で設定するコマンドのため、対話できる端末 (TTY) で実行してください。`,
    "  端末を使えない場合は ~/.localllm/config.json を直接編集し、アプリを起動し直してください。",
  ];
  if (command === "/permission") {
    return [
      ...head,
      "  関係するキー:",
      '    security.rules.allow / security.rules.deny / security.rules.ask  (権限ルール。例: "bash(npm *)")',
      '    先頭に "cli:" / "discord:" / "slack:" を付けるとその面だけに効く (例: "discord:web_fetch")。 無ければすべての面',
      '    ツール名だけの allow ("file_read") はツール全体の許可 (安全確認は残る)。 引数パターン付き ("bash(npm test)") はその形だけを確認なしで許可',
    ];
  }
  return [
    ...head,
    "  関係するキー:",
    "    discord.enabled / webhookUrl / applicationId / botToken / listenEnabled / attachGeneratedImages / allowedUserIds",
    "    slack.enabled / webhookUrl / botToken / appToken / allowedUserIds",
    "    chatLog.enabled / chatLog.vaultPath",
    '    search.provider ("duckduckgo" | "searxng") / search.searxngUrl',
    "  (Webhook URL・トークンは保存時に ~/.localllm/credentials.json へ移されます)",
  ];
}
