/**
 * Claude Code風インタラクティブ入力
 *
 * /コマンドや@ファイルパスを入力すると、入力行の下部にリアルタイムで
 * ドロップダウン候補が表示される。カーソルキーで選択しEnterで確定。
 *
 * 特徴:
 * - raw stdinでキーストロークを1つずつ処理
 * - ANSI エスケープシーケンスでドロップダウンを描画
 * - Shift+Enter でマルチライン入力（モダンターミナル対応）
 * - 入力履歴 (↑↓)
 * - マルチバイト文字（日本語）対応
 * - TTY非対応時はreadlineフォールバック
 */

import * as readline from "node:readline";
import chalk from "chalk";
import { nonTTYReader } from "../utils/non-tty-reader.js";
import { getDisplayWidth, stripAnsi, truncateToWidth } from "../utils/display-width.js";
import { screen } from "./screen-manager.js";
import { getOpsLogger } from "../utils/ops-logger.js";

// 幅計算は共通実装を使う (docs/tui-alternate-screen.md §11: 幅計算を 2 箇所に書かない)。
// 既存の import 元を壊さないよう、ここから再エクスポートする。
export { getDisplayWidth } from "../utils/display-width.js";

// ─── 公開型 ─────────────────────────────────────────────

export interface MenuItem {
  label: string;
  value: string;
  description?: string;
}

export type MenuProvider = (partial: string) => MenuItem[];

export interface InteractiveInputOptions {
  /** /コマンド候補を返すプロバイダー */
  commandProvider?: MenuProvider;
  /** @ファイルパス候補を返すプロバイダー */
  filePathProvider?: MenuProvider;
}

/** Ctrl+C が押されたことを示す特殊値 */
export const SIGINT_SIGNAL = "\x03";

// ─── stdin チャンク分類 ──────────────────────────────────

/** classifyChunkNewline の判定結果 */
export type ChunkNewlineKind =
  /** 改行を含まない (通常のタイプ・IME確定テキスト) */
  | "none"
  /** 本文の途中に改行がある = マルチライン貼り付け (Enter は改行挿入として扱う) */
  | "paste-burst"
  /** 改行が末尾のみ = 「1行ぶんのテキスト + Enter」 または単発 Enter (Enter は確定として扱う) */
  | "line-submit";

const CR = 0x0d;
const LF = 0x0a;

/**
 * 生 stdin チャンクの改行位置から「貼り付け」 と「行確定」 を区別する。
 *
 * 背景 (2026-06-13): IME で日本語を確定した直後の Enter を ConPTY が
 * 「続けて\r」 のような 1 チャンクに合流させることがある。 旧判定
 * (複数バイト + 改行 = 貼り付け) はこれを貼り付けと誤検出し、 Enter が
 * 確定でなく改行挿入になって「一度無駄に Enter を押さないと送信できない」
 * 症状を起こした。 真のマルチライン貼り付けは本文の途中に改行を持つので、
 * 「改行が末尾だけ」 のチャンクは行確定として扱う。
 *
 * トレードオフ: ブラケット貼り付け非対応端末 (legacy conhost) で貼り付けが
 * 行単位のチャンクに分かれて届いた場合、 1 行目が即確定し得る。 タイプした
 * Enter の飲み込み (毎回の送信失敗) の方が実害が大きいため行確定側に倒す。
 */
export function classifyChunkNewline(chunk: Buffer): ChunkNewlineKind {
  if (chunk.length === 0) return "none";
  let end = chunk.length;
  while (end > 0 && (chunk[end - 1] === CR || chunk[end - 1] === LF)) end--;
  const body = chunk.subarray(0, end);
  if (body.includes(CR) || body.includes(LF)) return "paste-burst"; // 本文中に改行
  if (end === chunk.length) return "none"; // 改行を含まない
  return "line-submit"; // 改行は末尾のみ ("テキスト+Enter" 合流 or 単発 Enter)
}

// ─── メインクラス ───────────────────────────────────────

export class InteractiveInput {
  private commandProvider: MenuProvider;
  private filePathProvider: MenuProvider;
  private history: string[] = [];
  private historyIndex = -1;
  private keypressInitialized = false;
  private dataListenerInstalled = false;
  /** stdin に「本文中に改行を含む」 chunk が届いた直近時刻 + 猶予 (ms) — この時刻まで届く \r は改行扱い */
  private pasteBurstUntilMs = 0;
  /**
   * stdin に「改行が末尾のみ」 の chunk が届いた直近時刻 + 猶予 (ms)。
   * この時刻までの \r は貼り付け判定 (pasteBurst / 連続キー間隔) を打ち消して
   * 通常の確定 Enter として扱う。 IME 確定 + Enter の ConPTY 合流対策 (2026-06-13)。
   */
  private lineSubmitUntilMs = 0;

  /** rawModeWatchdog が発火した回数 (§7.3 — 0 のままなら当て木を外せる) */
  private watchdogFireCount = 0;

