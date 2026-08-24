import { Agent, getGlobalDispatcher } from "undici";
import { getOpsLogger, maskHeaders } from "./ops-logger.js";

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

/** ストリーミング接続タイムアウト。fetch()〜最初のトークン受信まで。
 *  大型MoEモデル（122b等）は初回ロードに60分以上かかる場合があるため2時間に設定。 */
const DEFAULT_STREAM_CONNECT_TIMEOUT = 7_200_000; // 2時間

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

/**
 * シャットダウン時に keep-alive 接続プールを破棄する。
 *
 * undici の Agent（streamAgent）とグローバル dispatcher（httpGet/httpPost の fetch が使用）は
 * 仕様上コネクションをプールし、リクエスト完了後も keepAliveMaxTimeout（既定10分）まで
 * ソケットを開いたまま保持する。このソケットは libuv の open handle として数えられるため、
 * 閉じないと /quit 後もイベントループが枯渇せず、プロセスが終了しない（ターミナルに戻らない）。
 * プロセス終了直前にこれを呼び、プールを明示破棄してハンドルを解放する。
 */
export async function shutdownHttpClient(): Promise<void> {
  await Promise.allSettled([streamAgent.destroy(), getGlobalDispatcher().destroy()]);
}

export async function httpGet<T = unknown>(url: string, timeoutMs = DEFAULT_GET_TIMEOUT): Promise<HttpResponse<T>> {
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
  externalSignal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs);
  let detachExternalAbort = (): void => {};
  // 外部シグナル (ユーザーの Esc 中断等) を内部 controller に連動させる。
  // これが無いと中断後も接続が残り、 サーバ側 (llama.cpp 等) が生成を続けてしまう。
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      const relayAbort = (): void => controller.abort();
      externalSignal.addEventListener("abort", relayAbort, { once: true });
      detachExternalAbort = () => externalSignal.removeEventListener("abort", relayAbort);
    }
  }

  const reqHeaders = {
    "Content-Type": "application/json",
    ...additionalHeaders,
  };

  // 運用ログ TRACE: 送信ワイヤ (機密ヘッダはマスク済み body はそのまま記録 — Anthropic等は user prompt平文のため取り扱い注意)
  getOpsLogger().trace("http", "POST request", {
    url,
    headers: maskHeaders(reqHeaders),
    body,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
      // @ts-expect-error -- Node.js undici dispatcher option（型定義にないがランタイムで有効）
      dispatcher: streamAgent,
    });
  } catch (e) {
    // DNS エラーや接続拒否では fetch がタイマーより先に reject する。その場合も
    // 2時間の接続タイマーと外部 signal listener を残さない。
    detachExternalAbort();
    throw e;
  } finally {
    clearTimeout(connectTimer);
  }

  if (!res.ok) {
    try {
      const text = await res.text();
      // 運用ログ ERROR: HTTP 非200 を本文付きで記録 (4KBで切り詰め)
      getOpsLogger().error("http", `HTTP ${res.status}`, {
        url,
        status: res.status,
        statusText: res.statusText,
        bodyExcerpt: text.length > 4096 ? text.slice(0, 4096) + "...(truncated)" : text,
      });
      throw new Error(`HTTP ${res.status}: ${text}`);
    } finally {
      detachExternalAbort();
    }
  }
  if (!res.body) {
    getOpsLogger().error("http", "No response body for streaming", { url, status: res.status });
    detachExternalAbort();
    throw new Error("No response body for streaming");
  }

  // アイドルタイムアウト付きラッパーストリームを返す
  return wrapWithIdleTimeout(res.body, controller, idleTimeoutMs, detachExternalAbort);
}

/**
 * ReadableStreamにアイドルタイムアウトを付加するラッパー。
 * チャンクが来るたびにタイマーをリセットし、一定時間データが来なければ中断する。
 */
function wrapWithIdleTimeout(
  source: ReadableStream<Uint8Array>,
  abortController: AbortController,
  idleTimeoutMs: number,
  onFinalize: () => void = () => {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let finalized = false;

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    onFinalize();
  };

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
          finalize();
          ctrl.close();
          return;
        }
        // データ受信 → タイマーリセット
        resetIdleTimer();
        ctrl.enqueue(value);
      } catch (e) {
        finalize();
        ctrl.error(e);
      }
    },
    cancel() {
      finalize();
      // reader.cancel() に加えて controller も abort し、 undici に確実に接続を
      // 切断させる (サーバ側の生成停止はクライアント切断の検知に依存するため)。
      void reader.cancel().catch(() => {});
      abortController.abort();
    },
  });
}
