export class ToolRegistry {
    tools = new Map();
    register(handler) {
        this.tools.set(handler.name, handler);
    }
    get(name) {
        return this.tools.get(name);
    }
    getDefinitions() {
        return Array.from(this.tools.values()).map((t) => t.definition);
    }
    getToolNames() {
        return Array.from(this.tools.keys());
    }
}
//# sourceMappingURL=tool-registry.js.map