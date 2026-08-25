import { describe, expect, it, vi } from "vitest";
import { getGitRevision, gitExecutableCandidates } from "../../scripts/git-revision.js";

describe("git revision discovery", () => {
  it("WindowsではPATH外の標準Git配置も候補にする", () => {
    const candidates = gitExecutableCandidates(
      { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      "win32",
    );
    expect(candidates[0]).toBe("git");
    expect(candidates).toContain("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(candidates).toContain("C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe");
  });

  it("PATHのgit失敗後に実在する標準配置からcommitを得る", () => {
    const run = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("not on PATH");
      })
      .mockReturnValueOnce("abc1234\n");
    const result = getGitRevision({
      candidates: ["git", "C:\\Program Files\\Git\\cmd\\git.exe"],
      exists: () => true,
      run,
    });
    expect(result).toBe("abc1234");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("全候補が失敗した場合だけunknown", () => {
    expect(
      getGitRevision({
        candidates: ["git"],
        exists: () => true,
        run: () => {
          throw new Error("no git");
        },
      }),
    ).toBe("unknown");
  });
});
