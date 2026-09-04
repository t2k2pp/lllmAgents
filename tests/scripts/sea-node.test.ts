import { describe, expect, it, vi } from "vitest";
import { isSeaCapableNode, selectSeaNode } from "../../scripts/sea-node.js";

describe("SEA Node selection", () => {
  it("candidate自身の設定が厳密にtrueの場合だけ対応とみなす", () => {
    const execFile = vi.fn(() => "true\n");
    expect(isSeaCapableNode("C:/node.exe", { exists: () => true, execFile })).toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      "C:/node.exe",
      ["-p", "process.config.variables.single_executable_application === true"],
      { encoding: "utf8" },
    );

    expect(
      isSeaCapableNode("C:/wrapper.exe", {
        exists: () => true,
        execFile: () => "undefined\n",
      }),
    ).toBe(false);
  });

  it("実行中Nodeが非対応ならSEA対応fallbackを選ぶ", () => {
    const selected = selectSeaNode({
      current: "/shim/node",
      fallbackCandidates: ["/official/node"],
      isCapable: (candidate) => candidate === "/official/node",
    });
    expect(selected).toBe("/official/node");
  });

  it("明示NODE_EXEが非対応なら別candidateへ黙ってfallbackしない", () => {
    expect(() =>
      selectSeaNode({
        requested: "/custom/node",
        current: "/official/node",
        isCapable: () => false,
      }),
    ).toThrow(/NODE_EXE is not an existing SEA-capable Node binary/);
  });

  it("対応candidateが無ければ確認対象と復旧方法を示す", () => {
    expect(() =>
      selectSeaNode({
        current: "/shim/node",
        fallbackCandidates: ["/usr/local/bin/node"],
        isCapable: () => false,
      }),
    ).toThrow(/Checked: \/shim\/node, \/usr\/local\/bin\/node.*set NODE_EXE/);
  });
});
