import type { ToolHandler } from "../tool-registry.js";
/** config 変更時にサンドボックスインスタンスをリセットする（テスト・ウィザード用） */
export declare function resetProcessSandboxCache(): void;
interface BashToolHandler extends ToolHandler {
    setStreamOutput(enabled: boolean): void;
    /** 現在実行中の子プロセスを強制終了する（Ctrl+C用） */
    killRunningProcess(): void;
}
export declare const bashTool: BashToolHandler;
export {};
//# sourceMappingURL=bash.d.ts.map