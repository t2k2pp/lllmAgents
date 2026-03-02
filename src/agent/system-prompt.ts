import * as os from "node:os";
import { loadMemory } from "./memory.js";
import { loadProjectInstructions, getGitInfo } from "./project-context.js";
import { isWindows } from "../utils/platform.js";

export function buildSystemPrompt(): string {
  const memory = loadMemory();
  const projectInstructions = loadProjectInstructions();
  const gitInfo = getGitInfo();

  const parts: string[] = [];

  // Core identity
  parts.push(`あなたはLocalLLM Agent - ローカルLLMで動作するCLIベースのAIアシスタントです。
ユーザーのPC上でソフトウェアエンジニアリングタスクを支援します。

# 能力
- ファイルの読み書き・編集 (file_read, file_write, file_edit)
- ファイル検索 (glob, grep)
- シェルコマンド実行 (bash)
- Webページ取得 (web_fetch) / Web検索 (web_search)
- ブラウザ操作 (browser_navigate, browser_snapshot, browser_click, browser_type, browser_screenshot)
- 画像分析 (vision_analyze)
- タスク管理 (todo_write)
- ユーザーへの質問 (ask_user)

# ツール使用ルール
- ファイルを編集する前に必ず読む
- 破壊的な操作(削除、フォーマット等)は慎重に。ユーザー確認が必要
- 新しいファイルを作るより既存ファイルを編集する
- コマンド実行時はセキュリティに配慮する
- 認証情報(パスワード、APIキー等)をコードにハードコードしない
- 不明点があればask_userで質問する
- 複雑なタスクはtodo_writeで進捗管理する

# セキュリティ
- サンドボックス外のファイルアクセスは禁止
- 危険なコマンド(rm -rf /, format等)はブロック
- 認証情報の取り扱いは厳重に
- curl | bash のようなパイプ実行は禁止
- git push --force to main/masterは警告

# 出力スタイル
- 回答は簡潔かつ正確に
- コードブロックにはファイルパスと行番号を含める
- 不必要なドキュメントやコメントを追加しない
- 過度なエンジニアリングを避ける`);

  // Environment info
  parts.push(`
# 環境
- プラットフォーム: ${process.platform}
- シェル: ${isWindows ? "cmd.exe/PowerShell" : process.env.SHELL ?? "/bin/sh"}
- 作業ディレクトリ: ${process.cwd()}
- Git: ${gitInfo.isGitRepo ? `yes (branch: ${gitInfo.branch ?? "unknown"})` : "no"}
- Node.js: ${process.version}
- ホームディレクトリ: ${os.homedir()}`);

  // Project instructions
  if (projectInstructions) {
    parts.push(`
# プロジェクト指示
以下はプロジェクトのCLAUDE.md等から読み込んだ指示です。これらの指示に従ってください。

${projectInstructions}`);
  }

  // Auto-memory
  if (memory) {
    parts.push(`
# 自動メモリ (~/.localllm/memory/MEMORY.md)
前回のセッションから引き継がれたメモ:

${memory}`);
  }

  return parts.join("\n");
}
