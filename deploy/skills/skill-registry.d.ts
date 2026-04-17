export interface SkillDefinition {
    name: string;
    description: string;
    trigger: string;
    content: string;
    filePath: string;
    builtIn: boolean;
    /** フォークモード: "fork" の場合、独立したSubAgentコンテキストで実行 */
    context?: "fork";
    /** context:fork 時に許可するツールリスト（未指定時は全ツール） */
    tools?: string[];
}
export declare class SkillRegistry {
    private skills;
    register(skill: SkillDefinition): void;
    get(nameOrTrigger: string): SkillDefinition | undefined;
    getByPrefix(input: string): {
        skill: SkillDefinition;
        remainingArgs: string;
    } | undefined;
    list(): SkillDefinition[];
    getNames(): string[];
    getTriggers(): string[];
}
//# sourceMappingURL=skill-registry.d.ts.map