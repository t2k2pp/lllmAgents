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
import { getRegistryCompletions } from "./commands/registry.js";

// ─── コマンド定義（説明付き） ────────────────────────────
//
// 注: レジストリ登録コマンド (src/cli/commands/ — PR-10) の候補は
// getRegistryCompletions() から自動合成されるため、この配列には旧 switch 方式の
// コマンドだけを列挙する。新規コマンドはレジストリ側に追加すること。

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
  { command: "/clear", description: "会話履歴クリア (現在の Room)" },
  { command: "/room", description: "Room 一覧 (A/B/C の状態・現在地)" },
  { command: "/room A", description: "REPL を Room A へ移動" },
  { command: "/room B", description: "REPL を Room B へ移動 (Discord 既定)" },
  { command: "/room C", description: "REPL を Room C へ移動 (Slack 既定)" },
  {
    command: "/room resume",
    description: "現在の Room の最後の会話を再開 (/room resume A|B|C で指定)",
    needsArg: true,
  },
  {
    command: "/room autoresume",
    description: "現在の Room の自動 Resume を on/off (/room autoresume on|off [A|B|C])",
    needsArg: true,
  },
  { command: "/queue", description: "受信順キューの待ち状況を表示" },
  { command: "/queue clear", description: "REPL の type-ahead 待機入力を破棄" },
  {
    command: "/context",
    description: "コンテキスト使用状況 (System prompt / Memory / Skills / Tools / Messages 内訳)",
  },
  { command: "/context system", description: "システムプロンプト本文の内訳をダンプ" },
  { command: "/context memory", description: "メモ・プロジェクト指示の本文をダンプ" },
  { command: "/context skills", description: "注入中スキル一覧 (trigger/description) をダンプ" },
  {
    command: "/context tools",
    description: "ツール定義をトークン降順で一覧 (/context tools <name> で全文スキーマ)",
    needsArg: true,
  },
  { command: "/context messages", description: "会話履歴をメッセージ単位でダンプ" },
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
  {
    command: "/goal-loop",
    description: '決定的検証ゲート型ループ: --check の exit 0 まで反復 (例: --check "npm test")',
    needsArg: true,
  },
  { command: "/stream", description: "ストリーミング表示モードの確認/切り替え (引数なしで対話 toggle)" },
  // ── Model / Second LLM コマンド (docs/model-registry.md) ──
  // Phase 3 (2026-05-27): 個別編集系を /models Edit wizard に集約した。
  // 2026-06-21: discoverability 優先で main-slot の編集系サブコマンドを補完に復活
  //   （second/vision は description 等が補完に出るのに main だけ非対称だった漏れの解消）。
  //   - dispatcher (repl.ts の /model ハンドラ) は元から全サブコマンドを処理している。
  //   - 補完に出すのは現在値表示も兼ねる編集系: description / temperature / top_p / top_k /
  //     rep_penalty / host / port / provider（bare で現在値、引数で更新）。
  //   - 除外: /model url（dispatcher 内で非推奨明示）、ip（host の alias）。
  //   - 個別編集をまとめて行う集約 UI は引き続き /models Edit。
  //   - /model setup <provider> の各バリアントは /models Add new... の wizard へ集約 → 補完から除外。
  { command: "/model", description: "main / second / 他 slot の状態を 1 画面で表示 (詳細編集は /models)" },
  { command: "/model list", description: "main slot の利用可能モデル一覧から選択" },
  { command: "/model context", description: "main slot のコンテキスト長を変更 (例: 128k)", needsArg: true },
  { command: "/model description", description: "main slot の特性説明 (サブエージェント選択の材料)", needsArg: true },
  { command: "/model temperature", description: "main slot の temperature (0〜2、推論重視は低め)", needsArg: true },
  { command: "/model top_p", description: "main slot の top_p (0〜1、1.0で無効化)", needsArg: true },
  { command: "/model top_k", description: "main slot の top_k (整数、Ollama系で有効)", needsArg: true },
  {
    command: "/model rep_penalty",
    description: "main slot の repetition penalty (1.0で中立、>1で繰り返し抑制)",
    needsArg: true,
  },
  { command: "/model host", description: "main slot の接続先ホスト/IP を変更", needsArg: true },
  { command: "/model port", description: "main slot の接続先ポートを変更", needsArg: true },
  {
    command: "/model provider",
    description: "main slot のプロバイダ種別を変更 (ローカル系。クラウドは setup へ誘導)",
    needsArg: true,
  },
  { command: "/model setup", description: "main slot の新規セットアップ wizard (プロバイダ選択は wizard 内で)" },
  // /model second 系 (docs/model-registry.md §4.1)
  { command: "/model second", description: "second slot の状態表示・サブコマンド (旧 /second)" },
  { command: "/model second enable", description: "second slot を有効化" },
  { command: "/model second disable", description: "second slot を無効化" },
  { command: "/model second setup", description: "second slot の新規セットアップ wizard" },
  { command: "/model second list", description: "second slot の利用可能モデル一覧から選択" },
  { command: "/model second context", description: "second slot のコンテキスト長を変更 (例: 128k)", needsArg: true },
  {
    command: "/model second description",
    description: "second slot の特性説明 (サブエージェント選択の材料)",
    needsArg: true,
  },
  // /model vision 系 (docs/model-registry.md Phase 5) — 画像認識を含むマルチモーダル言語生成 AI を指定
  { command: "/model vision", description: "vision slot の状態表示 (画像認識を含むマルチモーダル言語生成 AI)" },
  { command: "/model vision setup", description: "vision slot の新規セットアップ wizard" },
  { command: "/model vision list", description: "vision slot の利用可能モデル一覧から選択 (vision 対応モデル優先)" },
  { command: "/model vision context", description: "vision slot のコンテキスト長を変更 (例: 128k)", needsArg: true },
  { command: "/model vision description", description: "vision slot の特性説明", needsArg: true },
  { command: "/model vision clear", description: "vision slot を解除 (main LLM にフォールバック)" },
  { command: "/todo", description: "タスクリスト (active のみ / all=全件 / archive=完了済み削除)" },
  {
    command: "/goal-seek",
    description: "Goal Seek mode 開始 — acceptance criteria を立て合格まで自律実行",
    needsArg: true,
  },
  { command: "/exit-goal-seek", description: "Goal Seek mode を抜ける (acceptance 未達成でも user 明示で中断)" },
  { command: "/resume", description: "セッション復元 (引数なしで picker / latest = 最新 / list = 一覧)" },
  { command: "/resume latest", description: "最新セッションを即復元 (旧 /continue)" },
  { command: "/resume list", description: "保存セッション一覧 (旧 /sessions)" },
  { command: "/sessions", description: "[非推奨] /resume list の alias" },
  { command: "/continue", description: "[非推奨] /resume latest の alias" },
  { command: "/memory", description: "メモリ表示" },
  { command: "/remember", description: "メモリに追記", needsArg: true },
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
  {
    command: "/sandbox",
    description: "bash 封じ込めの状態 (Mac/Linux/WSL2内=processSandbox。Winネイティブは非対応→WSL2内起動を案内)",
  },
  { command: "/sandbox on", description: "bash 封じ込めを有効化 (Mac/Linux/WSL2内のOSサンドボックス)" },
  { command: "/sandbox off", description: "bash 封じ込めを無効化" },
  { command: "/sandbox status", description: "封じ込めレベル・ネット allowlist・自動許可・中継先を表示" },
  { command: "/sandbox allow", description: "ネット allowlist にドメインを追加 (例: *.example.com)", needsArg: true },
  { command: "/sandbox deny", description: "ネット allowlist からドメインを削除", needsArg: true },
  // /cost (詳細表示として復活、 2026-06-01): /status は要約のみ、 詳細は /cost 配下に集約。
  // 設計: docs/cost-token-command-design.md
  {
    command: "/cost",
    description: "LLM 使用量サマリ (計測窓 / 合計 / 上位モデル)。 既定は計測窓 (/cost reset で区切り)",
  },
  {
    command: "/cost models",
    description: "モデル別の token / コスト / 単価・算出根拠 (期間: today|month|all|session 追記可)",
  },
  { command: "/cost providers", description: "provider 別 + slot (main/second/vision/image) 別の集計" },
  { command: "/cost today", description: "今日の使用量サマリ" },
  { command: "/cost yesterday", description: "昨日の使用量サマリ (任意日は /cost YYYY-MM-DD)" },
  { command: "/cost month", description: "今月の使用量サマリ" },
  { command: "/cost lastmonth", description: "先月の使用量サマリ (任意月は /cost YYYY-MM)" },
  { command: "/cost all", description: "全期間の使用量サマリ" },
  { command: "/cost reset", description: "計測窓をリセット (履歴 jsonl は保持)" },
  { command: "/cost export", description: "使用量を jsonl/csv で出力 (例: /cost export csv all)", needsArg: true },
  {
    command: "/cost rate",
    description: "為替レート設定でコストを円表示 (例: /cost rate 150)。 /cost rate off でドル表示に戻す",
    needsArg: true,
  },
  { command: "/token", description: "/cost の alias (token / コスト可視化)" },
  // /image: 画像生成 (Azure GPT Images / SD WebUI / ComfyUI)。設計: docs/image-generation.md
  { command: "/image", description: "画像生成の状態表示 (機能トグル / プロファイル一覧)" },
  { command: "/image on", description: "画像生成機能を有効化 (image_generate ツール登録)" },
  { command: "/image off", description: "画像生成機能を無効化 (ツール解除)" },
  { command: "/image setup", description: "プロファイル追加 (azure | sd-webui | comfyui)", needsArg: true },
  { command: "/image set", description: "既定の品質・解像度を変更 (API Key は触らず対話選択)" },
  { command: "/image use", description: "アクティブプロファイルを切替", needsArg: true },
  { command: "/image list", description: "プロファイル一覧を表示" },
  { command: "/image remove", description: "プロファイルを削除", needsArg: true },
  { command: "/image test", description: "アクティブバックエンドへの疎通確認 (Azure は設定検証のみ)" },
  { command: "/image gen", description: "ダイレクト画像生成 (例: /image gen a red dragon, pixel art)", needsArg: true },
  {
    command: "/compress-input",
    description: "入力圧縮モード切替（project指示/メモが閾値超過時に意図保持圧縮、既定OFF）",
  },
  {
    command: "/status",
    description: "セッション状態を 1 画面で表示 (slot / context / capability / metrics / cost / tasks)",
  },
  // /second は /model second の alias として動作 (Phase 4)。 補完には alias のみ残す。
  { command: "/second", description: "[非推奨] /model second の alias。 新規には /model second を推奨" },
  { command: "/swap", description: "メインLLM ⇔ セカンドLLM を入れ替え (確認あり)" },
  { command: "/swap -y", description: "メインLLM ⇔ セカンドLLM を入れ替え (確認なし)" },
  { command: "/switch", description: "メインLLM ⇔ セカンドLLM を入れ替え (/swap と同じ)" },
  {
    command: "/models",
    description: "Model Registry: 登録済モデル一覧 → Set as main/second / Edit / Duplicate / Delete / Add new",
  },
  { command: "/models list", description: "Model Registry の一覧表示のみ ([main]/[second] タグ付き)" },
  // Phase 6 (docs/model-orchestration.md §7): 任意 named slot への割当。
  // task ツールの model 引数 / エージェント定義の frontmatter model: から指名できるようになる。
  { command: "/models slot", description: "全 slot (main/second/vision + 自由 slot) の割当状況を表示" },
  {
    command: "/models slot clear",
    description: "自由 slot を解除 (例: /models slot clear deep)",
    needsArg: true,
  },
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
  // 旧 4 系統 (/discord /slack /chatlog /search) は dispatcher 互換のため case 本体を残すが、
  // /integrations の各サブメニューが内部呼び出しする実装専用とし、補完候補からは除外する
  // (cleanup 2026-06-20: 統廃合済みのため [非推奨] alias を補完から削除)。
  { command: "/integrations", description: "外部統合 (Discord / Slack / Chatlog / Search) を 1 画面で設定" },
  { command: "/intg", description: "/integrations の短縮形" },
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
    // レジストリ登録コマンド (PR-10) の候補を自動合成
    ...getRegistryCompletions().map((c) => ({
      command: c.command,
      description: c.description,
      needsArg: c.needsArg,
    })),
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

    // /context tools <tool名> のツール名補完 (partial 例: "context tools ba")
    const ctxToolMatch = partial.match(/^(context tools )(.*)$/);
    if (ctxToolMatch && toolNames.length > 0) {
      const cmdPrefix = ctxToolMatch[1]; // "context tools "
      const toolPrefix = ctxToolMatch[2];
      return toolNames
        .filter((n) => n.startsWith(toolPrefix))
        .sort()
        .map((n) => ({
          label: `/${cmdPrefix}${n}`,
          value: `/${cmdPrefix}${n}`,
          description: "このツールの定義全文 (parameters スキーマ) を表示",
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
export function createFileMenuProvider(cwd: string = process.cwd()): MenuProvider {
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

const BUILTIN_COMMANDS = [
  ...BUILTIN_COMMAND_DEFS.map((d) => d.command),
  ...getRegistryCompletions().map((c) => c.command),
];

export interface CompleterOptions {
  skillTriggers?: string[];
  toolNames?: string[];
  cwd?: string;
}

export function createCompleter(options: CompleterOptions = {}): (line: string) => CompleterResult {
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
      // /context tools <tool名> のツール名補完
      const ctxToolMatch = line.match(/^(\/context tools )(.*)$/);
      if (ctxToolMatch && toolNames.length > 0) {
        const cmdPrefix = ctxToolMatch[1];
        const toolPrefix = ctxToolMatch[2];
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
    const depth = p.match(/\//g)?.length ?? 0;
    score -= depth;
    // 同スコアならファイル優先（ディレクトリは末尾"/"分だけ僅かに減点）
    if (p.endsWith("/")) score -= 0.5;
    hits.push({ path: p, score });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, FILE_TREE_RESULT_LIMIT).map((h) => h.path);
}
