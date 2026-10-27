import type { Message, ToolCall, ContentPart } from "../providers/base-provider.js";

/** アシスタントメッセージ追加時のコールバック */
export type AssistantMessageCallback = (content: string, toolCalls?: ToolCall[]) => void;

/**
 * 揮発フラグの設計メモ:
 *
 * harness が in-turn のリトライ・自己点検・nudge のために注入する補助メッセージには揮発の印
 * (Message.ephemeral) を付ける。 終わった依頼の揮発メッセージは次の整理イベントの前処理で除く
 * (docs/context-reduction-redesign.md §5.2 / §6.2)。 応答のたびには除かない (除くと送信済みの履歴が
 * 書き換わり、 依頼 1 件ごとに KV キャッシュの全部を読み直すことになる)。
 *
 * 設計上の制約:
 *   - tool_call を含む assistant メッセージと、 対応する tool_result (role=tool) は
 *     OpenAI 互換 API 仕様で必ずペアで存在する必要があるため、 揮発化禁止。
 *   - 揮発対象は「assistant の純テキスト (tool_calls なし)」 と「user 役の harness 注入」 のみ。
 *   - ユーザーに表示済みの assistant テキストは会話記録なので、 揮発として渡されても印を付けない
 *     (2026-06-12 の回答消失対策。 以前は応答の終わりに印を外していた)。
 *   - 印は contextNote と同じ内部専用の欄。 セッションに保存され、 provider へ送る前に toSentMessage() が外す。
 */
/**
 * 準システムプロンプト composer の signature。
 * AgentLoop が basePrompt + Goal section + ToDo section + datetime 等を結合する関数を渡す。
 * 毎 getMessages() 呼出で呼ばれて fresh な system prompt を作る (動的合成)。
 *
 * 返り値を { stable, dynamic } の 2 分割にしているのはプロンプトキャッシュ最適化のため
 * (docs/prompt-prefix-stability.md):
 *   - stable: session 内で不変な base (identity / rules / skills / project / memory)。
 *     getMessages() はこれを **先頭の** system メッセージとして返し、 Anthropic 系プロバイダは
 *     ここに cache_control を付ける (= tools+system がキャッシュされる)。
 *   - dynamic: 毎ターン変わる部分 (現在日時 / goal / todo)。 getMessages() には入れない。
 *     履歴より前に置くと前方一致が毎回そこで途切れ、 履歴全部が再計算になるため。
 *     呼び出し側が attachDynamicContext() で末尾の未送信メッセージに添付する。
 *
 * docs/strategic-todo-design.md §2.2 / §3.1 参照。
 */
export interface ComposedSystemPrompt {
  stable: string;
  dynamic: string;
}
export type SystemPromptComposer = (basePrompt: string) => ComposedSystemPrompt;

/** 状態通知の現在日時 (ローカル時刻、 秒まで)。 */
function formatLocalDatetime(now: Date): string {
  return now.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** contextNote を送信用の本文に描画する。 tool 出力やユーザー発言と取り違えないよう囲む。 */
function renderContextNote(note: string): string {
  return (
    "<harness-context>\n" +
    "The harness attached the current state below. It is not part of the tool output or the user's message.\n\n" +
    `${note}\n` +
    "</harness-context>"
  );
}

/**
 * 履歴の 1 件を provider へ送る形に描画する (思考の inline 化・状態通知の連結)。
 * getMessages() と、 送る形で大きさを数える整理の段階 (reduction-stages.ts) が同じものを使う。
 * 描画が要らないメッセージはそのまま返す (同じ参照)。
 */
export function toSentMessage(m: Message): Message {
  // 思考保全: assistant.thinking がある場合は content の先頭に inline 化して送信。
  // provider に未対応フィールドを渡さないために thinking フィールド自体は除外。
  //
  // 2026-05-15 — 命令付きフォーマットに変更 (user 指摘):
  // 旧 `[内部思考 ...]` は単なるラベルで model が「この形式で出力せよ」 と誤解し
  // [/内部思考] を repeat するループに陥った (T12/T13 で観測)。
  // model は自分の過去出力を「自分のもの」 と認識する meta-awareness が無いため、
  // 入力に置かれたタグは template として解釈される。
  // 修正: 標準 <thinking> タグ + 明示的命令 (**以下を踏まえ答えを出す**) で
  // 「これは consume するもの、 出力は新規生成」 を model に伝える。
  if (m.role === "assistant" && m.thinking) {
    const baseContent = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const inlined =
      `<thinking>\n` + `**以下を踏まえ答えを出す**\n` + `${m.thinking}\n` + `</thinking>\n\n` + `${baseContent}`;
    const out: Message = { role: m.role, content: inlined };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  }
  if (m.contextNote) {
    const { contextNote, ephemeral: _ephemeral, ...rest } = m;
    const note = renderContextNote(contextNote);
    const content: string | ContentPart[] =
      typeof m.content === "string"
        ? m.content.length > 0
          ? `${m.content}\n\n${note}`
          : note
        : [...m.content, { type: "text", text: note }];
    return { ...rest, content };
  }
  // 揮発の印 (内部専用) は provider に渡さない
  if (m.ephemeral !== undefined) {
    const { ephemeral: _ephemeral, ...rest } = m;
    return rest;
  }
  return m;
}

/**
 * ツールの対の検証 (docs/archive/context-forgetting.md §2.1)。 tool_calls を持つ assistant の直後に、
 * その全 tool_call_id に対応する role="tool" が揃っていること、 孤立した tool 結果が無いことを確かめる。
 * @returns 壊れていればその内容、 揃っていれば null
 */
export function findToolPairingError(messages: readonly Message[]): string | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") {
      // ここに来る tool は直前の assistant(tool_calls) に回収されていないもの = 孤立
      return `孤立した tool_result があります (index=${i})`;
    }
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;

    const pending = new Set(m.tool_calls.map((c) => c.id));
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const id = messages[j].tool_call_id;
      if (!id || !pending.delete(id)) {
        return `対応する tool_call の無い tool_result です (index=${j}, tool_call_id=${id ?? "なし"})`;
      }
      j++;
    }
    if (pending.size > 0) {
      return `tool_result が欠落しています (assistant index=${i}, 未対応 id=${[...pending].join(", ")})`;
    }
    i = j - 1; // 回収した tool 群は再走査しない
  }
  return null;
}

