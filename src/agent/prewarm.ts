/**
 * 先読み (docs/context-reduction-redesign.md §9。 整理の作り直し タスク 9)。
 *
 * 履歴を書き換えた後 (依頼の終わりの整理・/compact) と、 セッションを再開した後は、 サーバの KV キャッシュに
 * 今の並びが無い。 次の本体呼び出しで全部を読み直すと十数分かかるので、 利用者の手が空いている間に
 * 「次の本体呼び出しと同じ並び」 を出力上限 1 で送り、 サーバに読み込ませておく。 結果は捨てる。
 *
 * 送るのは、 利用者が /prewarm で頼んだときと、 自動の先読み (設定 context.prewarm.auto。 既定は切) が入っているときの
 * 依頼の終わりの整理・/compact・再開の後 (§9.1)。 既定を切にしたのは、 思わぬときに長い読み込みが始まり、
 * 本体の読み込みと見分けられなかったため (2026-10-27 利用者の判断)。
 *
 * 並びは本体呼び出しと同じ組み立て (AgentLoop.buildMainCallRequest) から作り、 出力上限だけを 1 に差し替える。
 * 状態通知 (attachDynamicContext) は付けない: 次の本体呼び出しは、 この並びの末尾に利用者の発言を足し、
 * その発言に状態通知を付けるだけなので、 先読みの並びがそのまま先頭になる (prompt-prefix-stability.md §3.2)。
 * 一時停止した作業の再開 (/run resume) は発言を足さずに本体を呼ぶので先読みしない (呼び出し側が呼ばない)。
 *
 * 先読みは性能のための最適化で、 失敗しても正しさは変わらない。 ただし黙らない (始まり・終わり・失敗・取り消しは画面と記録に出す)。
 *
 * 先読み中の待ち合わせ: 先読みは裏で走らせる (利用者の入力を妨げない)。 本体呼び出しは送る前に waitBeforeMainCall() で
 * 終わりを待ち、 脇の呼び出しは sideCall() の入口 (SideCallGate) で待つ。 スロットが 1 つのサーバでは、 先読み中に別の並びを
 * 送ると先読みした中身を追い出し、 切断するとそれまでの読み込みが無駄になるため。 Esc (abort()) は先読みも切る。
 *
 * 古い並びの先読みは待たずに切る (§9.5。 2026-10-27 実機: 再開の先読み 約 40 万トークンを、 直後の整理で捨てる並びなのに
 * 1 時間 40 分待ち続けた)。 先読みは 「次の本体呼び出しの先頭になる並び」 にだけ意味がある。 次のどれかで切る
 * (llama.cpp は HTTP の接続が閉じると処理を取り消す):
 * - 整理イベントが履歴を書き換えると決めたとき (AgentLoop が cut() を呼ぶ。 要約の呼び出しや差し替えより前)
 * - 次の呼び出しの並び (設定・道具の定義・messages) が、 先読みの並びで始まらなくなったとき。 2 段で見る:
 *   (1) 安全網: 何かが先読みを待つ前 (本体呼び出し・脇の呼び出し) に、 今の並びの指紋と先読みの指紋を比べ、
 *       始まらなければ待たずに切る (waitBeforeMainCall / beforeSideCall)。 どの経路で並びが変わっても拾う
 *   (2) すぐ切る: 並びを変える操作 (履歴の書き換え・/clear・載せ替え・system の更新・道具の登録と解除・model や設定の変更) が
 *       AgentLoop.invalidatePrewarm() を呼び、 同じ比べ方で古ければその場で切る (サーバの計算を待たずに止める)
 * 切った理由は種類 (利用者 user / 古い stale / 差し替え replaced / 終了 stop) と中身を、 記録 (side_call の abortKind・
 * abortReason と PrewarmOutcome) に残す。
 */
import type { ProviderType, SecondLLMProviderType } from "../config/types.js";
import type { LLMProvider, Message } from "../providers/base-provider.js";
import { fingerprintPrompt, type PromptFingerprint } from "./prompt-fingerprint.js";
import type { MainCallRequest } from "./reduction-summary.js";
import { type SideCallGate, type SideCallPurpose, sideCall } from "./side-call.js";

/**
 * 先読みを送る契機 (§9.1)。 request-end = 依頼の終わり (規則 2) の整理の後、 manual = /compact の後、
 * resume = セッションの再開、 manual-command = 利用者の /prewarm (この 3 つ以外は自動の先読みが入っているときだけ)
 */
export type PrewarmTrigger = "request-end" | "manual" | "resume" | "manual-command";

