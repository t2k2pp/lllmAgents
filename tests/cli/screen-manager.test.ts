import { describe, it, expect, vi, afterEach } from "vitest";
import { ScreenManagerImpl, shouldUseAlternateScreen } from "../../src/cli/screen-manager.js";

/** 書き出し先を捕まえる ScreenManager を作る (素通しモード) */
function createHarness(maxLines?: number) {
  const written: string[] = [];
  const screen = new ScreenManagerImpl({ sink: (t) => written.push(t), maxLines, stdin: null });
  return { screen, written };
}

/**
 * 代替画面モードの ScreenManager を作る。
 * 端末サイズを固定して描画結果を決め打ちで検証できるようにする。
 */
function createAltHarness(opts: { rows?: number; columns?: number; maxLines?: number } = {}) {
  const written: string[] = [];
  const screen = new ScreenManagerImpl({
    sink: (t) => written.push(t),
    maxLines: opts.maxLines,
    alternate: true,
    rows: () => opts.rows ?? 6,
    columns: () => opts.columns ?? 20,
    stdin: null,
  });
  return { screen, written, all: () => written.join("") };
}

describe("ScreenManager: 行分割とスクロールバック", () => {
  it("改行で分割して行配列に積む (末尾は書きかけ行)", () => {
    const { screen } = createHarness();
    screen.write("foo\nbar\n");
    expect(screen.snapshotLines()).toEqual(["foo", "bar", ""]);
  });

  it("末尾に改行が無い書き込みは最終行へ追記する (ストリーミング対策)", () => {
    const { screen } = createHarness();
    screen.write("he");
    screen.write("llo");
    screen.write(" world");
    expect(screen.snapshotLines()).toEqual(["hello world"]);
  });

  it("追記の途中で改行が来たら行が確定する", () => {
    const { screen } = createHarness();
    screen.write("abc");
    screen.write("def\nghi");
    expect(screen.snapshotLines()).toEqual(["abcdef", "ghi"]);
  });

  it("maxLines を超えたら先頭から捨てる", () => {
    const { screen } = createHarness(3);
    screen.write("1\n2\n3\n4\n5\n");
    expect(screen.snapshotLines()).toEqual(["4", "5", ""]);
  });

  it("空文字は何もしない", () => {
    const { screen, written } = createHarness();
    screen.write("");
    expect(written).toEqual([]);
    expect(screen.snapshotLines()).toEqual([""]);
  });
});

describe("ScreenManager: 所有権", () => {
  it("所有者がいなければ currentOwner は undefined", () => {
    const { screen } = createHarness();
    expect(screen.currentOwner()).toBeUndefined();
  });

  it("取得すると currentOwner が立ち、解放すると消える", () => {
    const { screen } = createHarness();
    const release = screen.acquireLive({ name: "inquirer" });
    expect(screen.currentOwner()).toBe("inquirer");
    release();
    expect(screen.currentOwner()).toBeUndefined();
  });

  it("redraw を持つ所有者 (ソフト所有) は排他にならない", () => {
    const { screen, written } = createHarness();
    const release = screen.acquireLive({ name: "input", redraw: () => {} });
    expect(screen.isExclusive()).toBe(false);
    screen.write("通知\n");
    expect(written).toEqual(["通知\n"]);
    release();
  });

  it("redraw を持たない所有者 (排他所有) は排他になる", () => {
    const { screen } = createHarness();
    const release = screen.acquireLive({ name: "inquirer" });
    expect(screen.isExclusive()).toBe(true);
    release();
    expect(screen.isExclusive()).toBe(false);
  });

  it("解放関数は二重に呼んでも壊れない", () => {
    const { screen } = createHarness();
    const release = screen.acquireLive({ name: "inquirer" });
    release();
    release();
    expect(screen.currentOwner()).toBeUndefined();
    expect(screen.isExclusive()).toBe(false);
  });

  it("start() していなければ代替画面ではない", () => {
    const { screen } = createHarness();
    expect(screen.isAlternate()).toBe(false);
  });
});

// ─── 段階 2 (docs/tui-alternate-screen.md §3 / §6 / §8) ───────────────

