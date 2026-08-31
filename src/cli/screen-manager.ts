/**
 * ScreenManager — 端末出力の唯一の受け口。
 * 設計: docs/tui-alternate-screen.md §3 (ScreenManager) / §4 (ライブ領域の排他制御)
 *       / §6 (classic stream) / §7 (stdin の一元化) / §8 (終了処理)
 *
 * ## 実装範囲 (段階 1〜4)
 *
 * - 段階 1: ライブ領域の「所有権」 と、排他所有中の出力キューイング
 *           ← 不具合 1 (選択肢の行が複製される) / 2 (選択肢が他の出力に埋もれる) の修正
 * - 段階 2: 代替画面バッファ (`\x1b[?1049h`) + スクロールバックの全画面再描画 + 16ms 集約
 * - 段階 3: ソフト所有 (`redraw` を持つ所有者は割り込み出力で消えない)
 * - 段階 4: ライブ領域の取得・解放に stdin の状態遷移を結び付ける
 *
 * ## stdin はセッション単位で持ち続ける (docs/stdin-ownership.md)
 *
 * 段階 4 では所有者ごとに raw mode を付け外ししていたが、raw mode は端末というプロセス
 * 全体で 1 つしかない資源であり、「使う人が来たら on、帰ったら off」 では **誰も持って
 * いない一瞬**が必ずできる。その一瞬に打鍵すると OS の行バッファに溜まり、Enter を押す
 * まで届かない (不具合 4 の残存症状)。
 *
 * そこで `start()` で取得したら `stop()` まで **保持し続ける**。
 * `acquireLive()` / `release()` は所有者の種別を問わず「保持を再確認する」 だけにする
 * (inquirer は終了時に自前で cooked へ戻すため、再確認が必要)。
 *
 * ## 描画は必ず「全画面再描画」 にする
 *
 * 差分描画は「前回描いた行数ぶん戻る」 前提を持ち込むことになり、それはまさに不具合 1 の
 * 構造そのものである (§3.5)。速度は 16ms のフレーム集約で担保し、差分描画は入れない。
 *
 * ## 無限再帰を避ける約束
 *
 * OutputRouter (src/cli/output-router.ts) が `console.log` / `process.stdout.write` を
 * 差し替えて、すべての出力をこの ScreenManager に集約する。
 * したがって ScreenManager 自身が `console.log` や `process.stdout.write` を呼ぶと
 * 自分自身に戻ってきて無限再帰する。実際の書き出しには、モジュール読み込み時 (=差し替え前)
 * に捕まえた `originalStdoutWrite` (= `rawWrite`) だけを使うこと。
 *
 * ライブ領域の所有者 (入力欄・進捗インジケータ) も同じ理由で `process.stdout.write` では
 * なく `screen.writeLive()` を使う。ライブ領域の描画はスクロールバックには記録しない。
 */
import { getDisplayWidth, truncateAnsiToWidth } from "../utils/display-width.js";

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

// ─── 代替画面を使ってよいかの判定 (§6.1 / §11) ─────────────────

/** `shouldUseAlternateScreen` に渡す環境。テストから差し替えられるよう引数にする */
export interface AlternateScreenEnv {
  /** LLLMAGENT_DISABLE_ALTERNATE_SCREEN */
  disable?: string;
  /** 起動引数 --no-alt-screen */
  disableByCli?: boolean;
  /** process.stdout.isTTY */
  isTTY?: boolean;
  /** TERM */
  term?: string;
  /** process.platform */
  platform?: string;
  /** Windows Terminal (WT_SESSION) */
  wtSession?: string;
  /** TERM_PROGRAM (VS Code / iTerm2 等) */
  termProgram?: string;
  /** ConEmuANSI */
  conEmuANSI?: string;
  /** ANSICON */
  ansicon?: string;
}

/**
 * 代替画面バッファを使ってよいかを判定する (§6.1)。
 *
 * 以下のいずれかでclassic stream表示 (= false):
 *   1. --no-alt-screen、または環境変数 LLLMAGENT_DISABLE_ALTERNATE_SCREEN が設定されている
 *   2. process.stdout.isTTY が false (パイプ・リダイレクト・CI)
 *
 * TTYなのに能力が不足・不明な場合は黙って表示を変えず、原因が分かるようfail-fastする。
 * classic stream表示を意図するユーザーは明示的に --no-alt-screen を選べる。
 */
export function shouldUseAlternateScreen(env: AlternateScreenEnv): boolean {
  if (env.disableByCli) return false;
  const disable = env.disable;
  if (disable !== undefined && disable !== "" && disable !== "0" && disable.toLowerCase() !== "false") {
    return false;
  }
  if (!env.isTTY) return false;
  const term = env.term ?? "";
  if (term === "dumb") {
    throw new Error(
      "TUIを開始できません: TERM=dumb はAlternate Screenに対応していません。" +
        "端末設定を修正するか、classic stream表示を意図する場合だけ --no-alt-screen を指定してください。",
    );
  }

  if (env.platform === "win32") {
    // Windows は端末の実装差が大きい。能力不明を黙ってclassic表示には落とさない。
    const known = env.wtSession || env.termProgram || env.conEmuANSI || env.ansicon || term;
    if (!known) {
      throw new Error(
        "TUIを開始できません: Windows端末のANSI/Alternate Screen対応を判定できません。" +
          "Windows Terminal等を使うか、classic stream表示を意図する場合だけ --no-alt-screen を指定してください。",
      );
    }
    return true;
  }
  if (term === "") {
    throw new Error(
      "TUIを開始できません: TTYですがTERMが未設定のため端末能力を判定できません。" +
        "TERMを正しく設定するか、classic stream表示を意図する場合だけ --no-alt-screen を指定してください。",
    );
  }
  return true;
}

