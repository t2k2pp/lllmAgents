import { describe, it, expect } from "vitest";
import { buildBwrapArgs, buildSeatbeltProfile } from "../../src/security/process-sandbox.js";

// セキュリティ上重要な「どのレベルで FS/ネットをどう開閉するか」を純粋関数として検証する
// (docs/wsl-sandbox-design.md §7: FS書込・ネットワークの2軸)。

describe("buildBwrapArgs", () => {
  it("full はネットワークを遮断する (--unshare-net あり)", () => {
    const args = buildBwrapArgs("echo hi", ["/work"], true);
    expect(args).toContain("--unshare-net");
  });
  it("fs はネットワークを通す (--unshare-net なし)", () => {
    const args = buildBwrapArgs("echo hi", ["/work"], false);
    expect(args).not.toContain("--unshare-net");
  });
  it("ルートは ro-bind、 許可ディレクトリは書込 bind", () => {
    const args = buildBwrapArgs("echo hi", ["/work", "/out"], false);
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    // --bind /work /work と --bind /out /out が含まれる
    const joined = args.join(" ");
    expect(joined).toContain("--bind /work /work");
    expect(joined).toContain("--bind /out /out");
    // コマンドは /bin/sh -c で末尾に
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"]);
  });
});

describe("buildSeatbeltProfile", () => {
  it("fs はネットワークを許可する", () => {
    const p = buildSeatbeltProfile(["/work"], "fs");
    expect(p).toContain("(allow network*)");
  });
  it("full / network はネットワークを許可しない", () => {
    expect(buildSeatbeltProfile(["/work"], "full")).not.toContain("(allow network*)");
    expect(buildSeatbeltProfile(["/work"], "network")).not.toContain("(allow network*)");
  });
  it("どのレベルでも書込は writeDirs に限定 (deny default + allow file-write* writeDirs)", () => {
    for (const level of ["fs", "network", "full"] as const) {
      const p = buildSeatbeltProfile(["/work"], level);
      expect(p).toContain("(deny default)");
      expect(p).toContain(`(allow file-write* (subpath "/work"))`);
      // 読み取りは全許可
      expect(p).toContain("(allow file-read*)");
    }
  });
});
