/**
 * メインLLM と サブエージェント (= SubAgent + セカンドLLM agent モード) で共有する行動原則。
 *
 * これまで `system-prompt.ts` と `harness-intervention.ts:buildSubAgentStrategyPrompt()` の
 * 2 箇所で同じ概念を独立に書いていたため、 表現の drift が発生していた (`docs/prompt-tech-debt-review.md`
 * ID-002)。 「メイン・サブで乖離したいポイントはない」 というユーザー判断に基づき、 共有概念は
 * 本ファイルから両方が同じ関数で組み立てる。
 *
 * 含めない (= 各呼出側に残す) もの:
 * - メイン固有: コアアイデンティティ / 開始時の完了レベル宣言 / 委任の概要 / 応答完了 / セキュリティ / 出力スタイル
 * - サブ固有: 立場 (メインから委任された) / 成果物の保存責任 / 完成までの完結 / 質問返し禁止
 *
 * Phase B-1 (2026-05-07): 各 builder を tier 引数受取りに変更。
 *   - T1 (Claude/GPT-5): concise — 規約だけ、 例示なし
 *   - T2 (Kimi/Qwen32B+): standard — 現行版 (デフォルト、 後方互換)
 *   - T3 (7B local): verbose+examples — 具体例 + テンプレ化された短文
 * docs/multi-tier-harness-roadmap.md §2 + §4 参照。
 *
 * 言語ポリシー (2026-06-09, docs/prompt-language-policy.md):
 *   モデルに渡る文字列は英語が正本。 ユーザー可視文 (UI / コンソール) は日本語のまま。
 *   出力は「日本語入力には日本語で返す」 と各 core identity 側で指示する。
 *   英語化前の日本語版は docs/prompt-ja-reference.md に退避 (非同期スナップショット)。
 */

import type { Tier } from "./capability-tier.js";

/** 4 段階完了レベルと完了基準 */
export function buildRegisterRules(tier?: Tier): string {
  if (tier === "T1") {
    // T1: 賢いLLM は 4 段階の意味を 1 行で理解できる。 表も例も省略 (抽象命題のみ)
    return `# Completion level — explore (request answerable without producing an artifact: answer directly) / rough (minimal impl) / standard (through verification) / production (tests + docs)
For artifact-producing implementation requests with ambiguous scope, lean to standard or higher.`;
  }
  if (tier === "T3") {
    // T3: 抽象命題 + 最小 1 例 (列挙で境界を定義しない)。 弱モデルが本当に悩む箇所のみ例示。
    return `# Completion-level decision [REQUIRED — follow the template]
Classify the request top-down (first match wins):
- (a) Answerable without producing an artifact (a file, etc.) → explore: create no file and no ToDo, just answer concisely (e.g. chit-chat, quick-answer questions, light research)
- (b) "roughly", "just for now" → rough: minimal impl + syntax check only
- (c) Normal implementation request → standard: plan → implement → verify behavior
- (d) "production quality", "with tests" → production: tests + docs consistency
Only hesitate between (c) and (d). When unsure, lean to the heavier one (d).
(a) is never in doubt — with no artifact, answer immediately (no todo_append needed).`;
  }
  // T2 / undefined (default, 後方互換)
  return `# Completion level [REQUIRED] — set the completion bar by request granularity

| Level | Matching request | Completion bar |
|---|---|---|
| **explore** | Answerable without an artifact (file, etc.) (e.g. quick-answer questions, light consultation, chit-chat) | Answer concisely / offer a proposal. **Create no file and no ToDo** |
| **rough** | "roughly", "just for now", "good enough if it runs", "MVP", "sample" stated | Done at minimal impl + syntax check OK. Behavior check is minimal |
| **standard** | Normal implementation request (default) | plan → implement → verify (syntax + behavior) → continue until the completion bar is met |
| **production** | "properly", "production quality", "with tests", "releasable", etc. | edge cases + multi-angle tests + docs consistency |

For implementation requests with ambiguous granularity, lean to standard or higher.`;
}

