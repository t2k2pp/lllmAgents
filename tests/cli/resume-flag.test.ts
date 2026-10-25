import { describe, expect, it } from "vitest";
import type { SessionData } from "../../src/agent/session-manager.js";
import { parseResumeFlag, resolveResumeFlag } from "../../src/cli/resume-flag.js";

function session(id: string): SessionData {
  return { meta: { id, messageCount: 2 } } as unknown as SessionData;
}

describe("parseResumeFlag", () => {
  it("--resume が無ければ none", () => {
    expect(parseResumeFlag(["--no-mcp"])).toEqual({ kind: "none" });
  });

  it("--resume <id> は ID 指定", () => {
    expect(parseResumeFlag(["--no-mcp", "--resume", "abc123"])).toEqual({ kind: "id", id: "abc123" });
  });

  it("--resume latest は最新 (大文字小文字は問わない)", () => {
    expect(parseResumeFlag(["--resume", "latest"])).toEqual({ kind: "latest" });
    expect(parseResumeFlag(["--resume", "LATEST"])).toEqual({ kind: "latest" });
  });

  it("引数なし --resume は使い方エラー", () => {
    expect(parseResumeFlag(["--resume"]).kind).toBe("error");
  });

  it("次が別のフラグなら引数なし扱いでエラー", () => {
    expect(parseResumeFlag(["--resume", "--no-mcp"]).kind).toBe("error");
  });

  it("--resume の重複指定はエラー", () => {
    expect(parseResumeFlag(["--resume", "a", "--resume", "b"]).kind).toBe("error");
  });

  it("--continue は解釈しない (削除済みの書き方)", () => {
    expect(parseResumeFlag(["--continue"])).toEqual({ kind: "none" });
  });
});

describe("resolveResumeFlag", () => {
  const deps = {
    loadSession: (id: string) => (id === "known" ? session("known") : null),
    getLatestSession: () => session("newest"),
  };

  it("ID が見つかればそのセッション", () => {
    const r = resolveResumeFlag({ kind: "id", id: "known" }, deps);
    expect(r.kind === "session" && r.session.meta.id).toBe("known");
  });

  it("ID が見つからなければエラー (黙って新規にしない)", () => {
    const r = resolveResumeFlag({ kind: "id", id: "missing" }, deps);
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.message).toContain("セッション missing が見つかりません");
  });

  it("latest は最新セッション", () => {
    const r = resolveResumeFlag({ kind: "latest" }, deps);
    expect(r.kind === "session" && r.session.meta.id).toBe("newest");
  });

  it("保存セッションが無いと latest もエラー", () => {
    const r = resolveResumeFlag({ kind: "latest" }, { ...deps, getLatestSession: () => null });
    expect(r.kind).toBe("error");
  });

  it("使い方エラーには正しい書き方を添える", () => {
    const r = resolveResumeFlag(parseResumeFlag(["--resume"]), deps);
    expect(r.kind === "error" && r.message).toContain("--resume <session-id>");
    expect(r.kind === "error" && r.message).toContain("--resume latest");
  });

  it("none はそのまま", () => {
    expect(resolveResumeFlag({ kind: "none" }, deps)).toEqual({ kind: "none" });
  });
});
