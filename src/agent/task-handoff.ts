/**
 * タスクの引き継ぎ文書 (タスクごとの正本。 docs/task-handoff-design.md)
 *
 * タスク (依頼のまとまり) ごとに 1 つ、 決まった 7 つの節を持つ文書をディスクに置く。
 * 文脈には要約の要約を重ねず、 この文書から抜き出し直した物 (第 2 段) か、 1 行のポインタ (畳み込み) だけを置く。
 *
 * このファイルは純粋な部分 (型・上限・更新の当てはめ・描画・読み取り) と、 保存 (TaskHandoffStore) だけを持つ。
 * LLM を呼ぶ部分と履歴との対応は task-handoff-tracker.ts。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "../providers/base-provider.js";
import { writeFileAtomic } from "../utils/atomic-file.js";

// ─── 型 ───

export type TaskStatus = "進行中" | "中断" | "完了";

/** 文書を書いた契機 (§4.3) */
export type TaskCheckpointKind =
  | "create"
  | "todos-complete"
  | "goal-achieved"
  | "request-end"
  | "new-request"
  | "before-reduction"
  | "handoff"
  | "user-file";

/** 依頼の原文 1 件 (利用者の言葉をそのまま持つ。 要約しない) */
export interface TaskRequestEntry {
  at: string;
  text: string;
  /** 最初の依頼か、 続きの追加か */
  kind: "initial" | "follow-up";
}

export interface TaskTodoSnapshot {
  content: string;
  status: string;
}

/** 正本 (JSON)。 version は形の版 */
export interface TaskHandoffDoc {
  version: 1;
  id: string;
  sessionId: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  lastCheckpoint: TaskCheckpointKind;
  /** 畳み込みの前に保存したセッション (/resume で畳む前の完全な履歴に戻れる) */
  archivedSessionId?: string;
  requests: TaskRequestEntry[];
  constraints: string[];
  current: string;
  decisions: string[];
  failures: string[];
  next: string;
  files: string[];
  todos: TaskTodoSnapshot[];
}

/** 判断の節の更新 (LLM の出力を読んだもの。 §4.5) */
export interface TaskHandoffUpdate {
  addConstraints: string[];
  removeConstraints: Array<{ text: string; reason: string }>;
  current?: string;
  addDecisions: string[];
  addFailures: string[];
  next?: string;
}

// ─── 節と上限 (§4.2) ───

export const TASK_HANDOFF_SECTIONS = {
  requests: "依頼の原文",
  constraints: "決まり・制約",
  current: "現状",
  decisions: "決めた事と理由",
  failures: "試して駄目だった事",
  next: "次の一手",
  files: "関係するファイル",
} as const;

export const TASK_HANDOFF_LIMITS = {
  constraintChars: 400,
  /** これを超えたら経緯ログに警告 (決まりは理由なしに消さないので、 自動では消さない) */
  constraintSoftCount: 40,
  currentChars: 2_000,
  decisionCount: 12,
  decisionChars: 300,
  failureCount: 15,
  failureChars: 300,
  nextChars: 1_200,
  fileCount: 30,
  /** ポインタの行の上限 (古いものから落とす。 文書は残る) */
  pointerLines: 20,
  /** タイトル (依頼の頭) の長さ */
  titleChars: 40,
} as const;

/** ポインタのメッセージの目印 (user メッセージの先頭) */
export const TASK_POINTER_MARKER = "[タスクの記録]";

// ─── 小道具 ───

