/**
 * 依頼の要件展開 A/B 評価 (docs/request-elaboration-design.md §6)
 *
 * goemon 試作ログの 1 ターン目と同じ条件 (同じツール定義・同じ依頼文・同じ環境セクション) で、
 * システムプロンプトの behavioral 部分だけを差し替えて 1 回だけ LLM に投げ、 宣言と ToDo を比較する。
 *
 *   npx tsx sandbox/scripts/eval-request-elaboration.ts <baseline|current> <runLabel>
 *
 * - baseline: ログに記録された当時のシステムプロンプトをそのまま使う
 * - current : 現在の src の buildSystemPrompt(T2) の behavioral 部分 + ログの環境以降
 * 結果は sandbox/output/eval-request-elaboration/<variant>-<runLabel>.json に保存する。
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

const [variant, runLabel = "1"] = process.argv.slice(2);
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
const messages = [{ role: "system", content: system }, ...firstReq.messages.slice(1)];

const started = Date.now();
const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: firstReq.model, messages, tools: firstReq.tools, max_tokens: 16000, stream: false }),
  signal: AbortSignal.timeout(30 * 60 * 1000),
});
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const body = await res.json();
const msg = body.choices[0].message;
const calls = (msg.tool_calls ?? []).map((c: { function: { name: string; arguments: string } }) => {
  let args: unknown = c.function.arguments;
  try {
    args = JSON.parse(c.function.arguments);
  } catch {
    /* 打ち切り時は文字列のまま残す */
  }
  return { name: c.function.name, args };
});
const todo = calls.find((c: { name: string }) => c.name === "todo_append")?.args as
  | { items?: { content: string }[] }
  | undefined;
const fileWrite = calls.find((c: { name: string }) => c.name === "file_write");

const result = {
  variant,
  runLabel,
  durationSec: Math.round((Date.now() - started) / 1000),
  finishReason: body.choices[0].finish_reason,
  usage: body.usage,
  text: msg.content ?? "",
  reasoningChars: (msg.reasoning_content ?? "").length,
  todoItems: todo?.items?.map((i) => i.content) ?? [],
  toolNames: calls.map((c: { name: string }) => c.name),
  fileWriteChars: fileWrite ? JSON.stringify(fileWrite.args).length : 0,
  reasoningTail: (msg.reasoning_content ?? "").slice(-3000),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `${variant}-${runLabel}.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, reasoningTail: undefined }, null, 2));
console.log(`saved: ${outFile}`);
