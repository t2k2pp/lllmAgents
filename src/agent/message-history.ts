import type { Message, ToolCall, ContentPart } from "../providers/base-provider.js";

/** アシスタントメッセージ追加時のコールバック */
export type AssistantMessageCallback = (content: string, toolCalls?: ToolCall[]) => void;

/**
 * 揮発フラグの設計メモ:
 *
 * harness が in-turn のリトライ・自己点検・nudge のために注入する補助メッセージは、
 * ユーザー応答完了 (response_complete / 最終 assistant 応答) のタイミングで破棄したい。
 * これにより:
 *   - 過去 span の harness ノイズが次 span の判断を引きずらない
 *   - context 圧迫を抑える (短 ctx の T3 で特に効く)
 *   - LLM が思考した内容を span 内では活用しつつ、 span 境界で「消費し終えた」 として捨てる
 *
 * 設計上の制約:
 *   - tool_call を含む assistant メッセージと、 対応する tool_result (role=tool) は
 *     OpenAI 互換 API 仕様で必ずペアで存在する必要があるため、 揮発化禁止。
 *   - 揮発対象は「assistant の純テキスト (tool_calls なし)」 と「user 役の harness 注入」 のみ。
 *   - フラグは Message オブジェクトには載せない (provider にリークしないよう WeakSet で外置き)。
 */
/**
 * 準システムプロンプト composer の signature。
 * AgentLoop が basePrompt + Goal section + ToDo section + mode info 等を結合する関数を渡す。
 * 毎 getMessages() 呼出で呼ばれて fresh な system prompt を作る (動的合成)。
 *
 * docs/strategic-todo-design.md §2.2 / §3.1 参照。
 */
export type SystemPromptComposer = (basePrompt: string) => string;

export class MessageHistory {
  private messages: Message[] = [];
  private systemPrompt: string;
  private onAssistantMessage: AssistantMessageCallback | null = null;
  private ephemeralMessages = new WeakSet<Message>();
  /**
   * ユーザーに表示済み (白表示 / ストリーミング出力済み) の assistant メッセージ。
   * ephemeral でも span 終了時に purge せず永続化する (promoteDisplayedEphemeral)。
   *
   * 背景 (2026-06-12): 会話リクエストの実回答 (テキストのみ応答) が自己点検経路で
   * ephemeral 扱いになり、 span 終了時に purge されて「モデルが自分の直前の回答を
   * 参照できない」 状態が発生した (ユーザーが回答内容を指摘しても履歴に回答が無い)。
   * ユーザーが読んだ言葉は会話記録であり、 黙って欠損させてはならない。
   */
  private displayedMessages = new WeakSet<Message>();
  /**
   * 動的合成 composer。 注入されていれば getMessages() で毎回呼ばれて準システムプロンプトを作る。
   * 未注入なら従来通り this.systemPrompt をそのまま返す (後方互換)。
   */
  private composer: SystemPromptComposer | null = null;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  setAssistantMessageCallback(cb: AssistantMessageCallback | null): void {
    this.onAssistantMessage = cb;
  }

  /**
   * 準システムプロンプト合成関数を注入する。 AgentLoop が constructor で呼ぶ。
   * これ以降 getMessages() は毎回 composer(this.systemPrompt) を呼んで動的に system prompt を作る。
   */
  setSystemPromptComposer(composer: SystemPromptComposer | null): void {
    this.composer = composer;
  }

  getMessages(): Message[] {
    // 準システムプロンプト: composer があれば毎回再合成、 無ければ既存挙動 (base のみ)
    const finalSystemContent = this.composer ? this.composer(this.systemPrompt) : this.systemPrompt;
    return [
      { role: "system", content: finalSystemContent },
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
      ...this.messages.map((m) => {
        if (m.role === "assistant" && m.thinking) {
          const baseContent = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          const inlined =
            `<thinking>\n` +
            `**以下を踏まえ答えを出す**\n` +
            `${m.thinking}\n` +
            `</thinking>\n\n` +
            `${baseContent}`;
          const out: Message = { role: m.role, content: inlined };
          if (m.tool_calls) out.tool_calls = m.tool_calls;
          if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
          return out;
        }
        return m;
      }),
    ];
  }