/**
 * 先読みを送らない理由。
 * - not-local-server: 課金されるクラウドの provider、 または種類の分からない provider (§9.3)
 * - empty-history: 履歴が空 (読み込ませる会話が無い)
 * - auto-off: 自動の先読みが切 (設定 context.prewarm.auto。 /prewarm で送れる)
 */
export type PrewarmSkipReason = "not-local-server" | "empty-history" | "auto-off";

/** 先読みを切った理由の種類。 user = 利用者 (Esc)、 stale = 並びが古くなった、 replaced = 新しい先読みに替えた、 stop = 終了の前 */
export type PrewarmAbortKind = "user" | "stale" | "replaced" | "stop";

/** reduction_event の prewarm 欄 (§10.1)。 整理イベントの後に先読みしない契機 (規則 1 など) では欄そのものが null */
export type PrewarmOutcome =
  | { status: "skipped"; reason: PrewarmSkipReason; detail: string }
  | { status: "done"; durationMs: number }
  | { status: "failed"; durationMs: number; error: string }
  | { status: "aborted"; durationMs: number; kind?: PrewarmAbortKind; reason?: string };

/** 先読みを切った理由の中身 (記録・画面に出す) */
export const PREWARM_ABORT_REASONS = {
  user: "利用者の取り消し (Esc)",
  replaced: "新しい先読みに替えるため",
  stop: "終了の前",
  reduction: "会話を整理する (履歴を書き換える) と決めたため",
  swapped: "会話を載せ替えたため",
  mismatch: "次の本体呼び出しの並びが、 先読みの並びで始まらないため",
} as const;

/** AbortController.abort() に渡す、 先読みを切った理由 (side_call の記録が abortKind・abortReason として残す) */
export class PrewarmAbortReason {
  constructor(
    readonly kind: PrewarmAbortKind,
    readonly detail: string,
  ) {}
}

/**
 * 先読みを送ってよい provider (§9.3)。 自分のサーバで動かすもの (KV キャッシュがそのサーバにあり、 送っても課金されない) だけ。
 * クラウドは入力トークンに課金されるうえ (先読みの分だけ全部の入力をもう 1 回払う)、 キャッシュの扱いが provider 任せ
 * (明示の cache_control・数分で消える自動キャッシュ・子プロセスが自分で並びを組む claude-cli など) で、 待ち時間を減らせる保証も無い。
 */
const LOCAL_SERVER_TYPES: ReadonlySet<SecondLLMProviderType> = new Set<ProviderType>([
  "llamacpp",
  "vllm",
  "lmstudio",
  "ollama",
]);

/**
 * 先読みを送れない理由を返す (送れるなら null)。 自動の先読みの入切はここでは見ない (呼び出し側が見る)。
 * @param raw 履歴 (getRawMessages())
 */
export function prewarmSkipReason(
  providerType: string,
  raw: readonly Message[],
): { reason: Exclude<PrewarmSkipReason, "auto-off">; detail: string } | null {
  if (!LOCAL_SERVER_TYPES.has(providerType as SecondLLMProviderType)) {
    return {
      reason: "not-local-server",
      detail: `provider ${providerType} は自分のサーバで動かすもの (llamacpp / vllm / lmstudio / ollama) ではないため先読みしません (課金される・キャッシュの扱いが provider 任せ)`,
    };
  }
  if (raw.length === 0) {
    return { reason: "empty-history", detail: "履歴が空なので先読みしません" };
  }
  return null;
}

/** 本体呼び出しの送り方から、 先読みの送り方を作る (並び・ツール定義・設定はそのまま、 出力上限だけ 1) */
export function buildPrewarmRequest(main: MainCallRequest): MainCallRequest {
  return main.method === "chatWithTools"
    ? { method: "chatWithTools", params: { ...main.params, maxTokens: 1 } }
    : { method: "chat", params: { ...main.params, maxTokens: 1 } };
}

/** previous の並び (設定・道具の定義・messages) が、 そのまま current の先頭になっているか */
export function isPromptPrefix(previous: PromptFingerprint, current: PromptFingerprint): boolean {
  if (previous.settings !== current.settings || previous.tools !== current.tools) return false;
  if (current.messages.length < previous.messages.length) return false;
  return previous.messages.every((m, i) => current.messages[i] === m);
}

/** 中断された signal から、 先読みを切った理由を取り出す */
function abortReasonOf(signal: AbortSignal): { kind?: PrewarmAbortKind; reason?: string } {
  const r: unknown = signal.reason;
  return r instanceof PrewarmAbortReason ? { kind: r.kind, reason: r.detail } : {};
}

/** 走っている先読みの様子 (表示・/prewarm status 用) */
export interface PrewarmRunningStatus {
  trigger: PrewarmTrigger;
  startedAt: number;
  /** 送る並びの大きさの見込み (トークン) */
  promptTokens: number;
  /** 先読みの終わりを待っているもの (待っていなければ null) */
  waitingFor: string | null;
}

