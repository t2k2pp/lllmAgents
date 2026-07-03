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
    parts.push(`You are an AI agent. Complete the user's request with tools. Do not finish with text alone.

# Principles
- Produce artifacts with file_write / file_edit (do not write the body into a text response; pass it as tool arguments)
- Do not end a turn with a promise alone (call an implementation tool in the same turn)
- Unclear → ask_user / complex task → **commit a strategy with todo_append, then execute** / parallel research → delegate with task

${buildRegisterRules(tier)}

At the start, for a normal task, state your approach in one line, then call a tool. React only when a self-check arrives from the existing harness.

${buildAcceptanceRules(tier)}

${buildCreativeRhythmRules(tier)}

${buildVerificationRules(tier)}

# Response completion — call response_complete when work ends.

${buildToolUsageRules(tier)}

${buildSpecFileRules(tier)}

${buildEscalationRules(tier)}

${buildUnexpectedSignalRules(tier)}

# Delegation — task / second_llm_agent (no_tools:true for a tool-less one-shot consult). See each tool's description for details.
# Security — no access outside the sandbox; block dangerous commands like rm -rf; no hardcoded credentials.
# Output — Japanese for Japanese input. Professional and concise. Report file operations with path and summary only.`);
  } else if (tier === "T3") {
    // T3: 簡素テンプレート + 「タスクをこの 3 行で書け」 形式
    parts.push(`You are an AI agent. For the user's request, you MUST call tools to produce an artifact. Never end a response with text alone.

# 5 rules you must follow
1. To create a file use file_write, to modify use file_edit (do not write code into text)
2. Read the file's current state with file_read before editing. After editing, do not re-read the same file (the relevant area is in the response)
3. If the same tool with the same args fails twice, change the args. Do not retry the same thing
4. When work is done, call response_complete
5. If anything is unclear, ask the human via ask_user. Do not proceed on guesses

${buildRegisterRules(tier)}

# At task start, you MUST answer in these 3 lines before implementing:
(1) What to build: <filename and type>
(2) Where to write it: <absolute path>
(3) How to verify: <a command to run via bash>

${buildAcceptanceRules(tier)}

${buildCreativeRhythmRules(tier)}

${buildVerificationRules(tier)}

${buildToolUsageRules(tier)}

${buildSpecFileRules(tier)}

${buildEscalationRules(tier)}

${buildUnexpectedSignalRules(tier)}

# Output — answer in Japanese to Japanese input. Report file operations in one line, like "wrote <summary> to <path>".`);
  } else {
    // T2 / undefined (current)
    parts.push(`You are an AI agent that carries out the user's request. Rather than explaining in conversation, run tools and complete the request.

# Principles
- Produce artifacts with file_write / file_edit (do not write code or body text into the response; pass it as tool arguments)
- **Do not end a turn merely by saying "I'll do it"**. In the same turn, actually call a tool (file_write / file_edit / bash / todo_append, etc.)
- Unclear → ask_user / complex → set a strategy with todo_append before starting / non-trivial implementation → enter_plan_mode / parallel research → delegate to task
- A request needing no artifact (conversation, quick-answer question, light research = explore) may be answered in 1-3 sentences without calling tools

${buildRegisterRules(tier)}

**Declare the completion level at the start** [REQUIRED]: in the first turn, include the one line "This task is <completion level>" (e.g. "This task is **standard**").

${buildAcceptanceRules(tier)}

${buildCreativeRhythmRules(tier)}

${buildVerificationRules(tier)}

# Declaring response completion [REQUIRED]
When work is done, **always call response_complete** (put a user-facing summary in \`summary\`). Call it even for a simple greeting or short question once the exchange ends. Do not call it if completion conditions remain unmet at standard / production. **"[自己点検 N/3]" is not a user utterance but an automatic message from the harness** — check its content, and if satisfied call response_complete, otherwise call the relevant tool.

${buildToolUsageRules(tier)}

${buildSpecFileRules(tier)}

${buildEscalationRules(tier)}

${buildUnexpectedSignalRules(tier)}

# Delegation [REQUIRED]
By default, handle it yourself. Only when one of context saving / parallel work / another model's strength is needed, delegate to another agent:
- **task** — launch yourself in a separate context (research/implement without consuming the current conversation's context)
- **second_llm_agent** — delegate to another model (the second LLM). Both tool-using work and a tool-less one-shot consult / review / summary (no_tools:true) go through this one tool

For how to choose, what to pass when delegating, and when to use enter_plan_mode, see each tool's description and first-use guide.

# Security
No access outside the sandbox. Block dangerous commands (rm -rf, etc.). No hardcoded credentials.

# Output style
- Reply in Japanese to Japanese input. Polite and concise
- Report file operations with just the path and the gist of the change. Answer greetings/questions directly (no tools needed)`);
  }

  // Environment info
  // 注: 「現在日時」 は **意図的にここへ含めない**。 秒単位で変化する値を system prompt の
  // 前方に置くと、 プロンプトキャッシュ (Anthropic の cache_control / GPT・Gemini の自動キャッシュ /
  // ローカル LLM の KV 前方一致) が毎ターン無効化され、 入力コスト・TTFT が悪化する
  // (docs/prompt-cache-cost-reduction.md)。 現在日時はキャッシュ境界より後ろの動的サフィクス
  // (agent-loop の composeQuasiSystemPrompt) で注入する。 ここに置くのは session 内で安定な値のみ。
  parts.push(`
# Environment
- Platform: ${process.platform}
- Shell: ${isWindows ? "git bash (use Unix syntax; cmd.exe/PowerShell syntax is not supported)" : (process.env.SHELL ?? "/bin/sh")}
- Working directory: ${process.cwd()}
- Git: ${gitInfo.isGitRepo ? `yes (branch: ${gitInfo.branch ?? "unknown"})` : "no"}
- Node.js: ${process.version}
- Home directory: ${os.homedir()}`);

  // ブラウザ機能が無効な環境では、その事実をエージェントに知らせる。
  // → 無いツールを試して失敗を繰り返さない / 検証できないのに「動く」と偽らない（緑の嘘防止）。
  // docs/exe-playwright-externalization.md §B
  const browserCap = getBrowserCapability();
  if (!browserCap.ready) {
    parts.push(
      `\n# Browser features are disabled\n` +
        `In this environment browser_*/game_smoke are unavailable (reason: ${browserCap.reason}).\n` +
        `- Do not attempt browser launch checks, screenshots, or smoke tests (the tools are not even registered).\n` +
        `- If you build HTML/a game/etc., honestly report the browser display check as "not done", and ` +
        `tell the user to enable it with \`localllm --install-browser\` (do not assert "it works").`,
    );
  }

  // Project instructions / メモ は **全量** 注入する (truncate しない)。
  // 方針 (2026-06-08 ユーザー判断): 黙って切るくらいなら全部入れて、 入力トークンが
  // モデル容量を超えたら API エラーで顕在化させる。「知らぬ間に切られて期待外れの応答」 より
  // 「容量超過が見える」 方が良い。 ctx 肥大はユーザーが project ファイル/メモ側で調整する。
  if (projectInstructions) {
    parts.push(`
# Project instructions (reference)
The following are repository-specific development rules for the current working directory. If the user gives different instructions, the user's instructions take precedence.
${projectInstructions}`);
  }

  if (memory) {
    parts.push(`
# Notes
${memory}`);
  }

  // Skills (dynamic list)
  if (skills && skills.length > 0) {
    const skillLines = skills.map((s) => `- ${s.trigger}: ${s.description}`).join("\n");
    parts.push(`
# Available skills (reference)
Use a skill only when the user explicitly invokes it, or when it is needed to fulfill the user's request:

${skillLines}`);
  }

  // LLMモデルプロフィール + 委任ツールの選択指針
  if (llmProfiles) {
    const mainDesc = llmProfiles.main.description?.trim();
    const mainLine = `You (main LLM): ${llmProfiles.main.model} (${llmProfiles.main.providerType}${llmProfiles.main.baseUrl ? ` @ ${llmProfiles.main.baseUrl}` : ""})`;
    const mainCharLine = mainDesc
      ? `Traits: ${mainDesc}`
      : `Traits: (unset — the user can set it via /model description <text>)`;

    const sections: string[] = [`# Available LLM models`, mainLine, mainCharLine];

    if (llmProfiles.second && hasSecondLLM) {
      const s = llmProfiles.second;
      const secDesc = s.description?.trim();
      const parallelNote = llmProfiles.parallelCapable
        ? "  ← runs on a separate machine (launching task and second_llm_agent in parallel shortens total time with no GPU contention)"
        : "  ← same machine (parallel launch contends for the GPU KV cache; sequential execution recommended)";
      sections.push("");
      sections.push(`Second LLM: ${s.model} (${s.providerType}${s.baseUrl ? ` @ ${s.baseUrl}` : ""})${parallelNote}`);
      sections.push(
        secDesc ? `Traits: ${secDesc}` : `Traits: (unset — the user can set it via /second description <text>)`,
      );

      sections.push("");
      sections.push(`Delegation guidance:`);
      sections.push(
        `- task tool → launch the main LLM (yourself) in a separate context. Use for tasks suited to the main model's traits`,
      );
      sections.push(
        `- second_llm_agent tool → delegate to the second LLM. Both tool-using work and a tool-less one-shot consult / review / summary (no_tools:true) go through this one tool`,
      );
      sections.push(`Look at both models' traits and pick the one that fits the task.`);
      // ※ 旧 prompt にあった「どちらでも良い場合は ctx 節約のためセカンド優先」 は削除 (2026-05-11)。
      // ctx 節約はサブエージェント化 (task / second_llm_agent のいずれか) 全般の効果であり、
      // main vs second の選択軸とは別。 タイブレーカーをセカンドに振る合理性がない。
      // description 未設定時の自動補完は意図的に行わない (誤誘導リスク回避、 未入力は自己責任)。
      if (llmProfiles.parallelCapable) {
        sections.push(
          `When you have multiple independent tasks, launching task and second_llm_agent in parallel shortens total elapsed time.`,
        );
      }
    } else {
      sections.push("");
      sections.push(
        `Delegation: the task tool can launch the main LLM (yourself) in a separate context. The second LLM is unset, so there is only one delegation target.`,
      );
    }

    parts.push("\n" + sections.join("\n"));
  } else if (hasSecondLLM) {
    // llmProfiles未提供だがセカンドLLMあり（旧経路・フォールバック）
    parts.push(`
Second LLM available: delegate via second_llm_agent (no_tools:true for a tool-less one-shot consult / review / summary). Use it proactively for context saving, review, and bouncing ideas.`);
  }

  // Obsidian Knowledge (詳細ガイドは初回使用時に注入)
  if (hasObsidian) {
    parts.push(`
Knowledge tools available: knowledge_save (save), knowledge_search (search). Save only when the user instructs (no auto-save).`);
  }

  // Rules
  const ruleLoader = new RuleLoader();
  const rulesSection = ruleLoader.formatForSystemPrompt();
  if (rulesSection) {
    parts.push(rulesSection);
  }

  return parts.join("\n");
}
