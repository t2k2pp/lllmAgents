import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileAtomic } from "../utils/atomic-file.js";
import type { Message } from "../providers/base-provider.js";
import type { TodoItem } from "../tools/definitions/todo-write.js";
import type { GoalDefinition, EvaluationRecord } from "./goal-slot.js";
import type { RoomId } from "./room-types.js";

const SESSION_DIR = path.join(os.homedir(), ".localllm", "sessions");
const MAX_SESSION_TITLE_LENGTH = 80;

/** session名を一覧・terminalで安全に表示できる可視1行へ正規化する。 */
export function normalizeSessionTitle(value: string): string {
  const normalized = value
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\u200c" || character === "\u200d" ? character : " "))
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized.replace(/[\u200c\u200d]/g, "")) {
    throw new Error("session名が空です。可視文字を1文字以上指定してください。");
  }
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(normalized)]
    .slice(0, MAX_SESSION_TITLE_LENGTH)
    .map((entry) => entry.segment)
    .join("");
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
  title: string;
  /**
   * このセッションが属する Room (A/B/C)。 docs/room-model-design.md §5。
   * 後方互換: 旧セッション (Room 導入前) は undefined。
   * Room の「最後の会話」は room 一致セッションの updatedAt 最大で導出する。
   */
  room?: RoomId;
  /** /fork で分岐した元セッション。元データは変更せず、系譜だけ新セッションへ記録する。 */
  forkedFrom?: string;
}

/**
 * 圧縮対象外の in-memory slot を永続化するためのフィールド。
 * docs/todo-goal-lifecycle.md §2.3 参照。 旧 session ファイル (フィールドなし)
 * は optional のためそのまま読める (後方互換)。
 */
export interface SessionGoalSnapshot {
  definition: GoalDefinition;
  history: EvaluationRecord[];
}

export interface SessionData {
  meta: SessionMeta;
  messages: Message[];
  todos?: TodoItem[];
  goal?: SessionGoalSnapshot | null;
  /** PC再起動を跨ぐforeground run checkpoint。旧sessionとの互換性のためoptional。 */
  runCheckpoint?: unknown;
  // 注: paradigm モード (forward / goal-seek) は永続化しない。 goal-seek は必ず goal slot を
  // 伴うため、 restoreSession() が goal の有無からモードを一意に導出する (単一情報源)。
  // docs/room-model-design.md §10-3。
}

function ensureDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

export function createSession(model: string, room?: RoomId): SessionData {
  const now = new Date().toISOString();
  return {
    meta: {
      id: generateId(),
      createdAt: now,
      updatedAt: now,
      model,
      messageCount: 0,
      title: "",
      room,
    },
    messages: [],
  };
}

/**
 * 保存済み/現在のセッションから独立した会話分岐を作る。
 * messages/todos/goal はdeep copyし、以後の変更が元セッションへ伝播しない。
 */
export function forkSession(source: SessionData): SessionData {
  const fork = createSession(source.meta.model, source.meta.room);
  fork.meta.forkedFrom = source.meta.id;
  fork.meta.title = source.meta.title ? `${source.meta.title} (fork)` : "(fork)";
  fork.messages = structuredClone(source.messages);
  fork.todos = source.todos === undefined ? undefined : structuredClone(source.todos);
  fork.goal = source.goal === undefined ? undefined : structuredClone(source.goal);
  // 実行制御状態を別sessionへ複製すると、同じtool/APIを二重再開しうるためforkへは引き継がない。
  fork.meta.messageCount = fork.messages.length;
  return fork;
}

export function saveSession(session: SessionData): void {
  ensureDir();
  session.meta.updatedAt = new Date().toISOString();
  session.meta.messageCount = session.messages.length;

  // Derive title from first user message
  if (!session.meta.title) {
    const firstUser = session.messages.find((m) => m.role === "user");
    if (firstUser && typeof firstUser.content === "string") {
      session.meta.title = firstUser.content.slice(0, 80);
    }
  }

  const filePath = path.join(SESSION_DIR, `${session.meta.id}.json`);
  // 書き込み途中のプロセス死でセッションが破損しないようアトミックに書く (PR-02)
  writeFileAtomic(filePath, JSON.stringify(session, null, 2));
}

export function loadSession(id: string): SessionData | null {
  const filePath = path.join(SESSION_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    // 破損セッションは黙って無視せず告知して null を返す (呼び出し元は未存在と同じ扱い)
    console.error(`セッションファイルが壊れているため読み込めませんでした: ${filePath}`);
    return null;
  }
}

export function listSessions(limit = 20, room?: RoomId): SessionMeta[] {
  ensureDir();
  const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));

  const sessions: SessionMeta[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, file), "utf-8")) as SessionData;
      // room フィルタ: 指定時は meta.room 一致のみ (旧 room 無しセッションは除外)
      if (room !== undefined && data.meta.room !== room) continue;
      sessions.push(data.meta);
    } catch {
      // Skip corrupt files
    }
  }

  return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, limit);
}

/**
 * 指定 Room の「最後の会話」 (room 一致セッションのうち updatedAt 最大) のメタを返す。
 * 自動 Resume / 手動 Resume の対象解決に使う。 docs/room-model-design.md §5/§6。
 */
export function latestSessionMetaOfRoom(room: RoomId): SessionMeta | null {
  const list = listSessions(1, room);
  return list.length > 0 ? list[0] : null;
}

export function getLatestSession(): SessionData | null {
  const sessions = listSessions(1);
  if (sessions.length === 0) return null;
  return loadSession(sessions[0].id);
}