export class MessageHistory {
  private messages: Message[] = [];
  private systemPrompt: string;
  private onAssistantMessage: AssistantMessageCallback | null = null;
  /**
   * 動的合成 composer。 注入されていれば getMessages() で毎回呼ばれて準システムプロンプトを作る。
   * 未注入なら従来通り this.systemPrompt をそのまま返す (後方互換)。
   */
  private composer: SystemPromptComposer | null = null;
  /**
   * 送信済みのメッセージ。 attachDynamicContext() が添付のたびに全件を登録する。
   * 送信済みのメッセージには状態通知を付けない (書き換えると前方一致キャッシュが外れる)。
   */
  private sentMessages = new WeakSet<Message>();
  /** 直近に添付した状態通知。 key は日時を除いた内容 (変化の判定用)。 */
  private lastContextNote: { key: string; message: Message } | null = null;
  /**
   * 前回の送信以降に、 送信済みの部分を書き換えた操作の理由 (整理イベント・system の更新・/clear 等)。
   * AgentLoop が送信時に takeRewriteReasons() で取り出し、 理由の無い前方の変化を
   * 「予期しないキャッシュ破壊」 として記録する (docs/prompt-prefix-stability.md §7)。
   */
  private rewriteReasons: string[] = [];
  /**
   * 次の状態通知に 1 回だけ添える渡し直し (段階 3 の要約の後の、 最近触ったファイル・いまの作業。
   * docs/context-reduction-redesign.md §5.6)。 添えたら空にする。
   */
  private pendingStateHandover: string | null = null;
  /**
   * 送信済みの部分を書き換えた回数。 書き換え理由を申告するたびに増える。 直前の本体呼び出しの実数を
   * 次の P の土台にしてよいか (間に書き換えが無いか) を AgentLoop が確かめるのに使う
   * (docs/context-reduction-redesign.md §4.1 の P)。
   */
  private revision = 0;
  /**
   * 送信済みの部分を書き換えたときに呼ぶ (理由つき)。 AgentLoop が走っている先読みを確かめて、 古ければその場で切る
   * (docs/context-reduction-redesign.md §9.5)
   */
  private onRewrite: ((reason: string) => void) | null = null;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  setAssistantMessageCallback(cb: AssistantMessageCallback | null): void {
    this.onAssistantMessage = cb;
  }

  /** 送信済みの部分を書き換えたときの通知先を登録する (AgentLoop が履歴を作る・載せ替えるときに呼ぶ) */
  setRewriteListener(listener: ((reason: string) => void) | null): void {
    this.onRewrite = listener;
  }

  /**
   * 準システムプロンプト合成関数を注入する。 AgentLoop が constructor で呼ぶ。
   * これ以降 getMessages() は毎回 composer(this.systemPrompt) を呼んで動的に system prompt を作る。
   */
  setSystemPromptComposer(composer: SystemPromptComposer | null): void {
    this.composer = composer;
  }