interface RunningPrewarm {
  status: PrewarmRunningStatus;
  controller: AbortController;
  done: Promise<PrewarmOutcome>;
  /** 送った並びの指紋 (次の本体呼び出しの並びがこれで始まるかを確かめる) */
  fingerprint: PromptFingerprint;
  /** 今の時点で次の呼び出しが送る並びの指紋 (状態通知を付ける前) */
  currentFingerprint: () => PromptFingerprint;
}

export interface PrewarmRunnerHooks {
  /** 先読みを送り始めたとき (表示を出す) */
  onStart?(status: PrewarmRunningStatus): void;
  /** 先読みの終わりを待ち始めたとき (表示を待ちの言い方に替える) */
  onWait(who: string, status: PrewarmRunningStatus): void;
  /** 並びが古くなった先読みを切ったとき (動作ログを出す。 画面の 1 行は終わりの onEnd で出す) */
  onStale(trigger: PrewarmTrigger, reason: string): void;
  /** 先読みが終わったとき (成功・失敗・取り消しのどれでも。 表示を消して結果の 1 行を出す) */
  onEnd?(status: PrewarmRunningStatus, outcome: PrewarmOutcome): void;
}

export interface PrewarmStartOptions {
  trigger: PrewarmTrigger;
  provider: LLMProvider;
  /** 送り方を作る関数 (中断用の signal を受け取り、 本体呼び出しと同じ組み立てで作る) */
  build: (signal: AbortSignal) => MainCallRequest;
  /** 今の時点で次の呼び出しが送る並びの指紋を作る (古くなったかの比べる相手)。 省略時は送った並びのまま (古くならない扱い) */
  currentFingerprint?: () => PromptFingerprint;
  /** 送る並びの大きさの見込み (表示用) */
  promptTokens?: number;
}

/**
 * 先読みを 1 つだけ裏で走らせ、 本体呼び出し・脇の呼び出しを終わりまで待たせる。
 * AgentLoop が 1 つ持ち、 sideCall の入口の待ち合わせ (setSideCallGate) にも登録する。
 */
export class PrewarmRunner implements SideCallGate {
  private current: RunningPrewarm | null = null;
  private last: { trigger: PrewarmTrigger; outcome: PrewarmOutcome; finishedAt: number } | null = null;

  constructor(private readonly hooks: PrewarmRunnerHooks) {}

  isRunning(): boolean {
    return this.current !== null;
  }

  /** 走っている先読みの様子 (走っていなければ null) */
  runningStatus(): PrewarmRunningStatus | null {
    return this.current === null ? null : { ...this.current.status };
  }

  /** 直近に終わった先読みの結果 (まだ無ければ null) */
  lastOutcome(): { trigger: PrewarmTrigger; outcome: PrewarmOutcome; finishedAt: number } | null {
    return this.last;
  }

  /**
   * 先読みを裏で送る (すぐ返す)。 走っている先読みがあれば切ってから送る (並びが古くなっているため)。
   * @returns 先読みの終わり (成功・失敗・中断のどれでも resolve する。 reject しない)
   */
  start(options: PrewarmStartOptions): Promise<PrewarmOutcome> {
    // 並びは今の時点で作る。 前の先読みは切り、 その終わりを待ってから送る (同じスロットに 2 つ送らない)
    const previous = this.current;
    previous?.controller.abort(new PrewarmAbortReason("replaced", PREWARM_ABORT_REASONS.replaced));
    const controller = new AbortController();
    const request = buildPrewarmRequest(options.build(controller.signal));
    const fingerprint = fingerprintPrompt(request.params);
    const status: PrewarmRunningStatus = {
      trigger: options.trigger,
      startedAt: Date.now(),
      promptTokens: options.promptTokens ?? 0,
      waitingFor: null,
    };
    const done = (previous ? previous.done.then(() => undefined) : Promise.resolve())
      .then(() => {
        if (!controller.signal.aborted) this.hooks.onStart?.({ ...status });
        return send(options.provider, request, controller.signal, options.trigger);
      })
      .then((outcome) => {
        this.last = { trigger: options.trigger, outcome, finishedAt: Date.now() };
        this.hooks.onEnd?.({ ...status }, outcome);
        return outcome;
      });
    const running: RunningPrewarm = {
      status,
      controller,
      done,
      fingerprint,
      currentFingerprint: options.currentFingerprint ?? (() => fingerprint),
    };
    this.current = running;
    void done.finally(() => {
      if (this.current === running) this.current = null;
    });
    return done;
  }

