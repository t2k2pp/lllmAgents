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
 * foreground run の一時停止 (docs/durable-run-resume-design.md)。
 *
 * 一時停止は 1 方式だけ: pause を予約すると、 進行中の main LLM API の応答と、 その応答が頼んだ tool 群を
 * 完了させ、 AgentLoop が次の main LLM API を始める直前 (pauseAtBoundary) で停止する。
 * AgentLoop はその境界で会話と再開地点を保存するので、 停止後はアプリ・PC を終了してもよい。
 * 進行中の HTTP 接続は切らず、 停止中は新しい API 接続だけを待たせる。
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

    this.state = "pause_requested";
    this.ensurePausePromise();
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
    if (this.state === "paused") {
      const resumed = await this.waitForResume(this.ensurePausePromise(), signal);
      if (!resumed || !this.isActiveEpoch(requestEpoch)) return null;
    }
    if (signal?.aborted) return null;

    this.inFlight++;
    return { tracked: true, epoch: requestEpoch };
  }

  leaveRequest(token: RequestToken): void {
    if (!token.tracked || token.epoch !== this.epoch) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /**
   * AgentLoop が会話と tool result を確定し、 再開地点を保存した境界でだけ停止させる。
   * 次の main LLM API を開始する直前で呼ぶ。 予約が無ければ何もせず true を返す。
   */
  async pauseAtBoundary(): Promise<boolean> {
    if (this.state !== "pause_requested" || this.inFlight !== 0) return true;
    const waitEpoch = this.epoch;
    this.reachPause();
    await this.ensurePausePromise();
    return this.isActiveEpoch(waitEpoch);
  }

  isPauseRequested(): boolean {
    return this.state === "pause_requested";
  }

  /** API以外のrun後続処理もpause中に新規開始しないための共通checkpoint。 */
  async waitUntilRunning(): Promise<boolean> {
    if (this.state === "idle") return false;
    if (this.state !== "paused") return true;
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
          try {
            const invoke = target[method] as (value: GatedChatParams) => AsyncGenerator<unknown>;
            yield* invoke.call(target, params);
          } finally {
            gate.leaveRequest(token);
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as LLMProvider;
}