/** 実際の process.env / process.stdout から判定材料を集める */
function readAlternateScreenEnv(): AlternateScreenEnv {
  return {
    disable: process.env.LLLMAGENT_DISABLE_ALTERNATE_SCREEN,
    disableByCli: process.argv.slice(2).includes("--no-alt-screen"),
    isTTY: !!process.stdout.isTTY,
    term: process.env.TERM,
    platform: process.platform,
    wtSession: process.env.WT_SESSION,
    termProgram: process.env.TERM_PROGRAM,
    conEmuANSI: process.env.ConEmuANSI,
    ansicon: process.env.ANSICON,
  };
}

// ─── 型 ────────────────────────────────────────────────

export interface LiveOwner {
  /** 所有者の名前 (デバッグ・ログ用) */
  name: string;
  /**
   * ライブ領域を描き直す。これを実装できる所有者は「ソフト所有」 になり、
   * 割り込み出力があっても消えない (§4.2)。
   * 実装できない所有者 (inquirer 等) は undefined を渡して「排他所有」 になる。
   *
   * 呼ばれる時点で「ライブ領域は消去済み・カーソルは領域の先頭」 が保証される。
   */
  redraw?: () => void;
  /** ライブ領域が今何行あるか (排他所有では使わない) */
  height?: () => number;
  /**
   * 自分の描画を消す。classic stream モード (代替画面なし) で割り込み出力を
   * 差し込む前に呼ばれる。設計 §4.2 の「入力中の文字列が消えない」 を
   * 代替画面なしでも成立させるために必要 (代替画面では全画面再描画で足りる)。
   */
  clear?: () => void;
}

export interface ScreenManager {
  /** 起動。alt screen に入る (classic stream / 非TTYでは何もしない) */
  start(): void;
  /** 終了。alt screen を抜けて内容をスクロールバックへ書き戻す */
  stop(): void;
  /** 出力を 1 つ受け取る。console.log 相当 */
  write(text: string): void;
  /** ライブ領域の所有者による描画。スクロールバックに記録しない */
  writeLive(text: string): void;
  /** ライブ領域の高さが変わった等で描き直しを要求する (代替画面のみ有効) */
  refreshLive(): void;
  /** spinner libraryのframe分割に依存せず、一過性の状態行を更新する */
  updateTransientStatus(text: string): void;
  /** 一過性の状態行を消す */
  clearTransientStatus(): void;
  /** ライブ領域を取得する。解放関数を返す */
  acquireLive(owner: LiveOwner): () => void;
  /** 今ライブ領域を持っている所有者 (いなければ undefined) */
  currentOwner(): string | undefined;
  /** 代替画面が有効か */
  isAlternate(): boolean;
  /** スクロールバックを遡る (代替画面のみ)。行数省略で 1 画面ぶん */
  scrollUp(lines?: number): void;
  /** スクロールバックを戻す (代替画面のみ)。行数省略で 1 画面ぶん */
  scrollDown(lines?: number): void;
  /** 最下部 (追従状態) へ戻す */
  scrollToBottom(): void;
  /** stdin の raw mode を ScreenManager が保持しているか (docs/stdin-ownership.md §3.1) */
  holdsStdinRaw(): boolean;
  /** stdin を継承する子プロセスへ端末を渡す前に raw を手放す (§3.4) */
  suspendStdin(): void;
  /** suspendStdin() で手放した raw を取り戻す (§3.4) */
  resumeStdin(): void;
  /**
   * 生 stdin を自分で読む担い手を登録する (§3.3)。
   * 登録されている間は最下位の `\x03` 保険を止める。解除関数を返す。
   */
  registerStdinConsumer(name: string): () => void;
}

export interface ScreenManagerOptions {
  /** 実際の書き出し先。既定は差し替え前の生 stdout。テストで差し替える */
  sink?: (text: string) => void;
  /** スクロールバックとして保持する最大行数 */
  maxLines?: number;
  /** 代替画面を使うかを明示指定する (省略時は §6.1 の自動判定)。テスト用 */
  alternate?: boolean;
  /** §6.1 の端末能力判定入力。省略時は実環境。テスト用 */
  alternateEnv?: AlternateScreenEnv;
  /** 画面の行数。既定は process.stdout.rows */
  rows?: () => number;
  /** 画面の桁数。既定は process.stdout.columns */
  columns?: () => number;
  /** stdin の状態遷移対象 (§7)。既定は process.stdin。テストで差し替える */
  stdin?: ManagedStdin | null;
}

/**
 * ScreenManager が面倒を見る stdin。
 * `on` / `off` は `\x03` 保険 (docs/stdin-ownership.md §3.3) の購読に使う。
 * 実装していない差し替え stdin (テスト等) でも壊れないよう任意扱いにする。
 */
