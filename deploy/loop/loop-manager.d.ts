/**
 * LoopManager - 定期実行ループの管理
 *
 * /loop コマンドで登録されたプロンプトを一定間隔で繰り返し実行する。
 */
export interface LoopEntry {
    id: string;
    prompt: string;
    intervalMs: number;
    /** 表示用の間隔文字列 (例: "5m") */
    intervalStr: string;
    timerId: ReturnType<typeof setInterval>;
    createdAt: Date;
    lastRunAt?: Date;
    runCount: number;
}
/** ループ実行時に呼び出されるコールバック */
export type LoopRunner = (prompt: string) => Promise<void>;
/**
 * アクティブなループを管理するクラス。
 * REPL インスタンスに 1 つ保持される。
 */
export declare class LoopManager {
    private loops;
    private nextId;
    /**
     * 新しいループを開始する。
     * @returns 割り当てたループ ID
     */
    start(prompt: string, intervalMs: number, intervalStr: string, runner: LoopRunner): string;
    /**
     * 指定 ID のループを停止する。
     * @returns 停止できた場合 true、ID が存在しない場合 false
     */
    stop(id: string): boolean;
    /**
     * 全ループを停止する。
     * @returns 停止したループ数
     */
    stopAll(): number;
    /** アクティブなループの一覧を返す */
    list(): LoopEntry[];
    /** アクティブなループ数 */
    get count(): number;
}
/**
 * "5m", "2h", "1d", "30s" などの間隔文字列をミリ秒に変換する。
 * @returns パース成功時は { ms, label }、失敗時は null
 */
export declare function parseInterval(str: string): {
    ms: number;
    label: string;
} | null;
/**
 * 入力文字列から間隔とプロンプトを抽出する。
 *
 * 対応フォーマット:
 *   /loop 5m <prompt>
 *   /loop <prompt> every 20m
 *   /loop <prompt>             (デフォルト 10m)
 *
 * @param argsStr - "/loop" 以降の文字列
 */
export declare function parseLoopArgs(argsStr: string): {
    intervalMs: number;
    intervalStr: string;
    prompt: string;
};
//# sourceMappingURL=loop-manager.d.ts.map