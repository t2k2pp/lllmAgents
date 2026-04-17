import type { ToolHandler } from "../tool-registry.js";
import type { ObsidianConfig } from "../../config/types.js";
export declare function setObsidianConfig(config: ObsidianConfig | null): void;
export declare function getObsidianConfig(): ObsidianConfig | null;
/** Vault のナレッジディレクトリの絶対パスを返す */
export declare function getKnowledgeBasePath(): string | null;
export declare const knowledgeSaveTool: ToolHandler;
//# sourceMappingURL=knowledge-save.d.ts.map