  constructor(options: InteractiveInputOptions = {}) {
    this.commandProvider = options.commandProvider ?? (() => []);
    this.filePathProvider = options.filePathProvider ?? (() => []);
  }

  /**
   * rawModeWatchdog の発火をログに残す (§7.3)。
   *
   * 所有権を ScreenManager に一元化した以上、ここが発火するのは「誰かがまだ勝手に
   * stdin を触っている」 という設計違反の証拠である。黙って直すと気付けないので記録する。
   * 500ms ごとに走るためログが溢れないよう、最初の数回だけ出す。
   */
  private logWatchdogFired(reason: string): void {
    this.watchdogFireCount++;
    if (this.watchdogFireCount > 5) return;
    try {
      getOpsLogger().warn("tui", `rawModeWatchdog fired: ${reason}`, {
        count: this.watchdogFireCount,
        note: "docs/tui-alternate-screen.md §7.3 — stdin の所有権が一元化されていれば発火しないはず",
      });
    } catch {
      /* ログ失敗で入力を止めない */
    }
  }

  /**
   * プロンプトを表示しユーザー入力を返す。
   * Shift+Enter で改行を挿入し、Enter で確定。
   * @param prefix  プロンプト文字列 (例: "> ")
   * @param options.disableMenu  trueならドロップダウンを抑制
   */
  async question(prefix: string, options?: { disableMenu?: boolean }): Promise<string> {
    if (!process.stdin.isTTY) {
      return this.fallbackQuestion(prefix);
    }
    return this.interactiveQuestion(prefix, options?.disableMenu ?? false);
  }

  // ─── readline フォールバック（非TTY） ────────────────

  private fallbackQuestion(prefix: string): Promise<string> {
    // 非TTYモードでは NonTTYReader シングルトンを使う
    // （readline.createInterface を毎回作ると内部バッファが失われる問題を回避）
    process.stdout.write(prefix);
    return nonTTYReader.readLine();
  }

  // ─── インタラクティブ入力（メイン） ──────────────────