export type ManagedStdin = Pick<NodeJS.ReadStream, "isTTY" | "isRaw" | "setRawMode" | "resume"> &
  Partial<Pick<NodeJS.ReadStream, "on" | "off">>;

/**
 * カーソル移動 / 行消去 / カーソル表示制御 を含むかどうか。
 * スピナー (ora) や進捗インジケータのフレームはこれらで 1 行を上書きする。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI エスケープの検出そのものが目的
const CURSOR_CONTROL_PATTERN = /[\r\b]|\x1b\[[0-9;]*[A-HJKSTfsu]|\x1b\[\?25[lh]/;

/** 表示可能な文字を含むか (ANSI エスケープと制御文字を除いた中身があるか) */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 同上
const ANSI_SEQUENCE_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** 描画のフレーム集約間隔 (§3.5)。連続する write() を 1 回の描画にまとめる */
const FRAME_INTERVAL_MS = 16;

/**
 * スピナー由来の状態行を表示し続ける上限。
 * ora が止まると新しいフレームが来なくなるので、古い行を出しっぱなしにしない。
 */
const STATUS_LINE_TTL_MS = 1_000;

/** ライブ領域の高さ変化を追いかけて描き直す回数の上限 (暴走防止) */
const MAX_RENDER_PASSES = 3;

/**
 * raw mode 中の Ctrl+C。端末が SIGINT を生成しないのでバイトとして届く
 * (docs/stdin-ownership.md §3.3)。
 */
const CTRL_C_BYTE = 0x03;

/** PageUp / PageDown。修飾キー付きのCSI (`\x1b[5;2~`等) も同じ操作として扱う。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: raw stdinのANSI CSI検出そのものが目的
const SCROLL_KEY_PATTERN = /\x1b\[(5|6)(?:;\d+)?~/g;

/** 複数data chunkへ分割されたCSIを復元するために保持する最大文字数。 */
const SCROLL_SEQUENCE_TAIL_CHARS = 24;

/** stdin のチャンクに Ctrl+C が含まれるか。encoding 設定次第で文字列で届くことがある */
function containsCtrlC(chunk: Buffer | string | null | undefined): boolean {
  if (chunk == null) return false;
  if (typeof chunk === "string") return chunk.includes("\x03");
  if (typeof chunk.includes !== "function") return false;
  return chunk.includes(CTRL_C_BYTE);
}

interface OwnerEntry {
  owner: LiveOwner;
}

/**
 * ScreenManager 実装。
 *
 * - 排他所有者がいる間  : `write()` はキューに退避し、解放時に FIFO でフラッシュ
 * - 代替画面あり        : `write()` はスクロールバックへ積み、16ms 後に全画面再描画
 * - 代替画面なし (素通し): `write()` は sink へそのまま流す (従来どおりの表示)
 * - どちらの場合も、スピナー由来の一過性フレームは記録もキューもしない (§5)
 */
export class ScreenManagerImpl implements ScreenManager {
  private readonly sink: (text: string) => void;
  private readonly maxLines: number;
  private readonly forcedAlternate?: boolean;
  private readonly alternateEnv?: AlternateScreenEnv;
  private readonly rowsOf: () => number;
  private readonly columnsOf: () => number;
  private readonly stdin: ScreenManagerOptions["stdin"];

  /** 表示済みの全行 (ANSI 込み)。末尾要素は「改行待ちの書きかけ行」 */
  private lines: string[] = [""];
  /** 排他所有中に溜めた出力 (FIFO)。順序は絶対に入れ替えない */
  private queue: string[] = [];
  /** ライブ領域の所有者スタック。後ろほど新しい */
  private owners: OwnerEntry[] = [];
  /** 直前の書き込みがカーソル制御だけだったか (スピナーのフレーム判定に使う) */
  private pendingFrameControl = false;
  private started = false;
  /** 代替画面に入っているか */
  private alternate = false;
  /** 0 = 最下部に追従。>0 で遡り中 (§3.4) */
  private viewOffset = 0;
  /** 遡り始めてから増えた行数 (下端の「▼ 新しい出力が N 行」 に使う) */
  private newLinesWhileScrolled = 0;
  /** 描画のフレーム集約タイマー */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  /** 描画中フラグ (redraw() 内からの再入を防ぐ) */
  private rendering = false;
  /** ライブ領域の高さ変化を追いかけて描き直した回数 (暴走防止) */
  private renderPass = 0;
  /**
   * stdin の raw mode を ScreenManager が保持しているか
   * (docs/stdin-ownership.md §3.1)。start() で立ち stop() で降りる。
   */
  private stdinRawHeld = false;
  /** suspendStdin() で一時的に手放しているか (§3.4) */
  private stdinSuspended = false;
  /** 生 stdin を自分で読む担い手の数 (§3.3 の `\x03` 保険を止める条件) */
  private stdinConsumers = 0;
  /** 最下位の `\x03` 監視 (§3.3)。保持中だけ購読する */
  private sigintFallback: ((chunk: Buffer | string) => void) | null = null;
  /** PageUp/PageDownのCSIがdata chunk境界を跨いだ場合の末尾。 */
  private scrollSequenceTail = "";
  /** 代替画面で表示するスピナーの最新フレーム (ライブ領域の所有者がいないときだけ描く) */
  private statusLine = "";
  private statusAtMs = 0;
  /** 端末リサイズ購読 (stop で外す) */
  private resizeHandler: (() => void) | null = null;

