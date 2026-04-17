export type ContextMode = "dev" | "review" | "research";
export declare class ContextModeManager {
    currentMode: ContextMode;
    switchMode(mode: ContextMode): void;
    getPromptSection(): string;
    getModeInfo(): {
        name: string;
        description: string;
        priority: string;
    };
}
//# sourceMappingURL=context-mode.d.ts.map