/**
 * 入力補完・メニュー候補プロバイダー
 *
 * - createCommandMenuProvider: /コマンドのドロップダウン候補（説明付き）
 * - createFileMenuProvider: @ファイルパスのドロップダウン候補
 * - createCompleter: readline用Tab補完（フォールバック用）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CompleterResult } from "node:readline";
import type { MenuItem, MenuProvider } from "./interactive-input.js";

// ─── コマンド定義（説明付き） ────────────────────────────

interface CommandDef {
  command: string;
  description: string;
  /** trueなら選択後に引数入力を続ける（即確定しない） */
  needsArg?: boolean;
}

const BUILTIN_COMMAND_DEFS: CommandDef[] = [
  { command: "/help", description: "ヘルプ表示" },
  { command: "/quit", description: "終了" },
  { command: "/exit", description: "終了" },
  { command: "/clear", description: "会話履歴クリア" },
  { command: "/context", description: "コンテキスト使用状況 (System prompt / Memory / Skills / Tools / Messages 内訳)" },
  { command: "/compact", description: "コンテキスト圧縮" },
  // /capability /metrics /cost は /status に集約 (Phase optimize #4、 2026-05-28)
  { command: "/mcp status", description: "MCP サーバの接続状態を表示" },
  { command: "/mcp on", description: "MCP 全体を有効化 (/mcp reload で接続)" },
  { command: "/mcp off", description: "MCP 全体を無効化 (設定ファイルは変更しない)" },
  { command: "/mcp reload", description: "MCP サーバを切断して再接続" },
  { command: "/mcp toggle", description: "個別サーバの runtime skip 切替", needsArg: true },
  { command: "/skills status", description: "ロード済スキル一覧と有効/無効を表示" },
  { command: "/skills on", description: "全スキル有効化" },
  { command: "/skills off", description: "全スキル無効化 (= 設定残したまま読み飛ばし)" },
  { command: "/skills toggle", description: "個別スキルの有効/無効切替", needsArg: true },
  { command: "/try", description: "試行錯誤モード: 自動的に評価・改善を繰り返す", needsArg: true },
  { command: "/try 3", description: "最大3回試行（デフォルト）", needsArg: true },
  { command: "/stream", description: "ストリーミング表示モードの確認/切り替え (引数なしで対話 toggle)" },
  // ── Model / Second LLM コマンド (docs/model-registry.md) ──
  // Phase 3 (2026-05-27): 個別編集系のコマンドは /models Edit に統合された。
  //   - /model setup <provider> の各バリアントは /models Add new... の wizard へ集約 → 補完から除外
  //   - /model host / port / url / provider / temperature / top_p / top_k / rep_penalty / description
  //     等の個別編集は /models Edit から行う → 補完から除外 (dispatcher は互換のため残存)
  //   - 残すのは: /model (状態表示), /model info, /model list, /model context, /model setup
  { command: "/model", description: "main / second / 他 slot の状態を 1 画面で表示 (詳細編集は /models)" },
  { command: "/model list", description: "main slot の利用可能モデル一覧から選択" },
  { command: "/model context", description: "main slot のコンテキスト長を変更 (例: 128k)", needsArg: true },
  { command: "/model setup", description: "main slot の新規セットアップ wizard (プロバイダ選択は wizard 内で)" },
  // /model second 系 (docs/model-registry.md §4.1)
  { command: "/model second", description: "second slot の状態表示・サブコマンド (旧 /second)" },
  { command: "/model second enable", description: "second slot を有効化" },
  { command: "/model second disable", description: "second slot を無効化" },
  { command: "/model second setup", description: "second slot の新規セットアップ wizard" },
  { command: "/model second list", description: "second slot の利用可能モデル一覧から選択" },
  { command: "/model second context", description: "second slot のコンテキスト長を変更 (例: 128k)", needsArg: true },
  { command: "/model second description", description: "second slot の特性説明 (サブエージェント選択の材料)", needsArg: true },
  // /model vision 系 (docs/model-registry.md Phase 5) — 画像認識を含むマルチモーダル言語生成 AI を指定
  { command: "/model vision", description: "vision slot の状態表示 (画像認識を含むマルチモーダル言語生成 AI)" },
  { command: "/model vision setup", description: "vision slot の新規セットアップ wizard" },
  { command: "/model vision list", description: "vision slot の利用可能モデル一覧から選択 (vision 対応モデル優先)" },
  { command: "/model vision context", description: "vision slot のコンテキスト長を変更 (例: 128k)", needsArg: true },
  { command: "/model vision description", description: "vision slot の特性説明", needsArg: true },
  { command: "/model vision clear", description: "vision slot を解除 (main LLM にフォールバック)" },
  { command: "/todo", description: "タスクリスト (active のみ / all=全件 / archive=完了済み削除)" },
  { command: "/goal-seek", description: "Goal Seek mode 開始 — acceptance criteria を立て合格まで自律実行", needsArg: true },
  { command: "/exit-goal-seek", description: "Goal Seek mode を抜ける (acceptance 未達成でも user 明示で中断)" },
  { command: "/resume", description: "セッション復元 (引数なしで picker / latest = 最新 / list = 一覧)" },
  { command: "/resume latest", description: "最新セッションを即復元 (旧 /continue)" },
  { command: "/resume list", description: "保存セッション一覧 (旧 /sessions)" },
  { command: "/sessions", description: "[非推奨] /resume list の alias" },
  { command: "/continue", description: "[非推奨] /resume latest の alias" },
  { command: "/memory", description: "メモリ表示" },
  { command: "/remember", description: "メモリに追記", needsArg: true },
  { command: "/loglevel", description: "運用ログのレベル確認・変更 (trace/debug/info/warn/error)" },
  { command: "/diff", description: "git diff" },
  { command: "/plan", description: "プランモード" },
  { command: "/skills", description: "スキル一覧" },
  { command: "/checkpoint", description: "自動チェックポイント (シャドウGit) の状態/一覧" },
  { command: "/checkpoint on", description: "自動チェックポイントを有効化 (ファイル変更を裏で版管理)" },
  { command: "/checkpoint off", description: "自動チェックポイントを無効化" },
  { command: "/checkpoint list", description: "チェックポイント一覧" },
  { command: "/checkpoint restore", description: "指定番号のチェックポイントへ復元", needsArg: true },
  { command: "/checkpoint diff", description: "指定番号との差分サマリ", needsArg: true },
  { command: "/checkpoint clear", description: "今セッションのチェックポイント履歴を削除 (--all で全セッション)" },
  { command: "/sandbox", description: "bash 封じ込めの状態 (OS 共通: Win→WSL / Mac・Linux→processSandbox)" },
  { command: "/sandbox on", description: "bash 封じ込めを有効化 (OS に応じ WSL 経由 / OS サンドボックス)" },
  { command: "/sandbox off", description: "bash 封じ込めを無効化" },
  // /cost (詳細表示として復活、 2026-06-01): /status は要約のみ、 詳細は /cost 配下に集約。
  // 設計: docs/cost-token-command-design.md
  { command: "/cost", description: "LLM 使用量サマリ (計測窓 / 合計 / 上位モデル)。 既定は計測窓 (/cost reset で区切り)" },
  { command: "/cost models", description: "モデル別の token / コスト / 単価・算出根拠 (期間: today|month|all|session 追記可)" },
  { command: "/cost providers", description: "provider 別 + slot (main/second/vision) 別の集計" },
  { command: "/cost today", description: "今日の使用量サマリ" },
  { command: "/cost yesterday", description: "昨日の使用量サマリ (任意日は /cost YYYY-MM-DD)" },
  { command: "/cost month", description: "今月の使用量サマリ" },
  { command: "/cost lastmonth", description: "先月の使用量サマリ (任意月は /cost YYYY-MM)" },
  { command: "/cost all", description: "全期間の使用量サマリ" },
  { command: "/cost reset", description: "計測窓をリセット (履歴 jsonl は保持)" },
  { command: "/cost export", description: "使用量を jsonl/csv で出力 (例: /cost export csv all)", needsArg: true },
  { command: "/token", description: "/cost の alias (token / コスト可視化)" },
  { command: "/autorun", description: "Autorunモード切り替え（非破壊操作の自動許可）" },
  { command: "/parallel", description: "並列ツール実行数の確認・変更", needsArg: true },
  { command: "/status", description: "セッション状態を 1 画面で表示 (slot / context / capability / metrics / cost / tasks)" },
  // /second は /model second の alias として動作 (Phase 4)。 補完には alias のみ残す。
  { command: "/second", description: "[非推奨] /model second の alias。 新規には /model second を推奨" },
  { command: "/swap", description: "メインLLM ⇔ セカンドLLM を入れ替え (確認あり)" },
  { command: "/swap -y", description: "メインLLM ⇔ セカンドLLM を入れ替え (確認なし)" },
  { command: "/switch", description: "メインLLM ⇔ セカンドLLM を入れ替え (/swap と同じ)" },
  { command: "/models", description: "Model Registry: 登録済モデル一覧 → Set as main/second / Edit / Duplicate / Delete / Add new" },
  { command: "/models list", description: "Model Registry の一覧表示のみ ([main]/[second] タグ付き)" },
  { command: "/models help", description: "/models の使い方を表示" },
  { command: "/profiles", description: "[非推奨] /models の alias。 旧 LLM プロファイル履歴コマンド" },
  { command: "/profiles list", description: "[非推奨] 保存済みプロファイル一覧を表示" },
  { command: "/profiles delete", description: "[非推奨] プロファイルを複数選択して削除" },
  { command: "/profiles help", description: "[非推奨] /profiles の使い方を表示" },
  { command: "/profile", description: "[非推奨] /profiles の alias" },
  { command: "/knowledge", description: "Obsidianナレッジベース" },
  { command: "/knowledge vault", description: "Vaultパスを設定", needsArg: true },
  { command: "/knowledge tags", description: "タグ一覧" },
  { command: "/knowledge recent", description: "最近のノート" },
  { command: "/knowledge search", description: "ナレッジ検索", needsArg: true },
  { command: "/knowledge open", description: "フォルダを開く" },
  // /integrations (Phase optimize #3、 2026-05-28): Discord / Slack / Chatlog / Search を 1 picker に集約。
  // 旧 4 系統は dispatcher 互換維持、 補完候補からは [非推奨] alias 1 件ずつのみ残す。
  { command: "/integrations", description: "外部統合 (Discord / Slack / Chatlog / Search) を 1 画面で設定" },
  { command: "/intg", description: "/integrations の短縮形" },
  { command: "/discord", description: "[非推奨] Discord 単体設定。 /integrations 推奨" },
  { command: "/slack", description: "[非推奨] Slack 単体設定。 /integrations 推奨" },
  { command: "/chatlog", description: "[非推奨] Chatlog 単体設定。 /integrations 推奨" },
  { command: "/search", description: "[非推奨] Search 単体設定。 /integrations 推奨" },
  // /search のサブコマンド (duckduckgo / ddg / test / status) は /integrations 配下に集約済み
  { command: "/loop", description: "プロンプトを定期実行 (例: /loop 5m /pr-review)", needsArg: true },
  { command: "/loop status", description: "アクティブなループ一覧 + 停止 picker (旧 /loop list の発展形)" },
  // /permission は引数なしで対話 picker (Phase optimize #1)。
  // 旧サブコマンド (auto-add / require-add / rule-add allow / 等) は dispatcher 互換のため残存するが、
  // 補完候補からは外して 1 件に集約。
  { command: "/permission", description: "権限設定 (引数なしで picker: rules / auto / require / discord / slack)" },
];


