export class HookManager {
    hooks = new Map();
    register(event, handler) {
        if (!this.hooks.has(event)) {
            this.hooks.set(event, []);
        }
        this.hooks.get(event).push(handler);
    }
    async emit(context) {
        const handlers = this.hooks.get(context.event) ?? [];
        for (const handler of handlers) {
            const action = await handler(context);
            if (action === "block")
                return "block";
            if (action === "warn")
                return "warn";
        }
        return "continue";
    }
    hasHooks(event) {
        return (this.hooks.get(event)?.length ?? 0) > 0;
    }
}
// Global hook manager instance
export const hookManager = new HookManager();
//# sourceMappingURL=hooks.js.map