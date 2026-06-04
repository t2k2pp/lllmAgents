import { describe, it, expect } from "vitest";
import {
  buildBwrapArgs,
  buildSeatbeltProfile,
  defaultSecretDenyDirs,
} from "../../src/security/process-sandbox.js";

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
  it("機密ディレクトリは空 tmpfs で覆う (decision 3)、 かつ書込 bind より後に置く", () => {
    const args = buildBwrapArgs("echo", ["/work"], false, ["/home/u/.ssh"]);
    const joined = args.join(" ");
    expect(joined).toContain("--tmpfs /home/u/.ssh");
    // writeDirs の --bind は mask の --tmpfs より前（後勝ちで確実に隠すため）
    expect(joined.indexOf("--bind /work /work")).toBeLessThan(joined.indexOf("--tmpfs /home/u/.ssh"));
  });
});

describe("buildSeatbeltProfile", () => {
  it("fs はネット全開にしない (proxyPort 無しは fail-closed、 全開 allow network* は決して出さない)", () => {
    expect(buildSeatbeltProfile(["/work"], "fs")).not.toContain("(allow network*)");
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
  it("fs + proxyPort はネットを 127.0.0.1:port のみに制限 (env と表記一致・allow network* 無し)", () => {
    const p = buildSeatbeltProfile(["/work"], "fs", [], 54321);
    expect(p).toContain(`(allow network-outbound (remote ip "127.0.0.1:54321"))`);
    expect(p).not.toContain("(allow network*)");
  });
  it("fs + proxyPort なしは fail-closed (ネット許可を一切出さない)", () => {
    const p = buildSeatbeltProfile(["/work"], "fs");
    expect(p).not.toContain("(allow network*)");
    expect(p).not.toContain("network-outbound");
  });
  it("full はネット許可を出さない (deny default)", () => {
    const p = buildSeatbeltProfile(["/work"], "full");
    expect(p).not.toContain("(allow network");
  });
  it("機密ディレクトリは read を deny し、 allow file-read* より後に置く (last-match-wins)", () => {
    const p = buildSeatbeltProfile(["/work"], "fs", ["/home/u/.aws"]);
    expect(p).toContain(`(deny file-read* (subpath "/home/u/.aws"))`);
    expect(p.indexOf("(allow file-read*)")).toBeLessThan(
      p.indexOf(`(deny file-read* (subpath "/home/u/.aws"))`),
    );
  });
});

describe("defaultSecretDenyDirs", () => {
  it("ssh/aws/gnupg/kube/docker/gcloud を home 相対の絶対パスで返す", () => {
    const dirs = defaultSecretDenyDirs("/home/u");
    expect(dirs).toContain("/home/u/.ssh");
    expect(dirs).toContain("/home/u/.aws");
    expect(dirs).toContain("/home/u/.config/gcloud");
  });
  it("npm/pip 認証 (.npmrc/.pypirc) は塞がない (開発を止めない方針)", () => {
    const dirs = defaultSecretDenyDirs("/home/u");
    expect(dirs.some((d) => d.endsWith(".npmrc"))).toBe(false);
    expect(dirs.some((d) => d.endsWith(".pypirc"))).toBe(false);
  });
});
