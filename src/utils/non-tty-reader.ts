/**
 * 非TTYモード用 stdin 行読み取りシングルトン
 *
 * readline.createInterface を使い回す問題:
 *   パイプ入力は一括でstdinバッファに届く。
 *   readline は内部バッファを持つため、rl.close() 時に
 *   読み込んだが未消費の行が捨てられてしまう。
 *
 * 解決策:
 *   readline を1インスタンスだけ作成し、
 *   REPL と PermissionManager で行キューを共有する。
 */
import * as readline from "node:readline";

class NonTTYLineReader {
  private rl: readline.Interface | null = null;
  private lineQueue: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed = false;

  /**
   * stdin から次の行を返す Promise。
   * すでに読み込み済みの行があればそれを返す。
   * なければ readline の "line" イベントを待つ。
   */
  readLine(): Promise<string> {
    // 先読みキューに残っていればすぐ返す
    if (this.lineQueue.length > 0) {
      return Promise.resolve(this.lineQueue.shift()!);
    }
    if (this.closed) {
      return Promise.resolve("");
    }
    // readline を初期化（初回呼び出し時）
    if (!this.rl) {
      this.init();
    }
    return new Promise<string>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private init(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      // terminal: false でエコーなし・クリア不要
      terminal: false,
      crlfDelay: Infinity,
    });

    this.rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) {
        // 待ちがあればすぐ渡す
        waiter(line.trimEnd());
      } else {
        // 待ちがなければキューに積んでおく
        this.lineQueue.push(line.trimEnd());
      }
    });

    this.rl.once("close", () => {
      this.closed = true;
      // stdin が閉じたら全ての待ちを空文字で解決
      for (const waiter of this.waiters) {
        waiter("");
      }
      this.waiters = [];
    });
  }
}

export const nonTTYReader = new NonTTYLineReader();
