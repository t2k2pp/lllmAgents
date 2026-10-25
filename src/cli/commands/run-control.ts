import chalk from "chalk";
import type { AgentLoop } from "../../agent/agent-loop.js";
import type { RunPauseSnapshot } from "../../agent/run-api-gate.js";
import type { ReplCommandDef } from "./types.js";

type FeedbackLevel = "info" | "success" | "warn";
type Feedback = { level: FeedbackLevel; message: string; continuation?: Promise<void> };

function stateLabel(snapshot: RunPauseSnapshot): string {
  const state = {
    idle: "idle (runなし)",
    running: "running",
    pause_requested: "一時停止を予約済み (応答とtoolの完了待ち)",
    paused: "一時停止中 (再開地点を保存済み)",
  }[snapshot.state];
  return `${state} / source=${snapshot.source ?? "none"} / API実行中=${snapshot.inFlight}`;
}

function durableStatus(agent: AgentLoop): string {
  const current = agent.getDurableRunCheckpoint();
  if (current.status === "none") return "保存された再開地点: なし";
  if (current.status === "invalid") return `保存された再開地点: 壊れています (${current.reason})`;
  const compatibility =
    current.differences.length === 0 ? "compatible" : `blocked (${current.differences.join(" / ")})`;
  return `保存された再開地点: ${current.status} / saved=${current.checkpoint.savedAt} / boundary=${current.checkpoint.boundary} / ${compatibility}`;
}

export function executeRunControl(agent: AgentLoop, args: string[]): Feedback {
  const action = (args[0] ?? "status").toLowerCase();
  if (action === "status") {
    return {
      level: "info",
      message: `foreground run: ${stateLabel(agent.getRunPauseSnapshot())}\n  ${durableStatus(agent)}`,
    };
  }
  if (action === "pause") {
    if (args.length > 1)
      return { level: "warn", message: `不明な引数: ${args.slice(1).join(" ")}。使い方: /run pause` };
    const result = agent.requestRunPause();
    switch (result.status) {
      case "requested":
        return {
          level: "info",
          message:
            "一時停止を予約しました。進行中のLLM応答と、その応答が頼んだtoolを完了させ、次のLLM API直前で会話と再開地点を保存して止まります。「⏸ 一時停止しました」の表示後はアプリ・PCを終了できます。",
        };
      case "already_requested":
        return { level: "info", message: "一時停止は予約済みです。進行中のLLM応答とtoolの完了を待っています。" };
      case "already_paused":
        return { level: "info", message: "foreground runは既に一時停止中です。再開: /run resume" };
      case "not_cli":
        return {
          level: "warn",
          message: "現在の実行元はCLIではないため停止しません。background taskは /tasks で管理してください。",
        };
      case "not_running":
        return { level: "warn", message: "停止できるforeground runはありません。" };
      case "unavailable":
        return { level: "warn", message: `一時停止を開始できません: ${result.reason}` };
    }
  }
  if (action === "resume") {
    const result = agent.resumeRun();
    switch (result.status) {
      case "resumed":
        return { level: "success", message: "foreground runを再開しました。" };
      case "request_cancelled":
        return { level: "success", message: "pause予約を取り消し、foreground runを継続します。" };
      case "not_paused":
        return { level: "warn", message: "foreground runは停止していません。" };
      case "not_cli":
        return {
          level: "warn",
          message: "現在の実行元はCLIではありません。background taskは /tasks で管理してください。",
        };
      case "not_running": {
        const durable = agent.beginDurableRunResume();
        if (durable.status === "started") {
          return {
            level: "success",
            message: "保存された再開地点を検証し、次のLLM APIからrunを再開します。",
            continuation: durable.continuation,
          };
        }
        return {
          level: "warn",
          message:
            durable.status === "not_found"
              ? "再開できるforeground runはありません。一時停止したsessionは /resume <session-id> で先に復元してください。"
              : `一時停止したrunを再開できません: ${durable.reason}`,
        };
      }
      case "checkpoint_save_failed":
        return { level: "warn", message: `再開開始の状態を保存できないため再開しません: ${result.reason}` };
    }
  }
  if (action === "inspect") {
    const current = agent.getDurableRunCheckpoint();
    if (current.status === "none") return { level: "warn", message: "保存された再開地点はありません。" };
    if (current.status === "invalid")
      return { level: "warn", message: `保存された再開地点が壊れています: ${current.reason}` };
    return {
      level: current.differences.length === 0 && current.status === "durable_paused" ? "info" : "warn",
      message:
        `checkpoint=${current.checkpoint.checkpointId} / state=${current.status} / saved=${current.checkpoint.savedAt}\n` +
        `  session=${current.checkpoint.sessionId} / boundary=${current.checkpoint.boundary} / nextIteration=${current.checkpoint.run.nextIteration}\n` +
        `  pending: verification=${current.checkpoint.run.pendingVerification.length}, eval=${current.checkpoint.run.pendingEvalFiles.length}\n` +
        `  compatibility=${current.differences.length === 0 ? "ok" : current.differences.join(" / ")}\n` +
        "  tool引数・ユーザー入力は診断表示しません。",
    };
  }
  if (action === "discard") {
    const result = agent.discardDurableRunCheckpoint();
    if (result.status === "discarded") {
      return { level: "success", message: "再開地点だけを破棄しました。会話履歴は保持しています。" };
    }
    return { level: "warn", message: result.reason ?? "再開地点を破棄できません。" };
  }
  return { level: "warn", message: "使い方: /run [status|pause|resume|inspect|discard]" };
}

export function printRunControlFeedback(feedback: Feedback): void {
  const paint = feedback.level === "success" ? chalk.green : feedback.level === "warn" ? chalk.yellow : chalk.dim;
  console.log(paint(`  ${feedback.message}`));
}

export const runControlCommand: ReplCommandDef = {
  name: "/run",
  summary: "foreground runをLLM API境界で一時停止・再開",
  completions: [
    { command: "/run", description: "foreground runのpause状態を表示" },
    { command: "/run pause", description: "次のLLM API前で会話と再開地点を保存して一時停止 (終了しても再開可)" },
    { command: "/run resume", description: "一時停止中の同じrunを再開" },
    { command: "/run inspect", description: "保存された再開地点と互換性差分を表示" },
    { command: "/run discard", description: "会話を残して再開地点だけ破棄" },
  ],
  async handler(ctx, args) {
    const feedback = executeRunControl(ctx.agent, args);
    printRunControlFeedback(feedback);
    if (feedback.continuation) {
      if (ctx.awaitRunContinuation) await ctx.awaitRunContinuation(feedback.continuation);
      else await feedback.continuation;
    }
  },
};