// ─── MenuProvider（InteractiveInput用ドロップダウン） ────

/**
 * /コマンドのドロップダウン候補プロバイダーを生成。
 * partial は "/" の後の文字列（例: "he" → /help がマッチ）
 */
export function createCommandMenuProvider(
  skillTriggers: { trigger: string; description: string }[] = [],
  toolNames: string[] = [],
): MenuProvider {
  const allDefs: CommandDef[] = [
    ...BUILTIN_COMMAND_DEFS,
    ...skillTriggers.map((s) => ({
      command: s.trigger,
      description: s.description,
    })),
  ];

  return (partial: string): MenuItem[] => {
    // /permission <subcommand> <tool名> のツール名補完
    // partial 例: "permission auto-add ba"
    const permToolMatch = partial.match(
      /^(permission (auto-add|auto-remove|require-add|require-remove|discord-add|discord-remove) )(.*)$/,
    );
    if (permToolMatch && toolNames.length > 0) {
      const cmdPrefix = permToolMatch[1]; // "permission auto-add "
      const toolPrefix = permToolMatch[3]; // 入力中のツール名プレフィックス
      return toolNames
        .filter((n) => n.startsWith(toolPrefix))
        .sort()
        .map((n) => ({
          label: `/${cmdPrefix}${n}`,
          value: `/${cmdPrefix}${n}`,
          description: "ツール名",
        }));
    }

    // 通常コマンドマッチ
    return allDefs
      .filter((d) => d.command.slice(1).startsWith(partial.toLowerCase()))
      .map((d) => ({
        label: d.command,
        // needsArg: 選択後も引数入力を続けるため末尾にスペースを付与
        value: d.needsArg ? d.command + " " : d.command,
        description: d.description,
      }));
  };
}