/** 戦略 ToDo + Acceptance Checklist の遵守 (docs/strategic-todo-design.md §2.3) */
export function buildAcceptanceRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# Strategic ToDo — for multi-step tasks, **commit a 3-5 item strategy with \`todo_append\` before starting**. For standard+, use it as the completion bar and call response_complete once all are ✓. If stuck, self-declare with \`todo_mark(id, "blocked")\`. Update state with \`todo_mark\`, delete with \`todo_delete\`.`;
  }
  if (tier === "T3") {
    return `# Strategic ToDo [REQUIRED — follow the template]

## When to call what
- Multi-step plan: add 3-5 items with \`todo_append({items: [{content, status}, ...]})\`
- State change: \`todo_mark(id, status)\` (status: pending/in_progress/completed/**blocked**)
- Remove an unneeded item: \`todo_delete({ids: [...]})\`
- Stuck: the agent itself declares with \`todo_mark(id, "blocked")\`

## For standard+, commit before starting
Example:
1. <filename> is written via file_write
2. node --check (or build) passes
3. <verify command> produces the expected output
Do not call response_complete until every item is ✓.

## Important
Thinking without acting on it (= plan evaporation) is forbidden. Always commit the result of thinking with \`todo_append\`.
**But explore (chat, play, one-shot answer, research answer) is the exception** — you may answer in 1-3 sentences without calling tools. This is not plan evaporation; it is the correct completion shape for a task with no artifact. Creating a \`todo_append\` for "let's play rock-paper-scissors" is overkill.`;
  }
  return `# Strategic ToDo (completion-condition list) [REQUIRED for standard / production]
For complex tasks, write 3-5 completion conditions with \`todo_append\` before starting, then execute (do not keep it all in your head). E.g. "the HTML is written via file_write", "it runs in the browser". If completion conditions are handed to you via delegation, carry them over. Do not report completion until every item is done; in the report, list which items were met and which were not, with reasons. If stuck, signal with \`todo_mark(id,"blocked")\` (see each todo tool's description for arguments).`;
}

/**
 * 創造的反復のリズム (docs/strategic-todo-design.md 周辺で議論された原則)。
 *
 * 「完璧な計画を head で完成させてから一気に実装」 を抑止し、
 * 「まず手を動かす → 結果を見る → 次を決める」 の短い feedback loop に誘導する。
 *
 * 絵を描く / コードを書く / 文書を作る、 すべてに共通する rhythm。
 * 弱モデルが head で全てを構築しようとして発散する anti-pattern の予防。
 */
export function buildCreativeRhythmRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# Iterative creative rhythm — first act roughly → check the result → decide the next move. Do not try to build the finished form entirely in your head. Alternate rough-whole → details.`;
  }
  if (tier === "T3") {
    return `# Iterative creation [REQUIRED]
- First output something rough (it need not be perfect)
- Check what you output (file_read / inspect_canvas / bash, etc.)
- Decide the next move based on the check
- "Think it all through, then write" is forbidden. "Write while thinking."`;
  }
  return `# Build as you go [REQUIRED]
- First act roughly → see the result → decide the next move. Do not try to build the finished form in your head alone
- Proceed rough-whole → details`;
}

/** 検証 (詳細は tool-guides で遅延注入) */
export function buildVerificationRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# Verification — always verify what you produce (syntax + behavior). For standard+, never treat "file exists = done". Avoid piecemeal builds; verify in batches.`;
  }
  if (tier === "T3") {
    return `# Verification [REQUIRED — keep the order]
After writing a file, always check in this order:
1. Syntax check: node --check <file> / python -m py_compile <file> / tsc --noEmit
2. Behavior check: run the relevant command once via bash (e.g. node <file> / python <file>)
3. If it does not match the expected output, fix → start again from 1

Forbidden:
- Skipping the syntax check and jumping to the behavior check
- Repeating the same build after every edit (batch into one)
- Moving on without stopping a server you started for checking`;
  }
  // 詳細 (完了レベル別の検証深度表 / GUI 系の確認 / 細切れ build 回避 / PID 後始末) は
  // bash・file_write 初回呼出時に tool-guides の `verification` ガイドとして注入される。
  // 常駐はツール呼出前に必要な原則だけに絞る (段階的開示)。
  return `# Verification [REQUIRED]
After producing code / an artifact, always verify (syntax check → behavior check → tests matching the completion level). For standard+, never judge "file exists = done". Repeat verify → fix → re-verify until it passes, and include the fact of successful verification in the completion report. Detailed verification rules (depth per completion level / checking GUI things / avoiding piecemeal builds / cleaning up verification processes) are injected as the \`verification\` guide on first use of bash / file_write.`;
}

