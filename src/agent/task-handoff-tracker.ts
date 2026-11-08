/**
 * タスクの引き継ぎ文書と履歴の対応 (docs/task-handoff-design.md §4.3〜§5)
 *
 * - 履歴 (MessageHistory) ごとに、 使っている文書を 1 つ持つ (チャネルの会話の載せ替えでも取り違えない)
 * - 区切りで文書を書く (checkpoint)。 判断の節は脇の呼び出し task-handoff で、 本体と同じ並び + 指示で直す
 * - 新しい発言が前のタスクの続きか別かを決める (classify。 脇の呼び出し task-switch)
 *
 * 履歴の書き換え (畳み込み) は AgentLoop が行う。 ここは文書と LLM だけを扱い、 履歴は読むだけ。
 */
import type { LLMProvider, Message } from "../providers/base-provider.js";
import { collectResponse } from "../providers/base-provider.js";
import { isRateLimitError } from "../providers/utils/rate-limit.js";
import type { ContextBudget } from "./context-budget.js";
import type { MessageHistory } from "./message-history.js";
import type { MainCallRequest } from "./reduction-summary.js";
import { SUMMARY_MESSAGE_OPEN } from "./reduction-summary.js";
import { sideCall } from "./side-call.js";
import {
  addTaskFiles,
  applyTaskHandoffUpdate,
  collectFilesFromMessages,
  createTaskHandoffDoc,
  isTaskPointerMessage,
  messageText,
  parseTaskHandoffUpdate,
  renderTaskHandoffMarkdown,
  type TaskCheckpointKind,
  type TaskDocPaths,
  type TaskHandoffDoc,
  type TaskHandoffStore,
  type TaskHandoffUpdate,
  type TaskStatus,
  type TaskTodoSnapshot,
} from "./task-handoff.js";
import { estimateMessageTokens } from "./token-counter.js";
import { HANDOFF_MARKER } from "./handoff.js";

/** 判断の節の更新の指示の目印 (テスト・ログで見分ける) */
export const TASK_HANDOFF_UPDATE_TAG = "task-handoff-update-request";
/** 続きか別かの分類の指示の目印 */
export const TASK_SWITCH_TAG = "task-switch-request";

/** 判断の節の更新に要る最低の出力 (これ未満の空きなら呼ばない) */
const MIN_UPDATE_OUTPUT_TOKENS = 1_000;
/** 依頼の終わり・ToDo 全完了で LLM を呼ぶ、 増えた分の文字数の目安 (ツール呼び出しが無いとき) */
const REFINE_MIN_DELTA_CHARS = 2_000;
const CLASSIFY_MAX_TOKENS = 60;

/** 続きの印 (LLM を呼ばずに続きとみなす発言の始まり) */
const CONTINUATION_PATTERN =
  /^(続けて|つづけて|続き|もっと|さらに|あと[、,\s]|それ|その|これ|この|さっき|先ほど|今の|上の|やっぱり|やはり|ついでに|同じ|ok\b|okay\b|はい|うん|お願い|continue\b|go on\b)/i;
const CONTINUATION_MAX_CHARS = 200;

export interface TaskHandoffLogRecord {
  action: "create" | "update" | "follow-up" | "close" | "fold" | "classify" | "restore" | "error";
  taskId?: string;
  path?: string;
  kind?: TaskCheckpointKind;
  status?: TaskStatus;
  refined?: boolean;
  decision?: "same" | "new";
  basis?: "heuristic" | "llm" | "failed";
  detail?: string;
  durationMs?: number;
}

export interface TaskHandoffTrackerDeps {
  store: TaskHandoffStore;
  provider: () => LLMProvider;
  model: () => string;
  sessionId: () => string;
  todos: () => TaskTodoSnapshot[];
  log?: (record: TaskHandoffLogRecord) => void;
}

/** 判断の節の更新に要るもの (本体と同じ並び) */
export interface RefineContext {
  /** buildMainCallRequest() の結果。 attachDynamicContext() の前に作ること */
  request: MainCallRequest;
  promptTokens: number;
  budget: ContextBudget;
}

export type TaskUpdateCallResult =
  | { ok: true; update: TaskHandoffUpdate; unchanged: boolean }
  | { ok: false; reason: "no-room" | "length" | "format" | "tool-call" | "error"; detail: string };

export interface CheckpointResult {
  doc: TaskHandoffDoc;
  paths: TaskDocPaths;
  /** 判断の節を LLM で直したか */
  refined: boolean;
  /** 判断の節の更新が失敗したとき (機械的な節は書いてある) */
  refineFailure?: string;
}

