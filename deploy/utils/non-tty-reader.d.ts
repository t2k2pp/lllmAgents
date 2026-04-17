declare class NonTTYLineReader {
    private rl;
    private lineQueue;
    private waiters;
    private closed;
    /**
     * stdin から次の行を返す Promise。
     * すでに読み込み済みの行があればそれを返す。
     * なければ readline の "line" イベントを待つ。
     */
    readLine(): Promise<string>;
    /** stdin が閉じて（EOF）いるかどうか */
    isClosed(): boolean;
    private init;
}
export declare const nonTTYReader: NonTTYLineReader;
export {};
//# sourceMappingURL=non-tty-reader.d.ts.map