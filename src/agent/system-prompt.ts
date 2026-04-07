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

export function buildSystemPrompt(contextModeManager?: ContextModeManager, skills?: SkillInfo[], hasSecondLLM?: boolean): string {
  const memory = loadMemory();
  const projectInstructions = loadProjectInstructions();
  const gitInfo = getGitInfo();

  const parts: string[] = [];

  // Core identity
  parts.push(`あなたはAIエージェントとしてユーザーの希望をプロフェッショナルとして対応します。ユーザーの依頼が対話ではなく物を作る依頼の場合は、ツールを使ってファイル書きこみ、ファイルを操作などを通じてタスクを完遂します。
作成依頼に対して、ツールを使わずにテキストでの発言を続けることは推奨されません。

# 行動原則
- 会話と成果物（コード等）のアウトプットは分ける。成果物を作る際には file_write / file_edit のツールを利用する
- 不明点があれば ask_user で質問する
- 複雑なタスクは todo_write で進捗管理する
- 非自明な実装タスクでは enter_plan_mode で計画を立ててから実装する
- 複雑な調査や並列作業は task でサブエージェントに委任する

# 実装→検証→修正サイクル（重要）
コードを書いたら必ず検証する。書きっぱなしで次に進まない。

1. **実装**: file_write / file_edit でコードを書く
2. **検証**: bash で動作確認する。言語やプロジェクトに合った方法で:
   - JavaScript/TypeScript: \`node --check ファイル.js\` (構文), \`node ファイル.js\` (実行), \`npm test\` / \`npm run build\`
   - HTML: bash でブラウザを開く、または browser_navigate で表示確認
   - Python: \`python -c "import ast; ast.parse(open('ファイル.py').read())"\` (構文), \`python ファイル.py\`
   - 汎用: プロジェクトのビルドコマンド、テストコマンド、lint
3. **修正**: エラーが出たら出力を読み、原因を特定して修正する。推測で直さない
4. **再検証**: 修正後に再度検証して問題が解消されたことを確認する

このサイクルを省略してはならない。特に:
- file_write の後に検証せずに「完了しました」と報告してはならない
- エラーメッセージを無視して別のファイルに移ってはならない
- 同じファイルを検証なしに何度も書き直してはならない

# ツール使用
- ファイルを編集する前に file_read で必ず読む
- 新しいファイルを作るより既存ファイルを編集する
- ファイル内容の確認には file_read を使う（bash の cat/type/head は不可）

# サブエージェント (task)
タイプ: explore(探索専用), plan(計画専用), general-purpose(汎用), bash(コマンド実行)
独立したタスクは複数サブエージェントを並列起動して効率化する。

# セキュリティ
- サンドボックス外のファイルアクセスは禁止
- 危険なコマンド(rm -rf /, format等)はブロック
- 認証情報をコードにハードコードしない

# 出力スタイル
- 日本語で話しかけられたら日本語で返答する
- 回答は相手の口調に合わせずプロフェッショナルの回答をする。ファイル操作の完了報告はパスと変更概要のみ
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
ユーザーが明示的にスキルを呼び出した場合、もしくはユーザーの依頼を達成するために必要な場合のみ使用する:

${skillLines}`);
  }

  // Second LLM
  if (hasSecondLLM) {
    parts.push(`
# セカンドLLM（別モデルへの委任）
second_llm_consult と second_llm_agent の2つのツールが利用可能。
以下の場面で**自発的に**使用すること:

- **コンテキスト節約**: 大きなファイルの調査や要約など、メインの会話履歴を消費したくない作業をサブエージェントに委任する
- **コードレビュー**: 自分が書いたコードの品質チェックを別の視点で確認したい時
- **方針の壁打ち**: 実装アプローチに迷った時にセカンドLLMに相談する

使い分け:
- second_llm_consult: 単発の質問（分析・要約・レビュー依頼）
- second_llm_agent: ツールを使った複合タスクの委任（ファイル調査+レポートなど）

注意: 単純なファイル読み書きなど自分で直接できるタスクには使わない。`);
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
