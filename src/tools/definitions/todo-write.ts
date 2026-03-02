import type { ToolHandler, ToolResult } from "../tool-registry.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// In-memory todo list for the session
let todos: TodoItem[] = [];

export function getTodos(): TodoItem[] {
  return [...todos];
}

export function formatTodos(): string {
  if (todos.length === 0) return "No tasks.";
  return todos
    .map((t, i) => {
      const icon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
      return `${i + 1}. ${icon} ${t.content}`;
    })
    .join("\n");
}

export const todoWriteTool: ToolHandler = {
  name: "todo_write",
  definition: {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "タスクリストを管理します。複雑なタスクの進捗追跡に使います。todosパラメータにタスクリスト全体を渡してください。",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "タスクリスト全体",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "タスクの説明" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
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
    const newTodos = params.todos as TodoItem[];
    todos = newTodos;
    return { success: true, output: formatTodos() };
  },
};
