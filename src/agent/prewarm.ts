/**
 * 先読み (docs/context-reduction-redesign.md §9。 整理の作り直し タスク 9)。
 *
 * 履歴を書き換えた後 (依頼の終わりの整理・/compact) と、 セッションを再開した後は、 サーバの KV キャッシュに
 * 今の並びが無い。 次の本体呼び出しで全部を読み直すと十数分かかるので、 利用者の手が空いている間に
 * 「次の本体呼び出しと同じ並び」 を出力上限 1 で送り、 サーバに読み込ませておく。 結果は捨てる。
 *
 * 並びは本体呼び出しと同じ組み立て (AgentLoop.buildMainCallRequest) から作り、 出力上限だけを 1 に差し替える。
 * 状態通知 (attachDynamicContext) は付けない: 次の本体呼び出しは、 この並びの末尾に利用者の発言を足し、
 * その発言に状態通知を付けるだけなので、 先読みの並びがそのまま先頭になる (prompt-prefix-stability.md §3.2)。
 * 先読みを送る契機 (依頼の終わり・/compact・再開) の後は、 どれも次の本体呼び出しの前に利用者の発言が足されるので、
 * 履歴の末尾が assistant でもツール結果 (response_complete で終わった依頼など) でも、 状態通知の添付先は新しい発言になる。
 * 一時停止した作業の再開 (/run resume) は発言を足さずに本体を呼ぶので先読みしない (呼び出し側が呼ばない)。
 *
 * 先読みは性能のための最適化で、 失敗しても正しさは変わらない。 ただし黙らない (失敗は記録と画面の 1 行に出す)。
 *
 * 先読み中の待ち合わせ: 先読みは裏で走らせる (利用者の入力を妨げない)。 本体呼び出しは送る前に wait() で終わりを待ち、
 * 脇の呼び出しは sideCall() の入口 (SideCallGate) で待つ。 スロットが 1 つのサーバでは、 先読み中に別の並びを送ると
 * 先読みした中身を追い出し、 切断するとそれまでの読み込みが無駄になるため。 Esc の中断 (abort()) は先読みも切る。
 */
import type { ProviderType, SecondLLMProviderType } from "../config/types.js";
import type { LLMProvider, Message } from "../providers/base-provider.js";
import type { MainCallRequest } from "./reduction-summary.js";
import { type SideCallGate, type SideCallPurpose, sideCall } from "./side-call.js";

/** 先読みを送る契機 (§9.1)。 request-end = 依頼の終わり (規則 2) の整理の後、 manual = /compact の後、 resume = セッションの再開 */
export type PrewarmTrigger = "request-end" | "manual" | "resume";

/**
 * 先読みを送らない理由。
 * - not-local-server: 課金されるクラウドの provider、 または種類の分からない provider (§9.3)
 * - empty-history: 履歴が空 (読み込ませる会話が無い)
 */
export type PrewarmSkipReason = "not-local-server" | "empty-history";

/** reduction_event の prewarm 欄 (§10.1)。 整理イベントの後に先読みしない契機 (規則 1 など) では欄そのものが null */
export type PrewarmOutcome =
  | { status: "skipped"; reason: PrewarmSkipReason; detail: string }
  | { status: "done"; durationMs: number }
  | { status: "failed"; durationMs: number; error: string }
  | { status: "aborted"; durationMs: number };

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
 * 先読みを送らない理由を返す (送ってよければ null)。
 * @param raw 履歴 (getRawMessages())
 */
export function prewarmSkipReason(
  providerType: string,
  raw: readonly Message[],
): { reason: PrewarmSkipReason; detail: string } | null {
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

interface RunningPrewarm {
  trigger: PrewarmTrigger;
  controller: AbortController;
  done: Promise<PrewarmOutcome>;
}

export interface PrewarmRunnerHooks {
  /** 先読みの終わりを待ち始めたとき (利用者に見える 1 行を出す) */
  onWait(who: string): void;
}

/**
 * 先読みを 1 つだけ裏で走らせ、 本体呼び出し・脇の呼び出しを終わりまで待たせる。
 * AgentLoop が 1 つ持ち、 sideCall の入口の待ち合わせ (setSideCallGate) にも登録する。
 */
export class PrewarmRunner implements SideCallGate {
  private current: RunningPrewarm | null = null;

  constructor(private readonly hooks: PrewarmRunnerHooks) {}

  isRunning(): boolean {
    return this.current !== null;
  }

  /**
   * 先読みを裏で送る (すぐ返す)。 走っている先読みがあれば切ってから送る (並びが古くなっているため)。
   * @param build 送り方を作る関数 (中断用の signal を受け取り、 本体呼び出しと同じ組み立てで作る)
   * @returns 先読みの終わり (成功・失敗・中断のどれでも resolve する。 reject しない)
   */
  start(
    trigger: PrewarmTrigger,
    provider: LLMProvider,
    build: (signal: AbortSignal) => MainCallRequest,
  ): Promise<PrewarmOutcome> {
    // 並びは今の時点で作る。 前の先読みは切り、 その終わりを待ってから送る (同じスロットに 2 つ送らない)
    const previous = this.current;
    previous?.controller.abort();
    const controller = new AbortController();
    const request = buildPrewarmRequest(build(controller.signal));
    const done = (previous ? previous.done.then(() => undefined) : Promise.resolve()).then(() =>
      send(provider, request, controller.signal),
    );
    const running: RunningPrewarm = { trigger, controller, done };
    this.current = running;
    void done.finally(() => {
      if (this.current === running) this.current = null;
    });
    return done;
  }

  /** 走っている先読みを切る (Esc の中断)。 終わりは待たない */
  abort(): void {
    this.current?.controller.abort();
  }

  /** 走っている先読みを切って、 終わりまで待つ (載せ替え・終了の前) */
  async stop(): Promise<void> {
    const running = this.current;
    if (running === null) return;
    running.controller.abort();
    await running.done;
  }

  /**
   * 先読みが走っていれば、 終わるまで待つ (待ち始めに 1 行を出す)。 切断はしない。
   * @param who 待っているもの (表示用。 例: 本体の呼び出し)
   */
  async wait(who: string): Promise<void> {
    const running = this.current;
    if (running === null) return;
    this.hooks.onWait(who);
    await running.done;
  }

  /** 表示を出さずに終わりを待つ (テスト・終了処理用) */
  async settled(): Promise<void> {
    await this.current?.done;
  }

  /** sideCall の入口の待ち合わせ。 先読みそのものは待たない */
  async beforeSideCall(purpose: SideCallPurpose): Promise<void> {
    if (purpose === "prewarm") return;
    await this.wait(`脇の呼び出し (${purpose})`);
  }
}

/** 先読みを送り、 応答を読み捨てる。 失敗・中断も結果として返す (投げない) */
async function send(provider: LLMProvider, request: MainCallRequest, signal: AbortSignal): Promise<PrewarmOutcome> {
  const startedAt = Date.now();
  // 前の先読みの終わりを待つ間に切られた
  if (signal.aborted) return { status: "aborted", durationMs: 0 };
  let error: string | undefined;
  try {
    // 指紋は、 次の本体呼び出しの外れの判定で並びのずれを求めるのに使う (cache-miss.ts)
    for await (const chunk of sideCall("prewarm", provider, request, { fingerprint: true })) {
      if (chunk.type === "error") error = chunk.error ?? "Unknown LLM error";
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Date.now() - startedAt;
  if (signal.aborted) return { status: "aborted", durationMs };
  if (error !== undefined) return { status: "failed", durationMs, error };
  return { status: "done", durationMs };
}
