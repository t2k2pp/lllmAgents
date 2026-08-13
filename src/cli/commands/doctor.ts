/**
 * /doctor — 環境診断 (docs/production-readiness.md PR-16)。
 *
 * LLM 接続 / セカンド・ビジョン LLM / Playwright / Discord / Slack / 画像生成 /
 * ログ・セッションのディスク使用量を一括チェックして ✔/✖/− の表で出す。
 * トラブル報告時に「まず /doctor の結果を貼ってもらう」運用のための読み取り専用診断。
 * 通知の送信やメッセージ投稿など副作用のある操作は行わない。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import chalk from "chalk";
import { createProvider } from "../../providers/provider-factory.js";
import { probeBrowserCapability } from "../../browser/browser-capability.js";
import { detectModelDrift } from "../../agent/model-drift.js";
import type { ReplCommandDef, ReplCommandContext } from "./types.js";

const CHECK_TIMEOUT_MS = 8_000;

interface DoctorResult {
  label: string;
  /** ok=✔ / ng=✖ / skip=− (未設定・対象外) */
  status: "ok" | "ng" | "skip";
  detail: string;
}

async function withTimeout<T>(run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`タイムアウト (${CHECK_TIMEOUT_MS / 1000}秒)`)), CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** セッションが保持する復号済み provider での疎通 (メインLLM 用) */
async function checkMainLLM(ctx: ReplCommandContext): Promise<DoctorResult> {
  const label = "メインLLM";
  const ep = ctx.config.mainLLM;
  const target = `${ep.model ?? "?"} @ ${ep.baseUrl ?? ep.endpoint ?? "?"}`;
  try {
    const ok = await withTimeout(() => ctx.agent.getProvider().testConnection());
    return ok
      ? { label, status: "ok", detail: `${target} 応答あり` }
      : { label, status: "ng", detail: `${target} 応答なし` };
  } catch (e) {
    return { label, status: "ng", detail: `${target} 接続失敗: ${errText(e)}` };
  }
}

/**
 * config.mainLLM (設定値) と AgentLoop が握っている provider (実行中) が一致しているか。
 * 設計: docs/model-apply-immediacy.md §3.3
 *
 * ここは疎通ではなく整合の確認。 設定したのに反映されていない状態を、
 * 「なぜか品質が上がらない」 と悩む前に見つけるための項目。
 */
function checkModelBinding(ctx: ReplCommandContext): DoctorResult {
  const label = "モデル設定の反映状態";
  const live = ctx.agent.getLiveBinding();
  if (!live) {
    // 実行中バインディングが未記録 = 比較材料が無い。 誤検出を避けて skip 扱いにする
    return { label, status: "skip", detail: "実行中の接続情報が未記録のため判定できません" };
  }
  const drift = detectModelDrift(ctx.config.mainLLM, live);
  if (!drift) {
    return { label, status: "ok", detail: `設定値と実行中が一致 (${live.label})` };
  }
  return {
    label,
    status: "ng",
    detail: `設定 ${drift.wantLabel} に対し実行中は ${drift.liveLabel}。 /model apply で反映してください`,
  };
}

/** LLM エンドポイントへの疎通 (provider の testConnection を利用) */
async function checkLLM(
  label: string,
  endpoint: Parameters<typeof createProvider>[0] | null | undefined,
  skipDetail: string,
): Promise<DoctorResult> {
  if (!endpoint) return { label, status: "skip", detail: skipDetail };
  const target = `${endpoint.model ?? "?"} @ ${endpoint.baseUrl ?? endpoint.endpoint ?? "?"}`;
  try {
    const ok = await withTimeout(() => createProvider(endpoint).testConnection());
    return ok
      ? { label, status: "ok", detail: `${target} 応答あり` }
      : { label, status: "ng", detail: `${target} 応答なし` };
  } catch (e) {
    const msg = errText(e);
    if (msg.includes("decipher")) {
      // 暗号化キーは合言葉なしでは復号できない。設定異常とは区別して案内する
      return { label, status: "skip", detail: `${target} 暗号化キーのため /doctor では検証不可 (起動時に復号)` };
    }
    return { label, status: "ng", detail: `${target} 接続失敗: ${msg}` };
  }
}