export interface ClassifyResult {
  decision: "same" | "new";
  basis: "heuristic" | "llm" | "failed";
  detail?: string;
}

interface TrackerState {
  doc: TaskHandoffDoc;
  /** 判断の節の更新に入れたメッセージ (前回の更新より後の数え方。 §4.4) */
  covered: WeakSet<Message>;
  /** このタスクの最後の依頼が正常に終わり、 未完了の ToDo が無かったか (閉じるときの状態) */
  lastRequestCompleted: boolean;
}

// ─── 指示 ───

export function buildTaskUpdateInstruction(doc: TaskHandoffDoc, newMessageCount: number, retryNote?: string): string {
  return [
    `<${TASK_HANDOFF_UPDATE_TAG}>`,
    "ここで会話への返事はせず、 ツールも呼ばないでください。 これはハーネスからの依頼です。",
    "下の「タスクの引き継ぎ文書」 を、 ここまでの会話に合わせて更新します。",
    `前回の更新より後に増えたメッセージは ${newMessageCount} 件です。 そこで変わった節だけを、 次の形で書いてください。 変わらない節は書かないでください。 何も変わらなければ「変更なし」 とだけ書いてください。`,
    "",
    "## 決まり・制約",
    "+ 足す決まり (利用者が出した指示・守ると決めた方針。 利用者の言葉に近い形で)",
    "- 外す決まり (文書のとおり) | 理由: なぜ外すか",
    "## 現状",
    "(どこまで出来ていて、 何が動いているかを書き直した本文)",
    "## 決めた事と理由",
    "+ 決めた事 — 理由",
    "## 試して駄目だった事",
    "+ 試した事 — 駄目だった理由 (ツールが使えない・キーが無い・エラーなど。 同じ失敗を繰り返さないため)",
    "## 次の一手",
    "(次にやることを書き直した本文)",
    "",
    "「依頼の原文」 と「関係するファイル」 はハーネスが書くので、 書かないでください。",
    ...(retryNote ? ["", `前回の出力は使えませんでした: ${retryNote}`] : []),
    "",
    "## タスクの引き継ぎ文書 (今の版)",
    renderTaskHandoffMarkdown(doc),
    `</${TASK_HANDOFF_UPDATE_TAG}>`,
  ].join("\n");
}

/**
 * 判断の節の更新を求める (§4.4)。 本体と同じ並び (request.params.messages) の後ろに指示を 1 件足して送る。
 * レート制限は投げる。 ほかの失敗は結果で返す。 ツールを呼んだ・形が違うときは 1 回だけ出し直す。
 */
export async function requestTaskHandoffUpdate(input: {
  provider: LLMProvider;
  refine: RefineContext;
  doc: TaskHandoffDoc;
  newMessageCount: number;
}): Promise<TaskUpdateCallResult> {
  const { request, promptTokens, budget } = input.refine;
  let retryNote: string | undefined;
  let last: TaskUpdateCallResult = { ok: false, reason: "error", detail: "呼んでいません" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const instruction: Message = {
      role: "user",
      content: buildTaskUpdateInstruction(input.doc, input.newMessageCount, retryNote),
    };
    const room =
      budget.contextWindow - promptTokens - estimateMessageTokens([instruction]) - budget.estimateMarginTokens;
    const maxTokens = Math.min(budget.outputTokenLimit, room);
    if (maxTokens < MIN_UPDATE_OUTPUT_TOKENS) {
      return {
        ok: false,
        reason: "no-room",
        detail: `枠の残りが文書の更新の出力に足りません (空き ${room.toLocaleString("en-US")} トークン)`,
      };
    }
    const messages = [...request.params.messages, instruction];
    let res: Awaited<ReturnType<typeof collectResponse>>;
    try {
      const gen =
        request.method === "chatWithTools"
          ? sideCall(
              "task-handoff",
              input.provider,
              { method: "chatWithTools", params: { ...request.params, messages, maxTokens } },
              { fingerprint: true, signal: request.params.signal },
            )
          : sideCall(
              "task-handoff",
              input.provider,
              { method: "chat", params: { ...request.params, messages, maxTokens } },
              { fingerprint: true, signal: request.params.signal },
            );
      res = await collectResponse(gen);
    } catch (e) {
      if (isRateLimitError(e)) throw e;
      return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
    }
    if (res.toolCalls.length > 0) {
      retryNote = `ツールを呼びました (${res.toolCalls.map((c) => c.function.name).join(", ")})。 ツールは呼ばず、 文章だけで答えてください`;
      last = { ok: false, reason: "tool-call", detail: retryNote };
      continue;
    }
    if (res.finishReason === "length") {
      return { ok: false, reason: "length", detail: `出力が上限 ${maxTokens} トークンで切れました` };
    }
    const parsed = parseTaskHandoffUpdate(res.content);
    if (!parsed.ok) {
      retryNote = parsed.problem;
      last = { ok: false, reason: "format", detail: parsed.problem };
      continue;
    }
    return { ok: true, update: parsed.update, unchanged: parsed.unchanged };
  }
  return last;
}