/**
 * @ファイルパスのドロップダウン候補プロバイダーを生成。
 * partial は "@" の後の文字列（例: "src/cl" → src/cli/ がマッチ）
 */
export function createFileMenuProvider(
  cwd: string = process.cwd(),
): MenuProvider {
  return (partial: string): MenuItem[] => {
    const paths = completeFilePath(partial, cwd);
    return paths.map((p) => ({
      label: p,
      value: p,
      description: p.endsWith("/") ? "📂" : "📄",
    }));
  };
}

// ─── readline completer（フォールバック用） ──────────────

const BUILTIN_COMMANDS = BUILTIN_COMMAND_DEFS.map((d) => d.command);

export interface CompleterOptions {
  skillTriggers?: string[];
  toolNames?: string[];
  cwd?: string;
}

export function createCompleter(
  options: CompleterOptions = {},
): (line: string) => CompleterResult {
  const { skillTriggers = [], cwd = process.cwd() } = options;
  const allCommands = [...BUILTIN_COMMANDS, ...skillTriggers];
  const toolNames = options.toolNames ?? [];

  return (line: string): CompleterResult => {
    if (line.startsWith("/")) {
      // /permission <subcommand> <tool名> のツール名補完
      const permToolMatch = line.match(
        /^(\/permission (?:auto-add|auto-remove|require-add|require-remove|discord-add|discord-remove) )(.*)$/,
      );
      if (permToolMatch && toolNames.length > 0) {
        const cmdPrefix = permToolMatch[1];
        const toolPrefix = permToolMatch[2];
        const matches = toolNames.filter((n) => n.startsWith(toolPrefix)).map((n) => `${cmdPrefix}${n}`);
        return [matches, line];
      }
      const matches = allCommands.filter((cmd) => cmd.startsWith(line));
      return [matches, line];
    }

    const atMatch = line.match(/@([a-zA-Z0-9_./\\-]*)$/);
    if (atMatch) {
      const partial = atMatch[1];
      const completions = completeFilePath(partial, cwd);
      const atPrefix = `@${partial}`;
      return [completions.map((c) => `@${c}`), atPrefix];
    }

    return [[], line];
  };
}

