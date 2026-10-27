/**
 * 先読みの表示と取り消し (docs/context-reduction-redesign.md §9.6)。
 *
 * 先読みは裏で数分〜数十分続く。 表示が無いと、 利用者には本体の読み込みと見分けられない (2026-10-27 実機)。
 * そこで先読みの間は、 本体の 「LLM処理中...」 とは違う言い方の状態行を出し続け、 経過時間を毎秒更新する。
 * - 代替画面: 入力欄・スピナーの上の 1 行 (screen.setBackgroundStatus)。 消すまで出る
 * - 素通しの画面・パイプ: 動き続ける行は出さず、 始まりと終わりの行だけを出す
 * 本体・脇の呼び出しが先読みの終わりを待つ間は 「待っています」 の言い方に替える (素通しの画面では 1 行出す)。
 * 終わったら状態行を消し、 結果の 1 行 (済んだ・失敗・取り消した + 理由) を出す。
 *
 * 進み具合 (サーバが読み終えたトークン数) は出さない。 送る量の見込みと経過時間だけを出す
 * (llama.cpp の進み具合の通知はサーバの版と設定に依存し、 取れないときの別の取り方を重ねない。 §9.6)。
 *
 * 取り消し: 入力待ちで入力欄が空のときの Esc (interactive-input が cancelFromEscape を呼ぶ)。 処理中の Esc は
 * いつもどおり処理ごと中断し、 先読みも切る (AgentLoop.abort)。 取り消しの方法はこの Esc だけ。
 */
import chalk from "chalk";
import type { PrewarmOutcome, PrewarmRunningStatus } from "../agent/prewarm.js";
import { screen } from "./screen-manager.js";

/** 表示の出し先 (試験では差し替える) */
export interface PrewarmIndicatorOutput {
  /** 状態行を出し続けられるか (代替画面) */
  live(): boolean;
  /** 状態行を出す・替える (null で消す) */
  setStatus(text: string | null): void;
  /** 確定した 1 行を出す */
  log(line: string): void;
}

const defaultOutput: PrewarmIndicatorOutput = {
  live: () => screen.isAlternate(),
  setStatus: (text) => screen.setBackgroundStatus(text === null ? null : chalk.cyan(text)),
  log: (line) => console.log(chalk.dim(`  ${line}`)),
};

/** トークン数の読みやすい言い方 (1.2万 / 40.1万 / 900) */
export function formatTokenCount(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return n.toLocaleString("en-US");
}

/** 経過時間の言い方 (12秒 / 3分12秒 / 1時間40分) */
export function formatElapsedJa(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/** 状態行の文 (先読み中 / 待っている) */
export function formatPrewarmStatus(status: PrewarmRunningStatus, now: number): string {
  const size = status.promptTokens > 0 ? `約 ${formatTokenCount(status.promptTokens)} トークン · ` : "";
  const elapsed = formatElapsedJa(now - status.startedAt);
  if (status.waitingFor !== null) {
    return `⏳ 先読みの終わりを待っています (読み終われば次の呼び出しはキャッシュを使えます) · ${size}${elapsed} · Esc で取り消し`;
  }
  return `⇣ 先読み中 (次の呼び出しに備えて会話をサーバに読ませています) · ${size}${elapsed} · Esc で取り消し`;
}

/** 終わりの 1 行 */
export function formatPrewarmEnd(outcome: PrewarmOutcome): string | null {
  switch (outcome.status) {
    case "done":
      return `先読みが終わりました (${formatElapsedJa(outcome.durationMs)})。 次の呼び出しは読み込んだ会話を使えます`;
    case "failed":
      return null; // 失敗は AgentLoop が黄色の 1 行で出す (作業には影響しない旨を添える)
    case "aborted":
      if (outcome.kind === "user") return "先読みを取り消しました (Esc)";
      if (outcome.kind === "stale") {
        return outcome.reason?.startsWith("会話を整理する")
          ? "会話を整理したので、 古い並びの先読みを止めました"
          : `次の呼び出しで送る中身が変わったので、 古い並びの先読みを止めました (${outcome.reason ?? "並びの変化"})`;
      }
      if (outcome.kind === "replaced") return null; // 続けて新しい先読みの始まりを出す
      return `先読みを止めました (${outcome.reason ?? "中断"})`;
    case "skipped":
      return null;
    default: {
      const exhaustive: never = outcome;
      return String(exhaustive);
    }
  }
}

export class PrewarmIndicator {
  private status: PrewarmRunningStatus | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cancel: (() => boolean) | null = null;

  constructor(
    private readonly output: PrewarmIndicatorOutput = defaultOutput,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 先読みを取り消す関数を登録する (AgentLoop が作るときに 1 回) */
  setCancelHandler(cancel: (() => boolean) | null): void {
    this.cancel = cancel;
  }

  /** いま出している状態行の文 (出していなければ null。 試験・/prewarm status 用) */
  currentText(): string | null {
    return this.status === null ? null : formatPrewarmStatus(this.status, this.now());
  }

  isActive(): boolean {
    return this.status !== null;
  }

  begin(status: PrewarmRunningStatus): void {
    this.status = { ...status };
    if (this.output.live()) this.render();
    else this.output.log(formatPrewarmStatus(this.status, this.now()));
    // 起動の途中 (代替画面に入る前) に始まった先読みも、 画面に入った後は状態行に出す
    this.startTimer();
  }

  /** 本体・脇の呼び出しが先読みの終わりを待ち始めた */
  waiting(status: PrewarmRunningStatus): void {
    this.status = { ...status };
    if (this.output.live()) this.render();
    else this.output.log(formatPrewarmStatus(this.status, this.now()));
  }

  end(outcome: PrewarmOutcome): void {
    this.stopTimer();
    const wasActive = this.status !== null;
    this.status = null;
    if (wasActive) this.output.setStatus(null);
    const line = formatPrewarmEnd(outcome);
    if (line !== null) this.output.log(line);
  }

  /**
   * 入力待ちの Esc (入力欄が空のとき)。 先読み中なら先読みだけを取り消す。
   * @returns 取り消したなら true (先読みが無ければ false。 呼び出し側はいつもどおりの扱いを続ける)
   */
  cancelFromEscape(): boolean {
    if (this.status === null || this.cancel === null) return false;
    return this.cancel();
  }

  private render(): void {
    if (this.status !== null && this.output.live()) {
      this.output.setStatus(formatPrewarmStatus(this.status, this.now()));
    }
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.render(), 1000);
    // 表示の更新だけのためにプロセスを残さない
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** アプリ全体で 1 つの表示 (AgentLoop が出し、 入力欄の Esc が取り消す) */
export const prewarmIndicator = new PrewarmIndicator();
