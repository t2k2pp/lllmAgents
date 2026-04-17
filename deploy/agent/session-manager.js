import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
const SESSION_DIR = path.join(os.homedir(), ".localllm", "sessions");
function ensureDir() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
}
function generateId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${ts}-${rand}`;
}
export function createSession(model) {
    const now = new Date().toISOString();
    return {
        meta: {
            id: generateId(),
            createdAt: now,
            updatedAt: now,
            model,
            messageCount: 0,
            title: "",
        },
        messages: [],
    };
}
export function saveSession(session) {
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
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
}
export function loadSession(id) {
    const filePath = path.join(SESSION_DIR, `${id}.json`);
    if (!fs.existsSync(filePath))
        return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}
export function listSessions(limit = 20) {
    ensureDir();
    const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
    const sessions = [];
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, file), "utf-8"));
            sessions.push(data.meta);
        }
        catch {
            // Skip corrupt files
        }
    }
    return sessions
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, limit);
}
export function getLatestSession() {
    const sessions = listSessions(1);
    if (sessions.length === 0)
        return null;
    return loadSession(sessions[0].id);
}
//# sourceMappingURL=session-manager.js.map