// ─── ファイルパス補完（共通ロジック） ────────────────────
//
// 動作:
//   1. partial が空 / "/" 終わりの場合 → そのディレクトリ直下を列挙（ドリルダウン用）
//   2. それ以外 → プロジェクト配下を再帰スキャンしてフルパスに対し部分一致
//      Claude Code 風: "@completer" → src/cli/completer.ts がヒット
//
// 再帰走査は cwd ごとに数秒キャッシュ。除外: 巨大/無関係ディレクトリと dotfile/dir。

const FILE_TREE_IGNORE = new Set([
  ".git",
  "node_modules",
  "dist",
  "deploy",
  "coverage",
  ".vitest",
  "__pycache__",
  ".next",
  ".turbo",
  "out",
  ".cache",
]);
const FILE_TREE_MAX_DEPTH = 8;
const FILE_TREE_MAX_ENTRIES = 20000;
const FILE_TREE_CACHE_TTL_MS = 3000;
const FILE_TREE_RESULT_LIMIT = 30;

const fileTreeCache = new Map<string, { fetchedAt: number; entries: string[] }>();

function getProjectFiles(cwd: string): string[] {
  const cached = fileTreeCache.get(cwd);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < FILE_TREE_CACHE_TTL_MS) {
    return cached.entries;
  }
  const entries: string[] = [];
  walkDir(cwd, cwd, 0, entries);
  entries.sort();
  fileTreeCache.set(cwd, { fetchedAt: now, entries });
  return entries;
}

