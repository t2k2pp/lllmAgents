import type { Message } from "../providers/base-provider.js";
import type { SessionTerminalTranscript } from "../agent/session-manager.js";
import type { ScreenManager } from "./screen-manager.js";

export type TranscriptRestoreMode = "exact" | "legacy" | "invalid";

export interface TranscriptRestoreResult {
  mode: TranscriptRestoreMode;
  transcript: SessionTerminalTranscript;
}

function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "image_url" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** stdout未保存の旧sessionを、黙って空画面にせず会話履歴から可読形式へ再構成する。 */
export function reconstructLegacyTranscript(messages: Message[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    const body = contentText(message.content);
    if (message.role === "user") {
      lines.push(`> ${body}`);
    } else if (message.role === "assistant") {
      if (body) lines.push(body);
      for (const call of message.tool_calls ?? []) {
        lines.push(`  • ${call.function.name}`);
      }
    } else if (message.role === "tool") {
      lines.push(`  ↳ tool result${message.tool_call_id ? ` (${message.tool_call_id})` : ""}`);
      if (body) lines.push(body);
    }
    lines.push("");
  }
  return lines.length > 0 ? lines : [""];
}

export function restoreTerminalTranscript(
  screen: ScreenManager,
  saved: unknown,
  messages: Message[],
): TranscriptRestoreResult {
  if (
    saved &&
    typeof saved === "object" &&
    (saved as { version?: unknown }).version === 1 &&
    Array.isArray((saved as { lines?: unknown }).lines) &&
    (saved as { lines: unknown[] }).lines.every((line) => typeof line === "string") &&
    typeof (saved as { truncated?: unknown }).truncated === "boolean"
  ) {
    const transcript = saved as SessionTerminalTranscript;
    screen.restoreScrollback({ lines: transcript.lines, truncated: transcript.truncated });
    return { mode: "exact", transcript: structuredClone(transcript) };
  }

  const transcript: SessionTerminalTranscript = {
    version: 1,
    lines: reconstructLegacyTranscript(messages),
    truncated: false,
  };
  screen.restoreScrollback(transcript);
  return { mode: saved === undefined ? "legacy" : "invalid", transcript };
}
