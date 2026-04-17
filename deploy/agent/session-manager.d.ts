import type { Message } from "../providers/base-provider.js";
export interface SessionMeta {
    id: string;
    createdAt: string;
    updatedAt: string;
    model: string;
    messageCount: number;
    title: string;
}
export interface SessionData {
    meta: SessionMeta;
    messages: Message[];
}
export declare function createSession(model: string): SessionData;
export declare function saveSession(session: SessionData): void;
export declare function loadSession(id: string): SessionData | null;
export declare function listSessions(limit?: number): SessionMeta[];
export declare function getLatestSession(): SessionData | null;
//# sourceMappingURL=session-manager.d.ts.map