function clip(text: string, max: number): string {
  const flat = text.replace(/\r/g, "").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 依頼の頭からタイトルを作る */
export function makeTaskTitle(requestText: string): string {
  const line = oneLine(requestText);
  return line.length === 0 ? "(無題のタスク)" : clip(line, TASK_HANDOFF_LIMITS.titleChars);
}

export function newTaskId(now = Date.now()): string {
  return `t-${now.toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

/** メッセージの本文 (文字列か、 画像付きの text パート) を文字列にする */
export function messageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function createTaskHandoffDoc(input: {
  sessionId: string;
  requests: Array<{ text: string; at?: string }>;
  now?: Date;
  id?: string;
}): TaskHandoffDoc {
  const at = (input.now ?? new Date()).toISOString();
  const requests: TaskRequestEntry[] = input.requests
    .filter((r) => r.text.trim().length > 0)
    .map((r, i) => ({ at: r.at ?? at, text: r.text, kind: i === 0 ? "initial" : "follow-up" }));
  return {
    version: 1,
    id: input.id ?? newTaskId(),
    sessionId: input.sessionId,
    title: makeTaskTitle(requests[0]?.text ?? ""),
    status: "進行中",
    createdAt: at,
    updatedAt: at,
    lastCheckpoint: "create",
    requests,
    constraints: [],
    current: "",
    decisions: [],
    failures: [],
    next: "",
    files: [],
    todos: [],
  };
}

// ─── 更新の当てはめ (純粋) ───

export interface ApplyUpdateResult {
  doc: TaskHandoffDoc;
  /** 経緯ログに追記する行 (押し出した決めた事・削除した決まり・警告) */
  logLines: string[];
}

function normalizeItem(text: string): string {
  return oneLine(text).replace(/^[-+*・]\s*/, "");
}

/**
 * 判断の節の更新を当てはめる。 上限を超えた「決めた事」 「試して駄目だった事」 は古い側から経緯ログへ押し出す。
 * 決まりの削除は理由が要る (理由の無い削除は当てはめず、 経緯ログに残す)。
 */
export function applyTaskHandoffUpdate(doc: TaskHandoffDoc, update: TaskHandoffUpdate): ApplyUpdateResult {
  const L = TASK_HANDOFF_LIMITS;
  const next: TaskHandoffDoc = structuredClone(doc);
  const logLines: string[] = [];

  for (const removal of update.removeConstraints) {
    const target = normalizeItem(removal.text);
    if (!removal.reason.trim()) {
      logLines.push(`決まりの削除を見送り (理由が無い): ${target}`);
      continue;
    }
    const index = next.constraints.findIndex((c) => c === target || c.includes(target) || target.includes(c));
    if (index < 0) {
      logLines.push(`決まりの削除を見送り (文書に無い): ${target} | 理由: ${oneLine(removal.reason)}`);
      continue;
    }
    const [removed] = next.constraints.splice(index, 1);
    logLines.push(`決まりを削除: ${removed} | 理由: ${oneLine(removal.reason)}`);
  }
  for (const raw of update.addConstraints) {
    const item = clip(normalizeItem(raw), L.constraintChars);
    if (item && !next.constraints.includes(item)) next.constraints.push(item);
  }
  if (next.constraints.length > L.constraintSoftCount) {
    logLines.push(
      `警告: 決まり・制約が ${next.constraints.length} 項目あります (目安 ${L.constraintSoftCount})。 理由なしには消さないので、 要らないものは理由を付けて外してください`,
    );
  }

  if (update.current !== undefined) next.current = clip(update.current, L.currentChars);
  if (update.next !== undefined) next.next = clip(update.next, L.nextChars);

  for (const raw of update.addDecisions) {
    const item = clip(normalizeItem(raw), L.decisionChars);
    if (item && !next.decisions.includes(item)) next.decisions.push(item);
  }
  while (next.decisions.length > L.decisionCount) {
    const old = next.decisions.shift();
    logLines.push(`決めた事 (上限で経緯へ): ${old}`);
  }

  for (const raw of update.addFailures) {
    const item = clip(normalizeItem(raw), L.failureChars);
    if (item && !next.failures.includes(item)) next.failures.push(item);
  }
  while (next.failures.length > L.failureCount) {
    const old = next.failures.shift();
    logLines.push(`試して駄目だった事 (上限で経緯へ): ${old}`);
  }
  return { doc: next, logLines };
}

/** 関係するファイルを足す (新しい順。 上限を超えた古いものは落とす) */
export function addTaskFiles(doc: TaskHandoffDoc, files: readonly string[]): TaskHandoffDoc {
  if (files.length === 0) return doc;
  const merged = [...files.slice().reverse(), ...doc.files];
  const unique = [...new Set(merged.map((f) => f.trim()).filter((f) => f.length > 0))];
  return { ...doc, files: unique.slice(0, TASK_HANDOFF_LIMITS.fileCount) };
}

/** ツール呼び出しの引数からファイルのパスを拾う (機械的。 §4.2 の関係するファイル) */
export function collectFilesFromMessages(messages: readonly Message[]): string[] {
  const keys = ["file_path", "path", "filePath", "target_file", "notebook_path"];
  const files: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const key of keys) {
        const value = args[key];
        if (typeof value === "string" && value.trim().length > 0 && value.length < 500) files.push(value.trim());
      }
    }
  }
  return files;
}

// ─── 更新の出力の読み取り (§4.5) ───

export type ParseUpdateResult =
  | { ok: true; update: TaskHandoffUpdate; unchanged: boolean }
  | { ok: false; problem: string };

const UPDATABLE = [
  TASK_HANDOFF_SECTIONS.constraints,
  TASK_HANDOFF_SECTIONS.current,
  TASK_HANDOFF_SECTIONS.decisions,
  TASK_HANDOFF_SECTIONS.failures,
  TASK_HANDOFF_SECTIONS.next,
] as const;

function emptyUpdate(): TaskHandoffUpdate {
  return { addConstraints: [], removeConstraints: [], addDecisions: [], addFailures: [] };
}

/** LLM の出力を読む。 変わった節だけが書かれている前提。 `変更なし` なら空の更新 */
export function parseTaskHandoffUpdate(raw: string): ParseUpdateResult {
  let text = raw.replace(/\r/g, "").trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  if (/^変更なし[。.]?$/.test(text)) return { ok: true, update: emptyUpdate(), unchanged: true };

  const update = emptyUpdate();
  const lines = text.split("\n");
  let section: string | null = null;
  const bodies = new Map<string, string[]>();
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const name = heading[1];
      section = (UPDATABLE as readonly string[]).includes(name) ? name : null;
      if (section) bodies.set(section, []);
      continue;
    }
    if (section) bodies.get(section)?.push(line);
  }
  if (bodies.size === 0) {
    return { ok: false, problem: `決まった節の見出し (${UPDATABLE.map((s) => `## ${s}`).join(" / ")}) がありません` };
  }
  const listAdds = (body: string[]): string[] =>
    body
      .map((l) => l.trim())
      .filter((l) => /^[+＋]\s*/.test(l) || /^[-*・]\s*/.test(l))
      .map((l) => l.replace(/^[+＋\-*・]\s*/, "").trim())
      .filter((l) => l.length > 0 && l !== "なし");

  for (const [name, body] of bodies) {
    if (name === TASK_HANDOFF_SECTIONS.constraints) {
      for (const l of body.map((x) => x.trim())) {
        if (/^[+＋]\s*/.test(l)) {
          const item = l.replace(/^[+＋]\s*/, "").trim();
          if (item && item !== "なし") update.addConstraints.push(item);
        } else if (/^-\s*/.test(l)) {
          const item = l.replace(/^-\s*/, "").trim();
          const m = item.match(/^(.*?)\s*[|｜]\s*理由[:：]\s*(.*)$/);
          if (m) update.removeConstraints.push({ text: m[1].trim(), reason: m[2].trim() });
          else if (item && item !== "なし") update.removeConstraints.push({ text: item, reason: "" });
        }
      }
    } else if (name === TASK_HANDOFF_SECTIONS.decisions) {
      update.addDecisions.push(...listAdds(body));
    } else if (name === TASK_HANDOFF_SECTIONS.failures) {
      update.addFailures.push(...listAdds(body));
    } else if (name === TASK_HANDOFF_SECTIONS.current) {
      update.current = body.join("\n").trim();
    } else if (name === TASK_HANDOFF_SECTIONS.next) {
      update.next = body.join("\n").trim();
    }
  }
  return { ok: true, update, unchanged: false };
}

// ─── 描画 ───

function bullets(items: readonly string[]): string {
  return items.length === 0 ? "- なし" : items.map((i) => `- ${i}`).join("\n");
}

function todoLines(todos: readonly TaskTodoSnapshot[]): string[] {
  return todos.map(
    (t) => `- [${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] ${t.content}`,
  );
}

/** 次の一手 (書かれていなければ未完了の ToDo の先頭) */
function nextText(doc: TaskHandoffDoc): string {
  if (doc.next.trim()) return doc.next.trim();
  const open = doc.todos.find((t) => t.status !== "completed");
  return open ? `(ToDo より) ${open.content}` : "";
}

export interface TaskDocPaths {
  json: string;
  md: string;
  history: string;
}

/** 読む形 (.md) を描く。 ポインタ・/handoff が指すのはこれ */
export function renderTaskHandoffMarkdown(doc: TaskHandoffDoc, paths?: TaskDocPaths): string {
  const S = TASK_HANDOFF_SECTIONS;
  const out: string[] = [
    `# タスクの引き継ぎ: ${doc.title}`,
    "",
    `状態: ${doc.status} / 作成: ${doc.createdAt} / 更新: ${doc.updatedAt} (${doc.lastCheckpoint})`,
  ];
  if (paths) out.push(`正本: ${paths.json} / 経緯ログ: ${paths.history}`);
  if (doc.archivedSessionId) out.push(`畳む前の履歴: セッション ${doc.archivedSessionId} (/resume で戻れる)`);
  out.push("", `## ${S.requests}`);
  if (doc.requests.length === 0) out.push("- なし");
  for (const r of doc.requests) {
    out.push("", `### ${r.at}${r.kind === "follow-up" ? " (追加)" : ""}`, "", r.text.replace(/\r/g, ""));
  }
  out.push("", `## ${S.constraints}`, bullets(doc.constraints));
  out.push("", `## ${S.current}`, doc.current.trim() || "(未記入)");
  if (doc.todos.length > 0) out.push("", "ToDo:", ...todoLines(doc.todos));
  out.push("", `## ${S.decisions}`, bullets(doc.decisions));
  out.push("", `## ${S.failures}`, bullets(doc.failures));
  out.push("", `## ${S.next}`, nextText(doc) || "(未記入)");
  out.push("", `## ${S.files}`, bullets(doc.files));
  return `${out.join("\n")}\n`;
}

/**
 * 文脈に置く抜粋 (第 2 段で使う。 §9.2)。 依頼の原文は頭だけ、 ほかの節は上限内の全部。
 * 文書から毎回作り直すので、 何回作っても薄まらない。
 */
export function renderTaskHandoffExcerpt(doc: TaskHandoffDoc, mdPath: string, requestChars = 6_000): string {
  const S = TASK_HANDOFF_SECTIONS;
  const out: string[] = [`<task-handoff-excerpt task="${doc.id}" status="${doc.status}">`, `引き継ぎ文書: ${mdPath}`];
  out.push("", `## ${S.requests}`);
  let budget = requestChars;
  let omitted = 0;
  for (const r of doc.requests) {
    if (budget <= 0) {
      omitted++;
      continue;
    }
    const text = r.text.replace(/\r/g, "").trim();
    const shown = text.length <= budget ? text : `${text.slice(0, budget)}… (続きは文書)`;
    budget -= shown.length;
    out.push(`- ${r.kind === "follow-up" ? "(追加) " : ""}${shown}`);
  }
  if (omitted > 0) out.push(`- (ほか ${omitted} 件は文書の全文を読む)`);
  out.push("", `## ${S.constraints}`, bullets(doc.constraints));
  out.push("", `## ${S.current}`, doc.current.trim() || "(未記入)");
  if (doc.todos.length > 0) out.push(...todoLines(doc.todos));
  out.push("", `## ${S.decisions}`, bullets(doc.decisions));
  out.push("", `## ${S.failures}`, bullets(doc.failures));
  out.push("", `## ${S.next}`, nextText(doc) || "(未記入)");
  out.push("", `## ${S.files}`, bullets(doc.files.slice(0, 10)));
  out.push("</task-handoff-excerpt>");
  return out.join("\n");
}

/**
 * /handoff のメモを文書から描く (§7)。 handoff.ts のテンプレートの 4 つの見出しを持つ。
 * 「守るべき制約・決定事項」 には依頼の原文をそのまま入れる (要約しない)。
 */
export function renderHandoffNoteFromTask(doc: TaskHandoffDoc, mdPath: string): string {
  const done: string[] = [];
  for (const line of doc.current
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    done.push(line.startsWith("- ") ? line : `- ${line}`);
  }
  for (const t of doc.todos.filter((x) => x.status === "completed")) done.push(`- (完了した ToDo) ${t.content}`);
  for (const d of doc.decisions) done.push(`- 決めた事: ${d}`);
  const next = nextText(doc)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("- ") ? l : `- ${l}`));
  for (const t of doc.todos.filter((x) => x.status !== "completed")) next.push(`- (未完了の ToDo) ${t.content}`);
  const rules: string[] = [];
  for (const r of doc.requests) {
    rules.push(`- 依頼の原文${r.kind === "follow-up" ? " (追加)" : ""}:`);
    rules.push(
      ...r.text
        .replace(/\r/g, "")
        .trim()
        .split("\n")
        .map((l) => `  > ${l}`),
    );
  }
  for (const c of doc.constraints) rules.push(`- ${c}`);
  for (const f of doc.failures) rules.push(`- 試して駄目だった事: ${f}`);
  const files = [`- ${mdPath} — このタスクの引き継ぎ文書 (正本)`, ...doc.files.map((f) => `- ${f}`)];
  return [
    "## これまでにやったこと",
    done.length > 0 ? done.join("\n") : "- なし",
    "",
    "## 次にやること",
    next.length > 0 ? next.join("\n") : "- なし",
    "",
    "## 守るべき制約・決定事項",
    rules.length > 0 ? rules.join("\n") : "- なし",
    "",
    "## 関係するファイル",
    files.join("\n"),
  ].join("\n");
}

