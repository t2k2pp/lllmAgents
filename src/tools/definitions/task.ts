import chalk from "chalk";
import type { ToolDefinition } from "../../providers/base-provider.js";
import type { ToolHandler, ToolExecutionContext } from "../tool-registry.js";
import { MAX_FOLLOW_UP_CHARS, type SubAgentManager, type SubAgentType } from "../../agent/sub-agent.js";
import { ROOT_ANCESTORS } from "../../agent/delegation-context.js";
import { listResolvableSlots } from "../../config/model-resolver.js";

let subAgentManager: SubAgentManager | null = null;

export function setSubAgentManager(manager: SubAgentManager): void {
  subAgentManager = manager;
}

export function getSubAgentManager(): SubAgentManager | null {
  return subAgentManager;
}

/** system prompt / ツール定義に載せる slot の最大件数 (docs/model-orchestration.md §10)。 */
const MAX_LISTED_SLOTS = 5;

/**
 * `model` パラメータの description を registry の現在の slot 一覧から組み立てる。
 * slot は user がいつでも増減できるため、 静的文字列だと LLM が知らないままになる。
 * enum にしないのは、 ツール定義のキャッシュとズレたときに全 task 呼び出しが弾かれるため
 * (docs/model-orchestration.md §5.1)。
 */
function buildModelParamDescription(slots: ReturnType<typeof listResolvableSlots>): string {
  const listed = slots.slice(0, MAX_LISTED_SLOTS).map((s) => {
    const desc = s.description ? ` — ${s.description}` : "";
    return `${s.slot} (${s.label}${desc})`;
  });
  return (
    "このタスクを実行するモデル。 省略時はメインLLM。 " +
    `利用可能: main (現行モデル) / ${listed.join(" / ")}。 ` +
    "未割当の名前を指定した場合はメインLLM で実行し、 結果に modelNote で知らせる。"
  );
}

/** task ツールの定義を毎回組み立てる (slot 一覧が動的なため)。 */
function buildTaskDefinition(): ToolDefinition {
  const slots = listResolvableSlots();
  const properties: Record<string, unknown> = {
    subagent_type: {
      type: "string",
      enum: ["explore", "plan", "general-purpose", "bash", "code-reviewer"],
      description: "サブエージェントのタイプ",
    },
    description: {
      type: "string",
      description: "タスクの短い説明 (3-5語)",
    },
    prompt: {
      type: "string",
      description: "サブエージェントへの詳細な指示",
    },
    run_in_background: {
      type: "boolean",
      description: "バックグラウンドで実行する場合true。結果は後でtask_outputツールで取得。",
    },
    isolation: {
      type: "string",
      enum: ["shared", "worktree"],
      description:
        "filesystem境界。worktreeはlocal CLIのclean Git checkoutからdetached worktreeを作成する。作成不能時にsharedへfallbackしない。",
    },
    max_turns: {
      type: "integer",
      minimum: 1,
      maximum: 30,
      description: "この委任で許可するLLM呼出回数の上限。1〜30、省略時30。小さな調査は5〜10を推奨。",
    },
    skills: {
      type: "array",
      items: { type: "string" },
      description:
        "この委任のsystem promptへ起動時に全文を読み込むskill名。agent定義のskillsへ追加される。専門ワークフローを必須にする場合だけ指定。",
    },
  };
  // named slot が 1 つも無い環境では `model` を出さない (単一モデル運用ではノイズのため)
  if (slots.length > 0) {
    properties.model = { type: "string", description: buildModelParamDescription(slots) };
  }

  return {
    type: "function",
    function: {
      name: "task",
      description: TASK_DESCRIPTION,
      parameters: {
        type: "object",
        properties,
        required: ["subagent_type", "description", "prompt"],
      },
    },
  } as ToolDefinition;
}