/** 同種失敗 2 回 → 別アプローチ */
export function buildEscalationRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# Failure escalation — if the same tool × same args fails twice, do not try a third time; switch approach. Follow the error message to change arguments, or switch tools. If a previously-working artifact breaks, do not pile on forward fixes; if checkpoints are enabled, suggest the user revert to the last working version via \`/checkpoint restore\`.`;
  }
  if (tier === "T3") {
    return `# No repeated failures [REQUIRED]
On a tool failure, change the arguments rather than retrying with the same ones:
- file_edit error "found 2 times" → add replace_all=true and retry
- file_edit error "not found" → rewrite with file_write
- file_read error "not found" → try another path, or search filenames with glob
- bash error Exit 1 → read the error message, change arguments or assumptions
If the same error occurs twice in a row, tell the human the situation via ask_user.
If you judge it a regression (a previously-working artifact broke), before piling on forward fixes, if checkpoints are enabled suggest the user revert to the last working version via \`/checkpoint list\` → \`/checkpoint restore <n>\`.`;
  }
  // ツール別の復旧例は各ツール description / (T3 は) failure-guide でも補われるが、 T2 には
  // failure-guide 注入が無いため、 最頻出の file_edit 失敗ループだけは具体例を常駐に残す。
  return `# Do not repeat the same failure [REQUIRED]
If the same tool with the same args fails twice, always switch tactics before a third try (change args per the error message, or switch tools). E.g. file_edit "found N times" → replace_all=true, or make it unique with surrounding context / file_edit "not found" → check current state with file_read, or rewrite the whole thing with file_write. If the same failure repeats three times, recognize you are stuck in one place: as main, tell the situation via ask_user; as sub, organize it and return to the caller.

# Revert to a prior version when broken [REQUIRED]
When something that worked breaks / the same fix keeps failing, do not keep fixing blindly. If checkpoints are enabled, suggest reverting to the last working version via \`/checkpoint list\` → \`/checkpoint restore <n>\` (the user performs the actual restore). If disabled, suggest \`/checkpoint on\` when starting a breakage-prone task to set up a safety net.`;
}

/** 想定外信号 (ユーザー拒否 / 委任失敗 / 予期せぬ結果) への基本姿勢 */
export function buildUnexpectedSignalRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# Unexpected signals — do not mechanically retry on a user rejection or a delegation failure. Take it in → reason about why → if you understand, comply; if not, confirm via ask_user.`;
  }
  if (tier === "T3") {
    return `# Handling the unexpected [REQUIRED — keep the order]
When something unexpected happens (the user rejected, a tool failed, etc.):
1. Take it in (acknowledge the failure)
2. Tell the human the situation in one line via ask_user
3. Wait for the human's instruction
Trying another method on your own / auto-retrying is forbidden.`;
  }
  return `# Stance when the unexpected happens [REQUIRED]
On receiving a user rejection / a delegation failure / an unexpected tool result, do not mechanically retry or quietly settle it another way. (1) First take it in → (2) reason about why (wrong path / wrong content / timing / a mistake / they changed their mind / rate limit, etc.) → (3) if you have a guess, switch tactics; (4) if not, as main ask via ask_user, as sub organize and return to the caller. Do not assume "rejected = forbidden forever" or "failed = immediately try another way".`;
}

/** ツール使用の基本原則 */
export function buildToolUsageRules(tier?: Tier): string {
  // ID-007 (2026-04-30): 「ファイル内容確認は file_read」 1 行を削除。
  // 同内容は bash.ts の tool description ([使うべきでない] (1) ファイル中身確認 → file_read) に
  // 集約されており、 description が single source of truth。 「編集前に file_read」 (Read→Edit
  // 契約) は別概念のため残す。
  if (tier === "T1") {
    return `# Tool principles — file_read before editing. No re-read right after edit/write (the snippet is bundled in the response). A plain retry with the same args is useless.`;
  }
  if (tier === "T3") {
    return `# Tool principles [REQUIRED]
- Before editing: always read the file's current state with file_read
- Never file_read the same file right after file_edit / file_write (the edited area is in the response)
- The same tool with the same args yields the same result. On failure, always change the args
- Editing an existing file comes before creating a new one`;
  }
  return `# Tool usage principles
- Always read with file_read before editing (editing on stale info is a top cause of failure)
- **No file_read right after file_edit / file_write** — file_edit bundles ±20 lines around the edit, file_write bundles what was written. Use file_read only when you need to see a different spot
- Retrying the same tool × same args is useless. Change args or switch tools (see Failure escalation for specifics)
- Each tool's description states "when to use / not use / common misuses". Re-read when unsure
- Prefer editing existing over creating new`;
}

/** 仕様ファイルがあるときの作法 (メイン・サブ両方で有用) */
export function buildSpecFileRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# Spec files — file_read any specified .md/.txt before starting. If it conflicts with the request body, the spec file wins. Before finishing, confirm keyword coverage with grep.`;
  }
  if (tier === "T3") {
    return `# When there is a spec file [REQUIRED]
- Before starting, read the whole spec file with file_read
- If the spec and the request body differ, the spec file wins
- When done, check with grep that the spec's key terms appear in the artifact`;
  }
  return `# Conventions when a spec file exists [REQUIRED]
When handed a spec file path (.txt / .md / design doc, etc.), read the whole thing with file_read before starting. If it conflicts with the request body, the spec wins. Before completion, check with grep that key terms (color specs / layout / state machine, etc.) appear in the artifact.`;
}