  constructor(options: ScreenManagerOptions = {}) {
    this.sink = options.sink ?? rawWrite;
    this.maxLines = options.maxLines ?? 10_000;
    this.forcedAlternate = options.alternate;
    this.alternateEnv = options.alternateEnv;
    this.rowsOf = options.rows ?? (() => process.stdout.rows || 24);
    this.columnsOf = options.columns ?? (() => process.stdout.columns || 80);
    this.stdin = options.stdin === undefined ? process.stdin : options.stdin;
  }

  // ─── 起動・終了 (§8) ──────────────────────────────────

  start(): void {
    if (this.started) return;
    // TTY能力不明を黙って別表示へ落とさない。判定失敗時はraw modeへ触れる前に
    // fail-fastし、元の端末状態と診断理由を保つ。
    const alternate = this.forcedAlternate ?? shouldUseAlternateScreen(this.alternateEnv ?? readAlternateScreenEnv());
    this.started = true;
    this.alternate = alternate;
    // stdin はセッションの間ずっと保持する (docs/stdin-ownership.md §3.1)。
    // 代替画面を使うかどうかとは独立。素通しモードでも「誰も持っていない一瞬」 は作らない。
    try {
      this.acquireStdinRaw();
    } catch (error) {
      this.started = false;
      this.alternate = false;
      throw error;
    }
    if (!this.alternate) return;

    // 代替画面へ入り、画面を消してから初回描画する
    this.sink("\x1b[?1049h\x1b[2J\x1b[H");
    this.resizeHandler = () => this.renderNow();
    try {
      process.stdout.on("resize", this.resizeHandler);
    } catch {
      this.resizeHandler = null;
    }
    this.renderNow();
  }

  /**
   * 終了処理 (§8)。
   *
   * 代替画面を抜けたあと、**スクロールバックの内容を通常画面へ書き戻す**。
   * これをしないと「セッション終了後にログが何も残らない」 という、
   * 現行方式には無い退行が起きる。
   *
   * 何度呼ばれても壊れないこと (正常終了 / process.on("exit") / SIGINT / 例外が重なる)。
   */
  stop(): void {
    this.owners = [];
    this.cancelRender();
    // ここで初めて cooked に戻す (docs/stdin-ownership.md §3.1)。
    // stop() は tui-alternate-screen.md §8 の全経路 (exit / SIGINT / SIGTERM / 未捕捉例外)
    // から呼ばれるので、異常終了でも端末が raw のまま残らない。
    this.releaseStdinRaw();
    const wasAlternate = this.alternate;
    this.alternate = false;

    if (wasAlternate) {
      // カーソルを戻し、ブラケット貼り付けを解除してから通常画面へ
      this.sink("\x1b[?25h\x1b[?2004l\x1b[?1049l");
      // 退避中の出力はすべてスクロールバックにも記録済み。書き戻しに含まれるので
      // ここで再度流すと二重になる。捨てているのではなく下で必ず出力される
      this.queue = [];
      this.writeBackScrollback();
    } else {
      // 溜めたままの出力を捨てないこと (feedback: silent な欠損の禁止)
      this.flush();
    }
    if (this.resizeHandler) {
      try {
        process.stdout.off("resize", this.resizeHandler);
      } catch {
        /* ignore */
      }
      this.resizeHandler = null;
    }
    this.started = false;
  }

  /** start() 済みか */
  isStarted(): boolean {
    return this.started;
  }

  /** 代替画面の内容を通常画面のスクロールバックへ書き戻す (§8) */
  private writeBackScrollback(): void {
    const body = this.lines.join("\n");
    if (body.length === 0) return;
    this.sink(body.endsWith("\n") ? body : `${body}\n`);
  }

  // ─── 出力 ────────────────────────────────────────────

  write(text: string): void {
    if (!text) return;

    // スピナー / 進捗インジケータのフレームは一過性の表示であり記録する価値がない (§5)。
    // 排他所有中はキューに積まず捨てる。素通し中はそのまま流す (スピナーは見えてよい)。
    // 代替画面ではカーソル位置を ScreenManager が握っているので直接は描かせず、
    // 「最新のフレーム = 状態行」 として覚えておいてライブ領域に描く (下の drawStatus)。
    if (this.isTransientFrame(text)) {
      if (this.isExclusive()) return;
      if (this.alternate) {
        this.captureStatusLine(text);
        return;
      }
      this.sink(text);
      return;
    }

    // 確定した出力が来たらスピナーの役目は終わり。状態行を消す
    this.statusLine = "";

    // スクロールバックへ記録する。キューへ退避する場合も記録はここで 1 回だけ行い、順序を保つ。
    this.appendLines(text);

    if (this.isExclusive()) {
      this.queue.push(text);
      return;
    }

    if (this.alternate) {
      this.scheduleRender();
      return;
    }

    // ── 素通しモード ──
    // ソフト所有者 (入力欄など) がいるなら、その描画を一度消してから割り込み出力を差し込み、
    // 描き直す。これで「入力中の文字列が消えない」 (§4.2) が代替画面なしでも成立する。
    const soft = this.softOwner();
    if (soft?.redraw) {
      soft.clear?.();
      this.sink(text);
      if (!text.endsWith("\n")) this.sink("\n");
      soft.redraw();
      return;
    }
    this.sink(text);
  }

