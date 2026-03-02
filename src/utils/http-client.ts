export interface HttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

export async function httpGet<T = unknown>(
  url: string,
  timeoutMs = 10000,
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
  timeoutMs = 30000,
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
  timeoutMs = 120000,
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