/** 利用者が書いた /handoff のファイルから「守るべき制約・決定事項」 の項目を拾う (入力としてだけ読む。 §7) */
export function extractConstraintsFromHandoffNote(note: string): string[] {
  const lines = note.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      inSection = heading[1].includes("守るべき制約") || heading[1] === TASK_HANDOFF_SECTIONS.constraints;
      continue;
    }
    if (!inSection) continue;
    const item = line.match(/^\s*[-*・]\s+(.+)$/);
    if (item && item[1].trim() !== "なし") out.push(item[1].trim());
  }
  return out;
}

// ─── ポインタ (§5) ───

/** ポインタの 1 行 */
export function buildTaskPointerLine(doc: TaskHandoffDoc, mdPath: string): string {
  return `- ${doc.title}: ${mdPath}（${doc.status}）`;
}

export function isTaskPointerMessage(m: Message): boolean {
  return m.role === "user" && typeof m.content === "string" && m.content.startsWith(TASK_POINTER_MARKER);
}

export function buildTaskPointerMessage(lines: readonly string[]): string {
  return [
    `${TASK_POINTER_MARKER} 前のタスクは引き継ぎ文書に移しました。 続きや詳細が要るときは file_read で読んでください。`,
    ...lines,
  ].join("\n");
}

/** 履歴にあるポインタの行 (古い順) */
export function extractTaskPointerLines(messages: readonly Message[]): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    if (!isTaskPointerMessage(m)) continue;
    for (const line of (m.content as string).split("\n").slice(1)) {
      if (line.startsWith("- ")) lines.push(line);
    }
  }
  return lines;
}

