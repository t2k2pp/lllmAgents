export interface Rule {
    name: string;
    content: string;
    source: string;
}
export declare class RuleLoader {
    /** Load all rules from built-in, user-global, and project directories */
    loadAllRules(): Rule[];
    /** Format all loaded rules into a string suitable for system prompt injection */
    formatForSystemPrompt(): string;
}
//# sourceMappingURL=rule-loader.d.ts.map