describe("ScreenManager: TUI / classic stream 判定 (§6.1)", () => {
  const tty = { isTTY: true, term: "xterm-256color", platform: "linux" };

  it("TTY で TERM があれば代替画面を使う", () => {
    expect(shouldUseAlternateScreen(tty)).toBe(true);
  });

  it("LLLMAGENT_DISABLE_ALTERNATE_SCREEN=1 なら passthrough", () => {
    expect(shouldUseAlternateScreen({ ...tty, disable: "1" })).toBe(false);
  });

  it("--no-alt-screen なら passthrough", () => {
    expect(shouldUseAlternateScreen({ ...tty, disableByCli: true })).toBe(false);
  });

  it("--no-alt-screen の明示指定はTERM=dumbでもclassic stream表示を選べる", () => {
    expect(shouldUseAlternateScreen({ ...tty, term: "dumb", disableByCli: true })).toBe(false);
  });

  it("空文字 / 0 / false の環境変数は「無効化されていない」 と読む", () => {
    expect(shouldUseAlternateScreen({ ...tty, disable: "" })).toBe(true);
    expect(shouldUseAlternateScreen({ ...tty, disable: "0" })).toBe(true);
    expect(shouldUseAlternateScreen({ ...tty, disable: "false" })).toBe(true);
  });

  it("非TTY (パイプ・リダイレクト・CI) は passthrough", () => {
    expect(shouldUseAlternateScreen({ ...tty, isTTY: false })).toBe(false);
  });

  it("TTYのTERM=dumbは黙って表示を落とさず、対処を示してfail-fastする", () => {
    expect(() => shouldUseAlternateScreen({ ...tty, term: "dumb" })).toThrow(/TERM=dumb.*--no-alt-screen/);
  });

  it("TERM が無い POSIX TTYは判定不明を隠さずfail-fastする (§11)", () => {
    expect(() => shouldUseAlternateScreen({ isTTY: true, platform: "linux" })).toThrow(/TERMが未設定.*--no-alt-screen/);
  });

  it("Windows で端末能力の印が無ければ判定不明を隠さずfail-fastする", () => {
    expect(() => shouldUseAlternateScreen({ isTTY: true, platform: "win32" })).toThrow(
      /ANSI\/Alternate Screen対応を判定できません.*--no-alt-screen/,
    );
  });

  it("Windows Terminal / ConEmu / ANSICON なら代替画面を使う", () => {
    expect(shouldUseAlternateScreen({ isTTY: true, platform: "win32", wtSession: "abc" })).toBe(true);
    expect(shouldUseAlternateScreen({ isTTY: true, platform: "win32", conEmuANSI: "ON" })).toBe(true);
    expect(shouldUseAlternateScreen({ isTTY: true, platform: "win32", ansicon: "1" })).toBe(true);
    expect(shouldUseAlternateScreen({ isTTY: true, platform: "win32", termProgram: "vscode" })).toBe(true);
  });
});

describe("ScreenManager: 代替画面の入退場 (§3.1 / §8)", () => {
  it("start() で代替画面へ入り isAlternate が立つ", () => {
    const { screen, all } = createAltHarness();
    screen.start();
    expect(all()).toContain("\x1b[?1049h");
    expect(screen.isAlternate()).toBe(true);
    screen.stop();
  });

  it("stop() で代替画面を抜け、スクロールバックを通常画面へ書き戻す", () => {
    const { screen, written, all } = createAltHarness();
    screen.start();
    screen.write("一行目\n");
    screen.write("二行目\n");
    written.length = 0;
    screen.stop();

    const output = all();
    expect(output).toContain("\x1b[?1049l");
    // 代替画面を抜けた「後」 に書き戻すこと (中で出すと画面ごと消える)
    const afterLeave = output.slice(output.indexOf("\x1b[?1049l"));
    expect(afterLeave).toContain("一行目\n二行目\n");
    expect(screen.isAlternate()).toBe(false);
  });

  it("stop() は二重に呼んでも壊れず、書き戻しも 1 回だけ", () => {
    const { screen, written, all } = createAltHarness();
    screen.start();
    screen.write("ログ\n");
    written.length = 0;
    screen.stop();
    screen.stop();
    expect(all().split("ログ").length - 1).toBe(1);
  });

  it("排他所有中に溜めた出力も書き戻しに含まれる (silent な欠損の禁止)", () => {
    const { screen, written, all } = createAltHarness();
    screen.start();
    screen.acquireLive({ name: "inquirer" });
    screen.write("退避された行\n");
    written.length = 0;
    screen.stop();
    expect(all()).toContain("退避された行");
  });

  it("passthrough では代替画面のエスケープを一切出さない (§6.2)", () => {
    const { screen, written } = createHarness();
    screen.start();
    screen.write("素通し\n");
    screen.stop();
    const output = written.join("");
    expect(output).not.toContain("\x1b[?1049");
    expect(output).toBe("素通し\n");
    expect(screen.isAlternate()).toBe(false);
  });

  it("passthrough でも排他キューイングは有効のまま (§6.2)", () => {
    const { screen, written } = createHarness();
    screen.start();
    const release = screen.acquireLive({ name: "inquirer" });
    screen.write("割り込み\n");
    expect(written).toEqual([]);
    release();
    expect(written).toEqual(["割り込み\n"]);
    screen.stop();
  });
});

