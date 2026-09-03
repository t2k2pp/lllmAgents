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
    pause_requested: "pause予約済み",
    paused: "paused (プロセス内・API停止中)",
  }[snapshot.state];
  return `${state} / source=${snapshot.source ?? "none"} / API実行中=${snapshot.inFlight} / pause=${snapshot.mode ?? "none"}`;
}

function durableStatus(agent: AgentLoop): string {
  const current = agent.getDurableRunCheckpoint();
  if (current.status === "none") return "durable checkpoint=none";
  if (current.status === "invalid") return `durable checkpoint=invalid (${current.reason})`;
  const compatibility =
    current.differences.length === 0 ? "compatible" : `blocked (${current.differences.join(" / ")})`;
  return `durable checkpoint=${current.status} / saved=${current.checkpoint.savedAt} / boundary=${current.checkpoint.boundary} / ${compatibility}`;
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
    const durable = args.slice(1).some((arg) => arg.toLowerCase() === "--durable");
    const invalid = args.slice(1).filter((arg) => arg.toLowerCase() !== "--durable");
    if (invalid.length > 0)
      return { level: "warn", message: `不明な引数: ${invalid.join(" ")}。使い方: /run pause [--durable]` };
    const result = agent.requestRunPause(durable ? "durable" : "process");
    switch (result.status) {
      case "requested":
        if (durable) {
          return {
            level: "info",
            message:
              "durable pause予約を受理しました。進行中APIの応答と開始済みtool結果を確定し、次のLLM API直前でatomic保存します。durable_paused表示後はアプリ・PCを停止できます。",
          };
        }
        return result.snapshot.state === "paused"
          ? { level: "success", message: "foreground runはLLM API境界で停止中です。再開: /run resume" }
          : {
              level: "info",
              message: `pause予約を受理しました。アプリは終了せず、現在のLLM API ${result.snapshot.inFlight}件の完了後に停止します。`,
            };
      case "already_requested":
        return { level: "info", message: "pauseは予約済みです。現在のLLM API完了を待っています。" };
      case "already_paused":
        return { level: "info", message: "foreground runは既に停止中です。再開: /run resume" };
      case "not_cli":
        return {
          level: "warn",
          message: "現在の実行元はCLIではないため停止しません。background taskは /tasks で管理してください。",
        };
      case "not_running":
        return { level: "warn", message: "停止できるforeground runはありません。" };
      case "durable_unavailable":
        return { level: "warn", message: `durable pauseを開始できません: ${result.reason}` };
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
            message: "durable checkpointを検証し、保存済みの次のLLM API境界からrunを再開します。",
            continuation: durable.continuation,
          };
        }
        return {
          level: "warn",
          message:
            durable.status === "not_found"
              ? "再開できるforeground runはありません。再起動後は先に /resume <session-id> でdurable checkpoint付きsessionを復元してください。"
              : `durable runを再開できません: ${durable.reason}`,
        };
      }
      case "checkpoint_save_failed":
        return { level: "warn", message: `durable resume開始状態を保存できないため再開しません: ${result.reason}` };
    }
  }
  if (action === "inspect") {
    const current = agent.getDurableRunCheckpoint();
    if (current.status === "none") return { level: "warn", message: "durable checkpointはありません。" };
    if (current.status === "invalid")
      return { level: "warn", message: `durable checkpointが壊れています: ${current.reason}` };
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
      return { level: "success", message: "durable checkpointだけを破棄しました。会話履歴は保持しています。" };
    }
    return { level: "warn", message: result.reason ?? "durable checkpointを破棄できません。" };
  }
  return { level: "warn", message: "使い方: /run [status|pause [--durable]|resume|inspect|discard]" };
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
    { command: "/run pause", description: "次のLLM API境界でrunを一時停止" },
    { command: "/run pause --durable", description: "次のLLM API前を保存し、アプリ・PC再起動後も再開" },
    { command: "/run resume", description: "一時停止中の同じrunを再開" },
    { command: "/run inspect", description: "durable checkpointと互換性差分を表示" },
    { command: "/run discard", description: "会話を残してdurable checkpointだけ破棄" },
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