  /**
   * ライブ領域の所有者による描画 (§4.2)。
   * スクロールバックには記録せず、排他所有者がいる間は描かない
   * (inquirer が画面を完全に持っている最中に入力欄が割り込むのを防ぐ)。
   */
  writeLive(text: string): void {
    if (!text) return;
    if (this.isExclusive()) return;
    this.sink(text);
  }

  /** ライブ領域の高さが変わった等で描き直しを要求する (代替画面のみ) */
  refreshLive(): void {
    if (!this.alternate) return;
    this.scheduleRender();
  }

  /**
   * 代替画面の状態行を明示更新する。
   * oraのcursor制御と本文は複数writeに分かれるため、Proxy越しのframe推定だけを
   * user-visible progressの唯一の経路にしない。
   */
  updateTransientStatus(text: string): void {
    if (!text || !this.started || !this.alternate || this.isExclusive()) return;
    this.statusLine = text;
    this.statusAtMs = Date.now();
    this.scheduleRender();
  }

  clearTransientStatus(): void {
    if (!this.statusLine) return;
    this.statusLine = "";
    if (this.alternate) this.scheduleRender();
  }

  /**
   * 代替画面で ora のスピナーを消さないための「状態行」 (§5 の補足)。
   *
   * ora はライブラリ内部で stdout に 1 行を上書きし続ける。代替画面ではカーソル位置を
   * ScreenManager が握っているため素通しさせると画面が壊れる。かといって捨てるだけだと
   * 「考え中...」 が一切見えなくなり、現行方式からの退行になる。そこで最新フレームの
   * 本文だけを覚えておき、ライブ領域の所有者がいないときに 1 行として描く。
   *
   * カーソル制御だけのチャンク (ora は `cursorTo` と本文を別々に書く) は無視し、
   * 本文を含むチャンクだけを採用する。
   */
  private captureStatusLine(text: string): void {
    const visible = text
      .replace(ANSI_SEQUENCE_PATTERN, "")
      .replace(/[\r\b]/g, "")
      .trim();
    if (!visible) return;
    // 行を上書きする類の制御は落として本文 (色は残す) だけを持つ
    this.statusLine = text.replace(/[\r\b]/g, "");
    this.statusAtMs = Date.now();
    this.scheduleRender();
  }

  /** 表示すべき状態行 (古くなったものは出さない) */
  private activeStatusLine(): string {
    if (!this.statusLine) return "";
    if (Date.now() - this.statusAtMs > STATUS_LINE_TTL_MS) return "";
    return this.statusLine;
  }

  // ─── ライブ領域の所有権 (§4) ─────────────────────────

  acquireLive(owner: LiveOwner): () => void {
    const entry: OwnerEntry = { owner };
    // 所有者の種別を問わず raw を再確認する (docs/stdin-ownership.md §3.1)。
    // 段階 4 は `if (!owner.redraw) return` で inquirer をスキップしていたが、
    // 塞ぎたいのは「inquirer が自分で raw にする前の一瞬」 なのでスキップしてはいけない。
    // 失敗時に幽霊ownerを残さないため、raw確認後にだけ登録する。
    this.ensureStdinRaw();
    this.owners.push(entry);

    if (this.alternate) {
      if (owner.redraw) {
        this.scheduleRender();
      } else {
        // 排他所有 = inquirer に画面を明け渡す。直前までの内容を上から並べ、
        // カーソルを内容の直後に置いて「そこから下は inquirer のもの」 にする
        this.renderForPrompt();
      }
    }

    let released = false;
    return () => {
      // 二重解放は無視する (withPrompt の finally が例外経路と重なることがある)
      if (released) return;
      released = true;
      const index = this.owners.indexOf(entry);
      if (index !== -1) this.owners.splice(index, 1);
      // cooked に戻さない。代わりに raw を再確認し直す (docs/stdin-ownership.md §3.2)。
      // inquirer は終了時に自前で cooked へ戻すため、ここで塞がないと
      // 「次の所有者が来るまでの一瞬」 が cooked になる。
      this.ensureStdinRaw();
      // 入れ子の内側が解けただけならまだ流さない。外側の排他所有者が残っている
      if (this.isExclusive()) return;
      if (this.alternate) {
        // 内容はスクロールバックに記録済み。全画面再描画で一度に出る
        this.queue = [];
        this.renderNow();
      } else {
        this.flush();
      }
    };
  }

  currentOwner(): string | undefined {
    return this.owners.at(-1)?.owner.name;
  }

  isAlternate(): boolean {
    return this.alternate;
  }

  /**
   * 排他所有中か。
   * redraw を持たない所有者が 1 人でもいれば排他とみなす。
   * (ソフト所有者の上に inquirer が乗るなど、入れ子でも安全側に倒す)
   */
  isExclusive(): boolean {
    return this.owners.some((entry) => !entry.owner.redraw);
  }