export function buildTaskSwitchPrompt(doc: TaskHandoffDoc, newText: string): string {
  const requests = doc.requests
    .map((r) => r.text.trim())
    .join("\n---\n")
    .slice(-1_500);
  return [
    `<${TASK_SWITCH_TAG}>`,
    "作業中のタスクと、 利用者の新しい発言があります。",
    "新しい発言が、 作業中のタスクの続き (追加の指示・直し・そのタスクについての質問) なら same、",
    "別の新しいタスク (別の物を作る・別の問題を調べるなど) なら new と答えてください。",
    "",
    `## 作業中のタスクの依頼\n${requests || "(なし)"}`,
    `## 作業中のタスクの現状\n${doc.current.trim().slice(0, 600) || "(未記入)"}`,
    `## 新しい発言\n${newText.trim().slice(0, 1_500)}`,
    "",
    '{"task":"same"} か {"task":"new"} の JSON 1 行だけで答えてください。',
    `</${TASK_SWITCH_TAG}>`,
  ].join("\n");
}

export function parseTaskSwitchAnswer(text: string): "same" | "new" | null {
  const json = text.match(/"task"\s*:\s*"(same|new)"/i);
  if (json) return json[1].toLowerCase() as "same" | "new";
  const bare = text.trim().match(/^(same|new)\b/i);
  return bare ? (bare[1].toLowerCase() as "same" | "new") : null;
}

/** 続きの印で始まる短い発言か (LLM を呼ばずに続きとする) */
export function looksLikeContinuation(text: string): boolean {
  const t = text.trim();
  return t.length <= CONTINUATION_MAX_CHARS && CONTINUATION_PATTERN.test(t);
}

/** 履歴の中で、 利用者の言葉として依頼の原文に入れてよい発言か (ポインタ・引き継ぎメモ・ハーネスの促しを除く) */
function isUserWords(m: Message): boolean {
  if (m.role !== "user" || m.ephemeral === true || isTaskPointerMessage(m)) return false;
  return !messageText(m).startsWith(HANDOFF_MARKER);
}

// ─── 本体 ───

export class TaskHandoffTracker {
  private states = new WeakMap<MessageHistory, TrackerState>();

  constructor(private readonly deps: TaskHandoffTrackerDeps) {}

  get store(): TaskHandoffStore {
    return this.deps.store;
  }

  /** 使っている文書 (無ければ null)。 第 2 段の整理はここから抜粋を作る */
  activeDoc(history: MessageHistory): TaskHandoffDoc | null {
    return this.states.get(history)?.doc ?? null;
  }

  activePaths(history: MessageHistory): TaskDocPaths | null {
    const doc = this.activeDoc(history);
    return doc ? this.deps.store.pathsFor(doc) : null;
  }

  private log(record: TaskHandoffLogRecord): void {
    this.deps.log?.(record);
  }

  private put(history: MessageHistory, doc: TaskHandoffDoc, lastRequestCompleted = false): TaskDocPaths {
    const paths = this.deps.store.save(doc);
    const prev = this.states.get(history);
    this.states.set(history, {
      doc,
      covered: prev && prev.doc.id === doc.id ? prev.covered : new WeakSet(),
      lastRequestCompleted,
    });
    return paths;
  }

  /** 新しいタスクの文書を作って使う (保存の失敗は投げる) */
  startTask(history: MessageHistory, requestText: string, now = new Date()): TaskHandoffDoc {
    const doc = createTaskHandoffDoc({ sessionId: this.deps.sessionId(), requests: [{ text: requestText }], now });
    doc.todos = this.deps.todos();
    const paths = this.put(history, doc);
    // 文書を作る前の履歴 (畳み込みで残ったポインタなど) は、 このタスクの更新の対象にしない
    const state = this.states.get(history);
    for (const m of history.getRawMessages()) state?.covered.add(m);
    this.log({ action: "create", taskId: doc.id, path: paths.md, kind: "create", status: doc.status });
    return doc;
  }