  /** composer を呼んで { stable, dynamic } を得る。 composer が無ければ base 全量が stable。 */
  private compose(): ComposedSystemPrompt {
    if (!this.composer) return { stable: this.systemPrompt, dynamic: "" };
    return this.composer(this.systemPrompt);
  }

  getMessages(): Message[] {
    // 返すのは [固定 system, ...履歴] だけ。 毎ターン変わる dynamic はここに入れない
    // (docs/prompt-prefix-stability.md)。 状態通知は attachDynamicContext() が添付した
    // contextNote として、 添付先メッセージの本文の後ろに描画する。
    const { stable } = this.compose();
    return [{ role: "system", content: stable }, ...this.messages.map(toSentMessage)];
  }

  /**
   * 状態通知 (現在日時 / Goal / ToDo) を末尾の未送信メッセージに添付する。
   * LLM 呼び出しの直前に呼ぶ。 呼んだ時点の全メッセージを送信済みとして記録する。
   *
   * 一度送ったメッセージは書き換えず、 変わった情報だけを末尾に足す (docs/prompt-prefix-stability.md §3.2)。
   * 添付する条件 (いずれか):
   *   1. 日時を除いた内容が前回の通知と違う
   *   2. 前回通知を付けたメッセージが履歴から消えた (整理イベント・引き継ぎでのリセット)。 状態を見失わせない
   *   3. 末尾が user メッセージ (新しい依頼の始まり)。 現在日時をここで更新する
   *   4. 渡し直し (queueStateHandover) が待っている
   * 末尾が送信済み・既に通知付き・assistant の時は添付しない (次の呼び出しで再判定する。 渡し直しも待たせたまま)。
   *
   * 通知の中身 = 現在日時 + composer の dynamic (Goal 節 / ToDo 節) + 待っている渡し直し。
   * 渡し直しは変化の判定 (key) に含めない (1 回限りのものなので、 次の通知で消えても「変わった」 とはしない)。
   * @returns 添付したら true
   */
  attachDynamicContext(now: Date = new Date()): boolean {
    let attached = false;
    const tail = this.messages[this.messages.length - 1];
    if (tail && !this.sentMessages.has(tail) && !tail.contextNote && (tail.role === "tool" || tail.role === "user")) {
      const state = this.compose().dynamic.trim();
      const last = this.lastContextNote;
      const lastGone = last !== null && !this.messages.includes(last.message);
      const handover = this.pendingStateHandover;
      if (last === null || last.key !== state || lastGone || tail.role === "user" || handover !== null) {
        const parts = [`# Current datetime\n${formatLocalDatetime(now)}`];
        if (state.length > 0) parts.push(state);
        if (handover !== null) parts.push(handover);
        tail.contextNote = parts.join("\n\n");
        this.lastContextNote = { key: state, message: tail };
        this.pendingStateHandover = null;
        attached = true;
      }
    }
    for (const m of this.messages) this.sentMessages.add(m);
    return attached;
  }

  /**
   * 次の状態通知に 1 回だけ添える渡し直しを預ける (段階 3 の要約の後。 文面は reduction-summary.ts の
   * buildStateHandover())。 前のものが未添付のまま残っていれば置き換える (古い要約の渡し直しは意味がない)。
   */
  queueStateHandover(note: string): void {
    this.pendingStateHandover = note.trim().length > 0 ? note.trim() : null;
  }

  /** 添付を待っている渡し直し (無ければ null)。 テスト・表示用 */
  getPendingStateHandover(): string | null {
    return this.pendingStateHandover;
  }

