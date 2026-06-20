/**
 * コスト金額の共通整形ロジック。
 *
 * `/cost rate <円>` で設定する日本円換算レート (1ドルあたりの円) を 1 箇所に集約する。
 * /cost テーブルだけでなく、 Discord/Slack 通知や画像生成コストなど config を直接参照
 * できない場所からも同じ整形を使えるよう、 現在のレートをモジュール状態として保持する。
 *
 * 設計: docs/cost-token-command-design.md
 */

/** 現在の表示レート (1ドルあたりの円)。未設定 (ドル表示) なら undefined */
let currentJpyPerUsd: number | undefined;

/**
 * 表示レートを設定する。 起動時 (config 読込後) と `/cost rate` 変更時に呼ぶ。
 * 0 以下や非数は「未設定 (ドル表示)」として扱う。
 */
export function setDisplayJpyRate(rate: number | undefined): void {
  currentJpyPerUsd = rate && rate > 0 ? rate : undefined;
}

/** 現在の表示レートを取得する (未設定なら undefined) */
export function getDisplayJpyRate(): number | undefined {
  return currentJpyPerUsd;
}

/**
 * コスト金額 (USD) を整形する。
 * jpyPerUsd (1ドルあたりの円) が指定/設定されていれば「円のみ」、 未設定ならドルのみを返す。
 * 第 2 引数を省略すると現在のモジュール表示レート (setDisplayJpyRate) を使う。
 */
export function formatMoney(
  usd: number,
  jpyPerUsd: number | undefined = currentJpyPerUsd,
): string {
  if (jpyPerUsd && jpyPerUsd > 0) {
    return "¥" + Math.round(usd * jpyPerUsd).toLocaleString();
  }
  return "$" + usd.toFixed(4);
}
