import * as os from "node:os";
import { loadMemory } from "./memory.js";
import { loadProjectInstructions, getGitInfo } from "./project-context.js";
import { isWindows } from "../utils/platform.js";
import { RuleLoader } from "../rules/rule-loader.js";
import type { ContextModeManager } from "../context/context-mode.js";

/**
 * テキストを指定文字数以内に切り詰める。行境界で切るため中途半端な切断を避ける。
 */
function truncateAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars);
  const end = cut > 0 ? cut : maxChars;
  return text.slice(0, end);
}

export interface SkillInfo {
  name: string;
  trigger: string;
  description: string;
}

export function buildSystemPrompt(contextModeManager?: ContextModeManager, skills?: SkillInfo[]): string {
  const memory = loadMemory();
  const projectInstructions = loadProjectInstructions();
  const gitInfo = getGitInfo();

  const parts: string[] = [];

  // Core identity
  parts.push(`あなたはソフトウェアエンジニアです。ツールを使ってコードを書き、ファイルを操作し、タスクを完遂します。
考えたら即座にツールを呼び出してください。テキストで計画を述べるのではなく、行動してください。

# 行動原則
- テキスト応答にコードを書かない。コードは必ず file_write / file_edit で操作する
- 考えを述べるだけで終わらない。必ずツール呼び出しを含める
- 「次に〜します」ではなく、実際にそのツールを呼び出す
- 独立した複数のツール呼び出しは1つのレスポンスで並列に発行する
- 不明点があれば ask_user で質問する

# ツール使用
- ファイルを編集する前に file_read で必ず読む
- 新しいファイルを作るより既存ファイルを編集する
- ファイル内容の確認には file_read を使う（bash の cat/type/head は不可）
- 複雑なタスクは todo_write で進捗管理する
- 非自明な実装タスクでは enter_plan_mode で計画を立ててから実装する
- 複雑な調査や並列作業は task でサブエージェントに委任する

# サブエージェント (task)
タイプ: explore(探索専用), plan(計画専用), general-purpose(汎用), bash(コマンド実行)
独立したタスクは複数サブエージェントを並列起動して効率化する。

# セキュリティ
- サンドボックス外のファイルアクセスは禁止
- 危険なコマンド(rm -rf /, format等)はブロック
- 認証情報をコードにハードコードしない

# 出力スタイル
- 日本語で話しかけられたら日本語で返答する
- 回答は簡潔に。ファイル操作の完了報告はパスと変更概要のみ
- 挨拶・雑談・質問には直接返答する（ツール不要）`);

  // Environment info
  const now = new Date();
  const localDatetime = now.toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  parts.push(`
# 環境
- プラットフォーム: ${process.platform}
- シェル: ${isWindows ? "git bash (Unix構文を使用。cmd.exe/PowerShell構文は不可)" : process.env.SHELL ?? "/bin/sh"}
- 作業ディレクトリ: ${process.cwd()}
- Git: ${gitInfo.isGitRepo ? `yes (branch: ${gitInfo.branch ?? "unknown"})` : "no"}
- Node.js: ${process.version}
- ホームディレクトリ: ${os.homedir()}
- 現在日時: ${localDatetime}`);

  // Project instructions (truncate at line boundary to avoid broken context)
  if (projectInstructions) {
    parts.push(`
# プロジェクト指示（参考情報）
以下は現在の作業ディレクトリのリポジトリ固有の開発ルールです。ユーザーから別の指示がある場合はユーザーの指示を優先すること。
${truncateAtLine(projectInstructions, 3000)}`);
  }

  // Auto-memory (truncate at line boundary)
  if (memory) {
    parts.push(`
# メモ
${truncateAtLine(memory, 2000)}`);
  }

  // Skills (dynamic list)
  if (skills && skills.length > 0) {
    const skillLines = skills.map((s) => `- ${s.trigger}: ${s.description}`).join("\n");
    parts.push(`
# 利用可能なスキル一覧（参照用）
ユーザーが明示的にスキルを呼び出した場合のみ使用する。自発的に表示・実行しないこと:

${skillLines}`);
  }

  // Rules
  const ruleLoader = new RuleLoader();
  const rulesSection = ruleLoader.formatForSystemPrompt();
  if (rulesSection) {
    parts.push(rulesSection);
  }

  // Context mode
  if (contextModeManager) {
    parts.push(contextModeManager.getPromptSection());
  }

  return parts.join("\n");
}
