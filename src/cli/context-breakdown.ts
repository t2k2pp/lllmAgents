import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import chalk from "chalk";
import type { AgentLoop } from "../agent/agent-loop.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { MCPManager } from "../mcp/mcp-manager.js";
import { estimateTokens, estimateMessageTokens } from "../agent/token-counter.js";

/**
 * Claude Code の /context に倣って、 現在の文脈消費を以下のカテゴリに分解する。
 *
 *   System prompt   : 履歴 [0] (= system message) のうち、 Memory / Skills 以外の本体
 *   Memory files    : system message 内の 「# プロジェクト指示」 + 「# メモ」 セクション
 *   Skills          : system message 内の 「# 利用可能なスキル一覧」 セクション (=動的)
 *   System tools    : tool definitions JSON (built-in + MCP)
 *   Messages        : history 中の system 以外 (user/assistant/tool)
 *   Free space      : contextWindow からの残り
 *
 * トークン値は token-counter.ts のヒューリスティックに基づく推定値。
 */
export interface ContextBreakdown {
  model: string;
  contextWindow: number;
  totalUsed: number;
  totalUsedPct: number;
  systemPrompt: {
    total: number;
    core: number; // body excluding memory/skills sections
  };
  memory: {
    total: number;
    projectInstructions: number;
    autoMemory: number;
    files: Array<{ path: string; tokens: number; existsOnDisk: boolean }>;
  };
  skills: {
    total: number; // tokens consumed inside system prompt for the skills list
    loadedCount: number;
    enabledCount: number;
    items: Array<{ name: string; trigger: string; enabled: boolean; builtIn: boolean; tokens: number }>;
  };
  tools: {
    total: number;
    builtIn: { count: number; tokens: number };
    mcp: { count: number; tokens: number; servers: Array<{ name: string; tools: number; tokens: number }> };
  };
  messages: {
    total: number;
    count: number;
  };
  freeSpace: number;
}

const SECTION_HEADERS = [
  "# プロジェクト指示",
  "# メモ",
  "# 利用可能なスキル一覧",
  "# 利用可能なLLMモデル",
  "# 環境",
  "# 行動原則",
  "# プロジェクトルール",
  "# 必ず守る",
] as const;

interface ParsedSection {
  header: string;
  body: string;
}

/**
 * system prompt を `# <header>` 行で分割する。 最初の (header の前の) 部分は header="" で返す。
 * 既知のセクションヘッダのみ境界扱いする (本文中に偶然出現する `# ...` を誤検出しないため)。
 */
function splitByKnownHeaders(text: string): ParsedSection[] {
  // 行頭に既知のヘッダがある位置を全て収集
  const lines = text.split("\n");
  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SECTION_HEADERS.some((h) => line.startsWith(h))) {
      boundaries.push(i);
    }
  }
  if (boundaries.length === 0) return [{ header: "", body: text }];
  const sections: ParsedSection[] = [];
  // 先頭からの前文 (該当ヘッダ前)
  if (boundaries[0] > 0) {
    sections.push({ header: "", body: lines.slice(0, boundaries[0]).join("\n") });
  }
  for (let bi = 0; bi < boundaries.length; bi++) {
    const start = boundaries[bi];
    const end = bi + 1 < boundaries.length ? boundaries[bi + 1] : lines.length;
    sections.push({ header: lines[start], body: lines.slice(start, end).join("\n") });
  }
  return sections;
}

function findSection(sections: ParsedSection[], prefix: string): string {
  const found = sections.find((s) => s.header.startsWith(prefix));
  return found ? found.body : "";
}

/** ~/.localllm/memory/MEMORY.md の絶対パスを返す (memory.ts と同じ規約) */
function getAutoMemoryPath(): string {
  return path.join(os.homedir(), ".localllm", "memory", "MEMORY.md");
}

/** プロジェクト指示として読み込まれうるファイル (project-context.ts と同じ順) */
const PROJECT_INSTRUCTION_FILES = [
  "CLAUDE.md",
  ".claude/instructions.md",
  "AGENTS.md",
  ".clauderc",
  "LOCALLLM.md",
  ".localllm/instructions.md",
];

