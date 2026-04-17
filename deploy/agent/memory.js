import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
const MEMORY_DIR = path.join(os.homedir(), ".localllm", "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
function ensureDir() {
    if (!fs.existsSync(MEMORY_DIR)) {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
}
export function loadMemory() {
    if (!fs.existsSync(MEMORY_FILE))
        return "";
    return fs.readFileSync(MEMORY_FILE, "utf-8");
}
export function saveMemory(content) {
    ensureDir();
    fs.writeFileSync(MEMORY_FILE, content, "utf-8");
}
export function appendMemory(entry) {
    ensureDir();
    const current = loadMemory();
    const updated = current ? `${current}\n\n${entry}` : entry;
    fs.writeFileSync(MEMORY_FILE, updated, "utf-8");
}
export function getMemoryDir() {
    return MEMORY_DIR;
}
export function listMemoryFiles() {
    ensureDir();
    return fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
}
export function loadMemoryFile(filename) {
    const filePath = path.join(MEMORY_DIR, filename);
    if (!fs.existsSync(filePath))
        return "";
    return fs.readFileSync(filePath, "utf-8");
}
export function saveMemoryFile(filename, content) {
    ensureDir();
    fs.writeFileSync(path.join(MEMORY_DIR, filename), content, "utf-8");
}
//# sourceMappingURL=memory.js.map