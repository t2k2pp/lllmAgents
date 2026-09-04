import ora, { type Options, type Ora, type PersistOptions } from "ora";
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
 * ## 代替画面では Ora を起動しない (docs/tui-alternate-screen.md §5)
 *
 * ora の既定の出力先は **stderr** であり、代替画面のScreenManagerを素通りする。
 * 加えて実PTYでは Ora.stop/succeed が戻らずUI更新を塞ぐ事象があるため、代替画面では
 * Oraのtimerを始動せず、互換操作をScreenManagerの一過性statusへ写像する。
 *
 * 素通しモードでは既定の stderr のままにする。ここで stdout に寄せると
 * `... | tail` のようなパイプ実行でスピナーの ANSI がパイプ側へ流れ込み、
 * 本プロジェクトの検証手段 (パイプモード) を汚してしまう。
 *
 * さらに §5 のとおり、**排他所有中 (inquirer 表示中) は start() しても描画しない**。
 *
 * ora の素の呼び出しと同じシグネチャ (string | Options) を受けるdrop-in置換。
 */

export function createSpinner(options?: string | Options): Ora {
  const given: Options = typeof options === "string" ? { text: options } : { ...(options ?? {}) };

  // alternate screenではOraのtimer/stop処理を起動しない。実PTY上ではOra.stop/succeedが
  // 戻らず、受信済みresponse previewやresponse_complete後のREPL復帰を塞ぐ端末依存事象が
  // Linux/macOSの双方で再現した。ScreenManager自身が一過性statusを描画できるため、
  // ここではOra互換の公開操作だけをScreenManagerへ写像し、stdinとtimerの所有者を増やさない。
  if (screen.isAlternate() || screen.currentOwner() === "processing-input") {
    const spinner = ora({ ...given, discardStdin: false });
    let text = given.text ?? "";
    let active = false;
    let managed: Ora;

    const setText = (next?: string): void => {
      if (next !== undefined) text = next;
      if (active) screen.updateTransientStatus(text);
    };
    const stop = (): Ora => {
      if (active) screen.clearTransientStatus();
      active = false;
      return managed;
    };
    const persist = (symbol: string, next?: string): Ora => {
      setText(next);
      stop();
      console.log(`${symbol} ${text}`);
      return managed;
    };

    managed = new Proxy(spinner, {
      get(target, prop, receiver) {
        if (prop === "text") return text;
        if (prop === "isSpinning") return active;
        if (prop === "start") {
          return (next?: string): Ora => {
            if (next !== undefined) text = next;
            if (screen.isExclusive()) return managed;
            active = true;
            screen.updateTransientStatus(text);
            return managed;
          };
        }
        if (prop === "stop" || prop === "clear") return stop;
        if (prop === "succeed") return (next?: string): Ora => persist("✔", next);
        if (prop === "fail") return (next?: string): Ora => persist("✖", next);
        if (prop === "warn") return (next?: string): Ora => persist("⚠", next);
        if (prop === "info") return (next?: string): Ora => persist("ℹ", next);
        if (prop === "stopAndPersist") {
          return (persistOptions?: PersistOptions): Ora => persist(persistOptions?.symbol ?? " ", persistOptions?.text);
        }
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop, value, receiver) {
        if (prop === "text") {
          text = String(value);
          if (active) screen.updateTransientStatus(text);
          return true;
        }
        return Reflect.set(target, prop, value, receiver);
      },
    });
    return managed;
  }

  // 素通しモードは従来どおりOraのstderr描画を使う。呼び出し側のstream指定も保持する。
  const spinner = ora({ ...given, discardStdin: false });
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
