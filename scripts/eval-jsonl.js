#!/usr/bin/env node
/**
 * Phase 5-F: セッション JSONL からハーネス効果指標を自動集計するスクリプト。
 *
 * 入力: ~/.localllm/logs/sessions/*.jsonl  (または引数で個別ファイル/ディレクトリ指定)
 * 出力: stdout に Markdown サマリ
 *
 * 集計項目:
 *   - 基本: ターン数, 成功/失敗 tool 呼び出し, トークン (in/out), durationMs
 *   - 出力切れ: tokensOut が API 上限に張り付いた事象 (4096 / 8192 / 16384 / 32000 / 64000)
 *   - ハーネス警告挿入数: tool_result の output 中の `[システム][XXX]` マーカー出現
 *   - 失敗ツール内訳 (壁ドン候補)
 *   - 委任系 (second_llm_*, task) 連発回数
 *   - エラーカテゴリ (RATE_LIMIT / AUTH 等)
 *
 * 使い方:
 *   node scripts/eval-jsonl.js                          # ~/.localllm/logs/sessions/*.jsonl 全件
 *   node scripts/eval-jsonl.js path/to/file.jsonl       # 単一ファイル
 *   node scripts/eval-jsonl.js path/to/dir              # ディレクトリ内全 JSONL
 *   node scripts/eval-jsonl.js --since 2026-04-28       # 日時で絞込 (YYYY-MM-DD)
 *   node scripts/eval-jsonl.js --agent second-llm-agent # agentId で絞込
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// ─── 引数パース ─────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { paths: [], since: null, agent: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") opts.since = argv[++i];
    else if (a === "--agent") opts.agent = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.error(fs.readFileSync(__filename, "utf8").split("\n").slice(0, 25).join("\n"));
      process.exit(0);
    } else opts.paths.push(a);
  }
  if (opts.paths.length === 0) {
    opts.paths.push(path.join(os.homedir(), ".localllm", "logs", "sessions"));
  }
  return opts;
}

function expandToFiles(paths) {
  const files = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.error(`[skip] not found: ${p}`);
      continue;
    }
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        if (name.endsWith(".jsonl")) files.push(path.join(p, name));
      }
    } else if (p.endsWith(".jsonl")) {
      files.push(p);
    }
  }
  return files.sort();
}

function filterFiles(files, opts) {
  return files.filter((f) => {
    const base = path.basename(f);
    if (opts.since) {
      // ファイル名の冒頭が ISO 日付なので前方一致比較で OK
      if (base < opts.since) return false;
    }
    if (opts.agent) {
      if (!base.includes(opts.agent)) return false;
    }
    return true;
  });
}

// ─── 解析本体 ───────────────────────────────────────────────
const HARNESS_MARKERS = [
  "壁ドンループ警告",
  "Read→Edit契約",
  "連続委任警告",
  "経路保持原則",
  "委任先テキスト返却警告",
  "無限ループ警告",
  "進捗ゼロ警告",
  "HTML検証ヒント",
  "計画→ToDo誘導",
  "Acceptance Checklist 未消化",
];

const KNOWN_OUTPUT_LIMITS = [4096, 8192, 16384, 32000, 32768, 64000];

function analyzeFile(file) {
  const stats = {
    file: path.basename(file),
    agentId: null,
    model: null,
    turns: 0,
    requests: 0,
    responses: 0,
    toolResults: 0,
    toolSuccesses: 0,
    toolFailures: 0,
    toolNameCount: {},
    toolFailureNameCount: {},
    tokensIn: 0,
    tokensOut: 0,
    tokensOutMax: 0,
    durationMsTotal: 0,
    suspiciousMaxTokensHits: 0,        // tokensOut が API 上限に張り付いた疑い
    suspiciousMaxTokensValues: {},      // 値ごと内訳
    harnessMarkerCount: {},             // マーカーごと出現回数
    delegationCount: 0,
    delegationFailureCount: 0,
    errorCategoryCount: {},             // RATE_LIMIT / AUTH / ...
  };
  for (const m of HARNESS_MARKERS) stats.harnessMarkerCount[m] = 0;

  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.agentId && !stats.agentId) stats.agentId = rec.agentId;
    if (rec.model && !stats.model) stats.model = rec.model;

    if (rec.type === "request") {
      stats.requests++;
      // 直前の tool 呼び出しの enrichment は messages 内の role:tool に存在することが多い
      const msgs = Array.isArray(rec.messages) ? rec.messages : [];
      for (const m of msgs) {
        if (m && m.role === "tool" && typeof m.content === "string") {
          for (const marker of HARNESS_MARKERS) {
            const re = new RegExp(`\\[(?:システム)?\\]?\\[${marker}\\]|\\[${marker}\\]`);
            if (re.test(m.content)) stats.harnessMarkerCount[marker]++;
          }
        }
      }
    } else if (rec.type === "response") {
      stats.responses++;
      stats.turns = Math.max(stats.turns, rec.turn ?? 0);
      if (typeof rec.tokensIn === "number") stats.tokensIn += rec.tokensIn;
      if (typeof rec.tokensOut === "number") {
        stats.tokensOut += rec.tokensOut;
        if (rec.tokensOut > stats.tokensOutMax) stats.tokensOutMax = rec.tokensOut;
        // 出力上限張り付きの疑い検出: ぴったり既知の上限値と一致
        if (KNOWN_OUTPUT_LIMITS.includes(rec.tokensOut)) {
          stats.suspiciousMaxTokensHits++;
          stats.suspiciousMaxTokensValues[rec.tokensOut] =
            (stats.suspiciousMaxTokensValues[rec.tokensOut] ?? 0) + 1;
        }
      }
      if (typeof rec.durationMs === "number") stats.durationMsTotal += rec.durationMs;
    } else if (rec.type === "tool_result") {
      stats.toolResults++;
      const name = rec.toolName ?? "(unknown)";
      stats.toolNameCount[name] = (stats.toolNameCount[name] ?? 0) + 1;
      if (rec.success) stats.toolSuccesses++;
      else {
        stats.toolFailures++;
        stats.toolFailureNameCount[name] = (stats.toolFailureNameCount[name] ?? 0) + 1;
      }
      if (name === "second_llm_agent" || name === "second_llm_consult" || name === "task") {
        stats.delegationCount++;
        if (!rec.success) stats.delegationFailureCount++;
      }
      // 出力 (output) または error にハーネス警告マーカーが付いていれば加算
      const text = `${rec.output ?? ""}\n${rec.error ?? ""}`;
      for (const marker of HARNESS_MARKERS) {
        if (text.includes(`[${marker}]`)) stats.harnessMarkerCount[marker]++;
      }
      // セカンドLLM 失敗カテゴリ
      const m = text.match(/\[セカンドLLM失敗:([A-Z_]+)\]/);
      if (m) {
        const cat = m[1];
        stats.errorCategoryCount[cat] = (stats.errorCategoryCount[cat] ?? 0) + 1;
      }
    }
  }
  return stats;
}

// ─── 集約 + 出力 ───────────────────────────────────────────
function sumPer(field, perFile, stats) {
  let s = 0;
  for (const f of perFile) s += f[field] ?? 0;
  return s;
}

function topN(map, n = 5) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function render(perFile, totals) {
  const out = [];
  out.push(`# Phase 5 ハーネス効果集計レポート (eval-jsonl.js)`);
  out.push(`生成日時: ${new Date().toISOString()}`);
  out.push(`対象ファイル数: ${perFile.length}`);
  out.push("");

  out.push(`## 全体サマリ`);
  out.push("");
  out.push(`| 指標 | 値 |`);
  out.push(`|---|---|`);
  out.push(`| ターン総数 | ${totals.turns} |`);
  out.push(`| LLM 呼び出し (request) | ${totals.requests} |`);
  out.push(`| LLM 応答 (response) | ${totals.responses} |`);
  out.push(`| ツール実行回数 | ${totals.toolResults} |`);
  out.push(`| ツール成功 / 失敗 | ${totals.toolSuccesses} / ${totals.toolFailures} (失敗率 ${
    totals.toolResults ? ((totals.toolFailures / totals.toolResults) * 100).toFixed(1) : "0.0"
  }%) |`);
  out.push(`| 入力トークン総計 | ${totals.tokensIn.toLocaleString()} |`);
  out.push(`| 出力トークン総計 / 最大 | ${totals.tokensOut.toLocaleString()} / ${totals.tokensOutMax.toLocaleString()} |`);
  out.push(`| LLM 応答時間総計 | ${fmtDuration(totals.durationMsTotal)} |`);
  out.push(`| 委任系呼び出し / 失敗 | ${totals.delegationCount} / ${totals.delegationFailureCount} |`);
  out.push("");

  // 出力上限張り付き
  out.push(`## 出力切れ疑い (tokensOut が既知の API 上限に一致)`);
  out.push("");
  if (totals.suspiciousMaxTokensHits === 0) {
    out.push(`該当なし。`);
  } else {
    out.push(`合計 ${totals.suspiciousMaxTokensHits} 件。 内訳:`);
    out.push("");
    out.push(`| tokensOut | 件数 | 解釈 |`);
    out.push(`|---|---|---|`);
    for (const [val, cnt] of Object.entries(totals.suspiciousMaxTokensValues).sort(
      (a, b) => Number(a[0]) - Number(b[0]),
    )) {
      const interp = Number(val) <= 8192
        ? "**小さすぎる max_tokens**。 出力中途切れの強い疑い"
        : Number(val) >= 32000
        ? "API 上限張り付き。 タスクが長文だった可能性、 max_tokens 上限を確認"
        : "中間値。 設定漏れの可能性";
      out.push(`| ${val} | ${cnt} | ${interp} |`);
    }
  }
  out.push("");

  // ハーネス警告
  out.push(`## ハーネス警告挿入回数`);
  out.push("");
  out.push(`| マーカー | 件数 |`);
  out.push(`|---|---|`);
  for (const [k, v] of Object.entries(totals.harnessMarkerCount).sort((a, b) => b[1] - a[1])) {
    out.push(`| ${k} | ${v} |`);
  }
  out.push("");

  // ツール内訳
  out.push(`## ツール呼び出し内訳 (上位 10)`);
  out.push("");
  out.push(`| ツール | 呼出 | 失敗 | 失敗率 |`);
  out.push(`|---|---|---|---|`);
  for (const [name, cnt] of topN(totals.toolNameCount, 10)) {
    const fail = totals.toolFailureNameCount[name] ?? 0;
    const rate = cnt ? ((fail / cnt) * 100).toFixed(1) : "0.0";
    out.push(`| ${name} | ${cnt} | ${fail} | ${rate}% |`);
  }
  out.push("");

  // エラーカテゴリ
  if (Object.keys(totals.errorCategoryCount).length > 0) {
    out.push(`## セカンドLLM 失敗カテゴリ`);
    out.push("");
    out.push(`| カテゴリ | 件数 |`);
    out.push(`|---|---|`);
    for (const [k, v] of Object.entries(totals.errorCategoryCount).sort((a, b) => b[1] - a[1])) {
      out.push(`| ${k} | ${v} |`);
    }
    out.push("");
  }

  // ファイル別
  out.push(`## ファイル別 (上位)`);
  out.push("");
  out.push(`| ファイル | agent | model | turns | tools | 失敗率 | tokensOut max | 警告計 |`);
  out.push(`|---|---|---|---|---|---|---|---|`);
  const sorted = [...perFile].sort((a, b) => b.toolResults - a.toolResults).slice(0, 20);
  for (const s of sorted) {
    const failRate = s.toolResults ? ((s.toolFailures / s.toolResults) * 100).toFixed(0) : "0";
    const wTotal = Object.values(s.harnessMarkerCount).reduce((a, b) => a + b, 0);
    out.push(
      `| ${s.file} | ${s.agentId ?? "-"} | ${s.model ?? "-"} | ${s.turns} | ${s.toolResults} | ${failRate}% | ${s.tokensOutMax} | ${wTotal} |`,
    );
  }
  out.push("");

  return out.join("\n");
}

// ─── main ───────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv);
  const files = filterFiles(expandToFiles(opts.paths), opts);
  if (files.length === 0) {
    console.error("[error] no JSONL files matched.");
    process.exit(1);
  }

  const perFile = files.map(analyzeFile);
  const totals = {
    turns: sumPer("turns", perFile),
    requests: sumPer("requests", perFile),
    responses: sumPer("responses", perFile),
    toolResults: sumPer("toolResults", perFile),
    toolSuccesses: sumPer("toolSuccesses", perFile),
    toolFailures: sumPer("toolFailures", perFile),
    tokensIn: sumPer("tokensIn", perFile),
    tokensOut: sumPer("tokensOut", perFile),
    tokensOutMax: Math.max(0, ...perFile.map((f) => f.tokensOutMax)),
    durationMsTotal: sumPer("durationMsTotal", perFile),
    suspiciousMaxTokensHits: sumPer("suspiciousMaxTokensHits", perFile),
    delegationCount: sumPer("delegationCount", perFile),
    delegationFailureCount: sumPer("delegationFailureCount", perFile),
    suspiciousMaxTokensValues: {},
    harnessMarkerCount: Object.fromEntries(HARNESS_MARKERS.map((m) => [m, 0])),
    toolNameCount: {},
    toolFailureNameCount: {},
    errorCategoryCount: {},
  };
  for (const f of perFile) {
    for (const [k, v] of Object.entries(f.suspiciousMaxTokensValues)) {
      totals.suspiciousMaxTokensValues[k] = (totals.suspiciousMaxTokensValues[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(f.harnessMarkerCount)) {
      totals.harnessMarkerCount[k] += v;
    }
    for (const [k, v] of Object.entries(f.toolNameCount)) {
      totals.toolNameCount[k] = (totals.toolNameCount[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(f.toolFailureNameCount)) {
      totals.toolFailureNameCount[k] = (totals.toolFailureNameCount[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(f.errorCategoryCount)) {
      totals.errorCategoryCount[k] = (totals.errorCategoryCount[k] ?? 0) + v;
    }
  }
  process.stdout.write(render(perFile, totals));
}

main();