function listProjectInstructionFiles(cwd: string): string[] {
  const result: string[] = [];
  for (const f of PROJECT_INSTRUCTION_FILES) {
    const p = path.join(cwd, f);
    if (fs.existsSync(p)) result.push(p);
  }
  return result;
}

function safeFileTokens(absPath: string): number {
  try {
    const content = fs.readFileSync(absPath, "utf-8");
    return estimateTokens(content);
  } catch {
    return 0;
  }
}

export function buildContextBreakdown(
  agent: AgentLoop,
  skillRegistry: SkillRegistry | undefined,
  mcpManager: MCPManager | undefined,
  cwd: string = process.cwd(),
): ContextBreakdown {
  const messages = agent.getHistory().getMessages();
  const ctxWindow = agent.getContextWindow();
  const model = agent.getModel();

  // --- system message を抽出して内訳を計算
  const systemMsg = messages[0];
  const systemContent =
    systemMsg && systemMsg.role === "system" && typeof systemMsg.content === "string"
      ? systemMsg.content
      : "";
  const systemPromptTotal = estimateTokens(systemContent);

  const sections = splitByKnownHeaders(systemContent);
  const projectSectionBody = findSection(sections, "# プロジェクト指示");
  const memorySectionBody = findSection(sections, "# メモ");
  const skillsSectionBody = findSection(sections, "# 利用可能なスキル一覧");

  const projectSectionTokens = projectSectionBody ? estimateTokens(projectSectionBody) : 0;
  const memorySectionTokens = memorySectionBody ? estimateTokens(memorySectionBody) : 0;
  const skillsSectionTokens = skillsSectionBody ? estimateTokens(skillsSectionBody) : 0;
  const systemCoreTokens = Math.max(
    0,
    systemPromptTotal - projectSectionTokens - memorySectionTokens - skillsSectionTokens,
  );

  // --- memory files (auto-memory + project instructions) のディスク上の実体
  const autoMemoryPath = getAutoMemoryPath();
  const autoMemoryExists = fs.existsSync(autoMemoryPath);
  const projectFiles = listProjectInstructionFiles(cwd);

  const memoryFiles: ContextBreakdown["memory"]["files"] = [];
  for (const p of projectFiles) {
    memoryFiles.push({ path: p, tokens: safeFileTokens(p), existsOnDisk: true });
  }
  if (autoMemoryExists) {
    memoryFiles.push({ path: autoMemoryPath, tokens: safeFileTokens(autoMemoryPath), existsOnDisk: true });
  }

  // --- skills detail (system prompt にロードされている動的一覧)
  const skillsAll = skillRegistry?.listAllWithStatus() ?? [];
  const skillsEnabled = skillsAll.filter((s) => s.enabled);
  const totalEnabledTokens = skillsEnabled.reduce(
    (acc, s) => acc + estimateTokens(`- ${s.trigger}: ${s.description}`),
    0,
  );
  const skillItems = skillsAll.map((s) => ({
    name: s.name,
    trigger: s.trigger,
    enabled: s.enabled,
    builtIn: s.builtIn,
    tokens: estimateTokens(`- ${s.trigger}: ${s.description}`),
  }));

  // skill セクションのオーバーヘッド (見出し + 前置き) を加味するため、 セクション総量を採用。
  // 個別 token は表示用の按分参考値。
  void totalEnabledTokens;

  // --- tool definitions (= API 送信時に tools フィールドへ載る分)
  const toolDefs = agent.getToolRegistry().getDefinitions();
  const builtInDefs = toolDefs.filter((d) => !d.function.name.startsWith("mcp__"));
  const mcpDefs = toolDefs.filter((d) => d.function.name.startsWith("mcp__"));
  const builtInTokens = builtInDefs.length > 0 ? estimateTokens(JSON.stringify(builtInDefs)) : 0;
  const mcpTotalTokens = mcpDefs.length > 0 ? estimateTokens(JSON.stringify(mcpDefs)) : 0;
  const toolsTotal = builtInTokens + mcpTotalTokens;

  // MCP server 別の内訳: tool 名のプレフィックス mcp__<server>__ で分類
  // mcpManager は status 検証のために将来使うかもしれないが、 内訳自体は tool name から復元できる
  void mcpManager;
  const mcpServers: Array<{ name: string; tools: number; tokens: number }> = [];
  if (mcpDefs.length > 0) {
    const grouped = new Map<string, typeof mcpDefs>();
    for (const d of mcpDefs) {
      // d.function.name = mcp__<server>__<tool>
      const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(d.function.name);
      const server = m ? m[1] : "(unknown)";
      const arr = grouped.get(server) ?? [];
      arr.push(d);
      grouped.set(server, arr);
    }
    for (const [name, defs] of grouped) {
      mcpServers.push({
        name,
        tools: defs.length,
        tokens: estimateTokens(JSON.stringify(defs)),
      });
    }
    mcpServers.sort((a, b) => b.tokens - a.tokens);
  }

  // --- messages (system 以外)
  const userMessages = messages.slice(1);
  const messagesTokens = estimateMessageTokens(userMessages);

  const totalUsed = systemPromptTotal + toolsTotal + messagesTokens;
  const totalUsedPct = ctxWindow > 0 ? (totalUsed / ctxWindow) * 100 : 0;
  const freeSpace = Math.max(0, ctxWindow - totalUsed);

  return {
    model,
    contextWindow: ctxWindow,
    totalUsed,
    totalUsedPct,
    systemPrompt: {
      total: systemPromptTotal,
      core: systemCoreTokens,
    },
    memory: {
      total: projectSectionTokens + memorySectionTokens,
      projectInstructions: projectSectionTokens,
      autoMemory: memorySectionTokens,
      files: memoryFiles,
    },
    skills: {
      total: skillsSectionTokens,
      loadedCount: skillsAll.length,
      enabledCount: skillsEnabled.length,
      items: skillItems,
    },
    tools: {
      total: toolsTotal,
      builtIn: { count: builtInDefs.length, tokens: builtInTokens },
      mcp: { count: mcpDefs.length, tokens: mcpTotalTokens, servers: mcpServers },
    },
    messages: {
      total: messagesTokens,
      count: userMessages.length,
    },
    freeSpace,
  };
}