describe("ScreenManager: 描画とフレーム集約 (§3.5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("連続する write() は 16ms で 1 回の描画にまとめる", () => {
    vi.useFakeTimers();
    const { screen, written, all } = createAltHarness();
    screen.start();
    written.length = 0;

    screen.write("a\n");
    screen.write("b\n");
    screen.write("c\n");
    // まだ描いていない (集約待ち)
    expect(all()).toBe("");

    vi.advanceTimersByTime(20);
    // 1 フレーム = カーソルを隠す→描く→表示 の 1 セットだけ
    expect(all().split("\x1b[?25l").length - 1).toBe(1);
    expect(all()).toContain("a");
    expect(all()).toContain("c");
    screen.stop();
  });

  it("全画面再描画: 各行を \\x1b[2K で消してから書く (差分描画はしない)", () => {
    vi.useFakeTimers();
    const { screen, written, all } = createAltHarness({ rows: 4, columns: 20 });
    screen.start();
    written.length = 0;
    screen.write("x\n");
    vi.advanceTimersByTime(20);
    // rows=4 → viewport 4 行ぶん、すべて消してから描く
    expect(all().split("\x1b[2K").length - 1).toBe(4);
    screen.stop();
  });

  it("画面幅を超える行は折り返さずに切り詰める (全角も 2 桁で数える)", () => {
    vi.useFakeTimers();
    const { screen, written, all } = createAltHarness({ rows: 3, columns: 6 });
    screen.start();
    written.length = 0;
    screen.write("あいうえお\n"); // 10 桁 → 6 桁 = 3 文字ぶんで切れる
    vi.advanceTimersByTime(20);
    expect(all()).toContain("あいう");
    expect(all()).not.toContain("あいうえ");
    screen.stop();
  });
});

describe("ScreenManager: スクロールバックの遡り (§3.4)", () => {
  it("最大まで遡ると案内行を確保しても最古行へ到達できる", () => {
    const { screen, written, all } = createAltHarness({ rows: 5, columns: 20 });
    screen.start();
    screen.write("oldest-row\nrow-2\nrow-3\nrow-4\nrow-5\nrow-6\nrow-7\nnewest-row\n");
    written.length = 0;

    screen.scrollUp(100);

    expect(all()).toContain("oldest-row");
    expect(all()).toContain("▼");
    screen.stop();
  });

  it("scrollUp で視点が上へ動き、scrollToBottom で戻る", () => {
    const { screen, written, all } = createAltHarness({ rows: 5, columns: 20 });
    screen.start();
    screen.write("1\n2\n3\n4\n5\n6\n7\n8\n");
    written.length = 0;

    screen.scrollUp(3);
    expect(screen.scrollOffset()).toBe(3);
    // 遡った先の行が見えている
    expect(all()).toContain("3");
    // 下端に「新しい出力」 の案内が出る
    expect(all()).toContain("▼");

    written.length = 0;
    screen.scrollToBottom();
    expect(screen.scrollOffset()).toBe(0);
    expect(all()).toContain("8");
    expect(all()).not.toContain("▼");
    screen.stop();
  });

  it("遡り中に新しい出力が来ても視点を動かさない", () => {
    const { screen, written, all } = createAltHarness({ rows: 5, columns: 20 });
    screen.start();
    screen.write("1\n2\n3\n4\n5\n6\n7\n8\n");
    screen.scrollUp(3);
    const before = screen.scrollOffset();

    screen.write("9\n10\n");
    // 行が 2 本増えたぶんオフセットも押し上げ、見ている位置は変わらない
    expect(screen.scrollOffset()).toBe(before + 2);

    written.length = 0;
    screen.scrollUp(0); // 位置は変えずに描き直させる
    expect(all()).toContain("新しい出力が 2 行");
    screen.stop();
  });

  it("scrollDown で最下部まで戻ると新着カウントが消える", () => {
    const { screen } = createAltHarness({ rows: 5, columns: 20 });
    screen.start();
    screen.write("1\n2\n3\n4\n5\n6\n7\n8\n");
    screen.scrollUp(3);
    screen.write("9\n");
    screen.scrollDown(100);
    expect(screen.scrollOffset()).toBe(0);
    screen.stop();
  });

  it("passthrough ではスクロール操作を端末に任せる (no-op)", () => {
    const { screen, written } = createHarness();
    screen.start();
    screen.write("1\n2\n3\n");
    written.length = 0;
    screen.scrollUp(2);
    expect(screen.scrollOffset()).toBe(0);
    expect(written).toEqual([]);
    screen.stop();
  });
});

