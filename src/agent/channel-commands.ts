/**
 * チャネル(Discord/Slack)から投げられる「/コマンド」を処理する共有ロジック。
 * docs/room-model-design.md §8。
 *
 * Discord/Slack は対話 TTY を持たないため、 REPL の対話型コマンドはそのまま使えない。
 * ここでは「テキストを返す」 安全なサブセットだけを、 呼び出し元サーフェスの Room に
 * 載せ替えて実行する。 コマンドの意味は全サーフェス共通 (別物を作らない):
 *   /help /clear /context /status /todo /room
 *
 * 状態を読む/変えるコマンドは RoomManager.runInRoom で対象 Room をアクティブ化して実行する
 * (= 「今しゃべっている Room」 に対して効く)。
 */

import { buildContextBreakdown, formatContextBreakdown } from "../cli/context-breakdown.js";
import { formatTodos, clearTodos } from "../tools/definitions/todo-write.js";
import type { AgentLoop } from "./agent-loop.js";
import type { RoomManager } from "./room-manager.js";
import type { RoomId } from "./room-types.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { MCPManager } from "../mcp/mcp-manager.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function strip(s: string): string {
  return s.replace(ANSI, "");
}
function codeBlock(s: string): string {
  const t = strip(s).trim();
  return t ? "```\n" + t + "\n```" : "";
}

export interface ChannelCommandDeps {
  roomManager: RoomManager;
  agent: AgentLoop;
  /** 呼び出し元サーフェスの Room (Discord=B / Slack=C 既定)。 */
  room: RoomId;
  skillRegistry?: SkillRegistry;
  mcpManager?: MCPManager;
  /** 受信順キューの待ち件数 (status 表示用)。 */
  pending?: number;
}

const KNOWN = ["help", "clear", "context", "status", "todo", "room"];

const HELP = [
  "利用できるコマンド (先頭に `/` を付けて送信):",
  "  `/help`    — この一覧",
  "  `/clear`   — この Room の会話履歴・ToDo・Goal をクリア",
  "  `/context` — コンテキスト使用状況の内訳",
  "  `/status`  — 接続・モデル・Room・キューの状態",
  "  `/todo`    — 現在の ToDo",
  "  `/room`    — Room (A/B/C) の状態",
].join("\n");

/**
 * line が "/..." のチャネルコマンドなら処理してテキストを返す。 コマンドでなければ null
 * (= 通常のエージェント依頼として処理させる)。
 */
export async function runChannelCommand(
  line: string,
  deps: ChannelCommandDeps,
): Promise<string | null> {
  const t = line.trim();
  if (!t.startsWith("/")) return null;
  const parts = t.slice(1).trim().split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();

  if (!KNOWN.includes(cmd)) {
    return `未対応のコマンド: \`/${cmd}\`\n\n${HELP}`;
  }
  // アクティブ化不要 (Room 横断の表示系) は即返す。
  if (cmd === "help") return HELP;
  if (cmd === "room") return buildRoomText(deps);

  // 状態を読む/変えるコマンドは対象 Room に載せ替えて実行する。
  return deps.roomManager.runInRoom(deps.room, async () => {
    switch (cmd) {
      case "clear":
        deps.agent.getHistory().clear();
        deps.agent.exitGoalSeek("abort");
        clearTodos();
        return `🧹 Room ${deps.room} の会話履歴・ToDo・Goal をクリアしました。`;
      case "context": {
        const b = buildContextBreakdown(deps.agent, deps.skillRegistry, deps.mcpManager);
        return codeBlock(formatContextBreakdown(b)) || "(コンテキスト情報なし)";
      }
      case "todo": {
        const todos = codeBlock(formatTodos());
        return todos || "ToDo はありません。";
      }
      case "status":
        return buildStatusText(deps);
      default:
        return HELP;
    }
  });
}

function buildRoomText(deps: ChannelCommandDeps): string {
  const lines = ["**Rooms**"];
  for (const r of deps.roomManager.status()) {
    const marker = r.active ? "●" : "○";
    const tags = [
      r.surfaces.length ? r.surfaces.join("/") : "-",
      `autoResume=${r.autoResume ? "ON" : "OFF"}`,
      `${r.messageCount} msgs`,
    ].join(" · ");
    lines.push(`${marker} Room ${r.id}  ${tags}`);
  }
  return lines.join("\n");
}

function buildStatusText(deps: ChannelCommandDeps): string {
  const a = deps.agent;
  const room = deps.room;
  const auto = deps.roomManager.autoResumeFor(room) ? "ON" : "OFF";
  const skills = deps.skillRegistry ? deps.skillRegistry.list().length : null;
  let mcpLine = "";
  if (deps.mcpManager) {
    const servers = deps.mcpManager.getConnectedServers();
    const tools = servers.reduce((n, s) => n + s.toolCount, 0);
    mcpLine = `\nMCP: ${servers.length} servers / ${tools} tools`;
  }
  const lines = [
    "**Status**",
    `Room: ${room} (autoResume ${auto})`,
    `Model: ${a.getModel()}`,
    `Messages: ${a.getCurrentSessionMessageCount()}`,
    `Skills: ${skills ?? "-"}${mcpLine}`,
    `Queue: ${deps.pending ?? 0} 件待ち`,
  ];
  return lines.join("\n");
}
