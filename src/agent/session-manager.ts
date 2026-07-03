import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileAtomic } from "../utils/atomic-file.js";
import type { Message } from "../providers/base-provider.js";
import type { TodoItem } from "../tools/definitions/todo-write.js";
import type { GoalDefinition, EvaluationRecord } from "./goal-slot.js";
import type { RoomId } from "./room-types.js";

const SESSION_DIR = path.join(os.homedir(), ".localllm", "sessions");

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

  return sessions
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);
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