  /** 一番上のソフト所有者 (排他所有者がいるときは undefined) */
  private softOwner(): LiveOwner | undefined {
    if (this.isExclusive()) return undefined;
    return this.owners.at(-1)?.owner;
  }

  /** 退避中の出力の件数 (テスト・診断用) */
  pendingCount(): number {
    return this.queue.length;
  }

  /** スクロールバックの写し (テスト・診断用)。末尾は書きかけ行 */
  snapshotLines(): string[] {
    return [...this.lines];
  }

  /** 溜めた出力を FIFO でまとめて流す (素通しモード用) */
  private flush(): void {
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    for (const text of pending) this.sink(text);
  }

  // ─── stdin の一元化 (§7.2 / docs/stdin-ownership.md §3) ───────────

  /** stdin の raw mode を保持しているか (§3.1)。他の担い手が解除を控える判断に使う */
  holdsStdinRaw(): boolean {
    return this.stdinRawHeld && !this.stdinSuspended;
  }

  /**
   * セッションの開始時に raw mode を取得し、以後 stop() まで保持する (§3.1)。
   * 非 TTY (パイプ・リダイレクト) では何もしない。
   */
  private acquireStdinRaw(): void {
    const stdin = this.stdin;
    if (!stdin?.isTTY) return;
    this.applyRawMode();
    this.stdinRawHeld = true;
    this.stdinSuspended = false;
    this.installSigintFallback();
  }

  /**
   * 保持しているはずの raw mode が外れていないか確認し、外れていたら戻す (§3.1)。
   * 所有者の取得・解放のたびに呼ぶ。保持していない (start 前 / stop 後 / suspend 中) なら何もしない。
   */
  private ensureStdinRaw(): void {
    if (!this.stdinRawHeld || this.stdinSuspended) return;
    this.applyRawMode();
  }