function walkDir(dir: string, root: string, depth: number, out: string[]): void {
  if (depth > FILE_TREE_MAX_DEPTH) return;
  if (out.length >= FILE_TREE_MAX_ENTRIES) return;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of dirents) {
    if (out.length >= FILE_TREE_MAX_ENTRIES) return;
    if (ent.name.startsWith(".")) continue;
    if (FILE_TREE_IGNORE.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (ent.isDirectory()) {
      out.push(rel + "/");
      walkDir(full, root, depth + 1, out);
    } else if (ent.isFile()) {
      out.push(rel);
    }
  }
}

function listDirEntries(partial: string, cwd: string): string[] {
  try {
    const isExactDir = partial.endsWith("/") || partial.endsWith("\\");
    const searchDir = isExactDir ? path.resolve(cwd, partial) : cwd;
    if (!fs.existsSync(searchDir) || !fs.statSync(searchDir).isDirectory()) {
      return [];
    }
    const dirents = fs.readdirSync(searchDir, { withFileTypes: true });
    const results: string[] = [];
    for (const ent of dirents) {
      if (ent.name.startsWith(".")) continue;
      if (FILE_TREE_IGNORE.has(ent.name)) continue;
      const rel = isExactDir ? `${partial}${ent.name}` : ent.name;
      results.push(ent.isDirectory() ? `${rel}/` : rel);
    }
    return results.sort();
  } catch {
    return [];
  }
}

function completeFilePath(partial: string, cwd: string): string[] {
  // 1. 空 or "/" 終わり: そのディレクトリ直下を列挙
  if (partial === "" || partial.endsWith("/") || partial.endsWith("\\")) {
    return listDirEntries(partial, cwd);
  }

  // 2. 部分一致モード: 再帰スキャン + フルパス部分一致
  const needle = partial.toLowerCase().replace(/\\/g, "/");
  const all = getProjectFiles(cwd);

  type Hit = { path: string; score: number };
  const hits: Hit[] = [];
  for (const p of all) {
    const lower = p.toLowerCase();
    // basename 抽出 (ディレクトリは末尾 "/" の手前まで)
    const baseEnd = lower.endsWith("/") ? lower.length - 1 : lower.length;
    const lastSlash = lower.lastIndexOf("/", baseEnd - 1);
    const basename = lower.slice(lastSlash + 1, baseEnd);

    let score: number;
    if (basename.startsWith(needle)) {
      score = 1000;
    } else if (basename.includes(needle)) {
      score = 500;
    } else if (lower.includes(needle)) {
      score = 200;
    } else {
      continue;
    }
    // 浅いパス優先
    const depth = (p.match(/\//g)?.length ?? 0);
    score -= depth;
    // 同スコアならファイル優先（ディレクトリは末尾"/"分だけ僅かに減点）
    if (p.endsWith("/")) score -= 0.5;
    hits.push({ path: p, score });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, FILE_TREE_RESULT_LIMIT).map((h) => h.path);
}
