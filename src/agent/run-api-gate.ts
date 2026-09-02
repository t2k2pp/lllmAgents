import type { ChatParams, ChatWithToolsParams, LLMProvider, VisionChatParams } from "../providers/base-provider.js";
import type { RequestSource } from "../security/permission-manager.js";

export type RunPauseState = "idle" | "running" | "pause_requested" | "paused";

export type RunPauseSnapshot = {
  state: RunPauseState;
  source: RequestSource | null;
  inFlight: number;
};

export type RequestRunPauseResult =
  | { status: "requested" | "already_requested" | "already_paused"; snapshot: RunPauseSnapshot }
  | { status: "not_running" | "not_cli"; snapshot: RunPauseSnapshot };

export type ResumeRunResult =
  | { status: "resumed" | "request_cancelled"; snapshot: RunPauseSnapshot }
  | { status: "not_paused" | "not_running" | "not_cli"; snapshot: RunPauseSnapshot };

type RequestToken = { tracked: boolean; epoch: number };

/**
 * foreground run が発行する main LLM API を、リクエスト間の境界で協調停止する。
 * 進行中のHTTP接続は切らず、新しい接続だけを gate で待たせる。
 */
export class RunApiGate {
  private state: RunPauseState = "idle";
  private source: RequestSource | null = null;
  private inFlight = 0;
  private epoch = 0;
  private pausePromise: Promise<void> | null = null;
  private releasePause: (() => void) | null = null;

  constructor(private readonly onPauseReached?: (snapshot: RunPauseSnapshot) => void) {}

  beginRun(source: RequestSource): void {
    this.releaseWaiters();
    this.epoch++;
    this.state = "running";
    this.source = source;
    this.inFlight = 0;
  }

  finishRun(): RunPauseSnapshot {
    const previous = this.snapshot();
    this.releaseWaiters();
    this.epoch++;
    this.state = "idle";
    this.source = null;
    this.inFlight = 0;
    return previous;
  }

  abortRun(): void {
    if (this.state === "pause_requested" || this.state === "paused") {
      this.state = "running";
      this.releaseWaiters();
    }
  }

  requestPause(): RequestRunPauseResult {
    if (this.state === "idle") return { status: "not_running", snapshot: this.snapshot() };
    if (this.source !== "cli") return { status: "not_cli", snapshot: this.snapshot() };
    if (this.state === "paused") return { status: "already_paused", snapshot: this.snapshot() };
    if (this.state === "pause_requested") return { status: "already_requested", snapshot: this.snapshot() };

    if (this.inFlight === 0) {
      this.reachPause();
    } else {
      this.state = "pause_requested";
      this.ensurePausePromise();
    }
    return { status: "requested", snapshot: this.snapshot() };
  }

  resume(): ResumeRunResult {
    if (this.state === "idle") return { status: "not_running", snapshot: this.snapshot() };
    if (this.source !== "cli") return { status: "not_cli", snapshot: this.snapshot() };
    if (this.state === "running") return { status: "not_paused", snapshot: this.snapshot() };

    const status = this.state === "paused" ? "resumed" : "request_cancelled";
    this.state = "running";
    this.releaseWaiters();
    return { status, snapshot: this.snapshot() };
  }

  snapshot(): RunPauseSnapshot {
    return { state: this.state, source: this.source, inFlight: this.inFlight };
  }

  async enterRequest(signal?: AbortSignal): Promise<RequestToken | null> {
    if (this.state === "idle") return { tracked: false, epoch: this.epoch };

    const requestEpoch = this.epoch;
    if (this.state === "pause_requested" || this.state === "paused") {
      const pause = this.ensurePausePromise();
      const resumed = await this.waitForResume(pause, signal);
      if (!resumed || !this.isActiveEpoch(requestEpoch)) return null;
    }
    if (signal?.aborted) return null;

    this.inFlight++;
    return { tracked: true, epoch: requestEpoch };
  }

  leaveRequest(token: RequestToken): void {
    if (!token.tracked || token.epoch !== this.epoch) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0 && this.state === "pause_requested") this.reachPause();
  }

  /** API完了後の制御を境界上で止め、tool実行などrunの後続処理もresumeまで進めない。 */
  async waitAfterRequest(token: RequestToken, signal?: AbortSignal): Promise<boolean> {
    if (!token.tracked || token.epoch !== this.epoch) return false;
    if (this.state !== "pause_requested" && this.state !== "paused") return true;
    return await this.waitForResume(this.ensurePausePromise(), signal);
  }

  /** API以外のrun後続処理もpause中に新規開始しないための共通checkpoint。 */
  async waitUntilRunning(): Promise<boolean> {
    if (this.state === "idle") return false;
    if (this.state !== "pause_requested" && this.state !== "paused") return true;
    const waitEpoch = this.epoch;
    await this.ensurePausePromise();
    return this.isActiveEpoch(waitEpoch);
  }

  private reachPause(): void {
    if (this.state === "paused") return;
    this.state = "paused";
    this.ensurePausePromise();
    this.onPauseReached?.(this.snapshot());
  }

  private isActiveEpoch(epoch: number): boolean {
    return this.epoch === epoch && this.state !== "idle";
  }

  private ensurePausePromise(): Promise<void> {
    if (!this.pausePromise) {
      this.pausePromise = new Promise<void>((resolve) => {
        this.releasePause = resolve;
      });
    }
    return this.pausePromise;
  }

  private releaseWaiters(): void {
    this.releasePause?.();
    this.releasePause = null;
    this.pausePromise = null;
  }

  private async waitForResume(pause: Promise<void>, signal?: AbortSignal): Promise<boolean> {
    if (!signal) {
      await pause;
      return true;
    }
    if (signal.aborted) return false;
    return await new Promise<boolean>((resolve) => {
      const onAbort = () => resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
      void pause.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      });
    });
  }
}

type GatedChatParams = ChatParams | ChatWithToolsParams | VisionChatParams;
type GatedMethod = "chat" | "chatWithTools" | "chatWithVision";

/** Provider固有の追加メソッドをProxyで保ったまま、全chat経路へ同じrun gateを適用する。 */
export function gateLLMProvider(provider: LLMProvider, gate: RunApiGate): LLMProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === "chat" || property === "chatWithTools" || property === "chatWithVision") {
        const method = property as GatedMethod;
        return async function* gatedChat(params: GatedChatParams) {
          const token = await gate.enterRequest(params.signal);
          if (!token) return;
          let completed = false;
          try {
            const invoke = target[method] as (value: GatedChatParams) => AsyncGenerator<unknown>;
            yield* invoke.call(target, params);
            completed = true;
          } finally {
            gate.leaveRequest(token);
          }
          if (completed) await gate.waitAfterRequest(token, params.signal);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as LLMProvider;
}
