import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveInput } from "../../src/cli/interactive-input.js";
import { appendPromptHistory, loadPromptHistory } from "../../src/cli/prompt-history-store.js";
import { screen } from "../../src/cli/screen-manager.js";

describe("prompt-history-store", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-"));
    file = path.join(dir, "nested", "history.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ファイルが無ければ空を返す", () => {
    expect(loadPromptHistory(dir, file)).toEqual({ entries: [], invalidLines: 0 });
  });

  it("同じ作業フォルダの入力だけを古い順に返し、 複数行入力も保つ", () => {
    const projectA = path.join(dir, "a");
    const projectB = path.join(dir, "b");
    appendPromptHistory("最初の依頼", projectA, file);
    appendPromptHistory("別フォルダの依頼", projectB, file);
    appendPromptHistory("1行目\n2行目", projectA, file);

    expect(loadPromptHistory(projectA, file).entries).toEqual(["最初の依頼", "1行目\n2行目"]);
    expect(loadPromptHistory(projectB, file).entries).toEqual(["別フォルダの依頼"]);
  });

  it("上限件数を超える分は新しい側を残す", () => {
    for (let i = 0; i < 5; i++) appendPromptHistory(`p${i}`, dir, file);
    expect(loadPromptHistory(dir, file, 2).entries).toEqual(["p3", "p4"]);
  });

  it("読めない行は読み飛ばし、 件数を返す", () => {
    appendPromptHistory("正常", dir, file);
    fs.appendFileSync(file, "{壊れた行\n" + JSON.stringify({ display: 1, project: dir }) + "\n");
    expect(loadPromptHistory(dir, file)).toEqual({ entries: ["正常"], invalidLines: 2 });
  });
});

describe("InteractiveInput の ↑ 履歴", () => {
  const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  afterEach(() => {
    vi.restoreAllMocks();
    if (stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  });

  it("前回起動までの履歴を ↑ で呼び出し、 確定した入力を onHistoryAdd へ渡す", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    vi.spyOn(screen, "isAlternate").mockReturnValue(false);
    vi.spyOn(screen, "writeLive").mockImplementation(() => {});
    vi.spyOn(screen, "acquireLive").mockImplementation(() => () => {});
    const added: string[] = [];
    const input = new InteractiveInput({
      initialHistory: ["古い依頼", "前回の依頼"],
      onHistoryAdd: (entry) => added.push(entry),
    });

    const pending = input.question("> ");
    process.stdin.emit("keypress", undefined, { name: "up", sequence: "\x1b[A" });
    process.stdin.emit("keypress", undefined, { name: "up", sequence: "\x1b[A" });
    process.stdin.emit("keypress", "\r", { name: "return", sequence: "\r" });

    expect(await pending).toBe("古い依頼");
    expect(added).toEqual(["古い依頼"]);
  });
});