describe("ScreenManager: ライブ領域の描画 (§3.5 / §4.2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ソフト所有者の高さぶん viewport を詰めて redraw を呼ぶ", () => {
    vi.useFakeTimers();
    const { screen, all } = createAltHarness({ rows: 5, columns: 20 });
    screen.start();
    const calls: string[] = [];
    const release = screen.acquireLive({
      name: "input",
      redraw: () => {
        calls.push("redraw");
        screen.writeLive("> こんにちは");
      },
      height: () => 2,
    });
    vi.advanceTimersByTime(20);

    expect(calls.length).toBeGreaterThan(0);
    // ライブ領域は rows-2 の下、つまり 4 行目から
    expect(all()).toContain("\x1b[4;1H");
    expect(all()).toContain("> こんにちは");
    release();
    screen.stop();
  });

  it("writeLive はスクロールバックに記録しない (自分の描画で履歴を汚さない)", () => {
    const { screen } = createHarness();
    screen.write("本文\n");
    screen.writeLive("> 入力中");
    expect(screen.snapshotLines()).toEqual(["本文", ""]);
  });

  it("排他所有中の writeLive は描かない (inquirer が画面を持っている)", () => {
    const { screen, written } = createHarness();
    const release = screen.acquireLive({ name: "inquirer" });
    screen.writeLive("> 入力中");
    expect(written).toEqual([]);
    release();
  });

  it("passthrough ではソフト所有者を消してから割り込み出力を挟み、描き直す", () => {
    const { screen, written } = createHarness();
    const order: string[] = [];
    const release = screen.acquireLive({
      name: "input",
      redraw: () => order.push("redraw"),
      height: () => 1,
      clear: () => order.push("clear"),
    });
    screen.write("バックグラウンド通知\n");
    expect(order).toEqual(["clear", "redraw"]);
    expect(written).toEqual(["バックグラウンド通知\n"]);
    release();
  });
});

describe("ScreenManager: 代替画面でのスピナー状態行 (§5 補足)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ora のフレームはスクロールバックに積まず、ライブ領域に 1 行として描く", () => {
    vi.useFakeTimers();
    const { screen, written, all } = createAltHarness({ rows: 4, columns: 30 });
    screen.start();
    screen.write("本文\n");
    written.length = 0;

    // ora は cursorTo とフレーム本文を別々の write で出す
    screen.write("\x1b[1G");
    screen.write("⠋ 考え中...");
    vi.advanceTimersByTime(20);

    expect(screen.snapshotLines()).toEqual(["本文", ""]);
    // rows=4、状態行 1 行ぶんを確保して 4 行目に描く
    expect(all()).toContain("\x1b[4;1H");
    expect(all()).toContain("⠋ 考え中...");
    screen.stop();
  });

  it("確定した出力が来たら状態行は消える", () => {
    vi.useFakeTimers();
    const { screen, written, all } = createAltHarness({ rows: 4, columns: 30 });
    screen.start();
    screen.write("\x1b[1G");
    screen.write("⠋ 考え中...");
    vi.advanceTimersByTime(20);
    written.length = 0;

    screen.write("応答テキスト\n");
    vi.advanceTimersByTime(20);
    expect(all()).not.toContain("考え中");
    screen.stop();
  });

  it("排他所有 (inquirer) 中はフレームを完全に捨てる", () => {
    const { screen } = createAltHarness();
    screen.start();
    const release = screen.acquireLive({ name: "inquirer" });
    screen.write("\x1b[1G");
    screen.write("⠋ 考え中...");
    expect(screen.pendingCount()).toBe(0);
    expect(screen.snapshotLines()).toEqual([""]);
    release();
    screen.stop();
  });
});

