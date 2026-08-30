import { describe, expect, it } from "vitest";
import { resolveWindowsBashCommand } from "../../src/tools/definitions/bash.js";

describe("resolveWindowsBashCommand", () => {
  it("Git Bashが無い場合にcmd.exeへ意味を変えず、復旧手順付きで失敗する", () => {
    expect(() => resolveWindowsBashCommand("printf '%s' ok", null)).toThrow(/Git for Windows/);
    expect(() => resolveWindowsBashCommand("printf '%s' ok", null)).toThrow(/cmd\.exe.*実行しません/);
  });

  it("Git BashがあればPOSIX shellとしてコマンドを構成する", () => {
    expect(resolveWindowsBashCommand("pwd", "C:\\Program Files\\Git\\bin\\bash.exe")).toEqual({
      shell: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["-c", "pwd"],
    });
  });
});
