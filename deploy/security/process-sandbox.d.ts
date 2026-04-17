/**
 * OS-level process sandbox for bash tool execution.
 *
 * Claude Code と同等の仕組み:
 * - Linux: unshare(1) によるネットワーク名前空間隔離、bwrap(1) があればファイルシステム隔離も
 * - macOS: sandbox-exec(1) による sandbox-d プロファイル適用
 * - Windows: 未サポート（アプリケーションレベルの制限のみ）
 * - フォールバック: ツール非存在時は設定に警告を出して no-op
 */
export type ProcessSandboxLevel = "none" | "network" | "full";
export interface ProcessSandboxConfig {
    enabled: boolean;
    level: ProcessSandboxLevel;
    /** ネットワーク隔離でも許可するホスト（将来拡張用、現在は未使用） */
    allowedHosts?: string[];
}
export interface WrappedCommand {
    shell: string;
    args: string[];
    /** 実行後に削除すべき一時ファイル（sandbox profile等） */
    cleanup?: () => void;
}
export interface SandboxAvailability {
    platform: string;
    level: ProcessSandboxLevel;
    tools: {
        bwrap: boolean;
        unshare: boolean;
        sandboxExec: boolean;
    };
    effectiveLevel: ProcessSandboxLevel;
}
/**
 * OS-level プロセスサンドボックス。
 * bash ツールの spawn() 呼び出し前に wrapCommand() を適用することで
 * カーネルレベルの隔離を追加する。
 */
export declare class ProcessSandbox {
    private readonly config;
    private readonly plat;
    private readonly bwrap;
    private readonly unshare;
    private readonly sandboxExec;
    constructor(config: ProcessSandboxConfig);
    /** 有効化されているか、かつ利用可能なツールがあるか */
    isActive(): boolean;
    /** 設定と利用可能ツールから実際に適用されるレベルを返す */
    getEffectiveLevel(): ProcessSandboxLevel;
    /** 利用可能ツールの状態を返す（sandbox_info ツール用） */
    getAvailability(): SandboxAvailability;
    /**
     * コマンドをサンドボックスでラップした spawn 引数を返す。
     * @param command  実行するシェルコマンド文字列
     * @param allowedWriteDirs  書き込みを許可するディレクトリ（full レベルで使用）
     */
    wrapCommand(command: string, allowedWriteDirs: string[]): WrappedCommand;
    private wrapLinux;
    private wrapWithUnshare;
    private wrapWithBwrap;
    private wrapMacOS;
    /**
     * macOS sandbox-d プロファイルを生成。
     * Claude Code と同様に "deny default" から始め必要な許可を追加するホワイトリスト方式。
     */
    private buildSandboxdProfile;
}
//# sourceMappingURL=process-sandbox.d.ts.map