/** Discord Bot トークンの有効性 (読み取り専用 API。メッセージは送らない) */
async function checkDiscord(ctx: ReplCommandContext): Promise<DoctorResult> {
  const d = ctx.config.discord;
  const label = "Discord";
  if (!d?.botToken && !d?.webhookUrl) return { label, status: "skip", detail: "未設定" };
  if (!d.botToken) {
    return { label, status: "ok", detail: "Webhook のみ設定 (トークン検証対象なし)" };
  }
  try {
    const res = await withTimeout(() =>
      fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${d.botToken}` },
      }),
    );
    if (res.ok) {
      const me = (await res.json()) as { username?: string };
      return { label, status: "ok", detail: `Bot トークン有効 (${me.username ?? "bot"})` };
    }
    return { label, status: "ng", detail: `Bot トークンが拒否されました (HTTP ${res.status}。失効の可能性)` };
  } catch (e) {
    return { label, status: "ng", detail: `Discord API に到達できません: ${errText(e)}` };
  }
}

/** Slack Bot トークンの有効性 (auth.test は読み取り専用) */
async function checkSlack(ctx: ReplCommandContext): Promise<DoctorResult> {
  const s = ctx.config.slack;
  const label = "Slack";
  if (!s?.botToken && !s?.webhookUrl) return { label, status: "skip", detail: "未設定" };
  if (!s.botToken) {
    return { label, status: "ok", detail: "Webhook のみ設定 (トークン検証対象なし)" };
  }
  try {
    const res = await withTimeout(() =>
      fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${s.botToken}` },
      }),
    );
    const body = (await res.json()) as { ok?: boolean; error?: string; team?: string };
    if (body.ok) {
      return { label, status: "ok", detail: `Bot トークン有効 (workspace: ${body.team ?? "?"})` };
    }
    return { label, status: "ng", detail: `Bot トークンが無効です (${body.error ?? `HTTP ${res.status}`})` };
  } catch (e) {
    return { label, status: "ng", detail: `Slack API に到達できません: ${errText(e)}` };
  }
}

/** Playwright + Chromium の導入状態 (launch はしない) */
async function checkBrowser(ctx: ReplCommandContext): Promise<DoctorResult> {
  const label = "ブラウザ (Playwright)";
  try {
    const cap = await probeBrowserCapability(ctx.config);
    return cap.ready ? { label, status: "ok", detail: cap.reason } : { label, status: "ng", detail: cap.reason };
  } catch (e) {
    return { label, status: "ng", detail: `判定に失敗: ${errText(e)}` };
  }
}

/** 画像生成の設定整合 (課金を避けるため疎通は /image test に委ねる) */
function checkImageGen(ctx: ReplCommandContext): DoctorResult {
  const ig = ctx.config.imageGen;
  const label = "画像生成";
  if (!ig?.enabled) return { label, status: "skip", detail: "無効 (/image on で有効化)" };
  const active = ig.profiles?.find((p) => p.name === ig.active);
  if (!active) {
    return { label, status: "ng", detail: `アクティブプロファイル "${ig.active ?? "(未設定)"}" が見つかりません` };
  }
  return { label, status: "ok", detail: `プロファイル "${active.name}" (${active.providerType})。疎通は /image test` };
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) total += dirSizeBytes(full);
      else if (ent.isFile()) total += fs.statSync(full).size;
    } catch {
      // 消えたファイル等は無視
    }
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** ログ・セッションのディスク使用量 (世代管理 PR-15 の効き具合の確認にもなる) */
function checkDiskUsage(): DoctorResult {
  const base = path.join(os.homedir(), ".localllm");
  const logsBytes = dirSizeBytes(path.join(base, "logs"));
  let sessionCount = 0;
  try {
    sessionCount = fs.readdirSync(path.join(base, "sessions")).filter((f) => f.endsWith(".json")).length;
  } catch {
    // sessions ディレクトリなし
  }
  return {
    label: "ディスク使用量",
    status: "ok",
    detail: `logs ${formatBytes(logsBytes)} / セッション ${sessionCount} 件 (上限は logging.retention で調整)`,
  };
}

function renderResults(results: DoctorResult[]): void {
  console.log(chalk.bold("\n  環境診断 (/doctor):\n"));
  for (const r of results) {
    const mark = r.status === "ok" ? chalk.green("✔") : r.status === "ng" ? chalk.red("✖") : chalk.dim("−");
    const label = r.label.padEnd(20);
    const detail = r.status === "skip" ? chalk.dim(r.detail) : r.detail;
    console.log(`    ${mark} ${label} ${detail}`);
  }
  const ngCount = results.filter((r) => r.status === "ng").length;
  console.log();
  if (ngCount === 0) {
    console.log(chalk.green("  問題は見つかりませんでした。"));
  } else {
    console.log(chalk.yellow(`  ${ngCount} 件の問題が見つかりました。トラブル報告時はこの出力を添えてください。`));
  }
  console.log();
}

export const doctorCommand: ReplCommandDef = {
  name: "/doctor",
  summary: "環境診断 — LLM接続/Playwright/Discord/Slack/画像生成/ディスク使用量を一括チェック",
  completions: [
    {
      command: "/doctor",
      description: "環境診断 — LLM接続/Playwright/Discord/Slack/画像生成/ディスク使用量を一括チェック",
    },
  ],
  async handler(ctx) {
    console.log(chalk.dim("  診断中... (各チェック最大8秒)"));
    const [main, second, vision, browser, discord, slack] = await Promise.all([
      checkMainLLM(ctx),
      checkLLM(
        "セカンドLLM",
        ctx.config.secondLLM?.enabled ? ctx.config.secondLLM.endpoint : null,
        "無効 (/model second enable で有効化)",
      ),
      checkLLM("ビジョンLLM", ctx.config.visionLLM, "未設定 (メインLLMで代替)"),
      checkBrowser(ctx),
      checkDiscord(ctx),
      checkSlack(ctx),
    ]);
    renderResults([
      main,
      checkModelBinding(ctx),
      second,
      vision,
      browser,
      discord,
      slack,
      checkImageGen(ctx),
      checkDiskUsage(),
    ]);
  },
};
