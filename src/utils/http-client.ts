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
 * → ストリーミング応答は1時間待つ。接続確認のみ短めに設定。
 */

/** 接続確認用（モデル一覧取得等）。サーバーが起動しているかの確認なので短くてよい */
const DEFAULT_GET_TIMEOUT = 10_000; // 10秒

/** 非ストリーミングPOST（モデル情報クエリ等）。ローカルLLM向けに余裕を持たせる */
const DEFAULT_POST_TIMEOUT = 300_000; // 5分

/** ストリーミングPOST（LLMチャット）。重いモデルに合わせ1時間 */
const DEFAULT_STREAM_TIMEOUT = 3_600_000; // 1時間

export async function httpGet<T = unknown>(
  url: string,
  timeoutMs = DEFAULT_GET_TIMEOUT,
): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = (await res.json()) as T;
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
    const data = (await res.json()) as T;
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function httpPostStream(
  url: string,
  body: unknown,
  timeoutMs = DEFAULT_STREAM_TIMEOUT,
): Promise<ReadableStream<Uint8Array>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (!res.body) {
    throw new Error("No response body for streaming");
  }
  return res.body;
}
