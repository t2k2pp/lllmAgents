import { Agent } from "undici";

export interface HttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

/**
 * ローカルLLM向けタイムアウト設計:
 *
 * ローカルLLMは処理に時間がかかる（大型モデルで数分〜数十分）。
 * タイムアウトで打ち切ってリトライするのは、輻輳を悪化させるだけ。
 *
 * ストリーミング応答のタイムアウト戦略:
 * 1. 接続タイムアウト: fetch()の接続〜レスポンスヘッダー受信まで（1時間）
 * 2. アイドルタイムアウト: チャンク間の無通信時間で判定（60分）
 *    → LLMが推論中でも最初のトークンが来るまで待つ
 *    → 完全なハングだけを検出する
 * 3. undici bodyTimeout: 無効化（デフォルト300秒が原因で早期切断される）
 */

/** 接続確認用（モデル一覧取得等）。サーバーが起動しているかの確認なので短くてよい */
const DEFAULT_GET_TIMEOUT = 10_000; // 10秒

/** 非ストリーミングPOST（モデル情報クエリ等）。ローカルLLM向けに余裕を持たせる */
const DEFAULT_POST_TIMEOUT = 300_000; // 5分

/** ストリーミング接続タイムアウト。fetch()〜レスポンスヘッダー受信まで */
const DEFAULT_STREAM_CONNECT_TIMEOUT = 3_600_000; // 1時間

/** ストリーム読み取りのアイドルタイムアウト。チャンク間の最大無通信時間 */
const DEFAULT_STREAM_IDLE_TIMEOUT = 3_600_000; // 60分

/**
 * undici Agentのシングルトン。bodyTimeout/headersTimeoutを無効化して
 * Node.js fetch内部の早期切断を防ぐ。
 */
const streamAgent = new Agent({
  bodyTimeout: 0,
  headersTimeout: 0,
});

export async function httpGet<T = unknown>(
  url: string,
  timeoutMs = DEFAULT_GET_TIMEOUT,
): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let data = undefined as unknown as T;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = text as unknown as T;
      }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function httpPost<T = unknown>(
  url: string,
  body: unknown,
  timeoutMs = DEFAULT_POST_TIMEOUT,
): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = undefined as unknown as T;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = text as unknown as T;
      }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ストリーミングPOSTリクエスト。
 *
 * @param url - リクエストURL
 * @param body - リクエストボディ
 * @param connectTimeoutMs - 接続タイムアウト（fetch〜ヘッダー受信まで）
 * @param idleTimeoutMs - アイドルタイムアウト（チャンク間の最大無通信時間）
 * @param additionalHeaders - 追加のHTTPリクエストヘッダ
 */
export async function httpPostStream(
  url: string,
  body: unknown,
  connectTimeoutMs = DEFAULT_STREAM_CONNECT_TIMEOUT,
  idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT,
  additionalHeaders?: Record<string, string>,
): Promise<ReadableStream<Uint8Array>> {
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
    // @ts-expect-error -- Node.js undici dispatcher option（型定義にないがランタイムで有効）
    dispatcher: streamAgent,
  });

  clearTimeout(connectTimer);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (!res.body) {
    throw new Error("No response body for streaming");
  }

  // アイドルタイムアウト付きラッパーストリームを返す
  return wrapWithIdleTimeout(res.body, controller, idleTimeoutMs);
}

/**
 * ReadableStreamにアイドルタイムアウトを付加するラッパー。
 * チャンクが来るたびにタイマーをリセットし、一定時間データが来なければ中断する。
 */
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
      // 最初のチャンクを待つ間もアイドルタイマーを動かす
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
        // データ受信 → タイマーリセット
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
