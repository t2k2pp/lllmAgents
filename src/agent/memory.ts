import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const MEMORY_DIR = path.join(os.homedir(), ".localllm", "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");

function ensureDir(): void {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

export function loadMemory(): string {
  if (!fs.existsSync(MEMORY_FILE)) return "";
  return fs.readFileSync(MEMORY_FILE, "utf-8");
}

export function saveMemory(content: string): void {
  ensureDir();
  fs.writeFileSync(MEMORY_FILE, content, "utf-8");
}

export function appendMemory(entry: string): void {
  ensureDir();
  const current = loadMemory();
  const updated = current ? `${current}\n\n${entry}` : entry;
  fs.writeFileSync(MEMORY_FILE, updated, "utf-8");
}

export function getMemoryDir(): string {
  return MEMORY_DIR;
}

export function listMemoryFiles(): string[] {
  ensureDir();
  return fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
}

export function loadMemoryFile(filename: string): string {
  const filePath = path.join(MEMORY_DIR, filename);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}

export function saveMemoryFile(filename: string, content: string): void {
  ensureDir();
  fs.writeFileSync(path.join(MEMORY_DIR, filename), content, "utf-8");
}
