#!/usr/bin/env node
/**
 * Phase E-1: 自己改善ハーネス — セッションログの自動分析
 *
 * docs/multi-tier-harness-roadmap.md §4 Phase E-1 の実装。
 *
 * `~/.localllm/logs/sessions/*.jsonl` を集計し、 以下を含む Markdown レポートを
 * `~/.localllm/reports/loop-analysis-<YYYY-MM-DD>.md` に出力する:
 *
 *   - 基本 KPI (反復数中央値 / p90 / max、 セッション数、 トークン総量)
 *   - 失敗パターン頻度ランキング (toolName × error)
 *   - stuck-loop 検出件数 (同 args + 同 error が直近 10 反復内で 2 回以上)
 *   - 大反復スパン (≥40 反復) のトップリスト
 *   - 改善提案 (特定の閾値超過時)
 *
 * 使い方:
 *   node scripts/analyze-loop.mjs              # 全セッション
 *   node scripts/analyze-loop.mjs --since 2026-05-01  # 指定日以降
 *   node scripts/analyze-loop.mjs --top 30     # 上位 N 件まで表示
 *
 * Cron 自動実行例:
 *   0 9 * * MON node /path/to/scripts/analyze-loop.mjs  # 毎週月曜 9 時
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ===== 引数パース =====
const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : def;
}
const sinceArg = getArg("--since", null); // ISO date 文字列
const topN = parseInt(getArg("--top", "20"), 10);
const sinceTs = sinceArg ? new Date(sinceArg).getTime() : 0;

const LOG_DIR = path.join(os.homedir(), ".localllm", "logs", "sessions");
const REPORT_DIR = path.join(os.homedir(), ".localllm", "reports");

if (!fs.existsSync(LOG_DIR)) {
  console.error(`Log directory not found: ${LOG_DIR}`);
  process.exit(1);
}

// ===== ログ列挙 =====
const files = fs.readdirSync(LOG_DIR)
  .filter((f) => f.endsWith("_main.jsonl"))
  .map((f) => ({
    name: f,
    full: path.join(LOG_DIR, f),
    mtime: fs.statSync(path.join(LOG_DIR, f)).mtime.getTime(),
  }))
  .filter((f) => f.mtime >= sinceTs)
  .sort((a, b) => a.mtime - b.mtime);

if (files.length === 0) {
  console.error("No session logs to analyze.");
  process.exit(0);
}

// ===== 集計 =====
const FAILURE_WINDOW = 10;
const stats = {
  sessionCount: files.length,
  totalUserSpans: 0,
  spans: [], // { iterations, userMsgPreview, model, sessionFile }
  totalTokensIn: 0,
  totalTokensOut: 0,
  toolCounts: new Map(), // name → count
  failurePatterns: new Map(), // "tool:errKey" → count
  stuckLoops: [], // { signature, error, sessionFile, count }
  sessionsByModel: new Map(), // model → { sessions, totalIter, totalSpans }
};

function addToMap(map, key, inc = 1) {
  map.set(key, (map.get(key) ?? 0) + inc);
}

function normalizeError(err) {
  if (!err) return "";
  const s = String(err);
  // 末尾の path / 数字を除去して正規化 (= 同じパターンを集約)
  return s
    .replace(/\/[A-Za-z0-9._\-/]+/g, "<path>") // パス置換
    .replace(/\d+/g, "<num>") // 数字置換
    .slice(0, 120);
}

for (const f of files) {
  const lines = fs.readFileSync(f.full, "utf-8").split("\n");
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 壊れた行はスキップ
    }
  }
  if (events.length === 0) continue;

  // model 取得 (最初の request)
  const firstReq = events.find((e) => e.type === "request");
  const modelName = firstReq?.model ?? "unknown";

  // user turn の検出
  const userTurns = [];
  for (const e of events) {
    if (e.type === "request") {
      const msgs = e.messages ?? [];
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.role === "user") userTurns.push({
        turn: e.turn,
        preview: typeof lastMsg.content === "string" ? lastMsg.content.slice(0, 80) : "[non-string]",
        tokensIn: e.tokensIn ?? 0,
      });
    }
  }
  // 最終ターンを終端として加える
  const lastTurn = events.reduce((m, e) => Math.max(m, e.turn ?? 0), 0);
  userTurns.push({ turn: lastTurn + 1, preview: "(end)", tokensIn: 0 });

  // span 集計
  const spansInThisFile = [];
  for (let i = 0; i < userTurns.length - 1; i++) {
    const span = userTurns[i + 1].turn - userTurns[i].turn;
    if (span <= 0) continue;
    spansInThisFile.push({
      iterations: span,
      userMsgPreview: userTurns[i].preview,
      model: modelName,
      sessionFile: f.name,
    });
  }
  stats.totalUserSpans += spansInThisFile.length;
  stats.spans.push(...spansInThisFile);

  // tokensIn / tokensOut
  for (const e of events) {
    if (e.type === "response") {
      stats.totalTokensIn += e.tokensIn ?? 0;
      stats.totalTokensOut += e.tokensOut ?? 0;
      // tool 呼出統計
      for (const tc of e.toolCalls ?? []) {
        const n = tc.function?.name ?? "?";
        addToMap(stats.toolCounts, n);
      }
    }
    if (e.type === "tool_result" && e.success === false) {
      const tn = e.toolName ?? "?";
      const err = normalizeError(e.error ?? e.output);
      addToMap(stats.failurePatterns, `${tn}:${err}`);
    }
  }

  // stuck-loop 検出: file 内の (signature, error) を sliding window で追跡
  const recent = []; // { iteration, signature, error }
  // tool_call ID → invocation の map (tool_result とペアリング)
  const callsByTcid = new Map();
  for (const e of events) {
    if (e.type === "response") {
      for (const tc of e.toolCalls ?? []) {
        callsByTcid.set(tc.id, {
          turn: e.turn,
          name: tc.function?.name ?? "?",
          args: tc.function?.arguments ?? "",
        });
      }
    }
    if (e.type === "tool_result" && e.success === false) {
      const tcid = e.toolCallId;
      const call = callsByTcid.get(tcid);
      if (!call) continue;
      const sig = `${call.name}:${call.args.slice(0, 200)}`;
      const errKey = normalizeError(e.error ?? e.output);
      // window 外を除去
      while (recent.length > 0 && call.turn - recent[0].iteration > FAILURE_WINDOW) {
        recent.shift();
      }
      const prior = recent.filter((r) => r.signature === sig && r.error === errKey);
      if (prior.length > 0) {
        stats.stuckLoops.push({
          signature: sig.slice(0, 100),
          error: errKey,
          sessionFile: f.name,
          count: prior.length + 1,
        });
      }
      recent.push({ iteration: call.turn, signature: sig, error: errKey });
    }
  }

  // model 別集計
  if (!stats.sessionsByModel.has(modelName)) {
    stats.sessionsByModel.set(modelName, { sessions: 0, totalIter: 0, totalSpans: 0 });
  }
  const m = stats.sessionsByModel.get(modelName);
  m.sessions++;
  m.totalSpans += spansInThisFile.length;
  m.totalIter += spansInThisFile.reduce((s, x) => s + x.iterations, 0);
}

// ===== KPI 計算 =====
const allIters = stats.spans.map((s) => s.iterations).sort((a, b) => a - b);
const median = allIters[Math.floor(allIters.length / 2)] ?? 0;
const p90 = allIters[Math.floor(allIters.length * 0.9)] ?? 0;
const max = allIters[allIters.length - 1] ?? 0;
const avg = allIters.length > 0 ? Math.round(allIters.reduce((s, x) => s + x, 0) / allIters.length) : 0;
const stuckCount = stats.stuckLoops.length;
const stuckRate = stats.totalUserSpans > 0 ? (stuckCount / stats.totalUserSpans * 100).toFixed(1) : "0.0";

// 大反復スパン (≥40)
const longSpans = stats.spans
  .filter((s) => s.iterations >= 40)
  .sort((a, b) => b.iterations - a.iterations)
  .slice(0, topN);

// 失敗パターン top
const topFailures = [...stats.failurePatterns.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, topN);

// stuck-loop top (signature でグルーピング)
const stuckGrouped = new Map();
for (const sl of stats.stuckLoops) {
  const key = `${sl.signature}|${sl.error}`;
  addToMap(stuckGrouped, key);
}
const topStuck = [...stuckGrouped.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, topN)
  .map(([k, n]) => {
    const [sig, err] = k.split("|");
    return { sig, err, count: n };
  });

// ツール頻度 top
const topTools = [...stats.toolCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, topN);

// ===== 改善提案 (heuristic) =====
const suggestions = [];
if (parseFloat(stuckRate) > 5) {
  suggestions.push(
    `⚠ stuck-loop 発生率が ${stuckRate}% (目標 < 2%) です。 上位パターンの failure-guide / decision-tree を見直してください。`,
  );
}
if (p90 >= 50) {
  suggestions.push(
    `⚠ p90 反復数が ${p90} と高め (目標 < 40)。 大反復スパンの内容を確認し、 該当タスクのパターンを Phase D-2/D-3 のテーブルに追加検討。`,
  );
}
if (allIters.filter((i) => i >= 80).length > 0) {
  suggestions.push(
    `⚠ ≥80 反復のスパンが ${allIters.filter((i) => i >= 80).length} 件あります。 タスク分割か model 切替の検討を。`,
  );
}
if (topFailures.length > 0 && topFailures[0][1] >= 10) {
  suggestions.push(
    `💡 最頻失敗パターン「${topFailures[0][0]}」 が ${topFailures[0][1]} 回。 専用 failure-guide を追加すると効果的かも。`,
  );
}
if (suggestions.length === 0) {
  suggestions.push("✓ 異常な指標は検出されませんでした。 良好です。");
}

// ===== レポート生成 =====
const today = new Date().toISOString().slice(0, 10);
const reportFile = path.join(REPORT_DIR, `loop-analysis-${today}.md`);
fs.mkdirSync(REPORT_DIR, { recursive: true });

const oldestDate = files[0]?.mtime ? new Date(files[0].mtime).toISOString().slice(0, 10) : "?";
const newestDate = files[files.length - 1]?.mtime
  ? new Date(files[files.length - 1].mtime).toISOString().slice(0, 10)
  : "?";

const md = `# lllmAgents セッション分析レポート (${today})

> 自動生成: \`scripts/analyze-loop.mjs\`
>
> 集計範囲: ${oldestDate} 〜 ${newestDate}
> セッション数: ${stats.sessionCount} / 総 user span: ${stats.totalUserSpans}
> 累計トークン: in=${stats.totalTokensIn.toLocaleString()} / out=${stats.totalTokensOut.toLocaleString()}

## 1. 基本 KPI

| 指標 | 値 | 目標 |
|---|---:|:---:|
| 反復数 中央値 | ${median} | < 20 |
| 反復数 平均 | ${avg} | < 25 |
| 反復数 p90 | ${p90} | < 40 |
| 反復数 max | ${max} | < 80 |
| stuck-loop 検出 | ${stuckCount} 件 (${stuckRate}%) | < 2% |

## 2. 改善提案

${suggestions.map((s) => `- ${s}`).join("\n")}

## 3. モデル別統計

| model | sessions | spans | avg iter |
|---|---:|---:|---:|
${[...stats.sessionsByModel.entries()]
  .sort((a, b) => b[1].sessions - a[1].sessions)
  .map(([model, m]) => {
    const avgIter = m.totalSpans > 0 ? Math.round(m.totalIter / m.totalSpans) : 0;
    return `| ${model} | ${m.sessions} | ${m.totalSpans} | ${avgIter} |`;
  })
  .join("\n")}

## 4. 大反復スパン (≥40 反復) Top ${longSpans.length}

| 反復数 | model | user prompt 抜粋 | session |
|---:|---|---|---|
${longSpans.map((s) => `| ${s.iterations} | ${s.model} | ${s.userMsgPreview.replace(/\|/g, "\\|").slice(0, 60)}... | ${s.sessionFile} |`).join("\n") || "| — | — | (該当なし) | — |"}

## 5. 失敗パターン Top ${topFailures.length}

| 件数 | tool:error |
|---:|---|
${topFailures.map(([k, n]) => `| ${n} | \`${k.replace(/\|/g, "\\|").slice(0, 100)}\` |`).join("\n") || "| — | (該当なし) |"}

## 6. Stuck-loop パターン Top ${topStuck.length}

| 件数 | signature | error pattern |
|---:|---|---|
${topStuck.map((s) => `| ${s.count} | \`${s.sig.replace(/\|/g, "\\|").slice(0, 60)}\` | \`${s.err.replace(/\|/g, "\\|").slice(0, 60)}\` |`).join("\n") || "| — | (該当なし) | — |"}

## 7. ツール使用頻度 Top ${topTools.length}

| 件数 | tool |
|---:|---|
${topTools.map(([k, n]) => `| ${n} | ${k} |`).join("\n")}

---
このレポートは Phase E-1 (自己改善ハーネス) によって自動生成されました。
詳細: docs/multi-tier-harness-roadmap.md §4 Phase E-1
`;

fs.writeFileSync(reportFile, md, "utf-8");
console.log(`Report written: ${reportFile}`);
console.log(`Sessions analyzed: ${stats.sessionCount}, user spans: ${stats.totalUserSpans}, stuck-loops: ${stuckCount} (${stuckRate}%)`);
