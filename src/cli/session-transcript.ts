import type { Message } from "../providers/base-provider.js";
import type { SessionTerminalTranscript } from "../agent/session-manager.js";
import { stripAnsi } from "../utils/display-width.js";
import type { ScreenManager } from "./screen-manager.js";

export type TranscriptRestoreMode = "exact" | "recovered" | "legacy" | "invalid";

export interface TranscriptRestoreResult {
  mode: TranscriptRestoreMode;
  transcript: SessionTerminalTranscript;
  recoveredMessageCount: number;
}

function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "image_url" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function contentLines(content: string): string[] {
  return content.replace(/\r\n?/g, "\n").split("\n");
}

/** stdout未保存の旧sessionを、黙って空画面にせず会話履歴から可読形式へ再構成する。 */
export function reconstructLegacyTranscript(messages: Message[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    const body = contentText(message.content);
    if (message.role === "user") {
      const [first = "", ...rest] = contentLines(body);
      lines.push(`> ${first}`, ...rest.map((line) => `  ${line}`));
    } else if (message.role === "assistant") {
      if (body) lines.push(...contentLines(body));
      for (const call of message.tool_calls ?? []) {
        lines.push(`  • ${call.function.name}`);
      }
    } else if (message.role === "tool") {
      lines.push(`  ↳ tool result${message.tool_call_id ? ` (${message.tool_call_id})` : ""}`);
      if (body) lines.push(...contentLines(body));
    }
    lines.push("");
  }
  return lines.length > 0 ? lines : [""];
}

/** Markdown描画やANSI装飾の差を除き、保存stdoutに本文が実在するかを比較する。 */
function normalizeForCoverage(text: string): string {
  return stripAnsi(text)
    .normalize("NFKC")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|+\-•]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function isCoveredByTranscript(body: string, normalizedTranscript: string): boolean {
  const normalizedBody = normalizeForCoverage(body);
  if (!normalizedBody) return true;
  if (normalizedBody.length <= 160) return normalizedTranscript.includes(normalizedBody);

  // 長文はMarkdown rendererが表やリンクを組み替える場合があるため、先頭・中央・末尾の
  // 独立したanchorがすべて存在することを完全表示の条件にする。先頭だけのpreviewは通さない。
  const anchorLength = 64;
  const starts = [0, Math.floor((normalizedBody.length - anchorLength) / 2), normalizedBody.length - anchorLength];
  return starts.every((start) => normalizedTranscript.includes(normalizedBody.slice(start, start + anchorLength)));
}

function recoverMissingDialogue(savedLines: string[], messages: Message[]): { lines: string[]; count: number } {
  const normalizedTranscript = normalizeForCoverage(savedLines.join("\n"));
  const missing: string[] = [];
  let count = 0;

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const body = contentText(message.content);
    if (!body.trim() || isCoveredByTranscript(body, normalizedTranscript)) continue;
    const bodyLines = contentLines(body);
    if (message.role === "user") {
      const [first = "", ...rest] = bodyLines;
      missing.push(`> ${first}`, ...rest.map((line) => `  ${line}`), "");
    } else {
      missing.push(...bodyLines, "");
    }
    count++;
  }

  if (count === 0) return { lines: [...savedLines], count: 0 };
  const lines = [...savedLines];
  if (lines.at(-1) !== "") lines.push("");
  lines.push("──────── /resume: 保存stdoutから欠けていた会話を復元 ────────", "", ...missing);
  return { lines, count };
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
    const savedTranscript = saved as SessionTerminalTranscript;
    const recovered = recoverMissingDialogue(savedTranscript.lines, messages);
    screen.restoreScrollback({ lines: recovered.lines, truncated: savedTranscript.truncated });
    return {
      mode: recovered.count > 0 ? "recovered" : "exact",
      transcript: { version: 1, ...screen.snapshotScrollback() },
      recoveredMessageCount: recovered.count,
    };
  }

  const transcript: SessionTerminalTranscript = {
    version: 1,
    lines: reconstructLegacyTranscript(messages),
    truncated: false,
  };
  screen.restoreScrollback(transcript);
  return {
    mode: saved === undefined ? "legacy" : "invalid",
    transcript: { version: 1, ...screen.snapshotScrollback() },
    recoveredMessageCount: 0,
  };
}
