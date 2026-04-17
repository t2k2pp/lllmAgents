import type { SecondLLMConfig } from "../config/types.js";
export declare function displayWelcome(model: string, baseUrl: string, providerType: string, contextWindow: number, skillCount: number, secondLlmConfig?: SecondLLMConfig): void;
export interface SkillSummary {
    name: string;
    description: string;
}
export declare function displayHelp(skills?: SkillSummary[]): void;
export declare function displayError(message: string): void;
export declare function displayDiff(oldText: string, newText: string, filePath: string): void;
//# sourceMappingURL=renderer.d.ts.map