// ─── stdin 所有権の一元化 (docs/stdin-ownership.md) ───────────────────

/** 差し替え用の stdin。raw mode の呼び出し履歴と data 購読者を記録する */
function fakeStdin() {
  const listeners: ((chunk: Buffer) => void)[] = [];
  const state = {
    isTTY: true,
    isRaw: false,
    resumed: 0,
    calls: [] as boolean[],
    listeners,
    rawError: undefined as Error | undefined,
  };
  const stdin = {
    get isTTY() {
      return state.isTTY;
    },
    get isRaw() {
      return state.isRaw;
    },
    setRawMode(v: boolean) {
      if (v && state.rawError) throw state.rawError;
      state.isRaw = v;
      state.calls.push(v);
      return stdin;
    },
    resume() {
      state.resumed++;
      return stdin;
    },
    on(event: string, listener: (chunk: Buffer) => void) {
      if (event === "data") listeners.push(listener);
      return stdin;
    },
    off(event: string, listener: (chunk: Buffer) => void) {
      if (event !== "data") return stdin;
      const i = listeners.indexOf(listener);
      if (i !== -1) listeners.splice(i, 1);
      return stdin;
    },
  };
  /** 端末からの入力を模す */
  const emitData = (chunk: Buffer): void => {
    for (const l of [...listeners]) l(chunk);
  };
  return { stdin: stdin as unknown as NodeJS.ReadStream, state, emitData };
}

describe("ScreenManager: session全期間のスクロールキー", () => {
  it("入力所有者がいないLLM/tool実行中でもPgUp/PgDnを処理する", () => {
    const { stdin, emitData } = fakeStdin();
    const screen = new ScreenManagerImpl({
      sink: () => {},
      stdin,
      alternate: true,
      rows: () => 5,
      columns: () => 20,
    });
    screen.write("1\n2\n3\n4\n5\n6\n7\n8\n");
    screen.start();

    emitData(Buffer.from("\x1b[5~"));
    expect(screen.scrollOffset()).toBeGreaterThan(0);

    emitData(Buffer.from("\x1b[6~"));
    expect(screen.scrollOffset()).toBe(0);
    screen.stop();
  });

  it("chunk境界で分割されたPgUpも1回だけ処理する", () => {
    const { stdin, emitData } = fakeStdin();
    const screen = new ScreenManagerImpl({
      sink: () => {},
      stdin,
      alternate: true,
      rows: () => 5,
      columns: () => 20,
    });
    screen.write("1\n2\n3\n4\n5\n6\n7\n8\n");
    screen.start();

    emitData(Buffer.from("\x1b[5"));
    expect(screen.scrollOffset()).toBe(0);
    emitData(Buffer.from("~"));
    const once = screen.scrollOffset();
    expect(once).toBeGreaterThan(0);
    emitData(Buffer.from("x"));
    expect(screen.scrollOffset()).toBe(once);
    screen.stop();
  });

  it("排他prompt中はPageUpをpromptへ譲り、履歴を動かさない", () => {
    const { stdin, emitData } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin, alternate: true, rows: () => 5 });
    screen.write("1\n2\n3\n4\n5\n6\n7\n8\n");
    screen.start();
    const release = screen.acquireLive({ name: "inquirer" });

    emitData(Buffer.from("\x1b[5~"));
    expect(screen.scrollOffset()).toBe(0);

    release();
    screen.stop();
  });
});

/** process.emit を差し替えて発火したイベント名を集める (本物の SIGINT を飛ばさない) */
function captureProcessEmit() {
  const events: string[] = [];
  const spy = vi.spyOn(process, "emit").mockImplementation(((event: string | symbol) => {
    events.push(String(event));
    return true;
  }) as typeof process.emit);
  return { events, restore: () => spy.mockRestore() };
}

