export interface HttpResponse<T = unknown> {
    ok: boolean;
    status: number;
    data: T;
}
export declare function httpGet<T = unknown>(url: string, timeoutMs?: number): Promise<HttpResponse<T>>;
export declare function httpPost<T = unknown>(url: string, body: unknown, timeoutMs?: number): Promise<HttpResponse<T>>;
/**
 * ストリーミングPOSTリクエスト。
 *
 * @param url - リクエストURL
 * @param body - リクエストボディ
 * @param connectTimeoutMs - 接続タイムアウト（fetch〜ヘッダー受信まで）
 * @param idleTimeoutMs - アイドルタイムアウト（チャンク間の最大無通信時間）
 * @param additionalHeaders - 追加のHTTPリクエストヘッダ
 */
export declare function httpPostStream(url: string, body: unknown, connectTimeoutMs?: number, idleTimeoutMs?: number, additionalHeaders?: Record<string, string>): Promise<ReadableStream<Uint8Array>>;
//# sourceMappingURL=http-client.d.ts.map