  getRawMessages(): Message[] {
    return [...this.messages];
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  addUserMessage(content: string | ContentPart[], opts?: { ephemeral?: boolean }): void {
    const msg: Message = { role: "user", content };
    this.messages.push(msg);
    if (opts?.ephemeral) {
      this.ephemeralMessages.add(msg);
    }
  }

  addAssistantMessage(
    content: string,
    toolCalls?: ToolCall[],
    opts?: { ephemeral?: boolean; thinking?: string; displayed?: boolean },
  ): void {
    const msg: Message = { role: "assistant", content };
    if (opts?.displayed) {
      this.displayedMessages.add(msg);
    }
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    // 思考保全 (Phase 2 本実装): thinking がある場合は Message に保存。
    // span 境界で clearAllThinking() で削除される。
    if (opts?.thinking && opts.thinking.trim().length > 0) {
      msg.thinking = opts.thinking;
    }
    this.messages.push(msg);
    if (opts?.ephemeral) {
      // tool_call を含む assistant メッセージは揮発化禁止 (tool_result とのペアを切ると
      // OpenAI 互換 API で 400 になる)。 開発時に気付けるよう警告だけ出して mark はしない。
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          "[message-history] ephemeral=true は tool_calls を含む assistant メッセージには適用できません。 永続化します。",
        );
      } else {
        this.ephemeralMessages.add(msg);
      }
    }
    this.onAssistantMessage?.(content, toolCalls);
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({
      role: "tool",
      content,
      tool_call_id: toolCallId,
    });
  }

  /**
   * span 境界で呼び出し、 揮発マーク付きメッセージを履歴から除去する。
   * tool_call/tool_result ペアは揮発化していないので破壊されない。
   * @returns 除去した件数
   */
  purgeEphemeral(): number {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => !this.ephemeralMessages.has(m));
    return before - this.messages.length;
  }

  /**
   * ユーザーに表示済みの ephemeral assistant メッセージを永続化する (purge 前に呼ぶ)。
   * ユーザーが読んだ言葉 = 会話記録。 purge すると次 span でモデルが「自分が何を
   * 答えたか」 を参照できず、 指摘への応答が支離滅裂になる (2026-06-12 の実害)。
   * harness 注入の user nudge / 未表示 placeholder は従来通り purge 対象のまま。
   * @returns 永続化した件数
   */
  promoteDisplayedEphemeral(): number {
    let promoted = 0;
    for (const m of this.messages) {
      if (this.ephemeralMessages.has(m) && this.displayedMessages.has(m)) {
        this.ephemeralMessages.delete(m);
        promoted++;
      }
    }
    return promoted;
  }

  /**
   * 思考保全 (Phase 2 本実装) — span 境界で残存する thinking を削除する。
   * tool_call assistant メッセージは永続化されるが、 thinking はユーザー応答時点で
   * 「消費し終えた scratch」 として落とす (commit c5147fd の意図に整合)。
   * @returns 削除した thinking 数
   */
  clearAllThinking(): number {
    let cleared = 0;
    for (const m of this.messages) {
      if (m.role === "assistant" && m.thinking) {
        delete m.thinking;
        cleared++;
      }
    }
    return cleared;
  }

  /** デバッグ・テスト用: 指定メッセージが揮発マークされているか確認 */
  isEphemeral(msg: Message): boolean {
    return this.ephemeralMessages.has(msg);
  }

  replaceOlderMessages(summary: string, keepRecent: number): void {
    if (this.messages.length <= keepRecent) return;

    // 境界が tool_call / tool_result のペアを分断すると、Azure (Responses API) や
    // OpenAI 系で「対応する tool_call が見つからない」400 エラーになる。
    // 境界を前方に移動してペアを recent 側にまとめて含める。
    let boundary = this.messages.length - keepRecent;
    while (boundary > 0) {
      const cur = this.messages[boundary];
      const prev = this.messages[boundary - 1];
      const startsWithToolResult = cur?.role === "tool";
      const prevHasToolCalls =
        prev?.role === "assistant" &&
        Array.isArray(prev.tool_calls) &&
        prev.tool_calls.length > 0;
      if (startsWithToolResult || prevHasToolCalls) {
        boundary--;
      } else {
        break;
      }
    }
    if (boundary <= 0) return; // 全保持に倒す

    const recent = this.messages.slice(boundary);
    this.messages = [
      { role: "system", content: `[会話履歴の要約]\n${summary}` },
      ...recent,
    ];
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
    this.systemPrompt = prompt;
  }

  clear(): void {
    this.messages = [];
    // WeakSet は参照消失で自動 GC されるので明示クリア不要だが、 防御的に新規化
    this.ephemeralMessages = new WeakSet<Message>();
    this.displayedMessages = new WeakSet<Message>();
  }
}
