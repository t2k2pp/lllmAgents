import type { ToolHandler, ToolResult } from "../tool-registry.js";

/**
 * todo の status enum。
 * docs/strategic-todo-design.md §3.4 — `blocked` は agent が「この項目で進めない」 を
 * 自己宣言する状態。 ハーネスがヒューリスティックで判定するのではなく agent 自身が表明する。
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface TodoItem {
  /** 安定 ID。 todo_mark / todo_delete のターゲット指定に使う */
  id?: string;
  content: string;
  status: TodoStatus;
}

// In-memory todo list for the session
let todos: TodoItem[] = [];

export function getTodos(): TodoItem[] {
  return [...todos];
}

/**
 * Goal Seek mode 入口など、 外部から todo を seed する用途。
 * tool 経由 (LLM 駆動) と並列に使えるが、 上書きする点に注意。
 */
export function setTodos(newTodos: TodoItem[]): void {
  todos = [...newTodos];
}

export function clearTodos(): void {
  todos = [];
}

/** 短い安定 ID を発番。 衝突は実用上気にしない (session 内ユニーク) */
function generateTodoId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 全 todo に id を確保 (compat shim 経由で id 無しが入った場合の補完) */
function ensureIds(): void {
  for (const t of todos) {
    if (!t.id) t.id = generateTodoId();
  }
}

export function formatTodos(): string {
  if (todos.length === 0) return "No tasks.";
  ensureIds();
  return todos
    .map((t, i) => {
      const icon =
        t.status === "completed" ? "[x]"
        : t.status === "in_progress" ? "[>]"
        : t.status === "blocked" ? "[!]"
        : "[ ]";
      return `${i + 1}. ${icon} ${t.content} (id: ${t.id})`;
    })
    .join("\n");
}

/**
 * 準システムプロンプトに injection する todo セクション。
 * 全 todo を status 込みで表示。 todos 空のときは空文字を返す (section 自体を出さない)。
 * docs/strategic-todo-design.md §3.1 / §3.2 参照。
 */
export function buildTodoSection(): string {
  if (todos.length === 0) return "";
  ensureIds();
  const lines: string[] = [];
  lines.push("# 現在の ToDo (戦略)");
  lines.push("");
  lines.push("以下の項目が現在の作業計画です。 順次完了させてください。");
  lines.push("- 状態を変えるとき: `todo_mark(id, status)`");
  lines.push("- 新項目追加: `todo_append(items)`");
  lines.push("- 不要項目削除: `todo_delete(ids)`");
  lines.push("- 行き詰まったら status を `blocked` にして自己宣言してください");
  lines.push("");
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    const icon =
      t.status === "completed" ? "[x]"
      : t.status === "in_progress" ? "[>]"
      : t.status === "blocked" ? "[!]"
      : "[ ]";
    lines.push(`${i + 1}. ${icon} ${t.content} (id: ${t.id})`);
  }
  return lines.join("\n");
}

// ─── Phase 1 (案 C disciplined): 分離 tool 群 ───
// docs/strategic-todo-design.md §3.2 — append / mark / delete の 3 つに分離。
// bulk reset は意図的に提供しない (戦略破壊リスク回避、 disciplined design)。

const STATUS_ENUM = ["pending", "in_progress", "completed", "blocked"];

export const todoAppendTool: ToolHandler = {
  name: "todo_append",
  definition: {
    type: "function",
    function: {
      name: "todo_append",
      description:
        "既存の ToDo リストに項目を追加する。 思考の deliberation 結果として戦略を commit する主経路。 " +
        "リセットしたい場合は先に `todo_delete` で対象を削除してから append する (= 意図的な 2 段)。",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "追加する todo 項目の配列",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "タスクの説明 (1 文、 50 字程度)" },
                status: {
                  type: "string",
                  enum: STATUS_ENUM,
                  description: "初期状態。 通常は 'pending'。 即座に着手するなら 'in_progress'",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const items = params.items;
    if (!Array.isArray(items)) {
      return { success: false, output: "", error: "items パラメータが配列ではありません。 items: [{content, status}] の形式で渡してください。" };
    }
    const added: TodoItem[] = [];
    for (const raw of items) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const content = typeof r.content === "string" ? r.content : "";
      const status = (typeof r.status === "string" && STATUS_ENUM.includes(r.status))
        ? (r.status as TodoStatus)
        : "pending" as TodoStatus;
      if (!content) continue;
      added.push({ id: generateTodoId(), content, status });
    }
    todos.push(...added);
    return { success: true, output: `${added.length} 項目を追加しました。\n\n${formatTodos()}` };
  },
};

