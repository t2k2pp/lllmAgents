/**
 * PromptGate — プロンプト表示中は他の誰も画面に書かない、を保証する門。
 * 設計: docs/tui-alternate-screen.md §4.3
 *
 * inquirer は「前回描いた行数ぶん上に戻って描き直す」 前提で動く。そこへスピナーや
 * バックグラウンド通知が別の行を書き足すと行数の前提が崩れ、選択肢の行が複製されたり
 * (不具合 1)、選択肢が他の出力に埋もれたり (不具合 2) する。
 *
 * そこで inquirer を呼ぶ箇所をすべて `withPrompt()` で包み、その間だけ
 * ライブ領域を「排他所有」 する。排他所有中、ScreenManager は他の出力をキューへ退避し、
 * プロンプト終了後に FIFO でまとめて流す。
 *
 * ## なぜ出力先まで差し替えるのか
 *
 * OutputRouter が `process.stdout.write` を差し替えているため、inquirer 自身の描画も
 * ScreenManager に流れてしまう。排他所有中はそれがキューへ落ちるので、素直に使うと
 * プロンプトが 1 文字も表示されない。inquirer には「差し替えを受けない生 stdout」 を
 * 渡し、画面を完全に持たせる (§4.3 の「inquirer が画面を完全に持つ」)。
 */
import inquirerDefault from "inquirer";
import type { QuestionMap } from "inquirer";
import {
  select as rawSelect,
  input as rawInput,
  password as rawPassword,
  confirm as rawConfirm,
  checkbox as rawCheckbox,
  Separator,
} from "@inquirer/prompts";
import { screen, getRawStdout } from "./screen-manager.js";

/** inquirer に渡す入出力。出力だけ差し替え前の生 stdout に固定する */
const promptStreams = {
  input: process.stdin,
  output: getRawStdout(),
};

/**
 * プロンプト実行中だけライブ領域を排他所有する。
 *
 * `redraw` を渡さない = 排他所有 (§4.1)。入れ子で呼ばれても壊れないよう、
 * ScreenManager 側は所有者をスタックで持ち、排他所有者が 1 人でも残っている間は
 * キューを流さない。
 */
export async function withPrompt<T>(fn: () => Promise<T> | T): Promise<T> {
  const release = screen.acquireLive({ name: "inquirer" });
  try {
    return await fn();
  } finally {
    // ここで、退避していた出力がまとめて流れる
    release();
  }
}

/**
 * 出力先を生 stdout に固定した inquirer。
 * 呼び出し側は従来どおり `inquirer.prompt(...)` と書ける (import 元だけ差し替える)。
 */
export const inquirer: { prompt: typeof inquirerDefault.prompt } = {
  prompt: inquirerDefault.createPromptModule<Omit<QuestionMap, "__dummy">>(promptStreams),
};

/**
 * @inquirer/prompts の関数を「排他所有 + 生 stdout」 でくるむ。
 * 型 (ジェネリクス) を保つためシグネチャはそのまま通す。
 *
 * 注意: 元の関数は `.cancel()` を生やした CancelablePromise を返すが、ラップ後は
 * 素の Promise になる。現状 `.cancel()` を使っている箇所は無い (使うなら context の
 * `signal` を渡すこと)。
 */
function gate<F>(fn: F): F {
  const wrapped = (config: unknown, context?: Record<string, unknown>): Promise<unknown> => {
    const call = fn as (c: unknown, ctx?: Record<string, unknown>) => Promise<unknown>;
    return withPrompt(() => call(config, { ...promptStreams, ...context }));
  };
  return wrapped as unknown as F;
}

export const select = gate(rawSelect);
export const input = gate(rawInput);
export const password = gate(rawPassword);
export const confirm = gate(rawConfirm);
export const checkbox = gate(rawCheckbox);
export { Separator };
