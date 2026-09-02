import chalk from "chalk";
import type { AgentLoop } from "../../agent/agent-loop.js";
import type { RunPauseSnapshot } from "../../agent/run-api-gate.js";
import type { ReplCommandDef } from "./types.js";

type FeedbackLevel = "info" | "success" | "warn";
type Feedback = { level: FeedbackLevel; message: string };

function stateLabel(snapshot: RunPauseSnapshot): string {
  const state = {
    idle: "idle (runなし)",
    running: "running",
    pause_requested: "pause予約済み",
    paused: "paused (プロセス内・API停止中)",
  }[snapshot.state];
  return `${state} / source=${snapshot.source ?? "none"} / API実行中=${snapshot.inFlight}`;
}

export function executeRunControl(agent: AgentLoop, args: string[]): Feedback {
  const action = (args[0] ?? "status").toLowerCase();
  if (action === "status") {
    return { level: "info", message: `foreground run: ${stateLabel(agent.getRunPauseSnapshot())}` };
  }
  if (action === "pause") {
    const result = agent.requestRunPause();
    switch (result.status) {
      case "requested":
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
      case "not_running":
        return {
          level: "warn",
          message:
            "再開できるforeground runはありません。保存sessionの復元は /resume ですが、終了したrun自体は復元されません。",
        };
    }
  }
  return { level: "warn", message: "使い方: /run [status|pause|resume]" };
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
    { command: "/run resume", description: "一時停止中の同じrunを再開" },
  ],
  handler(ctx, args) {
    printRunControlFeedback(executeRunControl(ctx.agent, args));
  },
};
