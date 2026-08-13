import ora, { type Options, type Ora } from "ora";
import { screen } from "../cli/screen-manager.js";

/**
 * ora ラッパー。`discardStdin` を必ず false にし、描画先を ScreenManager に向けて生成する。
 *
 * ## discardStdin: false にする理由
 *
 * 背景 (Windows で「応答後にプロンプトで入力できず、Enter を 1 回押すと直る」バグ):
 * ora は既定で `discardStdin: true`。これはスピナー実行中の打鍵が表示を乱さないよう
 * 同梱の stdin-discarder を有効化するが、その実装 (node_modules/stdin-discarder/index.js)
 * は Windows において非対称な不具合を持つ:
 *   - #realStart(): win32 では早期 return し何もしない
 *   - #realStop():  win32 ガードが無く、process.stdin.pause() + setRawMode(false) を実行
 * つまり Windows ではスピナー「停止」のたびに端末が cooked (行バッファ) モードに落ち
 * stdin が pause される。スピナーは LLM の思考/受信中に回り、応答完了＝停止の瞬間に
 * プロンプトへ戻る直前で端末を cooked にするため、ユーザーがそこで打った文字は端末の
 * 行バッファに溜まり、Enter を押すまで届かない。
 *
 * 本アプリは interrupt-watcher が独自に stdin / Ctrl+C を扱うので、ora 側の stdin 操作は
 * 不要かつ有害。discardStdin:false で完全に無効化し、stdin の所有権をアプリ側に一本化する。
 *
 * ## 描画先を差し替える理由 (docs/tui-alternate-screen.md §5)
 *
 * ora の既定の出力先は **stderr** であり、OutputRouter (stdout の差し替え) を素通りする。
 * 代替画面ではカーソル位置を ScreenManager が握っているので、素通りされるとスピナーの
 * フレームが画面の任意の場所に描かれて表示が壊れる。そこで **代替画面のときだけ**
 * 出力先を ScreenManager に向け、一過性フレームとしてライブ領域の状態行に集約させる。
 *
 * 素通しモードでは既定の stderr のままにする。ここで stdout に寄せると
 * `... | tail` のようなパイプ実行でスピナーの ANSI がパイプ側へ流れ込み、
 * 本プロジェクトの検証手段 (パイプモード) を汚してしまう。
 *
 * さらに §5 のとおり、**排他所有中 (inquirer 表示中) は start() しても描画しない**。
 *
 * ora の素の呼び出しと同じシグネチャ (string | Options) を受ける drop-in 置換。
 */

let spinnerStream: NodeJS.WriteStream | undefined;

/**
 * ora に渡す出力ストリーム。`write` だけを ScreenManager に向け、
 * `isTTY` / `columns` などの判定材料は本物の stderr へ委譲する
 * (= 非TTY では従来どおり ora が自分で描画を止める)。
 *
 * `cursorTo` / `clearLine` / `moveCursor` は **束縛せずに** 返す。こうすると呼び出し時の
 * `this` がこのプロキシになり、その内部の `write` も ScreenManager 経由になる。
 * 本物の stderr に束縛してしまうと、そこだけ素通りして画面が壊れる。
 */
function getSpinnerStream(): NodeJS.WriteStream {
  if (spinnerStream) return spinnerStream;
  try {
    spinnerStream = new Proxy(process.stderr, {
      get(target, prop) {
        if (prop === "write") {
          return (chunk: unknown): boolean => {
            screen.write(typeof chunk === "string" ? chunk : String(chunk));
            return true;
          };
        }
        return Reflect.get(target, prop, target);
      },
    });
  } catch {
    // Proxy が作れない環境では素の stderr に倒す (描画されない方が致命的)
    spinnerStream = process.stderr;
  }
  return spinnerStream;
}

export function createSpinner(options?: string | Options): Ora {
  const given: Options = typeof options === "string" ? { text: options } : { ...(options ?? {}) };
  // 代替画面のときだけ ScreenManager 経由にする (素通しモードは従来どおり stderr)。
  // 呼び出し側が明示的に stream を指定していればそちらを尊重する。
  const stream = given.stream ?? (screen.isAlternate() ? getSpinnerStream() : undefined);
  const spinner = ora({ ...given, discardStdin: false, ...(stream ? { stream } : {}) });
  // §5: 排他所有中 (inquirer がプロンプトを描いている間) は回さない。
  // ここで描くと「前回描いた行数ぶん戻る」 という inquirer の前提が崩れる (不具合 1)。
  const rawStart = spinner.start.bind(spinner);
  spinner.start = (text?: string): Ora => {
    if (screen.isExclusive()) {
      if (text !== undefined) spinner.text = text;
      return spinner;
    }
    return rawStart(text);
  };
  return spinner;
}