  /**
   * 実際に raw mode を適用する。取得できなければ別入力方式へ黙って落とさず例外にする。
   *
   * libuv は要求モードが内部キャッシュと一致すると何もしないため、子プロセスや
   * inquirer が実コンソールのモードを変えた後は setRawMode(true) 単発では復旧
   * できないことがある。一度 false に落としてから true にして実モードと同期させる。
   *
   * 溜まっている入力は読み捨てない (捨てるとユーザーが先に打った文字が消える)。
   */
  private applyRawMode(): void {
    const stdin = this.stdin;
    if (!stdin?.isTTY) return;
    try {
      if (stdin.isRaw) stdin.setRawMode(false);
      stdin.setRawMode(true);
      stdin.resume();
    } catch (error) {
      throw new Error(
        `TTY raw modeを取得できないため対話sessionを開始できません: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** セッション終了。ここで初めて cooked に戻す (§3.1) */
  private releaseStdinRaw(): void {
    this.uninstallSigintFallback();
    this.scrollSequenceTail = "";
    if (!this.stdinRawHeld) return;
    this.stdinRawHeld = false;
    this.stdinSuspended = false;
    const stdin = this.stdin;
    if (!stdin?.isTTY) return;
    try {
      stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    // pause() はしない。溜まっている入力を落とさないため (§7.2)
  }

  /**
   * stdin を継承する子プロセスへ端末を渡す前に raw を手放す (§3.4)。
   *
   * 現状 `bash` ツールは `stdio: ["ignore", ...]` で stdin を子に渡していないため
   * 呼び出し側は無い。将来 stdin を継承する実行経路を足すときに前後で挟むこと。
   */
  suspendStdin(): void {
    if (!this.stdinRawHeld || this.stdinSuspended) return;
    this.stdinSuspended = true;
    this.uninstallSigintFallback();
    const stdin = this.stdin;
    if (!stdin?.isTTY) return;
    try {
      stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }

  /** suspendStdin() で手放した raw を取り戻す (§3.4) */
  resumeStdin(): void {
    if (!this.stdinRawHeld || !this.stdinSuspended) return;
    this.stdinSuspended = false;
    try {
      this.applyRawMode();
    } catch (error) {
      this.stdinSuspended = true;
      throw error;
    }
    this.installSigintFallback();
  }

  /**
   * 生 stdin を自分で読む担い手を登録する (§3.3)。
   *
   * `InterruptWatcher` のようにライブ領域の所有者ではないが Ctrl+C を自分で処理する
   * 担い手は、ここに登録して `\x03` 保険の二重発火を防ぐ。
   * 名前はデバッグ用で、動作には使わない。
   */
  registerStdinConsumer(_name: string): () => void {
    this.stdinConsumers++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.stdinConsumers = Math.max(0, this.stdinConsumers - 1);
    };
  }

  /** 生 stdin を読む担い手の数 (テスト・診断用) */
  stdinConsumerCount(): number {
    return this.stdinConsumers;
  }

  /**
   * 最下位の `\x03` 監視を張る (§3.3)。
   *
   * raw mode では Ctrl+C が SIGINT にならず `\x03` バイトとして届く。
   * raw を保持し続ける以上、誰も読んでいない一瞬があると Ctrl+C が効かなくなる。
   * **他の担い手が 1 人もいない間だけ** SIGINT を合成して既存のハンドラに委ねる。
   * 担い手がいる間は何もしないので、既存の Ctrl+C 処理と競合しない。
   */
  private installSigintFallback(): void {
    if (this.sigintFallback) return;
    const stdin = this.stdin;
    if (!stdin?.isTTY || typeof stdin.on !== "function") return;
    const listener = (chunk: Buffer | string): void => {
      if (!this.stdinRawHeld || this.stdinSuspended) return;
      // Alternate Screenでは端末本来のscrollbackが使えないため、入力欄が無いLLM/tool
      // 実行中もScreenManagerがPageUp/PageDownを受け持つ。排他prompt中だけはprompt側へ譲る。
      if (this.alternate && !this.isExclusive()) this.handleScrollInput(chunk);
      // ライブ領域の所有者 (入力欄 / inquirer) や生 stdin の担い手 (InterruptWatcher) が
      // いる間は、その人が自分で Ctrl+C を処理する。保険は黙っている。
      if (this.owners.length > 0 || this.stdinConsumers > 0) return;
      if (!containsCtrlC(chunk)) return;
      try {
        process.emit("SIGINT");
      } catch {
        /* ignore */
      }
    };
    this.sigintFallback = listener;
    try {
      stdin.on("data", listener);
    } catch {
      this.sigintFallback = null;
    }
  }

  private uninstallSigintFallback(): void {
    const listener = this.sigintFallback;
    if (!listener) return;
    this.sigintFallback = null;
    const stdin = this.stdin;
    if (typeof stdin?.off !== "function") return;
    try {
      stdin.off("data", listener);
    } catch {
      /* ignore */
    }
  }

  /** raw stdinのdata chunkからPageUp/PageDownを観測する。入力自体は消費せず、他のlistenerへも届く。 */
  private handleScrollInput(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const previousTailLength = this.scrollSequenceTail.length;
    const combined = this.scrollSequenceTail + text;
    SCROLL_KEY_PATTERN.lastIndex = 0;
    for (const match of combined.matchAll(SCROLL_KEY_PATTERN)) {
      const end = (match.index ?? 0) + match[0].length;
      // 前回tailに完全に含まれていたsequenceは再処理しない。chunk境界を跨いだものと
      // 今回chunk内で完結したものだけがpreviousTailLengthを越える。
      if (end <= previousTailLength) continue;
      if (match[1] === "5") this.scrollUp();
      else this.scrollDown();
    }
    this.scrollSequenceTail = combined.slice(-SCROLL_SEQUENCE_TAIL_CHARS);
  }

  // ─── スクロールバックの保持 (§3.4) ───────────────────

  /**
   * 受け取ったテキストを改行で分割して行配列へ追加する (§3.4)。
   * 末尾が改行で終わらない書き込み (ストリーミング中の逐次出力) は最終行に追記する。
   * これをしないと 1 文字ごとに行が増える。
   */
  private appendLines(text: string): void {
    const parts = text.split("\n");
    if (this.lines.length === 0) this.lines.push("");
    this.lines[this.lines.length - 1] += parts[0];
    const added = parts.length - 1;
    for (let i = 1; i < parts.length; i++) {
      this.lines.push(parts[i]);
    }
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
    // 遡り中は視点を動かさない (§3.4)。増えたぶんだけオフセットも押し上げる
    if (added > 0 && this.viewOffset > 0) {
      this.viewOffset += added;
      this.newLinesWhileScrolled += added;
    }
  }

  // ─── スクロール操作 (§3.4) ───────────────────────────

  scrollUp(lines?: number): void {
    if (!this.alternate) return;
    const step = lines ?? Math.max(1, this.viewportHeight() - 1);
    const viewHeight = this.viewportHeight();
    // 履歴が通常viewportに収まるなら遡る必要はない。溢れている場合は、遡り中に
    // 案内行を1行確保したcontent heightを上限計算にも使い、最古行まで到達可能にする。
    const max = this.lines.length <= viewHeight ? 0 : Math.max(0, this.lines.length - Math.max(1, viewHeight - 1));
    this.viewOffset = Math.min(max, this.viewOffset + step);
    this.renderNow();
  }

  scrollDown(lines?: number): void {
    if (!this.alternate) return;
    const step = lines ?? Math.max(1, this.viewportHeight() - 1);
    this.viewOffset = Math.max(0, this.viewOffset - step);
    if (this.viewOffset === 0) this.newLinesWhileScrolled = 0;
    this.renderNow();
  }

  scrollToBottom(): void {
    if (!this.alternate) return;
    if (this.viewOffset === 0) return;
    this.viewOffset = 0;
    this.newLinesWhileScrolled = 0;
    this.renderNow();
  }

  /** 遡り中か (テスト・診断用) */
  scrollOffset(): number {
    return this.viewOffset;
  }

  /** スクロールバック表示に使える行数 (ライブ領域を除いた高さ) */
  private viewportHeight(): number {
    const rows = Math.max(2, this.rowsOf());
    const live = Math.min(Math.max(0, this.liveHeight()), rows - 1);
    return Math.max(1, rows - live);
  }

  /**
   * ライブ領域が何行必要か。
   * ソフト所有者がいればその高さ。いなければスピナーの状態行 1 行 (あれば)。
   */
  private liveHeight(): number {
    const owner = this.softOwner();
    if (owner?.height) {
      try {
        return Math.max(0, owner.height());
      } catch {
        return 0;
      }
    }
    if (owner) return 0;
    return this.activeStatusLine() ? 1 : 0;
  }

  // ─── 描画 (§3.5) ─────────────────────────────────────

  /** 16ms のフレーム集約。連続する write() を 1 回の描画にまとめる */
  private scheduleRender(): void {
    if (!this.alternate || this.rendering) return;
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, FRAME_INTERVAL_MS);
    this.renderTimer.unref?.();
  }

  private cancelRender(): void {
    if (!this.renderTimer) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  /** 集約を待たずに即描画する (起動時・所有権の変化時・スクロール操作時) */
  private renderNow(): void {
    this.cancelRender();
    this.render();
  }

  /**
   * 全画面再描画 (§3.5)。
   *   1. カーソルを隠す
   *   2. ライブ領域の高さ h を所有者から取得
   *   3. viewport 高 = rows - h
   *   4. lines の該当範囲を上から書く (行ごとに \x1b[2K で消してから)
   *   5. ライブ領域を所有者の redraw() で描かせる
   *   6. カーソルを表示
   */
  private render(): void {
    if (!this.alternate || !this.started) return;
    if (this.rendering) return;
    if (this.isExclusive()) return; // inquirer が画面を持っている間は触らない
    this.rendering = true;
    try {
      const owner = this.softOwner();
      const rows = Math.max(2, this.rowsOf());
      const columns = Math.max(1, this.columnsOf());
      const reserved = Math.min(Math.max(0, this.liveHeight()), rows - 1);
      const viewH = Math.max(1, rows - reserved);
      // 遡り中は最下行を案内表示に使う
      const scrolled = this.viewOffset > 0;
      const contentH = scrolled ? Math.max(1, viewH - 1) : viewH;

      const total = this.lines.length;
      const maxOffset = Math.max(0, total - contentH);
      if (this.viewOffset > maxOffset) this.viewOffset = maxOffset;
      const end = total - this.viewOffset;
      const start = Math.max(0, end - contentH);
      const visible = this.lines.slice(start, end);

      let out = "\x1b[?25l";
      for (let i = 0; i < contentH; i++) {
        out += `\x1b[${i + 1};1H\x1b[2K`;
        const line = visible[i];
        if (line) out += truncateAnsiToWidth(line, columns);
      }
      if (scrolled) {
        out += `\x1b[${viewH};1H\x1b[2K`;
        out += truncateAnsiToWidth(this.scrollHint(), columns);
      }
      // ライブ領域を消してから所有者に渡す
      for (let i = 0; i < reserved; i++) {
        out += `\x1b[${viewH + 1 + i};1H\x1b[2K`;
      }
      out += `\x1b[${reserved > 0 ? viewH + 1 : viewH};1H`;
      this.sink(out);

      if (owner?.redraw) {
        try {
          owner.redraw();
        } catch {
          /* 所有者の描画失敗で画面全体を落とさない */
        }
      } else if (reserved > 0) {
        // 所有者がいない = スピナーの状態行を描く枠
        this.sink(truncateAnsiToWidth(this.activeStatusLine(), columns));
      }
      this.sink("\x1b[?25h");

      // 描いた結果ライブ領域の高さが変わっていたら、確保し直してもう一度描く。
      // (入力が折り返して行数が増えた場合など。通常は 2 パスで収束する)
      // 万一収束しない実装の所有者がいても画面を止めないよう、パス数に上限を設ける。
      if (Math.min(Math.max(0, this.liveHeight()), rows - 1) !== reserved && this.renderPass < MAX_RENDER_PASSES) {
        this.renderPass++;
        this.rendering = false;
        try {
          this.renderNow();
        } finally {
          this.renderPass--;
        }
      }
    } finally {
      this.rendering = false;
    }
  }

  /** 遡り中に最下行へ出す案内 (§3.4) */
  private scrollHint(): string {
    const n = this.newLinesWhileScrolled;
    const text = n > 0 ? `▼ 新しい出力が ${n} 行 (PgDn で下へ)` : `▼ 下に ${this.viewOffset} 行 (PgDn で下へ)`;
    // 反転表示。桁計算は共通の getDisplayWidth を使う (§11)
    const pad = Math.max(0, Math.min(this.columnsOf(), 200) - getDisplayWidth(text));
    return `\x1b[7m${text}${" ".repeat(pad)}\x1b[0m`;
  }

  /**
   * 排他所有 (inquirer) に画面を明け渡すための描画。
   * 直前までの内容を上から並べ、カーソルを内容の直後に置く。
   * inquirer はそこから下に自分のプロンプトを描き、自前の行数管理で描き直す。
   */
  private renderForPrompt(): void {
    this.cancelRender();
    const rows = Math.max(2, this.rowsOf());
    const columns = Math.max(1, this.columnsOf());
    const keep = Math.max(1, rows - 1);
    const start = Math.max(0, this.lines.length - keep);
    const visible = this.lines.slice(start).map((l) => truncateAnsiToWidth(l, columns));
    this.sink(`\x1b[?25h\x1b[2J\x1b[H${visible.join("\r\n")}`);
  }

  // ─── 一過性フレームの判定 (§5) ───────────────────────

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
}

/** プロセス全体で 1 つだけ存在する ScreenManager */
export const screen = new ScreenManagerImpl();
