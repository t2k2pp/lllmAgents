/**
 * 依頼の要件展開 A/B 評価 (docs/request-elaboration-design.md §6)
 *
 * goemon 試作ログの 1 ターン目と同じ条件 (同じツール定義・同じ依頼文・同じ環境セクション) で、
 * システムプロンプトの behavioral 部分だけを差し替えて 1 回だけ LLM に投げ、 宣言と ToDo を比較する。
 *
 *   npx tsx sandbox/scripts/eval-request-elaboration.ts <baseline|current> [runLabel] [promptKey]
 *
 * promptKey: goemon (既定) / fizzbuzz (小さな依頼を膨らませないか) / janken (explore で宣言・ToDo を出さないか)
 *
 * - baseline: ログに記録された当時のシステムプロンプトをそのまま使う
 * - current : 現在の src の buildSystemPrompt(T2) の behavioral 部分 + ログの環境以降
 * 結果は sandbox/output/eval-request-elaboration/<promptKey>-<variant>-<runLabel>.json に保存する。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSystemPrompt } from "../../src/agent/system-prompt.js";

const REPO = path.resolve(import.meta.dirname, "../..");
const LOG = path.join(os.homedir(), ".localllm/logs/sessions/2026-10-14T00-14-58_main.jsonl");
const OUT_DIR = path.join(REPO, "sandbox/output/eval-request-elaboration");
const ENDPOINT = "http://192.168.1.201:9087/v1/chat/completions";
const ENV_MARK = "\n# Environment\n";

const [variant, runLabel = "1", promptKey = "goemon"] = process.argv.slice(2);
const PROMPTS: Record<string, string | undefined> = {
  goemon: undefined, // ログの依頼文をそのまま使う
  fizzbuzz: "FizzBuzz を書いて",
  janken: "じゃんけんしよう",
};
if (!(promptKey in PROMPTS)) {
  console.error(`unknown promptKey: ${promptKey}`);
  process.exit(2);
}
if (variant !== "baseline" && variant !== "current") {
  console.error("usage: eval-request-elaboration.ts <baseline|current> [runLabel]");
  process.exit(2);
}

const firstReq = JSON.parse(fs.readFileSync(LOG, "utf8").split("\n")[0]);
const loggedSystem: string = firstReq.messages[0].content;
let system = loggedSystem;
if (variant === "current") {
  const fresh = buildSystemPrompt(undefined, false, false, undefined, "T2");
  const behavioral = fresh.slice(0, fresh.indexOf(ENV_MARK));
  system = behavioral + loggedSystem.slice(loggedSystem.indexOf(ENV_MARK));
}
const rest = firstReq.messages.slice(1);
const override = PROMPTS[promptKey];
if (override) rest[rest.length - 1] = { role: "user", content: override };
const messages = [{ role: "system", content: system }, ...rest];

const started = Date.now();
// 非ストリーミングだと undici の headers timeout (300s) に掛かるため SSE で受ける
const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: firstReq.model, messages, tools: firstReq.tools, max_tokens: 16000, stream: true }),
  signal: AbortSignal.timeout(40 * 60 * 1000),
});
if (!res.ok || !res.body) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
let content = "";
let reasoning = "";
let finishReason: string | null = null;
let usage: unknown = null;
const toolAcc: { name: string; arguments: string }[] = [];
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    const ev = JSON.parse(data);
    if (ev.usage) usage = ev.usage;
    const ch = ev.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finishReason = ch.finish_reason;
    const d = ch.delta ?? {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    for (const tc of d.tool_calls ?? []) {
      const slot = (toolAcc[tc.index ?? 0] ??= { name: "", arguments: "" });
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
    }
  }
}
const calls = toolAcc.filter(Boolean).map((c) => {
  let args: unknown = c.arguments;
  try {
    args = JSON.parse(c.arguments);
  } catch {
    /* 打ち切り時は文字列のまま残す */
  }
  return { name: c.name, args };
});
const todo = calls.find((c: { name: string }) => c.name === "todo_append")?.args as
  | { items?: { content: string }[] }
  | undefined;
const fileWrite = calls.find((c: { name: string }) => c.name === "file_write");

const result = {
  variant,
  runLabel,
  durationSec: Math.round((Date.now() - started) / 1000),
  promptKey,
  finishReason,
  usage,
  text: content,
  reasoningChars: reasoning.length,
  todoItems: todo?.items?.map((i) => i.content) ?? [],
  toolNames: calls.map((c: { name: string }) => c.name),
  fileWriteChars: fileWrite ? JSON.stringify(fileWrite.args).length : 0,
  reasoningTail: reasoning.slice(-3000),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `${promptKey}-${variant}-${runLabel}.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, reasoningTail: undefined }, null, 2));
console.log(`saved: ${outFile}`);
