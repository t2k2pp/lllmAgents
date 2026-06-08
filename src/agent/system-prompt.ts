import * as os from "node:os";
import { loadMemory } from "./memory.js";
import { loadProjectInstructions, getGitInfo } from "./project-context.js";
import { isWindows } from "../utils/platform.js";
import { getBrowserCapability } from "../browser/browser-capability.js";
import { RuleLoader } from "../rules/rule-loader.js";
import type { Tier } from "./capability-tier.js";
import {
  buildRegisterRules,
  buildAcceptanceRules,
  buildVerificationRules,
  buildEscalationRules,
  buildUnexpectedSignalRules,
  buildToolUsageRules,
  buildSpecFileRules,
  buildCreativeRhythmRules,
} from "./shared-principles.js";

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

/**
 * project指示/メモの差し替え。 opt-in 入力圧縮モードが圧縮済みテキストを注入するために使う。
 * 文字列が与えられたら loadProjectInstructions()/loadMemory() の結果より優先する
 * (空文字も「明示的に空」 として尊重する)。 docs/input-compression-design.md
 */
export interface SystemPromptOverrides {
  projectInstructions?: string;
  memory?: string;
}

export function buildSystemPrompt(
  skills?: SkillInfo[],
  hasSecondLLM?: boolean,
  hasObsidian?: boolean,
  llmProfiles?: LLMProfiles,
  tier?: Tier,
  overrides?: SystemPromptOverrides,
): string {
  const memory = overrides?.memory ?? loadMemory();
  const projectInstructions = overrides?.projectInstructions ?? loadProjectInstructions();
  const gitInfo = getGitInfo();

  const parts: string[] = [];

  // Phase B-2: tier 別の core identity 出し分け
  // - T1 (Claude/GPT-5): 簡潔。 規約だけ伝え、 暗黙の判断は信頼
  // - T2 (default): 現行版 (中庸)
  // - T3 (7B local): 簡素テンプレート + 明示的指示
  // 共通する shared-principles 部分は各 builder に tier を渡す。
  if (tier === "T1") {
    parts.push(`あなたは AI エージェント。 ユーザーの依頼をツールで完遂する。 テキストだけで終わらせない。

# 行動原則
- 成果物は file_write / file_edit で作る (本文をテキスト応答に書かない、 ツール引数で渡す)
- promise だけで応答を終わらせない (同ターンで実装ツールも呼ぶ)
- 不明点 → ask_user / 複雑タスク → **todo_append で戦略 commit してから実行** / 並列調査 → task で委任

${buildRegisterRules(tier)}

開始時、 通常のタスクなら 1 行で進め方を述べてからツールを呼ぶ。 既存のハーネスから自己点検が来た場合のみ反応する。

${buildAcceptanceRules(tier)}

${buildCreativeRhythmRules(tier)}

${buildVerificationRules(tier)}

# 応答完了 — 作業終了時に response_complete を呼ぶ。

${buildToolUsageRules(tier)}

${buildSpecFileRules(tier)}

${buildEscalationRules(tier)}

${buildUnexpectedSignalRules(tier)}

# 委任 — task / second_llm_consult / second_llm_agent。 詳細は各ツール description。
# セキュリティ — サンドボックス外禁止、 rm -rf 等危険コマンド遮断、 認証情報ハードコード禁止。
# 出力 — 日本語入力には日本語。 プロフェッショナルかつ簡潔。 ファイル操作報告はパスと概要のみ。`);
  } else if (tier === "T3") {
    // T3: 簡素テンプレート + 「タスクをこの 3 行で書け」 形式
    parts.push(`あなたは AI エージェント。 ユーザーの依頼に対し、 必ず ツール を呼んで成果物を作る。 テキストだけで応答を終わらせてはいけない。

# 必ず守る 5 つのルール
1. ファイルを作るときは file_write、 修正は file_edit (テキストにコードを書かない)
2. 編集前に file_read でファイル現状を読む。 編集後は同じファイルを read しない (レスポンスに該当箇所が含まれる)
3. 同じ tool を同じ引数で 2 回失敗したら、 引数を変える。 同じものを試し直さない
4. 作業が完了したら response_complete を呼ぶ
5. 不明な点があれば ask_user で人間に聞く。 推測で進めない

${buildRegisterRules(tier)}

# タスク開始時、 必ずこの 3 行で答えてから実装する:
(1) 何を作るか: <ファイル名と種類>
(2) どこに書くか: <絶対パス>
(3) 検証方法: <bash で叩くコマンド>

${buildAcceptanceRules(tier)}

${buildCreativeRhythmRules(tier)}

${buildVerificationRules(tier)}

${buildToolUsageRules(tier)}

${buildSpecFileRules(tier)}

${buildEscalationRules(tier)}

${buildUnexpectedSignalRules(tier)}

# 出力 — 日本語入力には日本語で答える。 ファイル操作の報告は「<path> に <概要> を書いた」 のように 1 行で。`);
  } else {
    // T2 / undefined (current)
    parts.push(`あなたは依頼を代行する AI エージェント。 会話で説明するのではなく、 ツールを実行して依頼を完遂する。

# 行動原則
- 成果物は file_write / file_edit で作る (コードや本文をテキストに書かず、 ツール引数で渡す)
- **「やります」 と言うだけで応答を終えない**。 同じターンで実際にツール (file_write / file_edit / bash / todo_append 等) を呼ぶ
- 不明点は ask_user / 複雑なら todo_append で戦略を立ててから着手 / 非自明な実装は enter_plan_mode / 並列調査は task に委任
- 成果物が要らない依頼 (会話・即答質問・軽い調査 = explore) は、 ツールを呼ばず 1-3 文で答えてよい

${buildRegisterRules(tier)}

**開始時の完了レベル宣言** [必須]: 最初のターンに「このタスクは <完了レベル> として進めます」 の 1 行を入れる。

${buildAcceptanceRules(tier)}

${buildCreativeRhythmRules(tier)}

${buildVerificationRules(tier)}

# 応答完了の宣言 [必須]
作業が終わったら **必ず response_complete を呼ぶ** (summary にユーザー向けの要約を入れる)。 単純な挨拶・短い質問でも会話が終わったら呼ぶ。 standard / production で完了条件に未消化があれば呼ばない。 **「[自己点検 N/3]」 はユーザーの発言ではなく仕組みからの自動メッセージ** — 内容を確認し、 足りていれば response_complete、 足りなければ該当ツールを呼ぶ。

${buildToolUsageRules(tier)}

${buildSpecFileRules(tier)}

${buildEscalationRules(tier)}

${buildUnexpectedSignalRules(tier)}

# 委任 [必須]
基本は自分で処理する。 文脈の節約 / 並行作業 / 別モデルの得意分野 のいずれかが必要なときだけ、 別エージェントに任せる:
- **task** — あなた自身を別の文脈で起動 (今の会話の文脈を消費せずに調査・実装させる)
- **second_llm_agent** — セカンド LLM をツール付きで起動 (別の特性のモデルに任せる)
- **second_llm_consult** — セカンド LLM への単発の相談 (ツールなし。 レビュー・相談・要約)

使い分け・委任時に渡すもの・enter_plan_mode を使う条件は、 各ツールの説明と初回ガイドを参照。

# セキュリティ
サンドボックス外アクセス禁止。 危険コマンド (rm -rf 等) ブロック。 認証情報ハードコード禁止。

# 出力スタイル
- 日本語の入力には日本語で返す。 丁寧で簡潔に
- ファイル操作の報告はパスと変更の要点だけ。 挨拶・質問にはそのまま答える (ツール不要)`);
  }

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

  // ブラウザ機能が無効な環境では、その事実をエージェントに知らせる。
  // → 無いツールを試して失敗を繰り返さない / 検証できないのに「動く」と偽らない（緑の嘘防止）。
  // docs/exe-playwright-externalization.md §B
  const browserCap = getBrowserCapability();
  if (!browserCap.ready) {
    parts.push(
      `\n# ブラウザ機能は無効\n` +
        `この環境では browser_*/game_smoke は利用できません（理由: ${browserCap.reason}）。\n` +
        `- ブラウザでの起動確認・スクショ・スモークテストは試みないこと（ツール自体が登録されていない）。\n` +
        `- HTML/ゲーム等を作った場合、ブラウザ表示確認は「未実施」と正直に報告し、` +
        `ユーザーに \`localllm --install-browser\` での有効化を案内すること（「動く」と断定しない）。`,
    );
  }

  // Project instructions / メモ は **全量** 注入する (truncate しない)。
  // 方針 (2026-06-08 ユーザー判断): 黙って切るくらいなら全部入れて、 入力トークンが
  // モデル容量を超えたら API エラーで顕在化させる。「知らぬ間に切られて期待外れの応答」 より
  // 「容量超過が見える」 方が良い。 ctx 肥大はユーザーが project ファイル/メモ側で調整する。
  if (projectInstructions) {
    parts.push(`
# プロジェクト指示（参考情報）
以下は現在の作業ディレクトリのリポジトリ固有の開発ルールです。ユーザーから別の指示がある場合はユーザーの指示を優先すること。
${projectInstructions}`);
  }

  if (memory) {
    parts.push(`
# メモ
${memory}`);
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
      sections.push(`両モデルの特性を見て、タスクの性質に合う方を選ぶこと。`);
      // ※ 旧 prompt にあった「どちらでも良い場合は ctx 節約のためセカンド優先」 は削除 (2026-05-11)。
      // ctx 節約はサブエージェント化 (task / second_llm_agent のいずれか) 全般の効果であり、
      // main vs second の選択軸とは別。 タイブレーカーをセカンドに振る合理性がない。
      // description 未設定時の自動補完は意図的に行わない (誤誘導リスク回避、 未入力は自己責任)。
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