// =============================================================================
// 表示用フォーマッタ
// =============================================================================

function formatTokens(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
  return n.toLocaleString();
}

function formatPct(part: number, whole: number): string {
  if (whole <= 0) return "0.0%";
  const pct = (part / whole) * 100;
  if (pct < 0.05) return "<0.1%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(0)}%`;
}

function progressBarLine(pct: number, width = 30): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const color = pct > 80 ? chalk.red : pct > 60 ? chalk.yellow : chalk.green;
  const overflow = pct > 100 ? chalk.red(" ⚠ over") : "";
  return `[${color("█".repeat(filled))}${chalk.dim("░".repeat(empty))}] ${pct.toFixed(1)}%${overflow}`;
}

/** 親カテゴリ行: ●ラベル ~tokens (pct) */
function categoryLine(
  bullet: string,
  bulletColor: (s: string) => string,
  label: string,
  tokens: number,
  whole: number,
): string {
  const padded = label.padEnd(18);
  const t = `~${formatTokens(tokens)} tokens`;
  const p = `(${formatPct(tokens, whole)})`;
  return `    ${bulletColor(bullet)} ${chalk.bold(padded)} ${t.padEnd(16)} ${chalk.dim(p)}`;
}

function subLine(label: string, value: string): string {
  return `      ${chalk.dim("└")} ${chalk.dim(label.padEnd(28))} ${chalk.dim(value)}`;
}

function shortenPath(p: string, cwd: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  if (p.startsWith(cwd + path.sep)) return p.slice(cwd.length + 1);
  return p;
}

/**
 * REPL の /context で出力する整形済みテキストを返す (console.log は呼び出し側に任せる)。
 */
