import * as os from "node:os";
import { loadMemory } from "./memory.js";
import { loadProjectInstructions, getGitInfo } from "./project-context.js";
import { isWindows } from "../utils/platform.js";
import { RuleLoader } from "../rules/rule-loader.js";

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

export function buildSystemPrompt(skills?: SkillInfo[], hasSecondLLM?: boolean, hasObsidian?: boolean): string {
  const memory = loadMemory();
  const projectInstructions = loadProjectInstructions();
  const gitInfo = getGitInfo();

  const parts: string[] = [];

  // Core identity
  parts.push(`あなたはAIエージェント。ユーザーの依頼をツールで完遂する。テキスト発言だけで終わらせない。

# 行動原則
- 成果物は file_write/file_edit で作る（テキスト回答と分離）
- 不明点 → ask_user / 複雑タスク → todo_write で管理 / 非自明な実装 → enter_plan_mode / 並列調査 → task で委任

# 実装→検証サイクル [必須]
実装(file_write/edit) → 検証(bash) → エラー修正 → 再検証。省略禁止。
検証例: JS/TS=\`node --check\`, Py=\`python -c"import ast;..."\`, 汎用=build/test/lint
禁止: 検証なしの完了報告 / エラー無視で別ファイルへ移動 / 検証なしの連続書き直し

# ツール使用
- 編集前に file_read で必ず読む。新規作成より既存編集を優先
- ファイル内容確認は file_read（bash の cat/head 不可）

# サブエージェント (task)
タイプ: explore / plan / general-purpose / bash。独立タスクは並列起動で効率化。

# セキュリティ
サンドボックス外アクセス禁止。危険コマンド(rm -rf等)ブロック。認証情報ハードコード禁止。

# 出力スタイル
- 日本語の入力には日本語で返答。プロフェッショナルな口調
- ファイル操作報告はパスと変更概要のみ。挨拶・質問には直接返答（ツール不要）`);

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

  // Second LLM (詳細ガイドは初回使用時に注入)
  if (hasSecondLLM) {
    parts.push(`
セカンドLLMツール利用可能: second_llm_consult(単発質問), second_llm_agent(複合タスク委任)。コンテキスト節約・レビュー・壁打ちに自発的に使用すること。`);
  }

  // Obsidian Knowledge (詳細ガイドは初回使用時に注入)
  if (hasObsidian) {
    parts.push(`
ナレッジツール利用可能: knowledge_save(保存), knowledge_search(検索)。保存はユーザー指示時のみ（自動保存禁止）。`);
  }

  // Rules
  const ruleLoader = new RuleLoader();
  const rulesSection = ruleLoader.formatForSystemPrompt();
  if (rulesSection) {
    parts.push(rulesSection);
  }

  return parts.join("\n");
}
