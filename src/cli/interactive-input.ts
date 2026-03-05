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

// ─── メインクラス ───────────────────────────────────────

export class InteractiveInput {
  private commandProvider: MenuProvider;
  private filePathProvider: MenuProvider;
  private history: string[] = [];
  private historyIndex = -1;
  private keypressInitialized = false;

  constructor(options: InteractiveInputOptions = {}) {
    this.commandProvider = options.commandProvider ?? (() => []);
    this.filePathProvider = options.filePathProvider ?? (() => []);
  }

  /**
   * プロンプトを表示しユーザー入力を返す。
   * Shift+Enter で改行を挿入し、Enter で確定。
   * @param prefix  プロンプト文字列 (例: "> ")
   * @param options.disableMenu  trueならドロップダウンを抑制
   */
  async question(
    prefix: string,
    options?: { disableMenu?: boolean },
  ): Promise<string> {
    if (!process.stdin.isTTY) {
      return this.fallbackQuestion(prefix);
    }
    return this.interactiveQuestion(prefix, options?.disableMenu ?? false);
  }

  // ─── readline フォールバック（非TTY） ────────────────

  private fallbackQuestion(prefix: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(prefix, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  // ─── インタラクティブ入力（メイン） ──────────────────

  private interactiveQuestion(
    prefix: string,
    disableMenu: boolean,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      const stdin = process.stdin;
      const stdout = process.stdout;

      // emitKeypressEvents は一度だけ呼ぶ
      if (!this.keypressInitialized) {
        readline.emitKeypressEvents(stdin);
        this.keypressInitialized = true;
      }

      stdin.setRawMode(true);
      stdin.resume();

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

      const prefixLen = stripAnsi(prefix).length;
      // 継続行のプレフィックス（プロンプトと同じ幅のスペース）
      const contPrefixStr = " ".repeat(prefixLen);
      const contPrefixLen = prefixLen;

      // 初期プロンプト描画
      stdout.write(prefix);

      // ─── レイアウトヘルパー ─────────────────────

      /** バッファの行分割とカーソル位置(行,列)を返す */
      const getLayout = () => {
        const lines = buffer.split("\n");
        const before = buffer.slice(0, cursorPos);
        const beforeLines = before.split("\n");
        const row = beforeLines.length - 1;
        const col = beforeLines[beforeLines.length - 1].length;
        return { lines, row, col };
      };

      const getLinePrefix = (i: number): string =>
        i === 0 ? prefix : contPrefixStr;

      const getLinePrefixWidth = (i: number): number =>
        i === 0 ? prefixLen : contPrefixLen;

      /** cursorTermRow から targetRow へターミナル行を移動 */
      const moveToRow = (targetRow: number): void => {
        if (targetRow > cursorTermRow) {
          stdout.write(`\x1b[${targetRow - cursorTermRow}B`);
        } else if (targetRow < cursorTermRow) {
          stdout.write(`\x1b[${cursorTermRow - targetRow}A`);
        }
        cursorTermRow = targetRow;
      };

      /** バッファの(row, col)からフラットなcursorPosを計算 */
      const rowColToPos = (row: number, col: number): number => {
        const lines = buffer.split("\n");
        let pos = 0;
        for (let i = 0; i < row && i < lines.length; i++) {
          pos += lines[i].length + 1; // +1 for \n
        }
        return pos + Math.min(col, (lines[row] ?? "").length);
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
          const atMatch = beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
          if (atMatch) {
            const partial = atMatch[1];
            items = this.filePathProvider(partial);
          }
        }

        if (items.length > 0 && items.length <= 50) {
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
        const { lines, row: cRow, col: cCol } = getLayout();

        // Step 1: 入力行0へ移動
        moveToRow(0);

        // Step 2: 全入力行を描画（旧行の余剰もクリア）
        const oldInputLines = renderedInputLines;
        const newInputLines = lines.length;
        const maxLines = Math.max(oldInputLines, newInputLines);

        for (let i = 0; i < maxLines; i++) {
          stdout.write("\r");
          stdout.clearLine(0);
          if (i < newInputLines) {
            stdout.write(getLinePrefix(i) + lines[i]);
          }
          if (i < maxLines - 1) {
            if (i < oldInputLines - 1) {
              // 既存行へ移動（スクロールしない）
              stdout.write("\x1b[1B");
            } else {
              // 新規行作成（スクロールする可能性あり）
              stdout.write("\n");
            }
            cursorTermRow = i + 1;
          }
        }

        renderedInputLines = newInputLines;

        // Step 3: カーソルを正しい入力位置に配置
        // 現在 cursorTermRow は maxLines - 1 にいる
        moveToRow(cRow);
        stdout.cursorTo(getLinePrefixWidth(cRow) + cCol);
      };

      /** ドロップダウンメニューを描画 */
      const renderMenu = (): void => {
        if (!menuVisible || menuItems.length === 0) {
          clearMenuDisplay();
          return;
        }

        const { row: cRow, col: cCol } = getLayout();
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

        for (let i = 0; i < totalToVisit; i++) {
          // 1行下へ移動
          if (i < renderedMenuLines) {
            stdout.write("\x1b[1B");
          } else {
            stdout.write("\n");
          }
          cursorTermRow = renderedInputLines + i;

          stdout.write("\r");
          stdout.clearLine(0);

          if (i < maxVisible) {
            const idx = startIdx + i;
            const item = menuItems[idx];

            if (idx === selectedIndex) {
              stdout.write(`  ${chalk.bgBlue.white(` ${item.label} `)}`);
              if (item.description) {
                stdout.write(chalk.dim(` ${item.description}`));
              }
            } else {
              stdout.write(chalk.dim(`   ${item.label} `));
              if (item.description) {
                stdout.write(chalk.dim(` ${item.description}`));
              }
            }
          } else if (i === maxVisible && hasScroll) {
            stdout.write(chalk.dim(`  ↕ ${selectedIndex + 1}/${menuItems.length}`));
          }
          // else: 旧メニューの余剰行 → clearLine で消去済み
        }

        renderedMenuLines = newMenuLineCount;

        // カーソルを入力位置に戻す
        moveToRow(cRow);
        stdout.cursorTo(getLinePrefixWidth(cRow) + cCol);
      };

      /** メニュー表示をクリア */
      const clearMenuDisplay = (): void => {
        if (renderedMenuLines === 0) return;

        const { row: cRow, col: cCol } = getLayout();

        // メニュー領域へ移動してクリア
        moveToRow(renderedInputLines - 1);

        for (let i = 0; i < renderedMenuLines; i++) {
          stdout.write("\x1b[1B\r");
          stdout.clearLine(0);
          cursorTermRow = renderedInputLines + i;
        }

        // カーソルを入力位置に戻す
        moveToRow(cRow);
        stdout.cursorTo(getLinePrefixWidth(cRow) + cCol);
        renderedMenuLines = 0;
      };

      // ─── 終了処理 ─────────────────────────────

      const cleanup = (): void => {
        clearMenuDisplay();
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        stdin.removeListener("keypress", onKeypress);
        stdin.removeListener("end", onEnd);
      };

      /** カーソルを最終入力行の下まで移動してから改行 */
      const moveToEndAndNewline = (): void => {
        if (renderedInputLines > 1) {
          const { row: cRow } = getLayout();
          const linesToBottom = renderedInputLines - 1 - cRow;
          if (linesToBottom > 0) {
            stdout.write(`\x1b[${linesToBottom}B`);
          }
        }
        stdout.write("\n");
      };

      const finish = (result: string): void => {
        cleanup();
        moveToEndAndNewline();
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

      const onKeypress = (
        _ch: string | undefined,
        key?: readline.Key,
      ): void => {
        if (!key) return;

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
          stdout.write("\n");
          resolve("");
          return;
        }

        // ── Shift+Enter → 改行挿入（マルチライン入力） ──
        if (key.name === "return" && key.shift) {
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
          if (menuVisible && menuItems.length > 0) {
            const selectedValue = menuItems[selectedIndex].value;
            selectItem();
            renderInput();

            if (buffer.startsWith("/")) {
              // /コマンド: 選択 → 即確定（Claude Codeと同じ動作）
              finish(buffer);
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

        // ── Escape → メニュー閉じる ──
        if (key.name === "escape") {
          if (menuVisible) {
            dismissMenu();
          }
          return;
        }

        // ── ↑ ──
        if (key.name === "up") {
          if (menuVisible) {
            selectedIndex = Math.max(0, selectedIndex - 1);
            renderMenu();
          } else {
            const { row, col } = getLayout();
            if (row > 0) {
              // マルチライン: 1行上へカーソル移動
              const lines = buffer.split("\n");
              const targetCol = Math.min(col, lines[row - 1].length);
              cursorPos = rowColToPos(row - 1, targetCol);
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
            const { row, col, lines } = getLayout();
            if (row < lines.length - 1) {
              // マルチライン: 1行下へカーソル移動
              const targetCol = Math.min(col, lines[row + 1].length);
              cursorPos = rowColToPos(row + 1, targetCol);
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
          const { row } = getLayout();
          cursorPos = rowColToPos(row, 0);
          renderInput();
          if (menuVisible) dismissMenu();
          return;
        }

        // ── End / Ctrl+E → 現在行の末尾 ──
        if (key.name === "end" || (key.ctrl && key.name === "e")) {
          const { row, lines } = getLayout();
          cursorPos = rowColToPos(row, lines[row].length);
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

// ─── ユーティリティ ─────────────────────────────────────

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
