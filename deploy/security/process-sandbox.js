/**
 * OS-level process sandbox for bash tool execution.
 *
 * Claude Code と同等の仕組み:
 * - Linux: unshare(1) によるネットワーク名前空間隔離、bwrap(1) があればファイルシステム隔離も
 * - macOS: sandbox-exec(1) による sandbox-d プロファイル適用
 * - Windows: 未サポート（アプリケーションレベルの制限のみ）
 * - フォールバック: ツール非存在時は設定に警告を出して no-op
 */
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
/** ツール存在チェック（複数パスを試す） */
function findTool(...paths) {
    for (const p of paths) {
        if (existsSync(p))
            return p;
    }
    return null;
}
/**
 * OS-level プロセスサンドボックス。
 * bash ツールの spawn() 呼び出し前に wrapCommand() を適用することで
 * カーネルレベルの隔離を追加する。
 */
export class ProcessSandbox {
    config;
    plat;
    bwrap;
    unshare;
    sandboxExec;
    constructor(config) {
        this.config = config;
        this.plat = platform();
        this.bwrap = findTool("/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap");
        this.unshare = findTool("/usr/bin/unshare", "/bin/unshare");
        this.sandboxExec = findTool("/usr/bin/sandbox-exec");
    }
    /** 有効化されているか、かつ利用可能なツールがあるか */
    isActive() {
        if (!this.config.enabled || this.config.level === "none")
            return false;
        return this.getEffectiveLevel() !== "none";
    }
    /** 設定と利用可能ツールから実際に適用されるレベルを返す */
    getEffectiveLevel() {
        if (!this.config.enabled || this.config.level === "none")
            return "none";
        if (this.plat === "linux") {
            if (this.config.level === "full" && this.bwrap)
                return "full";
            if (this.unshare)
                return "network";
            return "none";
        }
        if (this.plat === "darwin") {
            if (this.sandboxExec) {
                return this.config.level === "full" ? "full" : "network";
            }
            return "none";
        }
        return "none"; // Windows は未サポート
    }
    /** 利用可能ツールの状態を返す（sandbox_info ツール用） */
    getAvailability() {
        return {
            platform: this.plat,
            level: this.config.level,
            tools: {
                bwrap: !!this.bwrap,
                unshare: !!this.unshare,
                sandboxExec: !!this.sandboxExec,
            },
            effectiveLevel: this.getEffectiveLevel(),
        };
    }
    /**
     * コマンドをサンドボックスでラップした spawn 引数を返す。
     * @param command  実行するシェルコマンド文字列
     * @param allowedWriteDirs  書き込みを許可するディレクトリ（full レベルで使用）
     */
    wrapCommand(command, allowedWriteDirs) {
        const effective = this.getEffectiveLevel();
        if (effective === "none") {
            return { shell: "/bin/sh", args: ["-c", command] };
        }
        if (this.plat === "linux") {
            return this.wrapLinux(command, allowedWriteDirs, effective);
        }
        if (this.plat === "darwin") {
            return this.wrapMacOS(command, allowedWriteDirs, effective);
        }
        return { shell: "/bin/sh", args: ["-c", command] };
    }
    // ── Linux ────────────────────────────────────────────────────────────────
    wrapLinux(command, writeDirs, level) {
        if (level === "full" && this.bwrap) {
            return this.wrapWithBwrap(command, writeDirs);
        }
        // network レベル（または full でも bwrap なし）
        return this.wrapWithUnshare(command);
    }
    wrapWithUnshare(command) {
        // --net: ネットワーク名前空間の新規作成（ループバックのみ）
        // --fork: 子プロセスをフォークして実行
        return {
            shell: this.unshare,
            args: ["--net", "--fork", "--", "/bin/sh", "-c", command],
        };
    }
    wrapWithBwrap(command, writeDirs) {
        const args = [
            // Read-only bind mount of root filesystem
            "--ro-bind", "/", "/",
            // Essential virtual filesystems
            "--dev", "/dev",
            "--proc", "/proc",
            "--tmpfs", "/tmp",
            // Network isolation
            "--unshare-net",
            // New session (prevents ptrace from parent)
            "--new-session",
        ];
        // Writable bind mounts for allowed directories
        for (const dir of writeDirs) {
            if (existsSync(dir)) {
                args.push("--bind", dir, dir);
            }
        }
        args.push("--", "/bin/sh", "-c", command);
        return { shell: this.bwrap, args };
    }
    // ── macOS ────────────────────────────────────────────────────────────────
    wrapMacOS(command, writeDirs, level) {
        const profile = this.buildSandboxdProfile(writeDirs, level);
        // 一時プロファイルファイルを作成
        const profilePath = join(tmpdir(), `lllm-sandbox-${process.pid}-${Date.now()}.sb`);
        writeFileSync(profilePath, profile, "utf-8");
        return {
            shell: this.sandboxExec,
            args: ["-f", profilePath, "/bin/sh", "-c", command],
            cleanup: () => {
                try {
                    unlinkSync(profilePath);
                }
                catch { /* ignore */ }
            },
        };
    }
    /**
     * macOS sandbox-d プロファイルを生成。
     * Claude Code と同様に "deny default" から始め必要な許可を追加するホワイトリスト方式。
     */
    buildSandboxdProfile(writeDirs, level) {
        const lines = [
            "(version 1)",
            "(deny default)",
            // プロセス実行は許可（シェル、コマンドを動かすために必要）
            "(allow process*)",
            // システムコール基盤
            "(allow sysctl-read)",
            "(allow signal (target self))",
            // 読み取りは全ディレクトリで許可（write は下で制限）
            "(allow file-read*)",
            // /dev と /tmp は常に書き込み許可
            `(allow file-write* (subpath "/dev"))`,
            `(allow file-write* (subpath "/tmp"))`,
            `(allow file-write* (subpath "/private/tmp"))`,
        ];
        // 書き込み許可ディレクトリ
        for (const dir of writeDirs) {
            lines.push(`(allow file-write* (subpath "${dir}"))`);
        }
        // ネットワーク許可（network レベルは deny、full も network は deny）
        if (level !== "full" && level !== "network") {
            lines.push("(allow network*)");
        }
        // ネットワーク隔離: network / full レベルでは network を deny のまま（デフォルト deny）
        return lines.join("\n") + "\n";
    }
}
//# sourceMappingURL=process-sandbox.js.map