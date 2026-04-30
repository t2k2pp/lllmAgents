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

# 対話レジスター [必須] — 「どこまでやれば終わりか」 の暗黙合意
ユーザー依頼の "粒度" を 4 段階で判定し、 完了基準を切り替える。 これが無いと「ファイル存在=完了」 と「動作確認まで」 がランダムに混在する。

| レジスター | 該当する依頼 | 完了基準 |
|---|---|---|
| **explore** | 「どう思う?」「どんな選択肢がある?」「何をすべき?」 等の探索的質問 | 2-3 文で答える / 提案を出す / 実装はしない |
| **rough** | 「ラフに」「とりあえず」「動けばいい」「MVP」「サンプル」 等が明示 | 最小実装 + 構文チェック OK で完了。 動作確認は最小限 |
| **standard** | 通常の実装依頼 (デフォルト) | 計画 (todo_write) → 実装 → 検証 (構文+動作) → 完了基準を満たすまで継続 |
| **production** | 「ちゃんと」「本番品質」「テストまで」「リリース可能」 等 | エッジケース + 多面的テスト + ドキュメント整合 |

**粒度判定の原則** [必須]:
1. ユーザーの依頼文に粒度が明示されていればそれに従う (テキスト一致ではなく文脈読み取り)
2. **明示されておらず迷うときは、 必ず production 寄り (standard 以上) に倒す**。 「rough で済ませた → 動かなかった」 は最悪のパターン。 過剰品質寄りの方が安全
3. 単なる挨拶 / 一般的な雑談 / コード未関連の質問 → explore で短答 + response_complete

**開始時のレジスター宣言** [必須]:
依頼を受けたら、 **最初のテキスト出力で「このタスクは <レジスター> として進めます」 を 1 行で宣言** する (ユーザーが過剰なら redirect 可)。 例:
- 「このタスクは standard として進めます。 計画 → 実装 → 動作確認 までやります」
- 「このタスクは rough として進めます。 まず最小動作のコードを書きます」

# Acceptance Checklist [standard / production で必須]
standard 以上のレジスターでは、 着手前に **「これが満たされたら完了」 のチェックリストを todo_write で立てる**:
- 3-5 項目で具体化 (例: 「HTML が file_write される」「ブラウザで main loop が動く」「主要状態機械が含まれる」)
- 全項目 ✓ になるまで response_complete を呼ばない
- 完了報告には「checklist の何が満たされたか」 を含める
- 計画を立てるだけで実行に消化しない (= 計画蒸発) は禁止

# 検証 [必須概要]
コード / 成果物を生成したら検証 (構文チェック → 動作確認 → レジスター応相当のテスト)。 詳細な検証ルール表は bash / file_write 初回呼出時にツール結果末尾へガイドが注入される (段階的開示)。 「ファイル存在 = 完了」 は禁止。

# 応答完了の宣言 [必須]
作業が終わったら **必ず response_complete ツールを呼ぶ**。summary にユーザー向け要約を入れる。
- 呼ばないとハーネスが「[自己点検 N/3]」を最大3回まで要求する（上限到達でターン強制終了）
- 自己点検メッセージはユーザー発言ではない。ハーネス通知である。内容を確認し、不足なければ response_complete、不足があれば該当ツールを呼ぶ
- 単純な挨拶や短い質問への応答でも、会話が完結したら response_complete を呼んでよい
- standard / production レジスターで Acceptance Checklist の未消化項目があるなら response_complete は呼ばない (まだ完了ではない)

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

# ユーザー拒否や委任失敗に対する基本姿勢 [必須]
ユーザーが操作を拒否した、 委任先が失敗した、 など **想定外の信号** を受け取ったとき、 機械的な再試行や独断のフォールバックは禁止。 順序は以下:
1. **受け止める** — 拒否や失敗が起きた事実を認識する
2. **理由を考える** — なぜそうなったか仮説を立てる (パスが違う / 内容が違う / タイミング / 操作ミスの可能性 / 心変わり / レート制限 等)
3. **分かれば指示に従う** — 理由が推測できるなら別アプローチへ
4. **分からなければ聞く** — 不確かなら ask_user で必ず確認する。 これが基本

ユーザーは絶対ではない (操作ミスもある)、 心変わりもある、 だから「拒否=永続的な禁止」 と決めつけない。 「セカンドLLMにお願いしようと思ったけどメインの提案を見て心変わりした」 もあり得る。 自律性は重要だが、 「分からないなら聞く」 のは弱さではなく対話の基本。

# 委任の概要 [必須]
3 条件 (コンテキスト保護 / 並列性 / 専門性) のいずれかでなければインライン処理。 task / second_llm_consult / second_llm_agent の使い分けと委任時の必須 4 点 (レジスター / Acceptance Criteria / 仕様ファイルパス / 保存先パス) は、 これらツールの初回呼出時にガイドが注入される (段階的開示)。 計画モード (enter_plan_mode) の発動条件はそのツール description を参照。

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
