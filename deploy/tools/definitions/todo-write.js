// In-memory todo list for the session
let todos = [];
export function getTodos() {
    return [...todos];
}
export function formatTodos() {
    if (todos.length === 0)
        return "No tasks.";
    return todos
        .map((t, i) => {
        const icon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
        return `${i + 1}. ${icon} ${t.content}`;
    })
        .join("\n");
}
export const todoWriteTool = {
    name: "todo_write",
    definition: {
        type: "function",
        function: {
            name: "todo_write",
            description: "タスクリストを管理します。複雑なタスクの進捗追跡に使います。todosパラメータにタスクリスト全体を渡してください。",
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
    async execute(params) {
        const newTodos = params.todos;
        if (!Array.isArray(newTodos)) {
            return { success: false, output: "", error: "todosパラメータが配列ではありません。todos: [{content: '...', status: 'pending'}] の形式で渡してください。" };
        }
        todos = newTodos;
        return { success: true, output: formatTodos() };
    },
};
//# sourceMappingURL=todo-write.js.map