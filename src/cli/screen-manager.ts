/**
 * ScreenManager — 端末出力の唯一の受け口。
 * 設計: docs/tui-alternate-screen.md §3 (ScreenManager) / §4 (ライブ領域の排他制御)
 *
 * ## 段階 1 (docs/tui-alternate-screen.md §10) の実装範囲
 *
 * - 代替画面 (alternate screen) はまだ持たない。`write()` は生 stdout へ素通しする
 * - ライブ領域の「所有権」 と、排他所有中の出力キューイングは完全に実装する
 *   ← 不具合 1 (選択肢の行が複製される) / 2 (選択肢が他の出力に埋もれる) の直接の修正
 * - スクロールバックの行配列だけは先に保持しておく (段階 2 の描画で使う)
 *
 * ## 無限再帰を避ける約束
 *
 * OutputRouter (src/cli/output-router.ts) が `console.log` / `process.stdout.write` を
 * 差し替えて、すべての出力をこの ScreenManager に集約する。
 * したがって ScreenManager 自身が `console.log` や `process.stdout.write` を呼ぶと
 * 自分自身に戻ってきて無限再帰する。実際の書き出しには、モジュール読み込み時 (=差し替え前)
 * に捕まえた `originalStdoutWrite` だけを使うこと。
 */

/**
 * 差し替え前に捕まえた生の書き出し口。
 * このモジュールは output-router より先に評価されるため、ここで掴むのは常に本物。
 */
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

/** 生 stdout へ直接書く。ScreenManager / OutputRouter 専用。 */
export function rawWrite(text: string): void {
  try {
    originalStdoutWrite(text);
  } catch {
    /* EPIPE 等で落とさない (パイプ先が先に閉じることがある) */
  }
}

let rawStdoutView: NodeJS.WriteStream | undefined;

/**
 * 出力の差し替えを受けない stdout のビューを返す。
 *
 * inquirer は「画面を自分で持つ」 側なので、その描画までキューに退避してしまうと
 * プロンプトが一切表示されなくなる。排他所有者にはこのビューを渡し、
 * 描画だけは素通しさせる (§4.3 の「inquirer が画面を完全に持つ」)。
 *
 * `write` だけを生ハンドルに差し替え、`columns` / `on` などその他は本物へ委譲する。
 */
