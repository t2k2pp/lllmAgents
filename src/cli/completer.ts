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
  { command: "/capability", description: "LLM能力ティア (T1/T2/T3) と profile を表示" },
  { command: "/metrics", description: "現セッションのテレメトリ (反復・bash累積・stuck-loop・トークン)" },
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
  { command: "/stream", description: "ストリーミング表示モードの確認/切り替え" },
  { command: "/stream on", description: "ストリーミング表示モードに切り替え" },
  { command: "/stream off", description: "スピナー+Markdownレンダリングモードに切り替え" },
  // ── Model / Second LLM コマンド (docs/model-registry.md) ──
  // Phase 3 (2026-05-27): 個別編集系のコマンドは /models Edit に統合された。
  //   - /model setup <provider> の各バリアントは /models Add new... の wizard へ集約 → 補完から除外
  //   - /model host / port / url / provider / temperature / top_p / top_k / rep_penalty / description
  //     等の個別編集は /models Edit から行う → 補完から除外 (dispatcher は互換のため残存)
  //   - 残すのは: /model (状態表示), /model info, /model list, /model context, /model setup
  { command: "/model", description: "メインLLM の状態を表示 (詳細編集は /models)" },
  { command: "/model info", description: "メインLLM の詳細情報を表示" },
  { command: "/model list", description: "メインLLM の利用可能モデル一覧から選択" },
  { command: "/model context", description: "メインLLM のコンテキスト長を変更 (例: 128k)", needsArg: true },
  { command: "/model setup", description: "メインLLM の新規セットアップ wizard (プロバイダ選択は wizard 内で)" },
  { command: "/todo", description: "タスクリスト (active のみ / all=全件 / archive=完了済み削除)" },
  { command: "/goal-seek", description: "Goal Seek mode 開始 — acceptance criteria を立て合格まで自律実行", needsArg: true },
  { command: "/exit-goal-seek", description: "Goal Seek mode を抜ける (acceptance 未達成でも user 明示で中断)" },
  { command: "/sessions", description: "セッション一覧" },
  { command: "/resume", description: "セッション復元" },
  { command: "/continue", description: "最新セッション復元" },
  { command: "/memory", description: "メモリ表示" },
  { command: "/remember", description: "メモリに追記", needsArg: true },
  { command: "/loglevel", description: "運用ログのレベル確認・変更 (trace/debug/info/warn/error)" },
  { command: "/diff", description: "git diff" },
  { command: "/plan", description: "プランモード" },
  { command: "/skills", description: "スキル一覧" },
  { command: "/cost", description: "セッションのトークン・コスト表示" },
  { command: "/autorun", description: "Autorunモード切り替え（非破壊操作の自動許可）" },
  { command: "/parallel", description: "並列ツール実行数の確認・変更", needsArg: true },
  { command: "/status", description: "ステータス" },
  // /second 系も /models へ集約 (詳細編集は /models Edit、 新規追加は /models Add new)。
  // 残すのは: /second (状態), /second enable, /second disable, /second setup, /second list, /second context
  { command: "/second", description: "セカンドLLM の状態を表示 (詳細編集は /models)" },
  { command: "/second enable", description: "セカンドLLM を有効化" },
  { command: "/second disable", description: "セカンドLLM を無効化" },
  { command: "/second setup", description: "セカンドLLM の新規セットアップ wizard (プロバイダ選択は wizard 内で)" },
  { command: "/second list", description: "セカンドLLM の利用可能モデル一覧から選択" },
  { command: "/second context", description: "セカンドLLM のコンテキスト長を変更 (例: 128k)", needsArg: true },
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
  { command: "/chatlog", description: "チャットログ保存設定 (status)" },
  { command: "/chatlog status", description: "チャットログの状態表示" },
  { command: "/chatlog vault", description: "チャットログ Vault パス設定", needsArg: true },
  { command: "/chatlog enable", description: "チャットログ ON" },
  { command: "/chatlog disable", description: "チャットログ OFF" },
  { command: "/discord", description: "Discord通知設定 (status)" },
  { command: "/discord status", description: "Discord 設定状態を表示" },
  { command: "/discord enable", description: "Discord 通知を有効化" },
  { command: "/discord disable", description: "Discord 通知を無効化" },
  { command: "/discord url", description: "Discord Webhook URL を設定", needsArg: true },
  { command: "/discord test", description: "Discord にテスト送信" },
  { command: "/discord app-id", description: "Discord Application ID を設定", needsArg: true },
  { command: "/discord public-key", description: "Discord Public Key (署名検証) を設定", needsArg: true },
  { command: "/discord bot-token", description: "Discord Bot Token を設定", needsArg: true },
  { command: "/discord port", description: "Interaction Server ポート設定", needsArg: true },
  { command: "/discord register", description: "/ask スラッシュコマンドを Discord に登録 (任意: guild-id)", needsArg: true },
  { command: "/discord listen start", description: "Interaction Server を起動" },
  { command: "/discord listen stop", description: "Interaction Server を停止" },
  { command: "/discord listen auto-start", description: "次回起動時に自動起動 (offで解除)", needsArg: true },
  { command: "/slack", description: "Slack設定 (status)" },
  { command: "/slack status", description: "Slack 設定状態を表示" },
  { command: "/slack enable", description: "Slack 通知を有効化" },
  { command: "/slack disable", description: "Slack 通知を無効化" },
  { command: "/slack url", description: "Slack Webhook URL を設定", needsArg: true },
  { command: "/slack test", description: "Slack にテスト送信" },
  { command: "/slack bot-token", description: "Slack Bot Token (xoxb-) を設定", needsArg: true },
  { command: "/slack app-token", description: "Slack App-Level Token (xapp-) を設定", needsArg: true },
  { command: "/search", description: "Web検索プロバイダー設定 (status)" },
  { command: "/search status", description: "現在の検索プロバイダー表示" },
  { command: "/search searxng", description: "SearXNG に切替 (任意: URL)", needsArg: true },
  { command: "/search duckduckgo", description: "DuckDuckGo に切替" },
  { command: "/search ddg", description: "DuckDuckGo に切替 (短縮形)" },
  { command: "/search test", description: "テスト検索を実行" },
  { command: "/loop", description: "プロンプトを定期実行 (例: /loop 5m /pr-review)", needsArg: true },
  { command: "/loop list", description: "アクティブなループ一覧" },
  { command: "/loop stop", description: "ループを停止 (任意: id|all)", needsArg: true },
  { command: "/permission", description: "権限設定" },
  { command: "/permission list", description: "権限設定一覧" },
  { command: "/permission auto-add", description: "CLI自動許可に追加", needsArg: true },
  { command: "/permission auto-remove", description: "CLI自動許可から削除", needsArg: true },
  { command: "/permission require-add", description: "CLI確認必要に追加", needsArg: true },
  { command: "/permission require-remove", description: "CLI確認必要から削除", needsArg: true },
  { command: "/permission discord-add", description: "Discord許可に追加", needsArg: true },
  { command: "/permission discord-remove", description: "Discord許可から削除", needsArg: true },
  { command: "/permission rules", description: "パターンルール一覧" },
  { command: "/permission rule-add allow", description: "allowルールを追加", needsArg: true },
  { command: "/permission rule-add deny", description: "denyルールを追加", needsArg: true },
  { command: "/permission rule-add ask", description: "askルールを追加", needsArg: true },
  { command: "/permission rule-remove allow", description: "allowルールを削除", needsArg: true },
  { command: "/permission rule-remove deny", description: "denyルールを削除", needsArg: true },
  { command: "/permission rule-remove ask", description: "askルールを削除", needsArg: true },
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