describe("ScreenManager: stdin をセッション単位で保持する (§3.1)", () => {
  it("端末能力判定の失敗はraw modeへ触れる前に理由を保って停止する", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({
      sink: () => {},
      stdin,
      alternateEnv: { isTTY: true, term: "dumb", platform: "linux" },
    });

    expect(() => screen.start()).toThrow(/TERM=dumb/);
    expect(state.calls).toEqual([]);
    expect(screen.holdsStdinRaw()).toBe(false);
  });

  it("raw mode取得失敗は黙って別入力へ落とさず、修正後にstartを再試行できる", () => {
    const { stdin, state } = fakeStdin();
    state.rawError = new Error("unsupported ioctl");
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin, alternate: true });

    expect(() => screen.start()).toThrow(/raw mode.*unsupported ioctl/);
    expect(screen.holdsStdinRaw()).toBe(false);

    state.rawError = undefined;
    expect(() => screen.start()).not.toThrow();
    expect(screen.holdsStdinRaw()).toBe(true);
    screen.stop();
  });

  it("所有取得時のraw mode再確認が失敗しても幽霊ownerを残さない", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin, alternate: true });
    screen.start();
    state.rawError = new Error("raw mode lost");

    expect(() => screen.acquireLive({ name: "input", redraw: () => {} })).toThrow(/raw mode lost/);
    expect(screen.currentOwner()).toBeUndefined();

    state.rawError = undefined;
    screen.stop();
  });

  it("start() で raw mode を取得し resume する", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    expect(state.isRaw).toBe(true);
    expect(state.resumed).toBe(1);
    expect(screen.holdsStdinRaw()).toBe(true);
    screen.stop();
  });

  it("既に raw のときは一度 false に落としてから true にする (libuv キャッシュ対策)", () => {
    const { stdin, state } = fakeStdin();
    state.isRaw = true;
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    expect(state.calls).toEqual([false, true]);
    screen.stop();
  });

  it("所有者を解放しても cooked に戻さない (所有者と所有者のあいだを塞ぐ)", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const release = screen.acquireLive({ name: "input", redraw: () => {} });
    release();
    expect(state.isRaw).toBe(true);
    expect(screen.holdsStdinRaw()).toBe(true);
    screen.stop();
  });

  it("排他所有 (inquirer) でも raw を再確認する (段階 4 の早期 return を撤去)", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    state.calls.length = 0;
    const release = screen.acquireLive({ name: "inquirer" });
    // 排他所有者でもスキップせずに raw を張り直す
    expect(state.calls).toEqual([false, true]);
    release();
    screen.stop();
  });

  it("inquirer が終了時に cooked へ戻しても release() で raw に戻る (§3.2)", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const release = screen.acquireLive({ name: "inquirer" });
    // inquirer は外部ライブラリなので自前で cooked へ戻す。これは防げない
    stdin.setRawMode(false);
    release();
    expect(state.isRaw).toBe(true);
  });

  it("入れ子の所有をすべて解放しても保持は続く", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const outer = screen.acquireLive({ name: "input", redraw: () => {} });
    const inner = screen.acquireLive({ name: "progress", redraw: () => {} });
    inner();
    outer();
    expect(state.isRaw).toBe(true);
    screen.stop();
  });

  it("stop() で初めて cooked に戻る", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    expect(state.isRaw).toBe(true);
    screen.stop();
    expect(state.isRaw).toBe(false);
    expect(screen.holdsStdinRaw()).toBe(false);
    // 監視も外れている (リスナーの取り残しがない)
    expect(state.listeners.length).toBe(0);
  });

  it("stop() 後の release() は raw を張り直さない", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const release = screen.acquireLive({ name: "input", redraw: () => {} });
    screen.stop();
    state.calls.length = 0;
    release();
    expect(state.calls).toEqual([]);
    expect(state.isRaw).toBe(false);
  });

  it("非TTY では stdin に一切触らない (パイプモードを壊さない)", () => {
    const { stdin, state } = fakeStdin();
    state.isTTY = false;
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const release = screen.acquireLive({ name: "input", redraw: () => {} });
    release();
    screen.stop();
    expect(state.calls).toEqual([]);
    expect(state.resumed).toBe(0);
    expect(state.listeners.length).toBe(0);
    expect(screen.holdsStdinRaw()).toBe(false);
  });

  it("stdin を渡さない (null) 構成でも start/stop が壊れない", () => {
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin: null });
    expect(() => {
      screen.start();
      screen.acquireLive({ name: "input", redraw: () => {} })();
      screen.stop();
    }).not.toThrow();
    expect(screen.holdsStdinRaw()).toBe(false);
  });
});

