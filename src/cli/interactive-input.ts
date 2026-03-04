/**
 * Claude Code風インタラクティブ入力
 *
 * /コマンドや@ファイルパスを入力すると、入力行の下部にリアルタイムで
 * ドロップダウン候補が表示される。カーソルキーで選択しEnterで確定。
 *
 * 特徴:
 * - raw stdinでキーストロークを1つずつ処理
 * - ANSI エスケープシーケンスでドロップダウンを描画
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
   * @param prefix  プロンプト文字列 (例: "> ")
   * @param options.disableMenu  trueならドロップダウンを抑制（マルチラインモード用）
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
      let savedHistoryBuffer = "";

      const prefixLen = stripAnsi(prefix).length;

      // 初期プロンプト描画
      stdout.write(prefix);

      // ─── メニューロジック ──────────────────────

      const updateMenu = (): void => {
        if (disableMenu) return;

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

      const renderLine = (): void => {
        stdout.cursorTo(0);
        stdout.clearLine(0);
        stdout.write(prefix + buffer);
        stdout.cursorTo(prefixLen + cursorPos);
      };

      const renderMenu = (): void => {
        clearMenuDisplay();
        if (!menuVisible || menuItems.length === 0) return;

        const maxVisible = Math.min(menuItems.length, 8);

        // スクロールウィンドウ
        let startIdx = 0;
        if (selectedIndex >= maxVisible) {
          startIdx = selectedIndex - maxVisible + 1;
        }

        // カーソル位置を保存
        stdout.write("\x1b7");

        for (let i = 0; i < maxVisible; i++) {
          const idx = startIdx + i;
          const item = menuItems[idx];

          stdout.write("\n\r");
          stdout.clearLine(0);

          if (idx === selectedIndex) {
            // 選択中のアイテム: 反転表示
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
        }

        // スクロールインジケータ
        if (menuItems.length > maxVisible) {
          stdout.write("\n\r");
          stdout.clearLine(0);
          stdout.write(chalk.dim(`  ↕ ${selectedIndex + 1}/${menuItems.length}`));
          renderedMenuLines = maxVisible + 1;
        } else {
          renderedMenuLines = maxVisible;
        }

        // カーソル位置を復元
        stdout.write("\x1b8");
      };

      const clearMenuDisplay = (): void => {
        if (renderedMenuLines === 0) return;
        stdout.write("\x1b7"); // Save
        for (let i = 0; i < renderedMenuLines; i++) {
          stdout.write("\n\r");
          stdout.clearLine(0);
        }
        stdout.write("\x1b8"); // Restore
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

      const finish = (result: string): void => {
        cleanup();
        stdout.write("\n");
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
          stdout.write("\n");
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

        // ── Enter ──
        if (key.name === "return") {
          if (menuVisible && menuItems.length > 0) {
            // メニューから選択 → 入力に反映（確定はしない）
            selectItem();
            renderLine();
            // 選択後にさらに候補があるか確認（ディレクトリ→中身）
            updateMenu();
            renderMenu();
          } else {
            finish(buffer);
          }
          return;
        }

        // ── Tab → メニューから選択 ──
        if (key.name === "tab") {
          if (menuVisible && menuItems.length > 0) {
            selectItem();
            renderLine();
            updateMenu();
            renderMenu();
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
          } else if (this.history.length > 0) {
            if (this.historyIndex < 0) {
              savedHistoryBuffer = buffer;
              this.historyIndex = this.history.length - 1;
            } else if (this.historyIndex > 0) {
              this.historyIndex--;
            }
            buffer = this.history[this.historyIndex];
            cursorPos = buffer.length;
            renderLine();
          }
          return;
        }

        // ── ↓ ──
        if (key.name === "down") {
          if (menuVisible) {
            selectedIndex = Math.min(menuItems.length - 1, selectedIndex + 1);
            renderMenu();
          } else if (this.historyIndex >= 0) {
            this.historyIndex++;
            if (this.historyIndex >= this.history.length) {
              this.historyIndex = -1;
              buffer = savedHistoryBuffer;
            } else {
              buffer = this.history[this.historyIndex];
            }
            cursorPos = buffer.length;
            renderLine();
          }
          return;
        }

        // ── ← ──
        if (key.name === "left") {
          if (cursorPos > 0) {
            cursorPos--;
            renderLine();
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
            renderLine();
            if (menuVisible) {
              updateMenu();
              renderMenu();
            }
          }
          return;
        }

        // ── Home / Ctrl+A ──
        if (key.name === "home" || (key.ctrl && key.name === "a")) {
          cursorPos = 0;
          renderLine();
          if (menuVisible) dismissMenu();
          return;
        }

        // ── End / Ctrl+E ──
        if (key.name === "end" || (key.ctrl && key.name === "e")) {
          cursorPos = buffer.length;
          renderLine();
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
            renderLine();
            if (buffer.length === 0) {
              dismissMenu();
            } else {
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
            renderLine();
            updateMenu();
            renderMenu();
          }
          return;
        }

        // ── Ctrl+U → 行クリア ──
        if (key.ctrl && key.name === "u") {
          buffer = "";
          cursorPos = 0;
          renderLine();
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
            renderLine();
            updateMenu();
            renderMenu();
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
            renderLine();
            updateMenu();
            renderMenu();
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