const TASK_DESCRIPTION =
  "メインLLM (あなた自身) を別コンテキストで起動してサブタスクを委任する。\n" +
  "[使うべき場面] (1) メインLLM の特性 (例: 大コンテキスト・特定の専門性) が活きるタスク。 " +
  "(2) 探索系 (explore / plan agent type) で読取専用の調査をメインから分離。 " +
  "(3) second_llm_agent と並列起動して総時間短縮 (parallelCapable=true 時)。\n" +
  "[使うべきでない] (1) セカンドLLM の特性が活きるタスク → second_llm_agent を優先。 " +
  "(2) 自分で 30 秒以内にできる軽作業 → インライン処理。 " +
  "(3) 細切れの連続委任 → 修正をまとめて 1 回で渡す。\n" +
  "[よくある誤用] (a) explore / plan agent に編集タスクを渡す → 読取専用なので失敗する。 " +
  "(b) general-purpose に「ファイル一覧出して」 程度を委任 → glob で十分。 " +
  "(c) bash agent に複雑な多段タスクを丸投げ → general-purpose を選ぶ。 " +
  "(d) code-reviewer agent に新規コードを書かせる → コードレビュー専任。\n" +
  "[利用可能タイプ] explore (コード調査・読取専用) / plan (実装計画・読取専用) / " +
  "general-purpose (全ツール) / bash (コマンド実行特化) / code-reviewer (品質・セキュリティレビュー特化)。\n" +
  "[second_llm_agent との使い分け] task = メインLLM (= あなた自身) / " +
  "second_llm_agent = 別モデル。 モデル特性で選ぶ。\n" +
  "[並列起動] 独立したタスクは複数同時起動で総時間短縮可能 (run_in_background + task_output)。";

export const taskTool: ToolHandler = {
  name: "task",
  // slot 一覧が動的に増減するため、 参照のたびに組み立て直す (docs/model-orchestration.md §5.1)
  get definition(): ToolDefinition {
    return buildTaskDefinition();
  },

  async execute(params: Record<string, unknown>, context?: ToolExecutionContext) {
    if (!subAgentManager) {
      return { success: false, output: "", error: "SubAgentManager not initialized" };
    }

    const type = params.subagent_type as SubAgentType;
    const description = params.description as string;
    const prompt = params.prompt as string;
    const background = params.run_in_background as boolean | undefined;
    const modelRef = typeof params.model === "string" ? params.model : undefined;
    const maxTurns = typeof params.max_turns === "number" ? params.max_turns : undefined;
    const skills = Array.isArray(params.skills)
      ? params.skills.filter((value): value is string => typeof value === "string" && value.trim() !== "")
      : undefined;
    const isolation =
      params.isolation === "worktree" ? "worktree" : params.isolation === "shared" ? "shared" : undefined;
    // D1: 呼出元の ancestors を SubAgentManager に伝播。 SubAgent 側で {sub} が追加される
    const parentAncestors = context?.ancestors ?? ROOT_ANCESTORS;

    // どのモデルで走るかを先に確定させ、 表示と modelNote に使う。
    // (launch* 側でも同じ解決を行うが provider はキャッシュ済みなので実質ノーコスト)
    const choice = subAgentManager.resolveModelFor(type, modelRef);
    // main 以外で走るときだけ使用モデルを出す (docs/model-orchestration.md §4.3)
    const modelSuffix = choice.display ? chalk.dim(`  (model: ${choice.display})`) : "";
    console.log(chalk.dim(`\n  [Task] ${type}: ${description}`) + modelSuffix);

    if (background) {
      const agentId = subAgentManager.launchBackground(
        type,
        description,
        prompt,
        parentAncestors,
        modelRef,
        maxTurns,
        skills,
        isolation,
        context?.source ?? "cli",
      );
      const snapshot = subAgentManager.getBackgroundTask(agentId);
      return {
        success: true,
        output: JSON.stringify({
          agentId,
          status: "running",
          isolation: snapshot?.isolation ?? "shared",
          ...(snapshot?.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
          ...(snapshot?.baseCommit ? { baseCommit: snapshot.baseCommit } : {}),
          ...(snapshot?.worktreePath ? { worktreePath: snapshot.worktreePath } : {}),
          ...(snapshot?.workspaceState ? { workspaceState: snapshot.workspaceState } : {}),
          message: `サブエージェントをバックグラウンドで起動しました: ${agentId}`,
          ...(choice.note ? { modelNote: choice.note } : {}),
        }),
      };
    }

    const result = await subAgentManager.launchForeground(
      type,
      description,
      prompt,
      parentAncestors,
      modelRef,
      maxTurns,
      skills,
      isolation,
      context?.source ?? "cli",
    );

    return {
      success: result.success,
      output: JSON.stringify({
        agentId: result.agentId,
        type: result.type,
        description: result.description,
        result: result.result,
        success: result.success,
        isolation: result.isolation ?? "shared",
        ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}),
        ...(result.baseCommit ? { baseCommit: result.baseCommit } : {}),
        ...(result.worktreePath ? { worktreePath: result.worktreePath } : {}),
        ...(result.workspaceState ? { workspaceState: result.workspaceState } : {}),
        ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
        // 解決に失敗しても実行は止めず、 事実を LLM に返す (silent な差し替えをしない)
        ...(choice.note ? { modelNote: choice.note } : {}),
      }),
    };
  },
};