describe("ScreenManager: suspendStdin / resumeStdin (§3.4)", () => {
  it("resume時のraw mode取得失敗はsuspend状態を保ち、修正後に再試行できる", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin, alternate: true });
    screen.start();
    screen.suspendStdin();
    state.rawError = new Error("resume ioctl failed");

    expect(() => screen.resumeStdin()).toThrow(/resume ioctl failed/);
    expect(screen.holdsStdinRaw()).toBe(false);

    state.rawError = undefined;
    screen.resumeStdin();
    expect(screen.holdsStdinRaw()).toBe(true);
    screen.stop();
  });

  it("suspend で cooked に戻し、resume で raw に戻す", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    screen.suspendStdin();
    expect(state.isRaw).toBe(false);
    expect(screen.holdsStdinRaw()).toBe(false);
    expect(state.listeners.length).toBe(0);

    screen.resumeStdin();
    expect(state.isRaw).toBe(true);
    expect(screen.holdsStdinRaw()).toBe(true);
    expect(state.listeners.length).toBe(1);
    screen.stop();
  });

  it("suspend 中は release() で raw を張り直さない (子プロセスの入力を奪わない)", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    screen.suspendStdin();
    state.calls.length = 0;
    screen.acquireLive({ name: "input", redraw: () => {} })();
    expect(state.calls).toEqual([]);
    expect(state.isRaw).toBe(false);
    screen.stop();
  });

  it("start() していなければ suspend / resume は何もしない", () => {
    const { stdin, state } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.suspendStdin();
    screen.resumeStdin();
    expect(state.calls).toEqual([]);
  });
});

describe("ScreenManager: Ctrl+C の保険 (§3.3)", () => {
  it("誰も所有していない間に \\x03 が来たら SIGINT を合成する", () => {
    const { stdin, emitData } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const cap = captureProcessEmit();
    try {
      emitData(Buffer.from([0x03]));
      expect(cap.events).toEqual(["SIGINT"]);
    } finally {
      cap.restore();
      screen.stop();
    }
  });

  it("所有者が 1 人でもいる間は何もしない (既存の Ctrl+C 処理と競合させない)", () => {
    const { stdin, emitData } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const release = screen.acquireLive({ name: "input", redraw: () => {} });
    const cap = captureProcessEmit();
    try {
      emitData(Buffer.from([0x03]));
      expect(cap.events).toEqual([]);
    } finally {
      cap.restore();
      release();
      screen.stop();
    }
  });

  it("排他所有 (inquirer) 中も何もしない (inquirer が自分で処理する)", () => {
    const { stdin, emitData } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const release = screen.acquireLive({ name: "inquirer" });
    const cap = captureProcessEmit();
    try {
      emitData(Buffer.from([0x03]));
      expect(cap.events).toEqual([]);
    } finally {
      cap.restore();
      release();
      screen.stop();
    }
  });

  it("生 stdin の担い手 (InterruptWatcher) が登録中は何もしない", () => {
    const { stdin, emitData } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const unregister = screen.registerStdinConsumer("interrupt-watcher");
    expect(screen.stdinConsumerCount()).toBe(1);
    const cap = captureProcessEmit();
    try {
      emitData(Buffer.from([0x03]));
      expect(cap.events).toEqual([]);
      // 担い手が抜けたら保険が再び働く
      unregister();
      unregister(); // 二重解除しても数が壊れない
      expect(screen.stdinConsumerCount()).toBe(0);
      emitData(Buffer.from([0x03]));
      expect(cap.events).toEqual(["SIGINT"]);
    } finally {
      cap.restore();
      screen.stop();
    }
  });

  it("Ctrl+C 以外の入力では発火しない", () => {
    const { stdin, emitData } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    const cap = captureProcessEmit();
    try {
      emitData(Buffer.from("hello", "utf8"));
      emitData(Buffer.from([0x1b]));
      expect(cap.events).toEqual([]);
    } finally {
      cap.restore();
      screen.stop();
    }
  });

  it("stop() 後は監視が外れて発火しない", () => {
    const { stdin, emitData } = fakeStdin();
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    screen.stop();
    const cap = captureProcessEmit();
    try {
      emitData(Buffer.from([0x03]));
      expect(cap.events).toEqual([]);
    } finally {
      cap.restore();
    }
  });

  it("非TTY では監視を張らない", () => {
    const { stdin, state } = fakeStdin();
    state.isTTY = false;
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin });
    screen.start();
    expect(state.listeners.length).toBe(0);
    screen.stop();
  });
});