export const todoMarkTool: ToolHandler = {
  name: "todo_mark",
  definition: {
    type: "function",
    function: {
      name: "todo_mark",
      description:
        "既存 todo の状態だけを変更する (内容は変えない)。 " +
        "`blocked` は「この項目で進めない、 別アプローチが必要、 ask_user が要る」 を **agent 自身が表明** する用途。 " +
        "ハーネスは blocked が連続したときに方針見直しを非干渉的に確認する。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "対象 todo の id (`todo_append` 戻り値 or todo section に表示される)" },
          status: {
            type: "string",
            enum: STATUS_ENUM,
            description: "新しい状態",
          },
        },
        required: ["id", "status"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof params.id === "string" ? params.id : "";
    const status = typeof params.status === "string" ? params.status : "";
    if (!id) return { success: false, output: "", error: "id を指定してください。" };
    if (!STATUS_ENUM.includes(status)) {
      return { success: false, output: "", error: `status は ${STATUS_ENUM.join("/")} のいずれかを指定してください。` };
    }
    const target = todos.find((t) => t.id === id);
    if (!target) return { success: false, output: "", error: `id="${id}" の todo が見つかりません。 一覧: ${todos.map((t) => t.id).join(", ")}` };
    target.status = status as TodoStatus;
    return { success: true, output: `id="${id}" を ${status} に変更しました。\n\n${formatTodos()}` };
  },
};

export const todoDeleteTool: ToolHandler = {
  name: "todo_delete",
  definition: {
    type: "function",
    function: {
      name: "todo_delete",
      description:
        "指定 id の todo を削除する。 戦略の破棄や不要項目の整理に使う。 " +
        "戦略全体を作り直したい場合は **全 id を delete してから `todo_append` で新計画を書く** (= 意図的な 2 段)。 " +
        "暗黙削除 (= 書き忘れ) と区別するため、 削除は必ずこの tool 経由で明示する。",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "削除対象 todo の id 配列",
          },
        },
        required: ["ids"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const ids = params.ids;
    if (!Array.isArray(ids)) {
      return { success: false, output: "", error: "ids パラメータが配列ではありません。" };
    }
    const idSet = new Set(ids.filter((x): x is string => typeof x === "string"));
    const before = todos.length;
    todos = todos.filter((t) => !idSet.has(t.id ?? ""));
    const removed = before - todos.length;
    return { success: true, output: `${removed} 項目を削除しました。\n\n${formatTodos()}` };
  },
};

// ─── 既存 todo_write は compat shim として残す (案 C 後方互換) ───

export const todoWriteTool: ToolHandler = {
  name: "todo_write",
  definition: {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "[deprecated — 新規開発では `todo_append` / `todo_mark` / `todo_delete` を推奨] " +
        "タスクリスト全体を置換する compat shim。 内部で「全削除 → append」 と等価動作する。 " +
        "戦略の部分更新は分離 tool を使うこと (意図信号が明確になり偶発的戦略破壊を防げる)。",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "タスクリスト全体 (既存は全て置換される)",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "タスクの説明" },
                status: {
                  type: "string",
                  enum: STATUS_ENUM,
                  description: "ステータス",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const newTodos = params.todos;
    if (!Array.isArray(newTodos)) {
      return { success: false, output: "", error: "todosパラメータが配列ではありません。todos: [{content: '...', status: 'pending'}] の形式で渡してください。" };
    }
    // 全削除 + append 等価。 status は valid 値に絞る (旧呼出が "completed" 等を期待していた互換性)
    todos = [];
    for (const raw of newTodos) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const content = typeof r.content === "string" ? r.content : "";
      const status = (typeof r.status === "string" && STATUS_ENUM.includes(r.status))
        ? (r.status as TodoStatus)
        : "pending" as TodoStatus;
      if (!content) continue;
      todos.push({ id: generateTodoId(), content, status });
    }
    return { success: true, output: formatTodos() };
  },
};