/** 畳み込みの後の履歴: これまでのポインタの行 + 新しい行を 1 件の user メッセージにする */
export function buildFoldedMessages(raw: readonly Message[], newLine: string): Message[] {
  const lines = [...extractTaskPointerLines(raw), newLine].slice(-TASK_HANDOFF_LIMITS.pointerLines);
  return [{ role: "user", content: buildTaskPointerMessage(lines) }];
}

// ─── 保存 ───

/** 正本の読み戻しの検査 */
function isTaskHandoffDoc(value: unknown): value is TaskHandoffDoc {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const arr = (k: string) => Array.isArray(v[k]);
  return (
    v.version === 1 &&
    typeof v.id === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.title === "string" &&
    (v.status === "進行中" || v.status === "中断" || v.status === "完了") &&
    typeof v.current === "string" &&
    typeof v.next === "string" &&
    arr("requests") &&
    arr("constraints") &&
    arr("decisions") &&
    arr("failures") &&
    arr("files") &&
    arr("todos")
  );
}

/**
 * 文書の保存先。 baseDir (絶対パス) の下に `<セッション ID>.tasks/` を作る。
 * 対話の AgentLoop は ~/.localllm/sessions を渡す。 テストは一時フォルダを渡す。
 */
export class TaskHandoffStore {
  constructor(readonly baseDir: string) {
    if (!path.isAbsolute(baseDir)) throw new Error(`[task-handoff] 保存先は絶対パスで指定してください: ${baseDir}`);
  }

