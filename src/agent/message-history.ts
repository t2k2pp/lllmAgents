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
export class MessageHistory {
  private messages: Message[] = [];
  private systemPrompt: string;
  private onAssistantMessage: AssistantMessageCallback | null = null;
  private ephemeralMessages = new WeakSet<Message>();

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  setAssistantMessageCallback(cb: AssistantMessageCallback | null): void {
    this.onAssistantMessage = cb;
  }

  getMessages(): Message[] {
    return [{ role: "system", content: this.systemPrompt }, ...this.messages];
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
    opts?: { ephemeral?: boolean },
  ): void {
    const msg: Message = { role: "assistant", content };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
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
  }
}