  /** 走っている先読みを切る (利用者の Esc)。 終わりは待たない。 @returns 切ったなら true */
  abort(): boolean {
    const running = this.current;
    if (running === null || running.controller.signal.aborted) return false;
    running.controller.abort(new PrewarmAbortReason("user", PREWARM_ABORT_REASONS.user));
    return true;
  }

  /**
   * 並びが古くなった (なる) 先読みを切る。 終わりは待たない。 動作ログは onStale が出す。
   * @returns 切ったなら true (走っていない・切り済みなら false)
   */
  cut(reason: string): boolean {
    const running = this.current;
    if (running === null || running.controller.signal.aborted) return false;
    running.controller.abort(new PrewarmAbortReason("stale", reason));
    this.hooks.onStale(running.status.trigger, reason);
    return true;
  }

  /**
   * 次の呼び出しの並びが先読みの並びで始まらなくなっていれば切る。
   * @param reason 切ったときの理由 (並びを変えた操作。 省略時は mismatch)
   * @param next 比べる相手の指紋 (省略時は今の並びを作って比べる)
   * @returns 切ったなら true
   */
  abortIfStale(reason: string = PREWARM_ABORT_REASONS.mismatch, next?: PromptFingerprint): boolean {
    const running = this.current;
    if (running === null || running.controller.signal.aborted) return false;
    if (isPromptPrefix(running.fingerprint, next ?? running.currentFingerprint())) return false;
    return this.cut(reason);
  }

  /** 走っている先読みを切って、 終わりまで待つ (終了の前) */
  async stop(): Promise<void> {
    const running = this.current;
    if (running === null) return;
    running.controller.abort(new PrewarmAbortReason("stop", PREWARM_ABORT_REASONS.stop));
    await running.done;
  }

  /**
   * 本体呼び出しの前。 先読みの並びが本体呼び出しの先頭になるなら、 終わるまで待つ (待ち始めに表示を替える。 切断はしない)。
   * 並びが先読みの並びで始まらなければ待たずに切る (安全網。 どの経路で並びが変わっても拾う)。
   * 切ったときは接続を閉じ終えるまでだけ待つ (同じスロットに 2 つ送らない)。
   * @param who 待っているもの (表示用。 例: 本体の呼び出し)
   * @param next これから送る本体呼び出しの指紋
   */
  async waitBeforeMainCall(who: string, next: PromptFingerprint): Promise<void> {
    const running = this.current;
    if (running === null) return;
    this.abortIfStale(PREWARM_ABORT_REASONS.mismatch, next);
    await this.waitFor(running, who);
  }

  /** 表示を出さずに終わりを待つ (テスト・終了処理用) */
  async settled(): Promise<void> {
    await this.current?.done;
  }

  /**
   * sideCall の入口の待ち合わせ。 先読みそのものは待たない。 次の本体呼び出しの並びが先読みの並びで始まらなければ
   * 待たずに切る (安全網。 切ったときは接続を閉じ終えるまでだけ待つ)。 整理イベントの要約は、 呼ぶ前に整理イベントが先読みを切っている
   */
  async beforeSideCall(purpose: SideCallPurpose): Promise<void> {
    if (purpose === "prewarm") return;
    const running = this.current;
    if (running === null) return;
    this.abortIfStale();
    await this.waitFor(running, `脇の呼び出し (${purpose})`);
  }

  private async waitFor(running: RunningPrewarm, who: string): Promise<void> {
    if (!running.controller.signal.aborted) {
      running.status.waitingFor = who;
      this.hooks.onWait(who, { ...running.status });
    }
    try {
      await running.done;
    } finally {
      running.status.waitingFor = null;
    }
  }
}

/** 先読みを送り、 応答を読み捨てる。 失敗・中断も結果として返す (投げない) */
async function send(
  provider: LLMProvider,
  request: MainCallRequest,
  signal: AbortSignal,
  trigger: PrewarmTrigger,
): Promise<PrewarmOutcome> {
  const startedAt = Date.now();
  // 前の先読みの終わりを待つ間に切られた
  if (signal.aborted) return { status: "aborted", durationMs: 0, ...abortReasonOf(signal) };
  let error: string | undefined;
  try {
    // 指紋は、 次の本体呼び出しの外れの判定で並びのずれを求めるのに使う (cache-miss.ts)。
    // signal を渡すと、 切ったときの記録 (side_call) に切った理由が残る
    for await (const chunk of sideCall("prewarm", provider, request, { fingerprint: true, signal, trigger })) {
      if (chunk.type === "error") error = chunk.error ?? "Unknown LLM error";
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Date.now() - startedAt;
  if (signal.aborted) return { status: "aborted", durationMs, ...abortReasonOf(signal) };
  if (error !== undefined) return { status: "failed", durationMs, error };
  return { status: "done", durationMs };
}