  pathsFor(doc: Pick<TaskHandoffDoc, "id" | "sessionId">): TaskDocPaths {
    const dir = path.join(this.baseDir, `${doc.sessionId}.tasks`);
    return {
      json: path.join(dir, `${doc.id}.json`),
      md: path.join(dir, `${doc.id}.md`),
      history: path.join(dir, `${doc.id}.history.md`),
    };
  }

  /** 正本 (JSON) と読む形 (.md) を原子的に書く。 失敗は投げる (呼び出し側は履歴を落とさない) */
  save(doc: TaskHandoffDoc): TaskDocPaths {
    const paths = this.pathsFor(doc);
    fs.mkdirSync(path.dirname(paths.json), { recursive: true });
    writeFileAtomic(paths.json, `${JSON.stringify(doc, null, 2)}\n`);
    writeFileAtomic(paths.md, renderTaskHandoffMarkdown(doc, paths));
    return paths;
  }

  /** 経緯ログに追記する (追記だけ。 文脈には載せない) */
  appendHistory(doc: TaskHandoffDoc, lines: readonly string[], at = new Date()): void {
    if (lines.length === 0) return;
    const paths = this.pathsFor(doc);
    fs.mkdirSync(path.dirname(paths.history), { recursive: true });
    if (!fs.existsSync(paths.history)) {
      fs.appendFileSync(paths.history, `# 経緯ログ: ${doc.title} (${doc.id})\n`, "utf8");
    }
    fs.appendFileSync(paths.history, `\n## ${at.toISOString()}\n${lines.map((l) => `- ${l}`).join("\n")}\n`, "utf8");
  }

  /** 正本を読み戻す (/resume)。 形が違えば投げる */
  load(jsonPath: string): TaskHandoffDoc {
    const parsed: unknown = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (!isTaskHandoffDoc(parsed)) throw new Error(`タスクの引き継ぎ文書の形が違います: ${jsonPath}`);
    return parsed;
  }
}