export function formatContextBreakdown(b: ContextBreakdown, cwd: string = process.cwd()): string {
  const out: string[] = [];
  const win = b.contextWindow;
  const winLabel = win >= 1000 ? `${Math.round(win / 1000)}k` : `${win}`;

  out.push("");
  out.push(chalk.bold("  Context Usage"));
  out.push(chalk.dim(`    Model: ${b.model}`));
  out.push(
    chalk.dim(`    Used : ~${formatTokens(b.totalUsed)} / ${winLabel} tokens (${b.totalUsedPct.toFixed(1)}%)`),
  );
  out.push(`    ${progressBarLine(b.totalUsedPct)}`);
  out.push("");
  out.push(chalk.dim("    Estimated usage by category"));

  // System prompt
  out.push(categoryLine("⛁", chalk.gray, "System prompt", b.systemPrompt.total, win));
  if (b.systemPrompt.core > 0) {
    out.push(subLine("Core (rules / env / profiles)", `~${formatTokens(b.systemPrompt.core)} tokens`));
  }

  // Memory files
  out.push(categoryLine("⛁", chalk.hex("#d77757"), "Memory files", b.memory.total, win));
  if (b.memory.projectInstructions > 0) {
    out.push(subLine("Project instructions", `~${formatTokens(b.memory.projectInstructions)} tokens`));
  }
  if (b.memory.autoMemory > 0) {
    out.push(subLine("Auto-memory (MEMORY.md)", `~${formatTokens(b.memory.autoMemory)} tokens`));
  }
  for (const f of b.memory.files) {
    out.push(subLine(shortenPath(f.path, cwd), `~${formatTokens(f.tokens)} tokens (on disk)`));
  }

  // Skills
  out.push(categoryLine("⛁", chalk.hex("#ffc107"), "Skills", b.skills.total, win));
  if (b.skills.loadedCount > 0) {
    out.push(
      subLine(
        "Loaded / Enabled",
        `${b.skills.loadedCount} / ${b.skills.enabledCount} (${b.skills.items.filter((s) => s.builtIn).length} builtin)`,
      ),
    );
    // 有効 skill のうち上位 5 件をトークン降順で表示 (情報過多回避)
    const enabledItems = b.skills.items.filter((s) => s.enabled).sort((a, b) => b.tokens - a.tokens);
    const visible = enabledItems.slice(0, 5);
    for (const s of visible) {
      const tag = s.builtIn ? "[builtin]" : "[user]";
      out.push(subLine(`${s.trigger} ${tag}`, `~${formatTokens(s.tokens)} tokens`));
    }
    if (enabledItems.length > visible.length) {
      out.push(subLine(`... and ${enabledItems.length - visible.length} more`, ""));
    }
  }

  // System tools
  out.push(categoryLine("⛁", chalk.hex("#9333ea"), "System tools", b.tools.total, win));
  if (b.tools.builtIn.count > 0) {
    out.push(
      subLine(
        `Built-in tools (${b.tools.builtIn.count})`,
        `~${formatTokens(b.tools.builtIn.tokens)} tokens`,
      ),
    );
  }
  if (b.tools.mcp.count > 0) {
    out.push(
      subLine(`MCP tools (${b.tools.mcp.count})`, `~${formatTokens(b.tools.mcp.tokens)} tokens`),
    );
    for (const s of b.tools.mcp.servers) {
      out.push(subLine(`  ${s.name} (${s.tools})`, `~${formatTokens(s.tokens)} tokens`));
    }
  }

  // Messages
  out.push(categoryLine("⛁", chalk.cyan, "Messages", b.messages.total, win));
  out.push(subLine(`Count`, `${b.messages.count} (user/assistant/tool)`));

  // Free space
  out.push(categoryLine("⛶", chalk.dim, "Free space", b.freeSpace, win));

  out.push("");
  out.push(chalk.dim("    /memory  でメモ本文を確認 / /skills で有効化状態 / /mcp で MCP 状態"));
  out.push(chalk.dim("    トークン値は推定 (CJK=1, ASCII≈4字/トークン)。 圧縮は /compact"));
  out.push("");
  return out.join("\n");
}
