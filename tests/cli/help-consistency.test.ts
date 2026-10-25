import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createCompleter } from "../../src/cli/completer.js";
import { BUILTIN_HELP_ENTRIES } from "../../src/cli/renderer.js";
import { getRegistryHelpEntries } from "../../src/cli/commands/registry.js";

/**
 * /help と補完の一覧が一致していることの検査 (docs/archive/todo-legacy-ways-cleanup.md T1)。
 * 以前は /help に削除済みの /capability /metrics や旧名 /sessions /continue が残り、
 * /skills が 2 行載るなど、 ヘルプと実際に使えるコマンドがずれていた。
 */

const root = (cmd: string) => cmd.split(/\s+/)[0];

function completionRoots(): Set<string> {
  const [matches] = createCompleter({})("/");
  return new Set(matches.map(root));
}

function helpRoots(): Set<string> {
  return new Set([...BUILTIN_HELP_ENTRIES.map((e) => root(e.usage)), ...getRegistryHelpEntries().map((e) => e.name)]);
}

describe("/help と補完の一致", () => {
  it("ヘルプに載るコマンドはすべて補完にも出る (削除済みコマンドを載せない)", () => {
    const comp = completionRoots();
    for (const r of helpRoots()) {
      expect(comp.has(r), `${r} が補完に無い`).toBe(true);
    }
  });

  it("補完に出るコマンドはすべてヘルプに載る", () => {
    const help = helpRoots();
    // /exit は /quit と同じ終了コマンドとして /quit の行に併記している
    help.add("/exit");
    for (const r of completionRoots()) {
      expect(help.has(r), `${r} がヘルプに無い`).toBe(true);
    }
  });

  it("ヘルプの同じ書式の行は 1 回だけ (/skills の重複など)", () => {
    const usages = BUILTIN_HELP_ENTRIES.map((e) => e.usage);
    expect(new Set(usages).size).toBe(usages.length);
  });

  it("削除したコマンドはヘルプに無い", () => {
    const usages = BUILTIN_HELP_ENTRIES.map((e) => e.usage);
    for (const removed of [
      "/capability",
      "/metrics",
      "/second",
      "/sessions",
      "/continue",
      "/profiles",
      "/switch",
      "/token",
      "/loop list",
    ]) {
      expect(
        usages.some((u) => u === removed || u.startsWith(`${removed} `)),
        removed,
      ).toBe(false);
    }
  });
});

describe("削除した別名コマンドが dispatcher に残っていない", () => {
  // repl.ts の switch は巨大なクラスの private メソッド内にあり単体で呼べないため、
  // case ラベルをソースから検査する。 別名を case に戻すとここで落ちる。
  const replSource = fs.readFileSync(path.resolve(__dirname, "../../src/cli/repl.ts"), "utf8");

  it.each([
    "/second",
    "/sessions",
    "/continue",
    "/profiles",
    "/profile",
    "/model-registry",
    "/registry",
    "/integration",
    "/intg",
    "/switch",
    "/token",
  ])("case %s が無い", (cmd) => {
    expect(replSource).not.toContain(`case "${cmd}":`);
  });

  it("/model url / ip、 /loop list、 /stream on|off、 /discord public-key / port の分岐が無い", () => {
    expect(replSource).not.toMatch(/args\[0\] === "url"/);
    expect(replSource).not.toMatch(/args\[0\] === "ip"/);
    expect(replSource).not.toContain("/model second url");
    expect(replSource).not.toMatch(/subCmd === "list"\) break/);
    expect(replSource).not.toMatch(/sub === "on"\) \{\s*this\.agent\.setStreamingDisplay/);
    expect(replSource).not.toContain('subCmd === "public-key"');
  });

  // T3: 設定コマンドは対話画面 (/permission・/integrations) だけにした
  it.each(["/discord", "/slack", "/search", "/chatlog"])("直接コマンド case %s が無い", (cmd) => {
    expect(replSource).not.toContain(`case "${cmd}":`);
  });

  it("/permission の旧サブコマンド分岐が無い", () => {
    // list / rules は他コマンドにもある名前なので、 権限固有の名前だけを見る
    for (const sub of [
      "rule-add",
      "rule-remove",
      "auto-add",
      "auto-remove",
      "require-add",
      "require-remove",
      "discord-add",
      "discord-remove",
      "slack-add",
      "slack-remove",
    ]) {
      expect(replSource, sub).not.toContain(`subCmd === "${sub}"`);
    }
  });

  it("設定画面は削除したコマンドを内部で呼ばない (関数を直接呼ぶ)", () => {
    expect(replSource).not.toMatch(/handleCommand\(\s*[`"]\/(discord|slack|search|chatlog|permission)\b/);
  });
});
