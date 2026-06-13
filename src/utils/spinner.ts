import ora, { type Options, type Ora } from "ora";

/**
 * ora ラッパー。`discardStdin` を必ず false にして生成する。
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
 * ora の素の呼び出しと同じシグネチャ (string | Options) を受ける drop-in 置換。
 */
export function createSpinner(options?: string | Options): Ora {
  if (typeof options === "string") {
    return ora({ text: options, discardStdin: false });
  }
  return ora({ ...(options ?? {}), discardStdin: false });
}
