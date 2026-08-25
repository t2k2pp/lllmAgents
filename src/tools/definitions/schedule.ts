import type { ToolDefinition } from "../../providers/base-provider.js";
import { MAX_ACTIVE_SCHEDULES, type LoopManager, type LoopRunner, parseInterval } from "../../loop/loop-manager.js";
import type { ToolHandler } from "../tool-registry.js";

const MIN_DELAY_MS = 10_000;
const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PROMPT_CHARS = 4_000;

const objectDefinition = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required },
  },
});

function permanentError(error: string) {
  return { success: false, output: "", error, errorKind: "permanent" as const };
}

/**
 * REPL sessionのLoopManagerをモデルから安全に操作するtoolsを作る。
 * factoryにして、複数REPL/test間でmanagerをglobal共有しない。
 */
export function createScheduleTools(manager: LoopManager, runner: LoopRunner): [ToolHandler, ToolHandler, ToolHandler] {
  const create: ToolHandler = {
    name: "schedule_create",
    definition: objectDefinition(
      "schedule_create",
      "現在のREPL session内で、指定delay後にpromptを実行するscheduleを作成する。既定は一回限り。" +
        " recurring=trueで同じ間隔の反復になる。実行時の各toolは通常のpermission/sandboxを通る。",
      {
        prompt: {
          type: "string",
          description: "将来のturnとして実行するプロンプトまたはスラッシュコマンド (最大4000文字)",
        },
        delay: {
          type: "string",
          description: "実行までの間隔。10s、5m、2h、1d形式。10秒以上7日以下。",
        },
        recurring: {
          type: "boolean",
          description: "trueなら同じdelayで反復。falseまたは省略なら一回限り。",
        },
      },
      ["prompt", "delay"],
    ),
    async execute(params) {
      if (typeof params.prompt !== "string" || params.prompt.trim() === "") {
        return permanentError("promptには空でない文字列を指定してください。");
      }
      const prompt = params.prompt.trim();
      if (prompt.length > MAX_PROMPT_CHARS) {
        return permanentError(`promptは${MAX_PROMPT_CHARS}文字以下にしてください。`);
      }
      if (typeof params.delay !== "string") {
        return permanentError("delayは10s、5m、2h、1d形式で指定してください。");
      }
      const parsed = parseInterval(params.delay.trim());
      if (!parsed) {
        return permanentError("delayは10s、5m、2h、1d形式で指定してください。");
      }
      if (parsed.ms < MIN_DELAY_MS) {
        return permanentError("delayは10秒以上にしてください。");
      }
      if (parsed.ms > MAX_DELAY_MS) {
        return permanentError("delayは7日以下にしてください。");
      }
      if (params.recurring !== undefined && typeof params.recurring !== "boolean") {
        return permanentError("recurringはbooleanで指定してください。");
      }
      if (manager.count >= MAX_ACTIVE_SCHEDULES) {
        return permanentError(
          `アクティブなscheduleは最大${MAX_ACTIVE_SCHEDULES}件です。schedule_deleteで不要な項目を削除してください。`,
        );
      }

      const recurring = params.recurring === true;
      const id = manager.start(prompt, parsed.ms, parsed.label, runner, { recurring });
      const entry = manager.list().find((candidate) => candidate.id === id);
      return {
        success: true,
        output: JSON.stringify({
          id,
          status: "scheduled",
          prompt,
          delay: parsed.label,
          recurring,
          nextRunAt: entry?.nextRunAt.toISOString(),
        }),
      };
    },
  };

  const list: ToolHandler = {
    name: "schedule_list",
    definition: objectDefinition(
      "schedule_list",
      "現在のREPL sessionでactiveなscheduleを一覧する。実行回数、skip、失敗診断も返す。",
      {},
    ),
    async execute() {
      const schedules = manager.list().map((entry) => ({
        id: entry.id,
        prompt: entry.prompt,
        delay: entry.intervalStr,
        recurring: entry.recurring,
        createdAt: entry.createdAt.toISOString(),
        nextRunAt: entry.nextRunAt.toISOString(),
        lastRunAt: entry.lastRunAt?.toISOString(),
        runCount: entry.runCount,
        skippedRuns: entry.skippedRuns,
        failureCount: entry.failureCount,
        ...(entry.lastError ? { lastError: entry.lastError } : {}),
      }));
      return { success: true, output: JSON.stringify({ count: schedules.length, schedules }) };
    },
  };

  const remove: ToolHandler = {
    name: "schedule_delete",
    definition: objectDefinition(
      "schedule_delete",
      "現在のREPL sessionからscheduleを取消する。idを指定するか、all=trueで全件を取消する。",
      {
        id: { type: "string", description: "取消するschedule ID" },
        all: { type: "boolean", description: "trueなら全scheduleを取消する" },
      },
    ),
    async execute(params) {
      if (params.all === true) {
        const deleted = manager.stopAll();
        return { success: true, output: JSON.stringify({ deleted, remaining: manager.count }) };
      }
      if (typeof params.id !== "string" || params.id.trim() === "") {
        return permanentError("idを指定するかall=trueを指定してください。");
      }
      const id = params.id.trim();
      if (!manager.stop(id)) {
        return permanentError(`schedule ${id} は存在しません。`);
      }
      return { success: true, output: JSON.stringify({ deleted: 1, id, remaining: manager.count }) };
    },
  };

  return [create, list, remove];
}
