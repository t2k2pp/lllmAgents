import type { AgentLoop } from "../agent/agent-loop.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import type { Config } from "../config/types.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { PlanManager } from "../agent/plan-mode.js";
export declare class REPL {
    private agent;
    private config;
    private skillRegistry?;
    private planManager?;
    private secondLLMManager?;
    private input;
    private multilineBuffer;
    private isMultiline;
    private lineNumber;
    private interactionServer;
    private loopManager;
    private agentBusy;
    constructor(agent: AgentLoop, config: Config, skillRegistry?: SkillRegistry | undefined, planManager?: PlanManager | undefined, secondLLMManager?: SecondLLMManager | undefined);
    /**
     * REPLメインループ。ユーザーが /quit するまで resolve しない。
     */
    start(): Promise<void>;
    private startInteractionServer;
    private getPromptPrefix;
    private processInput;
    private handleCommand;
}
//# sourceMappingURL=repl.d.ts.map