  private interactiveQuestion(prefix: string, disableMenu: boolean): Promise<string> {
    return new Promise<string>((resolve) => {
      const stdin = process.stdin;
      /**
       * 入力欄の描画はすべてここを通す (docs/tui-alternate-screen.md §4.2)。
       *
       * `process.stdout.write` は OutputRouter に差し替えられており、そのまま使うと
       * 自分の描画がスクロールバックへ記録され、代替画面では再描画が自分を呼び返す。
       * `writeLive` はスクロールバックに記録せず、排他所有 (inquirer) 中は描かない。
       */
      const out = (text: string): void => screen.writeLive(text);
      /** 行全体を消す (旧 stdout.clearLine(0) 相当) */
      const clearLine = (): void => out("\x1b[2K");
      /** 絶対桁へカーソルを移す (旧 stdout.cursorTo(col) 相当。col は 0 起点) */
      const cursorToCol = (col: number): void => out(`\x1b[${Math.max(0, col) + 1}G`);
      /**
       * 1 行下へ移る。代替画面ではライブ領域の行が ScreenManager によって確保済みなので
       * カーソル移動で足りる。改行を書くと画面全体がスクロールして描画がズレる。
       */
      const newRow = (): void => out(screen.isAlternate() ? "\x1b[1B" : "\n");

      // emitKeypressEvents は一度だけ呼ぶ
      if (!this.keypressInitialized) {
        readline.emitKeypressEvents(stdin);
        this.keypressInitialized = true;
      }

      // 生 stdin チャンクを観測して貼り付けを検出（ブラケット貼り付け非対応端末向け）。
      // emitKeypressEvents の data 購読と並行して動き、keypress イベントより前に発火する。
      // 同じ chunk から keypress イベントが順次発火するため、その間 isPasteBurst を有効化する。
      if (!this.dataListenerInstalled) {
        stdin.on("data", (chunk: Buffer) => {
          // 改行の位置で「マルチライン貼り付け」 と「行確定」 を区別する (classifyChunkNewline)。
          //   paste-burst: 本文中に改行 = 貼り付けほぼ確実 → 200ms の間 \r を改行扱い
          //                (同じ貼り付けから後続の keypress が発火し終わるまで保持)
          //   line-submit: 改行が末尾のみ = 「タイプした 1 行 + Enter」 の合流 or 単発 Enter
          //                → 200ms の間 \r を確定扱い (貼り付けバースト継続中を除く)
          // 単独マルチバイト文字 (日本語 IME 確定など) は改行を含まないのでどちらにも該当しない。
          const kind = classifyChunkNewline(chunk);
          const now = Date.now();
          if (kind === "paste-burst") {
            this.pasteBurstUntilMs = now + 200;
          } else if (kind === "line-submit" && now >= this.pasteBurstUntilMs) {
            this.lineSubmitUntilMs = now + 200;
          }
        });
        this.dataListenerInstalled = true;
      }

      // 入力待ち中のウォッチドッグ: バックグラウンド処理（Discord/Slack/ループ経由の
      // processInput）が interruptWatcher.stop() や inquirer 後始末で raw mode を外したり
      // stdin を pause すると、プロンプト表示中なのに入力が反応しなくなる。
      // 定期検査で自動復旧し、「一度改行しないと入力できない」状態を防ぐ。
      //
      // §7.3: stdin の所有権が ScreenManager に一元化された今、これは本来不要な当て木で
      // ある。いきなり外すと退行が怖いので 1 リリースの間は残すが、**発火したらログに
      // 残す**。発火しなくなったことを確認できたら削除する。
      const rawModeWatchdog = setInterval(() => {
        if (!stdin.isTTY) return;
        if (!stdin.isRaw) {
          stdin.setRawMode(true);
          this.logWatchdogFired("raw mode が解除されていたので再適用した");
        }
        if (stdin.isPaused()) {
          stdin.resume();
          this.logWatchdogFired("stdin が pause されていたので resume した");
        }
      }, 500);
      rawModeWatchdog.unref?.();

      // ─── 状態 ──────────────────────────────────

      let buffer = "";
      let cursorPos = 0;
      let menuItems: MenuItem[] = [];
      let selectedIndex = 0;
      let menuVisible = false;
      let renderedMenuLines = 0;
      let renderedInputLines = 1;
      /** カーソルが現在いるターミナル行 (入力行0からの相対) */
      let cursorTermRow = 0;
      let savedHistoryBuffer = "";
      /** ブラケット貼り付け中フラグ */
      let inPaste = false;
      /** 貼り付け中に蓄積される文字（終了マーカー受信時に一括で buffer に反映） */
      let pasteAccumulated = "";
      /** 直前キーイベントの時刻（ms） — ブラケット貼り付け非対応端末向けのフォールバック */
      let lastKeyTimeMs = 0;
      /** 直前のキーが \r (CR) だったか — \r\n が連続して届いた場合に \n を吸収するために使う */
      let lastKeyWasReturn = false;
      /** 連続キー検出閾値 — これ未満の間隔で届いた \r は貼り付けとみなし改行として扱う。
       *  人間の最速タイプは概ね 130ms/key なので 30ms なら安全に区別できる。 */
      const FAST_PASTE_DELTA_MS = 30;

      const prefixLen = getDisplayWidth(stripAnsi(prefix));
      // 継続行のプレフィックス（プロンプトと同じ幅のスペース）
      const contPrefixStr = " ".repeat(prefixLen);
      const contPrefixLen = prefixLen;

      /** ライブ領域の解放関数 (acquireLive の戻り)。cleanup で必ず呼ぶ */
      let releaseLive: (() => void) | null = null;
      /** 直近に ScreenManager へ通知したライブ領域の高さ */
      let lastLiveHeight = 1;

      // ─── レイアウトヘルパー ─────────────────────

      /**
       * ターミナルの幅に合わせて物理行（スクリーン行）へ分割し、
       * それぞれの行に対するテキスト、開始インデックス、およびカーソルの(物理行, 列)を算出する
       */
      const getLayout = () => {
        const columns = process.stdout.columns || 80;
        const logicalLines = buffer.split("\n");
        const screenLines: { text: string; startIndex: number }[] = [];

        let cRow = 0;
        let cCol = 0;
        let currentPos = 0;

        for (let i = 0; i < logicalLines.length; i++) {
          const logicalLine = logicalLines[i];
          let currentScreenLine = "";
          let lineStartIndex = currentPos;
          let currentLineWidth = i === 0 && screenLines.length === 0 ? prefixLen : contPrefixLen;

          if (logicalLine.length === 0) {
            if (currentPos === cursorPos) {
              cRow = screenLines.length;
              cCol = 0;
            }
            screenLines.push({ text: "", startIndex: lineStartIndex });
            currentPos++; // \n
            continue;
          }

          const chars = Array.from(logicalLine);
          for (let charIdx = 0; charIdx < chars.length; charIdx++) {
            if (currentPos === cursorPos) {
              cRow = screenLines.length;
              cCol = currentScreenLine.length;
            }

            const char = chars[charIdx];
            const charW = getDisplayWidth(char);

            // ターミナル幅を超過する場合、そこで行を折り返す（ハードラップ）
            if (currentLineWidth + charW > columns) {
              screenLines.push({ text: currentScreenLine, startIndex: lineStartIndex });
              currentScreenLine = char;
              lineStartIndex = currentPos;
              currentLineWidth = contPrefixLen + charW;
            } else {
              currentScreenLine += char;
              currentLineWidth += charW;
            }
            currentPos += char.length;
          }

          if (currentPos === cursorPos) {
            cRow = screenLines.length;
            cCol = currentScreenLine.length;
          }

          screenLines.push({ text: currentScreenLine, startIndex: lineStartIndex });
          currentPos++; // \n
        }

        if (cursorPos === buffer.length) {
          cRow = Math.max(0, screenLines.length - 1);
          cCol = screenLines.length > 0 ? screenLines[cRow].text.length : 0;
        }

        return { screenLines, row: cRow, col: cCol };
      };

      const getLinePrefixLayout = (screenIndex: number): string => (screenIndex === 0 ? prefix : contPrefixStr);

      const getLinePrefixWidthLayout = (screenIndex: number): number => (screenIndex === 0 ? prefixLen : contPrefixLen);

      /** バッファの行・列からターミナル上のカラム位置を計算 */
      const getTerminalColumn = (row: number, col: number, screenLines: { text: string }[]): number => {
        const lineText = screenLines[row]?.text || "";
        return getLinePrefixWidthLayout(row) + getDisplayWidth(lineText.slice(0, col));
      };

      /** cursorTermRow から targetRow へターミナル行を移動 */
      const moveToRow = (targetRow: number): void => {
        if (targetRow > cursorTermRow) {
          out(`\x1b[${targetRow - cursorTermRow}B`);
        } else if (targetRow < cursorTermRow) {
          out(`\x1b[${cursorTermRow - targetRow}A`);
        }
        cursorTermRow = targetRow;
      };

      /** バッファの(row, col)からフラットなcursorPosを計算 */
      const rowColToPos = (row: number, col: number, screenLines: { text: string; startIndex: number }[]): number => {
        if (screenLines.length === 0) return 0;
        const line = screenLines[row];
        return line.startIndex + col;
      };

      // ─── メニューロジック ──────────────────────

      const updateMenu = (): void => {
        if (disableMenu) return;

        // マルチライン入力中はメニュー無効
        if (buffer.includes("\n")) {
          menuItems = [];
          menuVisible = false;
          selectedIndex = 0;
          return;
        }

        let items: MenuItem[] = [];

        // / が先頭 → コマンドメニュー
        if (buffer.startsWith("/")) {
          const partial = buffer.slice(1);
          items = this.commandProvider(partial);
        } else {
          // 最後の @ トリガーを探す（先頭 or スペースの直後）
          const beforeCursor = buffer.slice(0, cursorPos);
          // パスにスペースを含まない、一般的なファイルパス構成文字のみを対象にする
          const atMatch = beforeCursor.match(/(?:^|\s)@([a-zA-Z0-9_./\\-]*)$/);
          if (atMatch) {
            const partial = atMatch[1];
            items = this.filePathProvider(partial);
          }
        }

        if (items.length > 0) {
          menuItems = items;
          selectedIndex = 0;
          menuVisible = true;
        } else {
          menuItems = [];
          menuVisible = false;
          selectedIndex = 0;
        }
      };

      const selectItem = (): void => {
        if (!menuVisible || menuItems.length === 0) return;
        const item = menuItems[selectedIndex];

        if (buffer.startsWith("/")) {
          buffer = item.value;
          cursorPos = buffer.length;
        } else {
          const beforeCursor = buffer.slice(0, cursorPos);
          const atIndex = beforeCursor.lastIndexOf("@");
          if (atIndex >= 0) {
            const before = buffer.slice(0, atIndex);
            const after = buffer.slice(cursorPos);
            const inserted = "@" + item.value;
            buffer = before + inserted + after;
            cursorPos = before.length + inserted.length;
          }
        }

        dismissMenu();
      };

      const dismissMenu = (): void => {
        clearMenuDisplay();
        menuVisible = false;
        menuItems = [];
        selectedIndex = 0;
      };

      // ─── 描画 ─────────────────────────────────
      //
      // ターミナルレイアウト:
      //   Row 0:   [prompt prefix][input line 0]
      //   Row 1:   [cont prefix  ][input line 1]  ← Shift+Enterで追加
      //   ...
      //   Row N-1: [cont prefix  ][input line N-1]
      //   Row N:   [menu item 0]                   ← メニュー（単一行入力時のみ）
      //   Row N+1: [menu item 1]
      //   ...
      //
      // renderedInputLines: 画面上の入力行数
      // renderedMenuLines:  画面上のメニュー行数
      // cursorTermRow:      カーソルがいるターミナル行 (Row 0 基準)

      /** 入力バッファ全行を再描画 */
      const renderInput = (): void => {
        const { screenLines, row: cRow, col: cCol } = getLayout();

        // Step 1: 入力行0へ移動
        moveToRow(0);

        // Step 2: 全入力行を描画（旧行の余剰もクリア）
        const oldInputLines = renderedInputLines;
        // screenLines が空でも1行は描画する
        const newInputLines = Math.max(1, screenLines.length);
        const maxLines = Math.max(oldInputLines, newInputLines);

        for (let i = 0; i < maxLines; i++) {
          out("\r");
          clearLine();
          if (i < screenLines.length) {
            out(getLinePrefixLayout(i) + screenLines[i].text);
          } else if (i === 0 && screenLines.length === 0) {
            out(prefix);
          }

          if (i < maxLines - 1) {
            if (i < oldInputLines - 1) {
              // 既存行へ移動（スクロールしない）
              out("\x1b[1B");
            } else {
              // 新規行作成（代替画面では確保済みの行へ移動、素通しでは改行）
              newRow();
            }
            cursorTermRow = i + 1;
          }
        }

        renderedInputLines = newInputLines;

        // Step 3: カーソルを正しい入力位置に配置
        // 現在 cursorTermRow は maxLines - 1 にいる
        moveToRow(cRow);
        cursorToCol(getTerminalColumn(cRow, cCol, screenLines));
        notifyLiveHeight();
      };

      /** ドロップダウンメニューを描画 */
      const renderMenu = (): void => {
        if (!menuVisible || menuItems.length === 0) {
          clearMenuDisplay();
          return;
        }

        const { row: cRow, col: cCol, screenLines } = getLayout();
        const maxVisible = Math.min(menuItems.length, 8);

        // スクロールウィンドウ
        let startIdx = 0;
        if (selectedIndex >= maxVisible) {
          startIdx = selectedIndex - maxVisible + 1;
        }

        const hasScroll = menuItems.length > maxVisible;
        const newMenuLineCount = maxVisible + (hasScroll ? 1 : 0);

        // メニュー領域へ移動（最後の入力行の1行下から）
        moveToRow(renderedInputLines - 1);

        const totalToVisit = Math.max(newMenuLineCount, renderedMenuLines);

        // ターミナル幅を超えると自動折り返しで描画が崩れるため、
        // 1行分の最大表示幅を算出して label/description を切り詰める。
        const columns = process.stdout.columns || 80;
        const maxLineWidth = Math.max(10, columns - 1);

        for (let i = 0; i < totalToVisit; i++) {
          // 1行下へ移動
          if (i < renderedMenuLines) {
            out("\x1b[1B");
          } else {
            newRow();
          }
          cursorTermRow = renderedInputLines + i;

          out("\r");
          clearLine();

          if (i < maxVisible) {
            const idx = startIdx + i;
            const item = menuItems[idx];
            const isSelected = idx === selectedIndex;

            // マージン幅: 選択時 "  " + label両端スペース2 = 4、非選択時 "   " + label末尾スペース1 = 4
            const marginW = 4;
            const labelTruncated = truncateToWidth(item.label, Math.max(1, maxLineWidth - marginW));
            const labelTruncatedW = getDisplayWidth(labelTruncated);
            const descBudget = maxLineWidth - marginW - labelTruncatedW - 1;
            const descText = item.description ? truncateToWidth(item.description, Math.max(0, descBudget)) : "";

            if (isSelected) {
              out(`  ${chalk.bgBlue.white(` ${labelTruncated} `)}`);
            } else {
              out(chalk.dim(`   ${labelTruncated} `));
            }
            if (descText) {
              out(chalk.dim(` ${descText}`));
            }
          } else if (i === maxVisible && hasScroll) {
            out(chalk.dim(`  ↕ ${selectedIndex + 1}/${menuItems.length}`));
          }
          // else: 旧メニューの余剰行 → clearLine で消去済み
        }

        renderedMenuLines = newMenuLineCount;

        // カーソルを入力位置に戻す
        moveToRow(cRow);
        cursorToCol(getTerminalColumn(cRow, cCol, screenLines));
        notifyLiveHeight();
      };

      /** メニュー表示をクリア */
      const clearMenuDisplay = (): void => {
        if (renderedMenuLines === 0) return;

        const { row: cRow, col: cCol, screenLines } = getLayout();

        // メニュー領域へ移動してクリア
        moveToRow(renderedInputLines - 1);

        for (let i = 0; i < renderedMenuLines; i++) {
          out("\x1b[1B\r");
          clearLine();
          cursorTermRow = renderedInputLines + i;
        }

        // カーソルを入力位置に戻す
        moveToRow(cRow);
        cursorToCol(getTerminalColumn(cRow, cCol, screenLines));
        renderedMenuLines = 0;
        notifyLiveHeight();
      };

      // ─── ライブ領域の所有 (§4.2) ────────────────
      //
      // 入力欄は「ソフト所有者」。割り込み出力が来ても ScreenManager が
      // 「スクロールバック更新 → redraw()」 の順で描き直すので入力中の文字列が消えない。

      /**
       * ライブ領域の高さが変わったら ScreenManager に知らせる。
       * 代替画面では確保する行数が変わるため、次のフレームで描き直してもらう。
       */
      const notifyLiveHeight = (): void => {
        const h = Math.max(1, renderedInputLines + renderedMenuLines);
        if (h === lastLiveHeight) return;
        lastLiveHeight = h;
        screen.refreshLive();
      };

      /**
       * ScreenManager からの再描画要求 (ライブ領域は消去済み・カーソルは領域先頭)。
       * 自前の行数キャッシュを捨てて先頭から描き直す。
       */
      const redrawLive = (): void => {
        cursorTermRow = 0;
        renderedInputLines = 1;
        renderedMenuLines = 0;
        renderInput();
        if (menuVisible) renderMenu();
      };

      /**
       * 素通しモードで割り込み出力を差し込む前に、自分の描画を消して行頭へ戻す。
       * (代替画面では全画面再描画で足りるので呼ばれない)
       */
      const clearLive = (): void => {
        clearMenuDisplay();
        moveToRow(0);
        const drawn = renderedInputLines;
        for (let i = 0; i < drawn; i++) {
          out("\r");
          clearLine();
          if (i < drawn - 1) {
            out("\x1b[1B");
            cursorTermRow = i + 1;
          }
        }
        moveToRow(0);
        out("\r");
        renderedInputLines = 1;
        lastLiveHeight = 1;
      };

      releaseLive = screen.acquireLive({
        name: "interactive-input",
        redraw: () => redrawLive(),
        height: () => Math.max(1, renderedInputLines + renderedMenuLines),
        clear: () => clearLive(),
      });

      // ブラケット貼り付けモードを有効化（モダンターミナル: Windows Terminal/iTerm2/kitty/mintty等）
      // マルチライン貼り付け時、端末は \x1b[200~ ... \x1b[201~ で内容を囲む。
      // これによりペースト内の \r を Enter と誤認せず改行として取り込める。
      out("\x1b[?2004h");

      // 初期プロンプト描画。代替画面では ScreenManager が位置を決めて redraw を呼ぶ
      if (screen.isAlternate()) {
        screen.refreshLive();
      } else {
        out(prefix);
      }

      // ─── 終了処理 ─────────────────────────────

      const cleanup = (): void => {
        clearInterval(rawModeWatchdog);
        clearMenuDisplay();
        // ブラケット貼り付けモードを無効化
        out("\x1b[?2004l");
        stdin.removeListener("keypress", onKeypress);
        stdin.removeListener("end", onEnd);
        // ライブ領域の解放。raw mode の解除は ScreenManager が行う (§7.2)
        releaseLive?.();
        releaseLive = null;
      };

      /**
       * カーソルを最終入力行の下まで移動してから改行。
       * 代替画面ではライブ領域を ScreenManager が管理しているので何もしない
       * (確定した入力は echoToScrollback でスクロールバックへ移す)。
       */
      const moveToEndAndNewline = (): void => {
        if (screen.isAlternate()) return;
        if (renderedInputLines > 1) {
          const { row: cRow } = getLayout();
          const linesToBottom = renderedInputLines - 1 - cRow;
          if (linesToBottom > 0) {
            out(`\x1b[${linesToBottom}B`);
          }
        }
        out("\n");
      };

      /**
       * 代替画面では入力欄はライブ領域にしか無く、確定してもスクロールバックに残らない。
       * 「何を打ったか」 が履歴から消えるのは現行方式にない退行なので、確定時に
       * プロンプト付きで 1 度だけスクロールバックへ書き出す。
       */
      const echoToScrollback = (result: string): void => {
        if (!screen.isAlternate()) return;
        const body = result.split("\n").join(`\n${contPrefixStr}`);
        screen.write(`${prefix}${body}\n`);
      };

      const finish = (result: string): void => {
        cleanup();
        moveToEndAndNewline();
        echoToScrollback(result);
        if (result.trim()) {
          this.history.push(result);
        }
        this.historyIndex = -1;
        resolve(result);
      };

      // stdin が閉じた場合（ターミナル終了等）
      const onEnd = (): void => {
        cleanup();
        resolve("");
      };
      stdin.once("end", onEnd);

      // ─── キープレスハンドラ ────────────────────

      const onKeypress = (_ch: string | undefined, key?: readline.Key): void => {
        if (!key) return;

        // ── ブラケット貼り付け: 開始マーカー ──
        if (key.sequence === "\x1b[200~") {
          inPaste = true;
          pasteAccumulated = "";
          return;
        }
        // ── ブラケット貼り付け: 終了マーカー ──
        if (key.sequence === "\x1b[201~") {
          inPaste = false;
          if (pasteAccumulated.length > 0) {
            if (menuVisible) dismissMenu();
            buffer = buffer.slice(0, cursorPos) + pasteAccumulated + buffer.slice(cursorPos);
            cursorPos += pasteAccumulated.length;
            pasteAccumulated = "";
            renderInput();
          }
          return;
        }
        // ── ブラケット貼り付け中: 内容を蓄積 (\r/\n を改行に正規化) ──
        if (inPaste) {
          if (key.name === "return" || key.name === "enter") {
            pasteAccumulated += "\n";
          } else if (_ch) {
            pasteAccumulated += _ch;
          } else if (key.sequence) {
            pasteAccumulated += key.sequence;
          }
          return;
        }

        // ── 連続キー時刻を更新（ブラケット貼り付け非対応端末向けフォールバック判定用） ──
        const now = Date.now();
        const keyDelta = lastKeyTimeMs === 0 ? Infinity : now - lastKeyTimeMs;
        lastKeyTimeMs = now;
        // 二段構えの貼り付け検出:
        //   (a) 生 stdin chunk で複数バイト+改行を観測 → pasteBurstUntilMs まで保持
        //   (b) 直前キーから FAST_PASTE_DELTA_MS 未満で連続発火 → 貼り付け中とみなす
        // line-submit 窓 (改行が末尾のみのチャンク = タイプ入力の確定) は貼り付け判定より優先。
        // ConPTY が「続けて\r」 を 1 チャンクで届けると (a) 改行入りチャンク (b) keyDelta≈0 の
        // 両方が誤発動して Enter が飲み込まれるため、 ここで両方を打ち消す (2026-06-13)。
        const isPasteBurst =
          now < this.lineSubmitUntilMs ? false : now < this.pasteBurstUntilMs || keyDelta < FAST_PASTE_DELTA_MS;

        // \r の直後でも \n 以外のキーが来たら CRLF 吸収状態を解除
        if (lastKeyWasReturn && key.name !== "enter") {
          lastKeyWasReturn = false;
        }

        // ── Ctrl+C ──
        if (key.ctrl && key.name === "c") {
          cleanup();
          moveToEndAndNewline();
          resolve(SIGINT_SIGNAL);
          return;
        }

        // ── Ctrl+D (EOF) ──
        if (key.ctrl && key.name === "d" && buffer === "") {
          cleanup();
          if (!screen.isAlternate()) out("\n");
          resolve("");
          return;
        }

        // ── Shift+Enter → 改行挿入（マルチライン入力） ──
        // Shift+Enter: モダンターミナル (Windows Terminal + CSI u, iTerm2, kitty)
        // Ctrl+J:      ユニバーサルフォールバック (\n = 0x0A → key.name="enter")
        if ((key.name === "return" && key.shift) || key.name === "enter") {
          // CRLF 吸収: 直前のキーが \r で、これが直後に届いた \n なら、既に \r 側で
          // 改行処理済みなので無視する。Ctrl+J 単独入力の場合は lastKeyWasReturn=false。
          if (key.name === "enter" && lastKeyWasReturn) {
            lastKeyWasReturn = false;
            return;
          }
          lastKeyWasReturn = false;
          // メニューが表示中なら先に閉じる
          if (menuVisible) {
            dismissMenu();
          }
          // バッファに改行を挿入
          buffer = buffer.slice(0, cursorPos) + "\n" + buffer.slice(cursorPos);
          cursorPos++;
          renderInput();
          return;
        }

        // ── Enter ──
        if (key.name === "return") {
          // フォールバック: ブラケット貼り付け非対応端末で貼り付けの \r が届いた場合、
          // pasteBurst 中なら改行として扱う（次の \n が CRLF の続きとして来た場合は吸収）
          if (isPasteBurst && !key.shift) {
            if (menuVisible) dismissMenu();
            buffer = buffer.slice(0, cursorPos) + "\n" + buffer.slice(cursorPos);
            cursorPos++;
            renderInput();
            lastKeyWasReturn = true;
            return;
          }
          // 通常の Enter は確定動作 — lastKeyWasReturn は立てない（直後の \n は別入力扱い）
          lastKeyWasReturn = false;
          if (menuVisible && menuItems.length > 0) {
            const selectedValue = menuItems[selectedIndex].value;
            selectItem();
            renderInput();

            if (buffer.startsWith("/") && !buffer.endsWith(" ")) {
              // /コマンド: 選択 → 即確定（引数不要のコマンド）
              finish(buffer);
            } else if (buffer.startsWith("/") && buffer.endsWith(" ")) {
              // /コマンド サブコマンド + 末尾スペース: 引数が必要なので確定しない
              // メニューを閉じて続けて入力可能にする
              updateMenu();
              if (menuVisible) renderMenu();
            } else if (selectedValue.endsWith("/")) {
              // @ディレクトリ: さらに中身を展開
              updateMenu();
              if (menuVisible) {
                renderMenu();
              }
            } else {
              // @ファイル: 選択完了、続けてメッセージ入力可能
              // (selectItem内でdismissMenu済み)
            }
          } else {
            finish(buffer);
          }
          return;
        }

        // ── Tab → メニューから選択（確定しない） ──
        if (key.name === "tab") {
          if (menuVisible && menuItems.length > 0) {
            selectItem();
            renderInput();
            updateMenu();
            if (menuVisible) {
              renderMenu();
            }
          }
          return;
        }

        // ── PgUp / PgDn → スクロールバックを遡る (§3.4) ──
        // 代替画面では端末自身のスクロールバックが使えないので、ScreenManager の
        // 行配列を遡る。素通しモードでは端末に任せる (ScreenManager 側で no-op)。
        if (key.name === "pageup") {
          screen.scrollUp();
          return;
        }
        if (key.name === "pagedown") {
          screen.scrollDown();
          return;
        }

        // ── Escape → メニュー閉じる / 入力クリア ──
        if (key.name === "escape") {
          if (menuVisible) {
            dismissMenu();
          } else if (buffer.length > 0) {
            // Claude Code と同様、メニュー非表示時の ESC は入力中テキストの破棄
            buffer = "";
            cursorPos = 0;
            this.historyIndex = -1;
            renderInput();
          }
          return;
        }

        // ── ↑ ──
        if (key.name === "up") {
          if (menuVisible) {
            selectedIndex = Math.max(0, selectedIndex - 1);
            renderMenu();
          } else {
            const { row, col, screenLines } = getLayout();
            if (row > 0) {
              // マルチライン: 1行上へカーソル移動
              const targetCol = Math.min(col, screenLines[row - 1].text.length);
              cursorPos = rowColToPos(row - 1, targetCol, screenLines);
              renderInput();
            } else if (this.history.length > 0) {
              // 履歴ナビゲーション
              if (this.historyIndex < 0) {
                savedHistoryBuffer = buffer;
                this.historyIndex = this.history.length - 1;
              } else if (this.historyIndex > 0) {
                this.historyIndex--;
              }
              buffer = this.history[this.historyIndex];
              cursorPos = buffer.length;
              renderInput();
            }
          }
          return;
        }

        // ── ↓ ──
        if (key.name === "down") {
          if (menuVisible) {
            selectedIndex = Math.min(menuItems.length - 1, selectedIndex + 1);
            renderMenu();
          } else {
            const { row, col, screenLines } = getLayout();
            if (row < screenLines.length - 1) {
              // マルチライン: 1行下へカーソル移動
              const targetCol = Math.min(col, screenLines[row + 1].text.length);
              cursorPos = rowColToPos(row + 1, targetCol, screenLines);
              renderInput();
            } else if (this.historyIndex >= 0) {
              // 履歴ナビゲーション
              this.historyIndex++;
              if (this.historyIndex >= this.history.length) {
                this.historyIndex = -1;
                buffer = savedHistoryBuffer;
              } else {
                buffer = this.history[this.historyIndex];
              }
              cursorPos = buffer.length;
              renderInput();
            }
          }
          return;
        }

        // ── ← ──
        if (key.name === "left") {
          if (cursorPos > 0) {
            cursorPos--;
            renderInput();
            if (menuVisible) {
              updateMenu();
              renderMenu();
            }
          }
          return;
        }

        // ── → ──
        if (key.name === "right") {
          if (cursorPos < buffer.length) {
            cursorPos++;
            renderInput();
            if (menuVisible) {
              updateMenu();
              renderMenu();
            }
          }
          return;
        }

        // ── Home / Ctrl+A → 現在行の先頭 ──
        if (key.name === "home" || (key.ctrl && key.name === "a")) {
          const { row, screenLines } = getLayout();
          cursorPos = rowColToPos(row, 0, screenLines);
          renderInput();
          if (menuVisible) dismissMenu();
          return;
        }

        // ── End / Ctrl+E → 現在行の末尾 ──
        if (key.name === "end" || (key.ctrl && key.name === "e")) {
          const { row, screenLines } = getLayout();
          cursorPos = rowColToPos(row, screenLines[row].text.length, screenLines);
          renderInput();
          if (menuVisible) {
            updateMenu();
            renderMenu();
          }
          return;
        }

        // ── Backspace ──
        if (key.name === "backspace") {
          if (cursorPos > 0) {
            buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
            cursorPos--;
            renderInput();
            if (buffer.length === 0) {
              dismissMenu();
            } else if (!buffer.includes("\n")) {
              updateMenu();
              renderMenu();
            }
          }
          return;
        }

        // ── Delete ──
        if (key.name === "delete") {
          if (cursorPos < buffer.length) {
            buffer = buffer.slice(0, cursorPos) + buffer.slice(cursorPos + 1);
            renderInput();
            if (!buffer.includes("\n")) {
              updateMenu();
              renderMenu();
            }
          }
          return;
        }

        // ── Ctrl+U → 全クリア ──
        if (key.ctrl && key.name === "u") {
          buffer = "";
          cursorPos = 0;
          renderInput();
          dismissMenu();
          return;
        }

        // ── Ctrl+W → 単語削除 ──
        if (key.ctrl && key.name === "w") {
          if (cursorPos > 0) {
            const before = buffer.slice(0, cursorPos);
            const trimmed = before.replace(/\S+\s*$/, "");
            buffer = trimmed + buffer.slice(cursorPos);
            cursorPos = trimmed.length;
            renderInput();
            if (!buffer.includes("\n")) {
              updateMenu();
              renderMenu();
            }
          }
          return;
        }

        // ── 通常文字入力（マルチバイト含む） ──
        if (key.sequence && !key.ctrl && !key.meta) {
          const ch = key.sequence;
          // 制御文字を除外
          if (ch.length > 0 && ch.charCodeAt(0) >= 32) {
            buffer = buffer.slice(0, cursorPos) + ch + buffer.slice(cursorPos);
            cursorPos += ch.length;
            renderInput();
            if (!buffer.includes("\n")) {
              updateMenu();
              renderMenu();
            }
          }
        }
      };

      stdin.on("keypress", onKeypress);
    });
  }
}
