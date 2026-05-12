/**
 * Phase D-1: Tool-call format 正規化
 *
 * ローカル LLM (vLLM / Ollama / llama.cpp) は OpenAI 互換 function calling を
 * 完全には守らないことが多い。 特に T2/T3 では以下の生形式で返される事例が観測されている:
 *
 *   - Mistral 形式: [TOOL_CALLS] [{"name": ..., "arguments": ...}]
 *   - ChatML 形式: <tool_call>{"name": ..., "arguments": ...}</tool_call>
 *   - ReAct 形式: Action: foo\nAction Input: {"key": "value"}
 *   - Plain JSON: {"name": "foo", "arguments": {...}} ... (テキスト中に裸で)
 *   - Anthropic XML 形式: <tool_call><function=name><parameter=key>value</parameter>...</function></tool_call>
 *     (gpt-5.x reasoning モードが thinking/text に混ぜて出すパターン。 2026-05-12 観測)
 *
 * 既存の isGarbageResponse() はこれらを「ガベージ」 として捨ててしまっていた。
 * 本モジュールは fallback として上記形式を OpenAI 互換 ToolCall[] に変換する。
 *
 * docs/multi-tier-harness-roadmap.md §4 Phase D-1 参照。
 */

import type { ToolCall } from "../providers/base-provider.js";

export interface NormalizationResult {
  /** 抽出されたツール呼び出し (見つからなければ空配列) */
  toolCalls: ToolCall[];
  /** ツール呼び出し部分を取り除いたテキスト (アシスタントの "考え" 等が残る場合) */
  cleanedText: string;
  /** どの形式で抽出したか (デバッグ・ログ用) */
  format: "mistral" | "chatml" | "react" | "plain-json" | "anthropic-xml" | "none";
}

/**
 * テキスト全体に対して各形式の抽出を試みる。 最初に成功した形式の結果を返す。
 * すべて失敗したら format="none" + cleanedText=text + toolCalls=[]。
 *
 * 使う側 (AgentLoop) は tier T2/T3 + toolCalls.length === 0 のときだけ
 * これを呼ぶ。 T1 は OpenAI 互換 function calling が確実なので不要。
 */
export function normalizeToolCalls(text: string): NormalizationResult {
  if (!text || text.trim().length === 0) {
    return { toolCalls: [], cleanedText: text, format: "none" };
  }

  // 順序重要: より特異性の高いマーカーから試す
  // Anthropic XML は <tool_call><function=...> の入れ子なので ChatML より特異 → 先に試す
  const tries: Array<(t: string) => NormalizationResult | null> = [
    extractMistralToolCalls,
    extractAnthropicXmlToolCalls,
    extractChatMLToolCalls,
    extractReActAction,
    extractPlainJSONToolCall,
  ];
  for (const fn of tries) {
    const result = fn(text);
    if (result && result.toolCalls.length > 0) {
      return result;
    }
  }
  return { toolCalls: [], cleanedText: text, format: "none" };
}

/**
 * Mistral 形式: `[TOOL_CALLS] [{"name": "...", "arguments": "..."}]`
 * vLLM が OpenAI 形式変換に失敗した場合に出る (既存 isGarbageResponse の検出パターン)。
 */
function extractMistralToolCalls(text: string): NormalizationResult | null {
  // [TOOL_CALLS] の後に JSON 配列 (or 単一オブジェクト)
  const re = /\[TOOL_CALLS\]\s*(\[.+?\]|\{.+?\})/s;
  const m = text.match(re);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const toolCalls: ToolCall[] = [];
    for (const it of items) {
      const name = String(it.name ?? "");
      if (!name) continue;
      const args = it.arguments;
      const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
      toolCalls.push({
        id: generateCallId(),
        type: "function",
        function: { name, arguments: argsStr },
      });
    }
    if (toolCalls.length === 0) return null;
    const cleanedText = text.replace(re, "").trim();
    return { toolCalls, cleanedText, format: "mistral" };
  } catch {
    return null;
  }
}

/**
 * ChatML 形式: `<tool_call>{...}</tool_call>` (Hermes / Qwen / 一部の Llama fine-tune で出る)
 * 複数の tool_call が連続することもある。
 */
function extractChatMLToolCalls(text: string): NormalizationResult | null {
  const re = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return null;
  const toolCalls: ToolCall[] = [];
  for (const m of matches) {
    try {
      const obj = JSON.parse(m[1]);
      const name = String(obj.name ?? "");
      if (!name) continue;
      const args = obj.arguments;
      const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
      toolCalls.push({
        id: generateCallId(),
        type: "function",
        function: { name, arguments: argsStr },
      });
    } catch {
      continue;
    }
  }
  if (toolCalls.length === 0) return null;
  const cleanedText = text.replace(re, "").trim();
  return { toolCalls, cleanedText, format: "chatml" };
}