describe("ScreenManager: 排他所有中のキューイング", () => {
  it("排他所有中の出力は画面に出さずキューへ退避する", () => {
    const { screen, written } = createHarness();
    screen.write("前\n");
    const release = screen.acquireLive({ name: "inquirer" });
    screen.write("割り込み1\n");
    screen.write("割り込み2\n");
    expect(written).toEqual(["前\n"]);
    expect(screen.pendingCount()).toBe(2);
    release();
  });

  it("解放時に FIFO でフラッシュする (順序を入れ替えない)", () => {
    const { screen, written } = createHarness();
    const release = screen.acquireLive({ name: "inquirer" });
    screen.write("1\n");
    screen.write("2\n");
    screen.write("3\n");
    release();
    expect(written).toEqual(["1\n", "2\n", "3\n"]);
    expect(screen.pendingCount()).toBe(0);
  });

  it("退避中もスクロールバックへの記録は書き込み順に行う", () => {
    const { screen } = createHarness();
    const release = screen.acquireLive({ name: "inquirer" });
    screen.write("a\n");
    screen.write("b\n");
    expect(screen.snapshotLines()).toEqual(["a", "b", ""]);
    release();
  });

  it("入れ子の排他所有: 内側を解放しても外側が残っていれば流さない", () => {
    const { screen, written } = createHarness();
    const outer = screen.acquireLive({ name: "outer" });
    const inner = screen.acquireLive({ name: "inner" });
    screen.write("x\n");
    inner();
    expect(written).toEqual([]);
    expect(screen.pendingCount()).toBe(1);
    outer();
    expect(written).toEqual(["x\n"]);
  });

  it("ソフト所有の上に排他所有が乗ったら排他として扱う", () => {
    const { screen, written } = createHarness();
    const soft = screen.acquireLive({ name: "input", redraw: () => {} });
    const exclusive = screen.acquireLive({ name: "inquirer" });
    screen.write("通知\n");
    expect(written).toEqual([]);
    exclusive();
    expect(written).toEqual(["通知\n"]);
    soft();
  });

  it("stop() は所有者を捨てて溜めた出力を必ず流す", () => {
    const { screen, written } = createHarness();
    screen.acquireLive({ name: "inquirer" });
    screen.write("残り\n");
    screen.stop();
    expect(written).toEqual(["残り\n"]);
  });
});

describe("ScreenManager: スピナー由来の一過性フレーム", () => {
  it("排他所有中はキューに積まず捨てる", () => {
    const { screen, written } = createHarness();
    const release = screen.acquireLive({ name: "inquirer" });
    // ora は cursorTo(0) とフレーム本文を別々の write で出す
    screen.write("\u001b[1G");
    screen.write("⠋ 考え中");
    screen.write("\u001b[1G");
    screen.write("⠙ 考え中");
    expect(screen.pendingCount()).toBe(0);
    release();
    expect(written).toEqual([]);
  });

  it("フレームはスクロールバックにも記録しない", () => {
    const { screen } = createHarness();
    screen.write("\r\u001b[2K");
    screen.write("進捗 10%");
    expect(screen.snapshotLines()).toEqual([""]);
  });

  it("排他所有していなければフレームはそのまま表示する", () => {
    const { screen, written } = createHarness();
    screen.write("\r\u001b[2K");
    expect(written).toEqual(["\r\u001b[2K"]);
  });

  it("改行を含む出力はフレーム扱いしない (確定した出力)", () => {
    const { screen, written } = createHarness();
    const release = screen.acquireLive({ name: "inquirer" });
    screen.write("\u001b[1G");
    screen.write("✔ 完了\n");
    release();
    expect(written).toEqual(["✔ 完了\n"]);
  });

  it("フレーム継続の扱いは次の 1 回だけ (通常出力を取りこぼさない)", () => {
    const { screen, written } = createHarness();
    const release = screen.acquireLive({ name: "inquirer" });
    screen.write("\u001b[1G"); // 捨てる
    screen.write("frame"); // 同じフレームの続きとして捨てる
    screen.write("token"); // 通常の出力なので退避する
    release();
    expect(written).toEqual(["token"]);
  });
});