export function getRawStdout(): NodeJS.WriteStream {
  if (rawStdoutView) return rawStdoutView;
  try {
    rawStdoutView = new Proxy(process.stdout, {
      get(target, prop) {
        if (prop === "write") return originalStdoutWrite;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } catch {
    // Proxy が作れない環境では素の stdout に倒す (描画されない方が致命的)
    rawStdoutView = process.stdout;
  }
  return rawStdoutView;
}

export interface LiveOwner {
  /** 所有者の名前 (デバッグ・ログ用) */
  name: string;
  /**
   * ライブ領域を描き直す。これを実装できる所有者は「ソフト所有」 になり、
   * 割り込み出力があっても消えない (§4.2)。
   * 実装できない所有者 (inquirer 等) は undefined を渡して「排他所有」 になる。
   */
  redraw?: () => void;
  /** ライブ領域が今何行あるか (排他所有では使わない) */
  height?: () => number;
}

export interface ScreenManager {
  /** 起動。alt screen に入る (段階 1 / passthrough では何もしない) */
  start(): void;
  /** 終了。alt screen を抜けて内容をスクロールバックへ書き戻す */
  stop(): void;
  /** 出力を 1 つ受け取る。console.log 相当 */
  write(text: string): void;
  /** ライブ領域を取得する。解放関数を返す */
  acquireLive(owner: LiveOwner): () => void;
  /** 今ライブ領域を持っている所有者 (いなければ undefined) */
  currentOwner(): string | undefined;
  /** 代替画面が有効か */
  isAlternate(): boolean;
}

export interface ScreenManagerOptions {
  /** 実際の書き出し先。既定は差し替え前の生 stdout。テストで差し替える */
  sink?: (text: string) => void;
  /** スクロールバックとして保持する最大行数 */
  maxLines?: number;
}

/**
 * カーソル移動 / 行消去 / カーソル表示制御 を含むかどうか。
 * スピナー (ora) や進捗インジケータのフレームはこれらで 1 行を上書きする。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI エスケープの検出そのものが目的
const CURSOR_CONTROL_PATTERN = /[\r\b]|\x1b\[[0-9;]*[A-HJKSTfsu]|\x1b\[\?25[lh]/;

/** 表示可能な文字を含むか (ANSI エスケープと制御文字を除いた中身があるか) */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 同上
const ANSI_SEQUENCE_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g;

interface OwnerEntry {
  owner: LiveOwner;
}

/**
 * 段階 1 の ScreenManager 実装。
 *
 * - 排他所有者がいない間: `write()` は sink へ素通し (従来どおりの表示)
 * - 排他所有者がいる間  : `write()` はキューに退避し、解放時に FIFO でフラッシュ
 * - どちらの場合も、スピナー由来の一過性フレームは記録もキューもしない (§5)
 */
export class ScreenManagerImpl implements ScreenManager {
  private readonly sink: (text: string) => void;
  private readonly maxLines: number;

  /** 表示済みの全行 (ANSI 込み)。末尾要素は「改行待ちの書きかけ行」 */
  private lines: string[] = [""];
  /** 排他所有中に溜めた出力 (FIFO)。順序は絶対に入れ替えない */
  private queue: string[] = [];
  /** ライブ領域の所有者スタック。後ろほど新しい */
  private owners: OwnerEntry[] = [];
  /** 直前の書き込みがカーソル制御だけだったか (スピナーのフレーム判定に使う) */
  private pendingFrameControl = false;
  private started = false;

  constructor(options: ScreenManagerOptions = {}) {
    this.sink = options.sink ?? rawWrite;
    this.maxLines = options.maxLines ?? 10_000;
  }

  start(): void {
    // 段階 1 では代替画面に入らないので状態を立てるだけ。
    // 段階 2 でここに \x1b[?1049h と初回描画が入る。
    this.started = true;
  }

  stop(): void {
    // 溜めたままの出力を捨てないこと (feedback: silent な欠損の禁止)。
    this.owners = [];
    this.flush();
    this.started = false;
  }

  /** start() 済みか (段階 2 で代替画面の入退場判定に使う) */
  isStarted(): boolean {
    return this.started;
  }

  write(text: string): void {
    if (!text) return;

    // スピナー / 進捗インジケータのフレームは一過性の表示であり記録する価値がない (§5)。
    // 排他所有中はキューに積まず捨てる。素通し中はそのまま流す (スピナーは見えてよい)。
    if (this.isTransientFrame(text)) {
      if (this.isExclusive()) return;
      this.sink(text);
      return;
    }

    // 段階 2 の描画のためにスクロールバックへ記録する。
    // キューへ退避する場合も記録はここで 1 回だけ行い、順序を保つ。
    this.appendLines(text);

    if (this.isExclusive()) {
      this.queue.push(text);
      return;
    }
    this.sink(text);
  }

  acquireLive(owner: LiveOwner): () => void {
    const entry: OwnerEntry = { owner };
    this.owners.push(entry);
    let released = false;
    return () => {
      // 二重解放は無視する (withPrompt の finally が例外経路と重なることがある)
      if (released) return;
      released = true;
      const index = this.owners.indexOf(entry);
      if (index !== -1) this.owners.splice(index, 1);
      // 入れ子の内側が解けただけならまだ流さない。外側の排他所有者が残っている
      if (!this.isExclusive()) this.flush();
    };
  }

  currentOwner(): string | undefined {
    return this.owners.at(-1)?.owner.name;
  }

  isAlternate(): boolean {
    // 段階 1 では代替画面を持たない。段階 2 で本実装する。
    return false;
  }

  /**
   * 排他所有中か。
   * redraw を持たない所有者が 1 人でもいれば排他とみなす。
   * (ソフト所有者の上に inquirer が乗るなど、入れ子でも安全側に倒す)
   */
  isExclusive(): boolean {
    return this.owners.some((entry) => !entry.owner.redraw);
  }

  /** 退避中の出力の件数 (テスト・診断用) */
  pendingCount(): number {
    return this.queue.length;
  }

  /** スクロールバックの写し (テスト・段階 2 の描画用)。末尾は書きかけ行 */
  snapshotLines(): string[] {
    return [...this.lines];
  }

  /** 溜めた出力を FIFO でまとめて流す */
  private flush(): void {
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    for (const text of pending) this.sink(text);
  }

  /**
   * 一過性のフレーム (スピナー・進捗インジケータ) かどうかを判定する。
   *
   * 判定方法 (§5 の「フレームは一過性なので記録しない」 という意図に沿った近似):
   *   1. 改行を含む書き込みは「確定した出力」 とみなし、一過性ではない
   *   2. 改行を含まず、カーソル移動 / 行消去 / \r を含む書き込みは一過性
   *   3. 直前が 2. だった場合、続く 1 回の書き込みも同じフレームの続きとみなす
   *      (ora は `cursorTo(0)` とフレーム本文を別々の write で出すため)
   *
   * 3. を「次の 1 回だけ」 に限っているのは、フラグが残り続けて本来の出力
   * (ストリーミングのトークン等) を取りこぼすのを防ぐため。
   */
  private isTransientFrame(text: string): boolean {
    if (text.includes("\n")) {
      this.pendingFrameControl = false;
      return false;
    }
    if (CURSOR_CONTROL_PATTERN.test(text)) {
      this.pendingFrameControl = true;
      return true;
    }
    if (this.pendingFrameControl) {
      this.pendingFrameControl = false;
      return true;
    }
    // ANSI エスケープだけで表示文字が無い書き込み (色リセット等) も記録しない
    return text.replace(ANSI_SEQUENCE_PATTERN, "").length === 0;
  }

  /**
   * 受け取ったテキストを改行で分割して行配列へ追加する (§3.4)。
   * 末尾が改行で終わらない書き込み (ストリーミング中の逐次出力) は最終行に追記する。
   * これをしないと 1 文字ごとに行が増える。
   */
  private appendLines(text: string): void {
    const parts = text.split("\n");
    if (this.lines.length === 0) this.lines.push("");
    this.lines[this.lines.length - 1] += parts[0];
    for (let i = 1; i < parts.length; i++) {
      this.lines.push(parts[i]);
    }
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }
}

/** プロセス全体で 1 つだけ存在する ScreenManager */
export const screen = new ScreenManagerImpl();
