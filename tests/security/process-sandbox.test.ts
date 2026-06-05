import { describe, it, expect } from "vitest";
import {
  buildBwrapArgs,
  buildBwrapAllowlistArgs,
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

describe("buildBwrapAllowlistArgs (Linux ネット allowlist ブリッジ・2b-2)", () => {
  const args = buildBwrapAllowlistArgs(
    "npm install",
    ["/work"],
    ["/home/u/.ssh"],
    "/tmp/lllm.sock",
    8118,
    "/usr/bin/socat",
    "/sbin/ip",
  );
  const joined = args.join(" ");
  it("ネットを隔離する (--unshare-net) ＝直結遮断", () => {
    expect(args).toContain("--unshare-net");
  });
  it("unix ソケットを名前空間内へ bind し、 機密 tmpfs より後に置く(/tmp マスク回避)", () => {
    expect(joined).toContain("--bind /tmp/lllm.sock /tmp/lllm.sock");
    expect(joined.indexOf("--tmpfs /home/u/.ssh")).toBeLessThan(joined.indexOf("--bind /tmp/lllm.sock"));
  });
  it("名前空間内で lo を起こし socat で TCP→unix を中継し、 ユーザーコマンドを実行", () => {
    const inner = args[args.length - 1];
    expect(inner).toContain("/sbin/ip link set lo up");
    expect(inner).toContain("/usr/bin/socat TCP-LISTEN:8118");
    expect(inner).toContain("UNIX-CONNECT:/tmp/lllm.sock");
    expect(inner).toContain("npm install");
    expect(inner).toContain("kill $__lllm_socat"); // 後始末
  });
  it("socat の listen 確立を待ってからコマンドを実行する (C-1 レース回避)", () => {
    const inner = args[args.length - 1];
    // readiness ループ: socat 接続確認が成功するまで待つ
    expect(inner).toMatch(/while \[ \$__lllm_i -lt \d+ \]/);
    expect(inner).toContain("connect-timeout=1");
    // 待機ループはユーザーコマンドより前
    expect(inner.indexOf("while [")).toBeLessThan(inner.indexOf("npm install"));
  });
  it("書込は writeDir に bind", () => {
    expect(joined).toContain("--bind /work /work");
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
  it("fs/full は書込を writeDirs に限定 (FS 隔離)", () => {
    for (const level of ["fs", "full"] as const) {
      const p = buildSeatbeltProfile(["/work"], level);
      expect(p).toContain("(deny default)");
      expect(p).toContain(`(allow file-write* (subpath "/work"))`);
      expect(p).not.toContain("(allow file-write*)\n"); // 全許可ではない
      expect(p).toContain("(allow file-read*)");
    }
  });
  it("network は FS を隔離しない (file-write 全許可・ネットだけ閉じる＝2軸の直交)", () => {
    const p = buildSeatbeltProfile(["/work"], "network");
    expect(p).toContain("(allow file-write*)"); // FS 開放
    expect(p).not.toContain(`(allow file-write* (subpath "/work"))`); // writeDir 限定はしない
    expect(p).not.toContain("(allow network"); // ネットは遮断のまま
  });
  it("fs + proxyPort はネットを localhost:port のみに制限 (Seatbelt は数値IP不可・allow network* 無し)", () => {
    const p = buildSeatbeltProfile(["/work"], "fs", [], 54321);
    // Seatbelt の remote ip はホストに "localhost"/"*" のみ許可。数値 127.0.0.1 はロード不能(exit 65)。
    expect(p).toContain(`(allow network-outbound (remote ip "localhost:54321"))`);
    expect(p).not.toContain(`(remote ip "127.0.0.1`);
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
