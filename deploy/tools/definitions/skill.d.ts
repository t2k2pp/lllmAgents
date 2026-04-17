import type { ToolHandler } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { PermissionManager } from "../../security/permission-manager.js";
import type { SubAgentManager } from "../../agent/sub-agent.js";
export declare function setSkillRegistry(registry: SkillRegistry): void;
export declare function setSkillPermissionManager(pm: PermissionManager): void;
export declare function setSkillSubAgentManager(manager: SubAgentManager): void;
export declare const skillTool: ToolHandler;
//# sourceMappingURL=skill.d.ts.map