  getRawMessages(): Message[] {
    return [...this.messages];
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * @param opts.contextNote セッションの再開で、 保存されていた状態通知を戻すときだけ渡す (送ったときと同じ並びに戻すため)
   */
  addUserMessage(content: string | ContentPart[], opts?: { ephemeral?: boolean; contextNote?: string }): void {
    const msg: Message = { role: "user", content };
    if (opts?.ephemeral) msg.ephemeral = true;
    if (opts?.contextNote) msg.contextNote = opts.contextNote;
    this.messages.push(msg);
  }

  addAssistantMessage(
    content: string,
    toolCalls?: ToolCall[],
    opts?: { ephemeral?: boolean; thinking?: string; displayed?: boolean },
  ): void {
    const msg: Message = { role: "assistant", content };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    // 思考保全 (Phase 2 本実装): thinking がある場合は Message に保存。
    // 終わった依頼の思考は次の整理イベントの前処理で消える (docs/context-reduction-redesign.md §5.2)。
    if (opts?.thinking && opts.thinking.trim().length > 0) {
      msg.thinking = opts.thinking;
    }
    if (opts?.ephemeral) {
      // tool_call を含む assistant メッセージは揮発化禁止 (tool_result とのペアを切ると
      // OpenAI 互換 API で 400 になる)。 開発時に気付けるよう警告だけ出して mark はしない。
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          "[message-history] ephemeral=true は tool_calls を含む assistant メッセージには適用できません。 永続化します。",
        );
      } else if (!opts.displayed) {
        // ユーザーに表示済み (白表示 / ストリーミング出力済み) のテキストは会話記録なので印を付けない。
        // 背景 (2026-06-12): 会話リクエストの実回答が自己点検経路で揮発扱いになり、 除かれて
        // 「モデルが自分の直前の回答を参照できない」 状態が起きた。 ユーザーが読んだ言葉を黙って欠損させない。
        msg.ephemeral = true;
      }
    }
    this.messages.push(msg);
    this.onAssistantMessage?.(content, toolCalls);
  }

  /**
   * 履歴中の system ノート (忘却トゥームストーン / 圧縮要約) を追加する。
   * session 復元用。 これを捨てると「何を忘れたか」 の記録が消え、
   * 次回の忘却で過去分が統合されず新しい記録だけになる。
   */
  addSystemNote(content: string): void {
    this.messages.push({ role: "system", content });
  }

  /**
   * @param opts.contextNote セッションの再開で、 保存されていた状態通知を戻すときだけ渡す (送ったときと同じ並びに戻すため)
   */
  addToolResult(toolCallId: string, content: string, opts?: { contextNote?: string }): void {
    const msg: Message = { role: "tool", content, tool_call_id: toolCallId };
    if (opts?.contextNote) msg.contextNote = opts.contextNote;
    this.messages.push(msg);
  }

  /**
   * 整理イベントの結果でメッセージ列を置き換える (docs/context-reduction-redesign.md §6.1)。
   * tool_calls / tool_result のペア整合を検証し、 壊れていれば例外を投げて
   * 呼び出し側にロールバックさせる (壊れた履歴を送ると provider が 400 を返すため)。
   *
   * 呼び出し側は写しに対して変換し、 ここで 1 回だけ差し替える。 ここが投げたら履歴は元のまま。
   *
   * @param reason 書き換え理由 (prefix_break / cache_miss の原因欄に出る)。 整理イベントは
   *   "reduction:<イベント ID>" (docs/context-reduction-redesign.md §6.1)。 申告の無い既定は "replace"
   */
  replaceMessages(next: Message[], reason = "replace"): void {
    MessageHistory.assertToolPairing(next);
    this.messages = [...next];
    this.noteRewrite(reason);
  }

  /** ツールの対が壊れていれば例外を投げる (中身は findToolPairingError) */
  private static assertToolPairing(messages: Message[]): void {
    const error = findToolPairingError(messages);
    if (error) throw new Error(`[message-history] ${error}`);
  }

  /** 直近 N 往復の会話テキストを返す（意図分類の文脈提供用） */
  getRecentContext(turns: number): string {
    const recent = this.messages.slice(-(turns * 2));
    return recent
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${m.role}]: ${content}`;
      })
      .join("\n");
  }

  getFullText(): string {
    return this.messages
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${content}`;
      })
      .join("\n");
  }

  updateSystemPrompt(prompt: string): void {
    // 書き換えてから申告する (通知先の先読みの確かめが、 新しい並びと比べられるように)
    const changed = prompt !== this.systemPrompt;
    this.systemPrompt = prompt;
    if (changed) this.noteRewrite("system-prompt");
  }

  /** 送信済みの部分を書き換えたことを申告する (理由をためて、 書き換えの回数を進める) */
  private noteRewrite(reason: string): void {
    this.rewriteReasons.push(reason);
    this.revision++;
    this.onRewrite?.(reason);
  }

  /** 送信済みの部分を書き換えた回数 (増えていれば、 その間に書き換えがあった) */
  getRevision(): number {
    return this.revision;
  }

  /** 前回取り出して以降の書き換え理由を返し、 空にする。 送信の直前に呼ぶ。 */
  takeRewriteReasons(): string[] {
    const reasons = this.rewriteReasons;
    this.rewriteReasons = [];
    return reasons;
  }

  /** まだ取り出していない書き換え理由の件数 (取り出さない)。 cache_miss の比べる相手が先読みに替わったときに使う */
  pendingRewriteReasonCount(): number {
    return this.rewriteReasons.length;
  }

  clear(): void {
    this.messages = [];
    this.noteRewrite("clear");
    this.pendingStateHandover = null;
  }
}