/**
 * Anthropic XML 形式:
 *   <tool_call>
 *     <function=NAME>
 *       <parameter=KEY>VALUE</parameter>
 *       <parameter=KEY2>VALUE2</parameter>
 *     </function>
 *   </tool_call>
 *
 * 2026-05-12 観測: Azure GPT-5.x reasoning が thinking または text にこの形式を
 * 出す事例 (= Anthropic Claude のツール呼び出し記法に引きずられている)。 native
 * function calling は別途出る場合もあるが、 出ないケースで thinking 内に残るのを救う。
 *
 * VALUE は JSON or プレーンテキスト。 JSON parse できれば object、 できなければ string。
 */
function extractAnthropicXmlToolCalls(text: string): NormalizationResult | null {
  const callRe = /<tool_call>\s*<function=([^>\s]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
  const matches = [...text.matchAll(callRe)];
  if (matches.length === 0) return null;

  const toolCalls: ToolCall[] = [];
  for (const m of matches) {
    const name = m[1].trim();
    if (!name) continue;
    const body = m[2];
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;
    for (const pm of body.matchAll(paramRe)) {
      const key = pm[1].trim();
      const rawValue = pm[2].trim();
      try {
        // JSON parse 成功なら object/array/number/etc. としてセット
        args[key] = JSON.parse(rawValue);
      } catch {
        // 失敗時はそのまま文字列
        args[key] = rawValue;
      }
    }
    toolCalls.push({
      id: generateCallId(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }

  if (toolCalls.length === 0) return null;
  const cleanedText = text.replace(callRe, "").trim();
  return { toolCalls, cleanedText, format: "anthropic-xml" };
}

/**
 * ReAct 形式: `Action: foo\nAction Input: {"key": "value"}`
 * 古い Llama / Mistral instruct で 7B クラスが出しがち。
 */
function extractReActAction(text: string): NormalizationResult | null {
  const re = /^[ \t]*Action:\s*(\w+)\s*\n[ \t]*Action Input:\s*(.+?)(?:\n\n|\n[A-Z]|$)/ms;
  const m = text.match(re);
  if (!m) return null;
  const name = m[1].trim();
  const rawArgs = m[2].trim();
  // arguments が JSON でない (= 単純な引数) ことも多い。 そのまま文字列で渡す
  let argsStr: string;
  try {
    JSON.parse(rawArgs);
    argsStr = rawArgs; // 既に valid JSON
  } catch {
    // ReAct で "filename.txt" のような non-JSON が来たら、 単一引数として包む
    // 命名規則は不明なので "input" で wrap (ツール側で拒否されればモデルが学習する)
    argsStr = JSON.stringify({ input: rawArgs });
  }
  const toolCalls: ToolCall[] = [{
    id: generateCallId(),
    type: "function",
    function: { name, arguments: argsStr },
  }];
  const cleanedText = text.replace(re, "").trim();
  return { toolCalls, cleanedText, format: "react" };
}

/**
 * Plain JSON 形式: テキストに裸で `{"name": "foo", "arguments": {...}}` が混じる。
 * 完全な JSON として valid な領域だけを抜き出す (前後にテキストがあってもよい)。
 *
 * 安全側に倒す: name フィールドが存在しない JSON は無視する (= 通常の JSON 出力と区別)。
 */
function extractPlainJSONToolCall(text: string): NormalizationResult | null {
  // 単純に最初の { から最後の } までを抜き出して試行。 nested の網羅は意図的にしない (誤検知抑制)。
  // テキスト中の最初のトップレベル JSON オブジェクト 1 つだけ抽出。
  const startIdx = text.indexOf("{");
  if (startIdx < 0) return null;
  // バランスの取れた括弧でカット
  let depth = 0;
  let endIdx = -1;
  let inStr = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx < 0) return null;
  const jsonSlice = text.slice(startIdx, endIdx + 1);
  try {
    const obj = JSON.parse(jsonSlice);
    const name = String(obj.name ?? obj.tool ?? obj.function ?? "");
    if (!name) return null;
    const args = obj.arguments ?? obj.parameters ?? obj.input ?? {};
    const argsStr = typeof args === "string" ? args : JSON.stringify(args);
    const toolCalls: ToolCall[] = [{
      id: generateCallId(),
      type: "function",
      function: { name, arguments: argsStr },
    }];
    const cleanedText = (text.slice(0, startIdx) + text.slice(endIdx + 1)).trim();
    return { toolCalls, cleanedText, format: "plain-json" };
  } catch {
    return null;
  }
}

/** OpenAI 互換 ID (call_xxxx)。 タイムスタンプ + 乱数で十分なユニーク性 */
function generateCallId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `call_${ts}${rnd}`;
}
