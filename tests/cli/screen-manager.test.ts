import { describe, it, expect } from "vitest";
import { ScreenManagerImpl } from "../../src/cli/screen-manager.js";

/** 書き出し先を捕まえる ScreenManager を作る */
function createHarness(maxLines?: number) {
  const written: string[] = [];
  const screen = new ScreenManagerImpl({ sink: (t) => written.push(t), maxLines });
  return { screen, written };
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

  it("段階 1 では代替画面を持たない", () => {
    const { screen } = createHarness();
    expect(screen.isAlternate()).toBe(false);
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