  /**
   * 文書が無いまま履歴に中身があるとき (前のタスクに文書がまだ無い・再開した古いセッション)、 履歴の利用者の発言から文書を作る。
   * 中身が無ければ null。 保存の失敗は投げる
   */
  adoptHistory(history: MessageHistory): TaskHandoffDoc | null {
    if (this.activeDoc(history)) return this.activeDoc(history);
    const raw = history.getRawMessages();
    const content = raw.filter((m) => !isTaskPointerMessage(m));
    if (content.length === 0) return null;
    const words = content.filter(isUserWords).map((m) => ({ text: messageText(m) }));
    const doc = createTaskHandoffDoc({
      sessionId: this.deps.sessionId(),
      requests: words.length > 0 ? words : [{ text: "(履歴に利用者の発言が残っていません)" }],
    });
    doc.todos = this.deps.todos();
    doc.files = addTaskFiles(doc, collectFilesFromMessages(content)).files;
    const paths = this.put(history, doc);
    this.log({ action: "create", taskId: doc.id, path: paths.md, kind: "create", detail: "履歴から作成" });
    return doc;
  }

  /** 続きの発言を依頼の原文に足す (状態は進行中に戻す。 保存の失敗は投げる) */
  noteFollowUp(history: MessageHistory, text: string, now = new Date()): void {
    const state = this.states.get(history);
    if (!state || !text.trim()) return;
    const doc = structuredClone(state.doc);
    doc.requests.push({ at: now.toISOString(), text, kind: doc.requests.length === 0 ? "initial" : "follow-up" });
    doc.status = "進行中";
    doc.updatedAt = now.toISOString();
    const paths = this.put(history, doc, false);
    this.log({ action: "follow-up", taskId: doc.id, path: paths.md });
  }

  /** 依頼の終わりを控える (閉じるときの状態 完了 / 中断 に使う) */
  noteRequestEnd(history: MessageHistory, completed: boolean): void {
    const state = this.states.get(history);
    if (state) state.lastRequestCompleted = completed;
  }

  /** 前回の更新より後に増えたメッセージ */
  private delta(history: MessageHistory, state: TrackerState): Message[] {
    return history.getRawMessages().filter((m) => !state.covered.has(m) && !isTaskPointerMessage(m));
  }

