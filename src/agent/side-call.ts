/**
 * 脇の呼び出しの入口 (docs/context-reduction-redesign.md §10.3)。
 *
 * 本体の会話ループ以外から LLM provider を呼ぶ処理 (意図の分類・要約・引き継ぎメモ・サブエージェント 等) は、
 * すべて sideCall() を通す。 provider の chat / chatWithTools / chatWithVision を直接呼んではいけない。
 *
 * なぜ: ローカル LLM のサーバはスロットが 1 つなので、 脇の呼び出しが本体の KV キャッシュを追い出している
 * 可能性がある。 目的ごとの回数・入力量・キャッシュ再利用量・所要時間をセッションログに残し、
 * 本体呼び出しでキャッシュが外れたとき (cache_miss) に「間に何の脇の呼び出しがあったか」 を示せるようにする。
 *
 * 記録先は AgentLoop が setSideCallSink() で登録する (1 プロセスに AgentLoop は 1 つ。 サブエージェントや
 * セカンド LLM の呼び出しもメインのセッションログに集める)。
 */
import type {
  ChatChunk,
  ChatParams,
  ChatWithToolsParams,
  LLMProvider,
  TokenUsage,
  VisionChatParams,
} from "../providers/base-provider.js";

/**
 * 脇の呼び出しの目的。 必須。 追加したら設計書 §10.3 にも書く。
 * - summarize: 履歴の要約 (段階 3 の requestSummary。 reduction-summary.ts)
 * - compress-instructions: プロジェクト指示・メモの圧縮 (system に入れる前)
 * - intent: 利用者の発言の意図の分類
 * - completion: 応答が完了を宣言しているかの分類
 * - progress: 進み具合の判定
 * - goal-promotion: Goal 昇格のための受け入れ条件の抽出
 * - handoff: 引き継ぎメモの作成
 * - prewarm: 先読み (prewarm.ts。 次の本体呼び出しと同じ並びを出力上限 1 で送る)
 * - subagent: サブエージェント (task ツール) の各呼び出し
 * - second-llm: セカンド LLM (相談・委任・評価) の各呼び出し
 * - vision: 画像の解析 (vision ツール)
 */
export type SideCallPurpose =
  | "summarize"
  | "compress-instructions"
  | "intent"
  | "completion"
  | "progress"
  | "goal-promotion"
  | "handoff"
  | "prewarm"
  | "subagent"
  | "second-llm"
  | "vision";

/** セッションログの side_call に書く 1 件。 */
export interface SideCallRecord {
  purpose: SideCallPurpose;
  model: string;
  providerType: string;
  /** サーバが返した入力トークン数 (返さない provider では無い) */
  tokensIn?: number;
  tokensOut?: number;
  /** キャッシュで再利用された入力トークン数 (返さない provider では無い) */
  tokensCached?: number;
  durationMs: number;
  finishReason?: string;
  /** 失敗・中断のとき、 その内容 */
  error?: string;
}

export interface SideCallSink {
  recordSideCall(record: SideCallRecord): void;
}

let sink: SideCallSink | undefined;

/** 記録先を登録する。 AgentLoop が生成時に呼ぶ。 */
export function setSideCallSink(next: SideCallSink | undefined): void {
  sink = next;
}

/**
 * 脇の呼び出しを送る前の待ち合わせ (docs/context-reduction-redesign.md §9.2)。 先読み中は脇の呼び出しを送らない
 * (スロットが 1 つのサーバでは先読みした中身を追い出す)。 AgentLoop が PrewarmRunner を登録する。
 */
export interface SideCallGate {
  beforeSideCall(purpose: SideCallPurpose): Promise<void>;
}

let gate: SideCallGate | undefined;

/** 待ち合わせを登録する。 AgentLoop が生成時に呼ぶ。 */
export function setSideCallGate(next: SideCallGate | undefined): void {
  gate = next;
}

export type SideCallRequest =
  | { method: "chat"; params: ChatParams }
  | { method: "chatWithTools"; params: ChatWithToolsParams }
  | { method: "chatWithVision"; params: VisionChatParams };

/**
 * 脇の呼び出しの入口。 provider の応答をそのまま流し、 終わったとき (正常・失敗・途中で読むのをやめた、 のどれでも)
 * に 1 件だけ記録する。 送る前に待ち合わせ (先読みの終わり) を待つ。 所要時間は待ち終えてから数える。
 */
export async function* sideCall(
  purpose: SideCallPurpose,
  provider: LLMProvider,
  request: SideCallRequest,
): AsyncGenerator<ChatChunk> {
  await gate?.beforeSideCall(purpose);
  const startedAt = Date.now();
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;
  let error: string | undefined;
  let finished = false;
  try {
    const gen = invoke(provider, request);
    for await (const chunk of gen) {
      if (chunk.type === "done") {
        finishReason = chunk.finishReason;
        usage = chunk.usage ?? usage;
      } else if (chunk.type === "error") {
        error = chunk.error ?? "Unknown LLM error";
      }
      yield chunk;
    }
    finished = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    if (!finished && error === undefined) error = "応答の途中で読むのをやめました";
    sink?.recordSideCall({
      purpose,
      model: request.params.model,
      providerType: provider.providerType,
      tokensIn: usage?.promptTokens,
      tokensOut: usage?.completionTokens,
      tokensCached: usage?.cachedTokens,
      durationMs: Date.now() - startedAt,
      finishReason,
      error,
    });
  }
}

function invoke(provider: LLMProvider, request: SideCallRequest): AsyncGenerator<ChatChunk> {
  switch (request.method) {
    case "chat":
      return provider.chat(request.params);
    case "chatWithTools":
      return provider.chatWithTools(request.params);
    case "chatWithVision":
      return provider.chatWithVision(request.params);
  }
}