export const taskOutputTool: ToolHandler = {
  name: "task_output",
  definition: {
    type: "function",
    function: {
      name: "task_output",
      description: "バックグラウンドで実行中のサブエージェントの結果を取得する",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "サブエージェントのID",
          },
        },
        required: ["agent_id"],
      },
    },
  },

  async execute(params: Record<string, unknown>) {
    if (!subAgentManager) {
      return { success: false, output: "", error: "SubAgentManager not initialized" };
    }

    const agentId = params.agent_id as string;

    if (subAgentManager.isRunning(agentId)) {
      // Still running, wait for result
      console.log(chalk.dim(`  [TaskOutput] Waiting for ${agentId}...`));
    }

    const result = await subAgentManager.getResult(agentId);

    if (!result) {
      return {
        success: false,
        output: "",
        error: `Agent ${agentId} not found or already completed`,
      };
    }

    return {
      success: result.success,
      output: JSON.stringify(result),
    };
  },
};

export const taskListTool: ToolHandler = {
  name: "task_list",
  definition: {
    type: "function",
    function: {
      name: "task_list",
      description: "バックグラウンドsub-agentの実行中・完了・失敗・取消状態を一覧する",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  async execute() {
    if (!subAgentManager) {
      return { success: false, output: "", error: "SubAgentManager not initialized" };
    }

    return {
      success: true,
      output: JSON.stringify({
        tasks: subAgentManager.listBackgroundTasks(),
        recoverableWorktrees: subAgentManager.listRecoverableWorktrees(),
        ...(subAgentManager.getWorktreeCapabilityError()
          ? { worktreeCapabilityError: subAgentManager.getWorktreeCapabilityError() }
          : {}),
      }),
    };
  },
};

export const taskDiffTool: ToolHandler = {
  name: "task_diff",
  definition: {
    type: "function",
    function: {
      name: "task_diff",
      description:
        "完了・中断したworktree taskのstage/unstage/untracked/binary差分を読み取る。main checkoutは変更しない。",
      parameters: {
        type: "object",
        properties: { agent_id: { type: "string", description: "worktree taskのagent ID" } },
        required: ["agent_id"],
      },
    },
  },
  async execute(params: Record<string, unknown>) {
    if (!subAgentManager) return { success: false, output: "", error: "SubAgentManager not initialized" };
    try {
      const diff = subAgentManager.diffWorktree(params.agent_id as string);
      return { success: true, output: JSON.stringify(diff) };
    } catch (error) {
      return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  },
};

export const taskApplyTool: ToolHandler = {
  name: "task_apply",
  definition: {
    type: "function",
    function: {
      name: "task_apply",
      description:
        "完了したworktree taskの差分をcleanかつ同一baseのmain checkoutへ原子的に適用する。自動merge/commit/fallbackは行わない。",
      parameters: {
        type: "object",
        properties: { agent_id: { type: "string", description: "worktree taskのagent ID" } },
        required: ["agent_id"],
      },
    },
  },
  async execute(params: Record<string, unknown>) {
    if (!subAgentManager) return { success: false, output: "", error: "SubAgentManager not initialized" };
    try {
      return { success: true, output: JSON.stringify(subAgentManager.applyWorktree(params.agent_id as string)) };
    } catch (error) {
      return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  },
};

export const taskDiscardTool: ToolHandler = {
  name: "task_discard",
  definition: {
    type: "function",
    function: {
      name: "task_discard",
      description: "完了・中断したmanaged worktreeと未回収変更を明示的に破棄する。任意pathは指定できない。",
      parameters: {
        type: "object",
        properties: { agent_id: { type: "string", description: "worktree taskのagent ID" } },
        required: ["agent_id"],
      },
    },
  },
  async execute(params: Record<string, unknown>) {
    if (!subAgentManager) return { success: false, output: "", error: "SubAgentManager not initialized" };
    try {
      return { success: true, output: JSON.stringify(subAgentManager.discardWorktree(params.agent_id as string)) };
    } catch (error) {
      return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  },
};

export const taskSendTool: ToolHandler = {
  name: "task_send",
  definition: {
    type: "function",
    function: {
      name: "task_send",
      description:
        "実行中のバックグラウンドsub-agentへ追加指示を送る。進行中LLMは再steerし、進行中toolは完了後に方向転換する。",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "追加指示を送るサブエージェントのID",
          },
          message: {
            type: "string",
            maxLength: MAX_FOLLOW_UP_CHARS,
            description: `親orchestratorから送る追加指示（1〜${MAX_FOLLOW_UP_CHARS}文字）`,
          },
        },
        required: ["agent_id", "message"],
      },
    },
  },

  async execute(params: Record<string, unknown>) {
    if (!subAgentManager) {
      return { success: false, output: "", error: "SubAgentManager not initialized" };
    }

    const agentId = params.agent_id as string;
    const message = typeof params.message === "string" ? params.message : "";
    const result = subAgentManager.sendBackground(agentId, message);
    if (result.status !== "queued") {
      const errors: Record<Exclude<typeof result.status, "queued">, string> = {
        not_found: `Agent ${agentId} not found or already collected`,
        already_finished: `Agent ${agentId} is already finished`,
        invalid_message: "Follow-up message must not be empty",
        message_too_long: `Follow-up message exceeds ${MAX_FOLLOW_UP_CHARS} characters`,
        queue_full: "Follow-up queue is full (maximum 20 pending messages)",
        turn_limit_reached: "Agent has reached the maximum of 30 LLM turns",
      };
      return { success: false, output: "", error: errors[result.status] };
    }

    return {
      success: true,
      // 指示本文をtool resultやログへechoしない。
      output: JSON.stringify({ agentId, status: result.status, followUpCount: result.followUpCount }),
    };
  },
};

export const taskCancelTool: ToolHandler = {
  name: "task_cancel",
  definition: {
    type: "function",
    function: {
      name: "task_cancel",
      description: "実行中のバックグラウンドsub-agentを停止する",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "停止するサブエージェントのID",
          },
        },
        required: ["agent_id"],
      },
    },
  },

  async execute(params: Record<string, unknown>) {
    if (!subAgentManager) {
      return { success: false, output: "", error: "SubAgentManager not initialized" };
    }

    const agentId = params.agent_id as string;
    const status = subAgentManager.cancelBackground(agentId);
    if (status === "not_found") {
      return { success: false, output: "", error: `Agent ${agentId} not found or already collected` };
    }
    if (status === "already_finished") {
      return { success: false, output: "", error: `Agent ${agentId} is already finished` };
    }

    return {
      success: true,
      output: JSON.stringify({ agentId, status }),
    };
  },
};
