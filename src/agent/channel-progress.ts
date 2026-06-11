/**
 * チャネル進捗トラッカー (A-4: docs/channel-progress-design.md)
 *
 * AgentEventBus を購読してチャネル非依存に進捗テキストを組み立て、
 * チャネル固有の「メッセージ編集関数」をスロットリング付きで呼ぶ。
 * 1 つの進捗メッセージを編集し続ける方式 (新規メッセージ連投 = 通知スパムを避ける)。
 */

import type { AgentEventBus, Unsubscribe } from "./agent-events.js";
import { formatDuration } from "./task-reporter.js";

const MAX_RECENT_LINES = 5;
const MAX_LINE_CHARS = 80;

function truncateLine(s: string): string {
  const oneLine = s.replace(/\s*\n\s*/g, " ");
  return oneLine.length > MAX_LINE_CHARS ? oneLine.slice(0, MAX_LINE_CHARS) + "…" : oneLine;
}

export class ChannelProgressTracker {
  private startMs = Date.now();
  private toolCount = 0;
  /** 完了したツール・警告の直近行 (最新 MAX_RECENT_LINES 件) */
  private recent: string[] = [];
  /** 実行中ツール: callId → summary */
  private running = new Map<string, string>();
  private lastUpdateMs = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private detachFns: Unsubscribe[] = [];
  private stopped = false;

  constructor(
    /** 進捗メッセージの編集関数 (Slack: chat.update / Discord: webhook PATCH)。 失敗は無視される */
    private update: (text: string) => Promise<unknown>,
    /** 編集の最小間隔 (レート制限対策)。 間隔内のイベントは coalesce される */
    private minIntervalMs = 5000,
  ) {}

  attach(events: AgentEventBus): this {
    this.detachFns.push(
      events.on("tool_start", (e) => {
        this.running.set(e.callId, e.summary);
        this.schedule();
      }),
      events.on("tool_end", (e) => {
        this.running.delete(e.callId);
        this.toolCount++;
        const mark = e.success ? "✓" : "✗";
        const suffix = e.success ? "" : `: ${e.error ?? "failed"}`;
        this.pushRecent(`${mark} ${truncateLine(e.summary + suffix)}`);
        this.schedule();
      }),
      events.on("harness_notice", (e) => {
        // 自己点検 (info) はノイズのため除外。 warn/error のみ進捗に混ぜる
        if (e.level !== "info") {
          this.pushRecent(`⚠ ${truncateLine(e.message)}`);
          this.schedule();
        }
      }),
    );
    return this;
  }

  /** 購読解除 + 以後の編集停止。 完了時に最終応答側がメッセージを確定させる前に呼ぶ */
  detach(): void {
    this.stopped = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    for (const off of this.detachFns) off();
    this.detachFns = [];
  }

  /** 現在の進捗テキスト */
  buildText(): string {
    const elapsed = formatDuration(Date.now() - this.startMs);
    const lines = [`⏳ 処理中... (${elapsed} · 🔧 ${this.toolCount} tools)`];
    lines.push(...this.recent);
    for (const summary of this.running.values()) {
      lines.push(`▶ ${truncateLine(summary)}`);
    }
    return lines.join("\n");
  }

  private pushRecent(line: string): void {
    this.recent.push(line);
    if (this.recent.length > MAX_RECENT_LINES) this.recent.shift();
  }

  /** スロットリング付き編集。 間隔内は trailing edge で coalesce (最新状態を必ず反映) */
  private schedule(): void {
    if (this.stopped) return;
    const since = Date.now() - this.lastUpdateMs;
    if (since >= this.minIntervalMs) {
      this.flush();
      return;
    }
    if (this.pendingTimer) return; // 既に trailing 更新が予約済み
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.flush();
    }, this.minIntervalMs - since);
  }

  private flush(): void {
    if (this.stopped) return;
    this.lastUpdateMs = Date.now();
    // 進捗表示はベストエフォート: 編集失敗で本処理を止めない
    this.update(this.buildText()).catch(() => {});
  }
}
