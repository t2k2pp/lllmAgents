import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * http-client.ts のアイドルタイムアウト機能をテスト。
 *
 * 実際のHTTPリクエストは送らず、wrapWithIdleTimeout相当のロジックを
 * ReadableStreamで再現してテストする。
 */

// ReadableStreamにアイドルタイムアウトを付加するヘルパー（http-client.tsの内部関数を再現）
function wrapWithIdleTimeout(
    source: ReadableStream<Uint8Array>,
    abortController: AbortController,
    idleTimeoutMs: number,
): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            abortController.abort();
        }, idleTimeoutMs);
    };

    return new ReadableStream<Uint8Array>({
        start() {
            resetIdleTimer();
        },
        async pull(ctrl) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    if (idleTimer) clearTimeout(idleTimer);
                    ctrl.close();
                    return;
                }
                resetIdleTimer();
                ctrl.enqueue(value);
            } catch (e) {
                if (idleTimer) clearTimeout(idleTimer);
                ctrl.error(e);
            }
        },
        cancel() {
            if (idleTimer) clearTimeout(idleTimer);
            reader.cancel();
        },
    });
}

describe("wrapWithIdleTimeout", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("チャンクが定期的に来る場合はタイムアウトしない", async () => {
        const encoder = new TextEncoder();
        const chunks = [
            encoder.encode("data: chunk1\n"),
            encoder.encode("data: chunk2\n"),
            encoder.encode("data: chunk3\n"),
        ];

        let chunkIndex = 0;
        const source = new ReadableStream<Uint8Array>({
            pull(ctrl) {
                if (chunkIndex < chunks.length) {
                    ctrl.enqueue(chunks[chunkIndex++]);
                } else {
                    ctrl.close();
                }
            },
        });

        const controller = new AbortController();
        const wrapped = wrapWithIdleTimeout(source, controller, 5000);
        const reader = wrapped.getReader();

        const results: Uint8Array[] = [];

        // 各チャンクを読み取り - タイムアウトせずに完了するはず
        for (let i = 0; i < 3; i++) {
            const { done, value } = await reader.read();
            expect(done).toBe(false);
            if (value) results.push(value);
        }

        const { done } = await reader.read();
        expect(done).toBe(true);
        expect(results.length).toBe(3);
        expect(controller.signal.aborted).toBe(false);
    });

    it("アイドルタイムアウトが発動するとAbortControllerがabortされる", async () => {
        // 永久に待つストリームをシミュレート
        const source = new ReadableStream<Uint8Array>({
            pull() {
                // 意図的に何も返さない（永久待ち）
                return new Promise(() => { });
            },
        });

        const controller = new AbortController();
        const wrapped = wrapWithIdleTimeout(source, controller, 1000); // 1秒のアイドルタイムアウト
        const _reader = wrapped.getReader();

        // まだabortされていない
        expect(controller.signal.aborted).toBe(false);

        // 1秒進める → アイドルタイムアウト発動
        await vi.advanceTimersByTimeAsync(1100);

        // abortされたはず
        expect(controller.signal.aborted).toBe(true);
    });

    it("チャンク受信でタイマーがリセットされる", async () => {
        const encoder = new TextEncoder();
        let resolveNext: ((value: Uint8Array) => void) | null = null;

        const source = new ReadableStream<Uint8Array>({
            pull(ctrl) {
                return new Promise<void>((resolve) => {
                    resolveNext = (value: Uint8Array) => {
                        ctrl.enqueue(value);
                        resolve();
                    };
                });
            },
        });

        const controller = new AbortController();
        const wrapped = wrapWithIdleTimeout(source, controller, 5000);
        const reader = wrapped.getReader();

        // 読み取り開始 (非同期)
        const readPromise = reader.read();

        // 3秒進める (タイムアウトの60%、まだ発動しない)
        await vi.advanceTimersByTimeAsync(3000);
        expect(controller.signal.aborted).toBe(false);

        // チャンクを送信 → タイマーリセット
        resolveNext!(encoder.encode("data: chunk1\n"));
        const result = await readPromise;
        expect(result.done).toBe(false);

        // さらに3秒進める (リセット後なのでまだ発動しない)
        await vi.advanceTimersByTimeAsync(3000);
        expect(controller.signal.aborted).toBe(false);

        // さらに3秒進める (リセットから合計6秒 > 5秒 → 発動)
        await vi.advanceTimersByTimeAsync(3000);
        expect(controller.signal.aborted).toBe(true);
    });
});
