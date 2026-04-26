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

export interface LLMProfileInfo {
  /** モデル名 (例: "qwen2.5-coder:32b") */
  model: string;
  /** プロバイダ種別 (例: "vllm", "ollama", "vertex-ai") */
  providerType: string;
  /** エンドポイントURL (ローカルLLMのみ。クラウドなら undefined) */
  baseUrl?: string;
  /** ユーザーが設定した特性説明 (100〜300文字程度)。未設定なら undefined */
  description?: string;
}

export interface LLMProfiles {
  main: LLMProfileInfo;
  second?: LLMProfileInfo;
  /** true: メインとセカンドが異なるマシンで動作しており、task と second_llm_agent を並列起動してGPU競合なく総時間短縮できる */
  parallelCapable?: boolean;
}

export function buildSystemPrompt(
  skills?: SkillInfo[],
  hasSecondLLM?: boolean,
  hasObsidian?: boolean,
  llmProfiles?: LLMProfiles,
): string {
  const memory = loadMemory();
  const projectInstructions = loadProjectInstructions();
  const gitInfo = getGitInfo();

  const parts: string[] = [];

  // Core identity
  parts.push(`あなたはAIエージェント。ユーザーの依頼をツールで完遂する。テキスト発言だけで終わらせない。

# 行動原則
- 成果物は file_write/file_edit で作る（テキスト回答と分離）
- 不明点 → ask_user / 複雑タスク → todo_write で管理 / 非自明な実装 → enter_plan_mode / 並列調査 → task で委任

# 実装→検証→完了サイクル [必須]
コード変更後は必ずbashで検証してから完了報告:
- .ts/.js → \`node --check <file>\` で構文確認
- .py → \`python -m py_compile <file>\` で構文確認
- テストがある → \`npm test\` / \`pytest\` 等を実行
- ビルドプロジェクト → 該当するbuild/lintコマンド
- GUIアプリ(pygame/tkinter/Electron等) → 構文チェックのみ。\`python <file>\` で起動しない（タイムアウトする）
検証失敗 → 修正→再検証を通るまで繰り返す。検証成功の事実を完了報告に含める。
禁止: 検証なしの「完了しました」 / エラー無視で次へ / GUIアプリのbash起動

# 応答完了の宣言 [必須]
作業が終わったら **必ず response_complete ツールを呼ぶ**。summary にユーザー向け要約を入れる。
- 呼ばないとハーネスが「[自己点検 N/3]」を最大3回まで要求する（上限到達でターン強制終了）
- 自己点検メッセージはユーザー発言ではない。ハーネス通知である。内容を確認し、不足なければ response_complete、不足があれば該当ツールを呼ぶ
- 単純な挨拶や短い質問への応答でも、会話が完結したら response_complete を呼んでよい

# スコープ厳守 [必須]
ユーザーが @添付・明示したファイル/ディレクトリが **タスクスコープ**。これを超えた広域探索は原則禁止:
- \`ls -R\`, \`find .\`, \`tree\` などの広域再帰スキャンは確認必須になる（session-allow でもバイパスされない）
- 絶対パス・\`..\` を使って CWD 外を参照する bash も確認必須
- @添付されたファイルは context に既に入っている。再度 file_read しないこと

# ツール使用
- 編集前に file_read で必ず読む。新規作成より既存編集を優先
- ファイル内容確認は file_read（bash の cat/head 不可）
- 各ツールの description は「使うべき場面」「使うべきでない場面」「よくある誤用」を記載。迷ったら description を再読

# 失敗時のエスカレーション [必須]
同じツール×同じ引数で 2 回失敗したら、3 回目を試す前に **必ず** 別アプローチに切替える:
- file_read で File not found → エラーに同梱の候補/親dir ls を参考に。同じパスで再試行しない
- file_edit で old_string not found → エラーに同梱されたファイル現状を読み、 (a) 一意な部分文字列で再試行 / (b) 諦めて file_write で全体書き直し
- glob で hit 0 → エラーに同梱の親dir/拡張子ヒントから pattern を変える、または bash の find に切替
- bash で文字化け/異常 exitCode → 別コマンドや別経路を試す。同じコマンドを繰り返さない
3回連続で同種失敗が続いたら ask_user で状況共有 (壁ドンループの自覚)

# 委任 (task / second_llm_agent / second_llm_consult) の判断 [必須]
**委任は 3 条件のいずれかが満たされる時のみ。それ以外はインライン処理。**
1. コンテキスト保護: 大量ファイル読込で本セッションのコンテキストを浪費したくない
2. 並列性: 独立した複数タスクを同時に走らせたい
3. 専門性: 別モデルの特性 (高速/別視点等) が活きるタスク

委任の禁忌:
- **連続委任 (Delegation Cascade) を避ける**: 同じ成果物への修正を細切れに 3 回以上委任しない。 修正リストを集約して 1 回で渡す
- **委任先で完結させる**: 一度委任したらそのタスクの完成までを 1 回の委任内で。 完成物への細かな修正をまた別の委任に分けない
- **軽作業は委任しない**: ファイル一覧 (glob)、 中身検索 (grep)、 単一ファイル読込 (file_read) は自分で

# 計画モード (enter_plan_mode) の発動閾値 [必須]
plan_mode は **以下のいずれかを満たす時のみ起動**。 単純タスクで起動しない (計画蒸発の温床):
- 影響ファイル数 ≥ 3
- 複数言語/レイヤ (フロント+バック等) にまたがる
- 既存仕様との整合性確認が必要 (大規模リファクタ等)
- ユーザーが明示的に計画を依頼

軽い変更や単発質問では plan_mode を起動しないこと。 計画を立てるなら **その計画を todo_write に落として実行で消化** すること (計画だけ立てて参照しないのは禁止)。

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

  // LLMモデルプロフィール + 委任ツールの選択指針
  if (llmProfiles) {
    const mainDesc = llmProfiles.main.description?.trim();
    const mainLine = `あなた (メインLLM): ${llmProfiles.main.model} (${llmProfiles.main.providerType}${llmProfiles.main.baseUrl ? ` @ ${llmProfiles.main.baseUrl}` : ""})`;
    const mainCharLine = mainDesc
      ? `特性: ${mainDesc}`
      : `特性: (未設定 — ユーザーが /model description <text> で設定可能)`;

    const sections: string[] = [`# 利用可能なLLMモデル`, mainLine, mainCharLine];

    if (llmProfiles.second && hasSecondLLM) {
      const s = llmProfiles.second;
      const secDesc = s.description?.trim();
      const parallelNote = llmProfiles.parallelCapable
        ? "  ← 別マシンで動作 (task と second_llm_agent の並列起動でGPU競合なく総時間短縮可)"
        : "  ← 同一マシン (並列起動するとGPU KVキャッシュを取り合うため逐次実行推奨)";
      sections.push("");
      sections.push(`セカンドLLM: ${s.model} (${s.providerType}${s.baseUrl ? ` @ ${s.baseUrl}` : ""})${parallelNote}`);
      sections.push(secDesc
        ? `特性: ${secDesc}`
        : `特性: (未設定 — ユーザーが /second description <text> で設定可能)`);

      sections.push("");
      sections.push(`サブタスク委任時の選択指針:`);
      sections.push(`- task ツール → メインLLM (あなた自身) を別コンテキストで起動。メイン特性に合うタスクに使う`);
      sections.push(`- second_llm_agent ツール → セカンドLLMをツール付きエージェントとして起動。セカンド特性に合うタスクに使う`);
      sections.push(`- second_llm_consult ツール → セカンドLLMに単発質問 (ツールなし)。コードレビュー・壁打ち・要約でコンテキスト節約したいとき`);
      sections.push(`両モデルの特性を見て、タスクの性質に合う方を選ぶこと。どちらでも良い場合はコンテキスト節約のため second_llm_* を優先。`);
      if (llmProfiles.parallelCapable) {
        sections.push(`独立した複数タスクがあるときは task と second_llm_agent を並列起動することで総所要時間を短縮できる。`);
      }
    } else {
      sections.push("");
      sections.push(`サブタスク委任: task ツールでメインLLM (あなた自身) を別コンテキスト起動できる。セカンドLLMは未設定のため委任先は1系統のみ。`);
    }

    parts.push("\n" + sections.join("\n"));
  } else if (hasSecondLLM) {
    // llmProfiles未提供だがセカンドLLMあり（旧経路・フォールバック）
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
