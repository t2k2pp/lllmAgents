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
  { command: "/context", description: "コンテキスト使用状況" },
  { command: "/compact", description: "コンテキスト圧縮" },
  { command: "/capability", description: "LLM能力ティア (T1/T2/T3) と profile を表示" },
  { command: "/metrics", description: "現セッションのテレメトリ (反復・bash累積・stuck-loop・トークン)" },
  { command: "/mcp status", description: "MCP サーバの接続状態を表示" },
  { command: "/mcp on", description: "MCP 全体を有効化 (/mcp reload で接続)" },
  { command: "/mcp off", description: "MCP 全体を無効化 (設定ファイルは変更しない)" },
  { command: "/mcp reload", description: "MCP サーバを切断して再接続" },
  { command: "/mcp toggle", description: "個別サーバの runtime skip 切替", needsArg: true },
  { command: "/try", description: "試行錯誤モード: 自動的に評価・改善を繰り返す", needsArg: true },
  { command: "/try 3", description: "最大3回試行（デフォルト）", needsArg: true },
  { command: "/stream", description: "ストリーミング表示モードの確認/切り替え" },
  { command: "/stream on", description: "ストリーミング表示モードに切り替え" },
  { command: "/stream off", description: "スピナー+Markdownレンダリングモードに切り替え" },
  { command: "/model", description: "モデル情報（設定値+サーバー報告）" },
  { command: "/model info", description: "モデル詳細情報" },
  { command: "/model list", description: "利用可能モデル一覧から選択" },
  { command: "/model context", description: "コンテキスト長の確認・変更 (例: 128k)", needsArg: true },
  { command: "/model setup", description: "ローカル系LLMをウィザードで再設定 (provider/host/port/model 一括)" },
  { command: "/model host", description: "メインLLM接続先のホスト or IP を変更 (ポートは保持)", needsArg: true },
  { command: "/model port", description: "メインLLM接続先のポート番号を変更", needsArg: true },
  { command: "/model url", description: "[非推奨] /model host + /model port または /model setup を推奨", needsArg: true },
  { command: "/model provider", description: "メインLLMのプロバイダーを実行時変更 (ollama/vllm等)", needsArg: true },
  { command: "/model setup azure-openai", description: "メインLLMをAzure OpenAI (Chat Completions API) へ対話セットアップ" },
  { command: "/model setup azure-gpt", description: "メインLLMをAzure OpenAI (Responses API、 gpt-5/codex系) へ対話セットアップ" },
  { command: "/model setup azure-claude", description: "メインLLMをAzure Claude へ対話セットアップ" },
  { command: "/model setup azure-foundry", description: "メインLLMをAzure AI Foundry (Kimi/Mistral等) へ対話セットアップ" },
  { command: "/model setup azure-anthropic", description: "メインLLMをAzure Claude (Anthropic Messages API) へ対話セットアップ" },
  { command: "/model description", description: "メインLLMの特性説明（サブエージェント選択の材料）", needsArg: true },
  { command: "/model temperature", description: "サンプリング温度 (0.0〜2.0、推論0.2/創造0.8。autoで未指定)", needsArg: true },
  { command: "/model top_p", description: "Top-p サンプリング (0.0〜1.0、1.0で無効化)", needsArg: true },
  { command: "/model top_k", description: "Top-k サンプリング (整数、20〜50推奨。Ollama系で有効)", needsArg: true },
  { command: "/model rep_penalty", description: "繰り返しペナルティ (1.0で中立、>1で抑制)", needsArg: true },
  { command: "/todo", description: "タスクリスト" },
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
{ command: "/second", description: "セカンドLLMの状態確認" },
  { command: "/second enable", description: "セカンドLLMを有効化" },
  { command: "/second disable", description: "セカンドLLMを無効化" },
  { command: "/second setup", description: "セカンドLLMの初期設定", needsArg: true },
  { command: "/second setup azure-openai", description: "Azure OpenAI (Chat Completions API) を対話セットアップ (endpoint/apiKey/deployment)" },
  { command: "/second setup azure-gpt", description: "Azure OpenAI (Responses API、 gpt-5/codex系) を対話セットアップ" },
  { command: "/second setup azure-claude", description: "Azure Claude を対話セットアップ (endpoint/apiKey/deployment)" },
  { command: "/second setup azure-foundry", description: "Azure AI Foundry (Kimi K2/Mistral等) を対話セットアップ" },
  { command: "/second setup azure-anthropic", description: "Azure Claude (Anthropic Messages API /anthropic/v1/messages) を対話セットアップ" },
  { command: "/second list", description: "セカンドLLMのモデル一覧から選択" },
  { command: "/second model", description: "セカンドLLMのモデルを直接指定", needsArg: true },
  { command: "/second url", description: "セカンドLLMのエンドポイントURL変更", needsArg: true },
  { command: "/second provider", description: "セカンドLLMのプロバイダー変更", needsArg: true },
  { command: "/second context", description: "セカンドLLMのコンテキスト長変更 (例: 128k)", needsArg: true },
  { command: "/second description", description: "セカンドLLMの特性説明（サブエージェント選択の材料）", needsArg: true },
  { command: "/second temperature", description: "セカンドLLMのサンプリング温度 (auto/clear で内部既定)", needsArg: true },
  { command: "/second top_p", description: "セカンドLLMのTop-p", needsArg: true },
  { command: "/second top_k", description: "セカンドLLMのTop-k (Ollama系)", needsArg: true },
  { command: "/second rep_penalty", description: "セカンドLLMの繰り返しペナルティ", needsArg: true },
  { command: "/swap", description: "メインLLM ⇔ セカンドLLM を入れ替え (確認あり)" },
  { command: "/swap -y", description: "メインLLM ⇔ セカンドLLM を入れ替え (確認なし)" },
  { command: "/switch", description: "メインLLM ⇔ セカンドLLM を入れ替え (/swap と同じ)" },
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

function completeFilePath(partial: string, cwd: string): string[] {
  try {
    const dir = path.dirname(partial);
    const prefix = path.basename(partial);
    const targetDir = path.resolve(cwd, dir === "." && partial === "" ? "." : dir);

    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      return [];
    }

    const isExactDir = partial.endsWith("/") || partial.endsWith("\\");
    let searchDir: string;
    let searchPrefix: string;

    if (isExactDir) {
      searchDir = path.resolve(cwd, partial);
      searchPrefix = "";
    } else {
      searchDir = targetDir;
      searchPrefix = prefix;
    }

    if (!fs.existsSync(searchDir) || !fs.statSync(searchDir).isDirectory()) {
      return [];
    }

    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (searchPrefix && !entry.name.startsWith(searchPrefix)) continue;

      const relativePath = isExactDir
        ? `${partial}${entry.name}`
        : dir === "."
          ? entry.name
          : `${dir}/${entry.name}`;

      if (entry.isDirectory()) {
        results.push(`${relativePath}/`);
      } else {
        results.push(relativePath);
      }
    }

    return results.sort();
  } catch {
    return [];
  }
}
