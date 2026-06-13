/**
 * 受信順グローバル FIFO キュー。 docs/room-model-design.md §11。
 *
 * 全サーフェス(REPL/Discord/Slack)の入力を「受信(イベント受付)順」 に 1 本のキューへ積み、
 * 単一ワーカーが FIFO で取り出して実行する。 AgentLoop は単一インスタンスで run を同時実行
 * できないため、 これにより同一 Room/別 Room とも到着順に直列化される(ロック不要)。
 *
 * 旧来の per-surface なチャネル実行キューを統合・置換する。 拒否はせず
 * 必ず並ばせる(position>0 を呼び出し元がユーザーへフィードバックする)。
 *
 * ジョブの失敗はチェーンを壊さない(次のジョブは実行される)。
 */
export class RoomRunQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;

  /** 現在キューにある(実行中含む)ジョブ数。 */
  get pending(): number {
    return this.pendingCount;
  }

  /**
   * ジョブを積む。 position = 自分より前に並んでいるジョブ数(0 = 即実行)。
   * result はジョブ自身の完了 Promise(呼び出し元がエラー処理する)。
   */
  enqueue<T>(job: () => Promise<T>): { position: number; result: Promise<T> } {
    const position = this.pendingCount;
    this.pendingCount++;
    const result = this.chain.then(job, job); // 前ジョブの成否に関わらず実行
    this.chain = result
      .catch(() => undefined)
      .finally(() => {
        this.pendingCount--;
      });
    return { position, result };
  }
}