  /**
   * 依頼の終わり・ToDo 全完了で判断の節を LLM で直すか (§4.3)。 ツール呼び出しがあったか、 増えた分が目安以上のとき。
   * 整理の前・畳み込み・/handoff は呼び出し側がいつも直す
   */
  shouldRefine(history: MessageHistory): boolean {
    const state = this.states.get(history);
    if (!state) return false;
    const delta = this.delta(history, state);
    if (delta.some((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0)) return true;
    return delta.reduce((n, m) => n + messageText(m).length, 0) >= REFINE_MIN_DELTA_CHARS;
  }

  /**
   * 文書を書く (§4.3)。 機械的な節 (ToDo・関係するファイル) はいつも写し、 refine があれば判断の節を LLM で直す。
   * 使っている文書が無ければ null。 保存の失敗とレート制限は投げる。 判断の節の更新の失敗は結果の refineFailure に載せる
   */
  async checkpoint(
    history: MessageHistory,
    kind: TaskCheckpointKind,
    opts: { refine: RefineContext | null },
  ): Promise<CheckpointResult | null> {
    const state = this.states.get(history);
    if (!state) return null;
    const startedAt = Date.now();
    const delta = this.delta(history, state);
    let doc = addTaskFiles(structuredClone(state.doc), collectFilesFromMessages(delta));
    doc.todos = this.deps.todos();
    let refined = false;
    let refineFailure: string | undefined;
    let logLines: string[] = [];
    if (opts.refine && delta.length > 0) {
      const result = await requestTaskHandoffUpdate({
        provider: this.deps.provider(),
        refine: opts.refine,
        doc,
        newMessageCount: delta.length,
      });
      if (result.ok) {
        const applied = applyTaskHandoffUpdate(doc, result.update);
        doc = applied.doc;
        logLines = applied.logLines;
        refined = true;
      } else {
        refineFailure = `判断の節を更新できませんでした (${result.reason}): ${result.detail}`;
        logLines.push(`${kind}: ${refineFailure}`);
      }
    }
    const now = new Date();
    doc.updatedAt = now.toISOString();
    doc.lastCheckpoint = kind;
    const paths = this.put(history, doc, state.lastRequestCompleted);
    this.deps.store.appendHistory(doc, logLines, now);
    if (refined) {
      const after = this.states.get(history);
      for (const m of delta) after?.covered.add(m);
    }
    this.log({
      action: refineFailure ? "error" : "update",
      taskId: doc.id,
      path: paths.md,
      kind,
      refined,
      detail: refineFailure,
      durationMs: Date.now() - startedAt,
    });
    return { doc, paths, refined, refineFailure };
  }

  /**
   * 新しい発言が前のタスクの続きか別かを決める (§5 の 2)。 文書が無ければ new。
   * 分類の失敗 (レート制限を除く) は same (畳まない側に倒す) とし、 basis=failed で返す
   */
  async classify(history: MessageHistory, newText: string, signal?: AbortSignal): Promise<ClassifyResult> {
    const doc = this.activeDoc(history);
    if (!doc) return { decision: "new", basis: "heuristic", detail: "使っている文書がありません" };
    if (looksLikeContinuation(newText)) {
      this.log({ action: "classify", taskId: doc.id, decision: "same", basis: "heuristic" });
      return { decision: "same", basis: "heuristic" };
    }
    try {
      const gen = sideCall(
        "task-switch",
        this.deps.provider(),
        {
          method: "chat",
          params: {
            model: this.deps.model(),
            messages: [{ role: "user", content: buildTaskSwitchPrompt(doc, newText) }],
            temperature: 0,
            maxTokens: CLASSIFY_MAX_TOKENS,
            disableThinking: true,
            stream: true,
            signal,
          },
        },
        { signal },
      );
      const res = await collectResponse(gen);
      const decision = parseTaskSwitchAnswer(res.content);
      if (!decision) throw new Error(`応答に same / new がありません (${res.content.slice(0, 80)})`);
      this.log({ action: "classify", taskId: doc.id, decision, basis: "llm" });
      return { decision, basis: "llm" };
    } catch (e) {
      if (isRateLimitError(e)) throw e;
      const detail = e instanceof Error ? e.message : String(e);
      this.log({ action: "classify", taskId: doc.id, decision: "same", basis: "failed", detail });
      return { decision: "same", basis: "failed", detail };
    }
  }

  /** 閉じる状態 (最後の依頼が正常に終わり未完了の ToDo が無ければ 完了) */
  closingStatus(history: MessageHistory): TaskStatus {
    return this.states.get(history)?.lastRequestCompleted ? "完了" : "中断";
  }

  /** 文書を閉じて使うのをやめる (保存の失敗は投げ、 そのときは使い続ける) */
  close(
    history: MessageHistory,
    status: TaskStatus,
    archivedSessionId?: string,
  ): { doc: TaskHandoffDoc; paths: TaskDocPaths } | null {
    const state = this.states.get(history);
    if (!state) return null;
    const doc = structuredClone(state.doc);
    const now = new Date();
    doc.status = status;
    doc.updatedAt = now.toISOString();
    if (archivedSessionId) doc.archivedSessionId = archivedSessionId;
    const paths = this.deps.store.save(doc);
    this.deps.store.appendHistory(
      doc,
      [`タスクを閉じました (${status})${archivedSessionId ? `。 畳む前の履歴: セッション ${archivedSessionId}` : ""}`],
      now,
    );
    this.states.delete(history);
    this.log({ action: "close", taskId: doc.id, path: paths.md, status });
    return { doc, paths };
  }

  /** 利用者のファイルから決まりを写す (/handoff from-file。 入力としてだけ読む。 §7) */
  importConstraints(history: MessageHistory, constraints: readonly string[]): TaskHandoffDoc | null {
    const state = this.states.get(history);
    if (!state || constraints.length === 0) return state?.doc ?? null;
    const applied = applyTaskHandoffUpdate(state.doc, {
      addConstraints: [...constraints],
      removeConstraints: [],
      addDecisions: [],
      addFailures: [],
    });
    const doc = { ...applied.doc, updatedAt: new Date().toISOString(), lastCheckpoint: "user-file" as const };
    this.put(history, doc, state.lastRequestCompleted);
    this.deps.store.appendHistory(doc, [`利用者の引き継ぎファイルから決まりを ${constraints.length} 件写しました`]);
    return doc;
  }

  /** 再開: 保存されていた正本を読み戻して使う。 読めなければ投げる (呼び出し側が警告する) */
  restore(history: MessageHistory, jsonPath: string): TaskHandoffDoc {
    const doc = this.deps.store.load(jsonPath);
    this.states.set(history, { doc, covered: new WeakSet(), lastRequestCompleted: false });
    this.log({ action: "restore", taskId: doc.id, path: this.deps.store.pathsFor(doc).md });
    return doc;
  }

  /** 履歴が既存の要約 (段階 3) をいくつ持つか (記録・第 2 段の判断用) */
  static countSummaries(history: MessageHistory): number {
    return history
      .getRawMessages()
      .filter(
        (m) => m.role === "assistant" && typeof m.content === "string" && m.content.startsWith(SUMMARY_MESSAGE_OPEN),
      ).length;
  }
}
