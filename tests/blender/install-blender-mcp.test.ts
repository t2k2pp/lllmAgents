import { describe, it, expect } from "vitest";
import {
  addonsDirFor,
  blenderConfigBase,
  findBlenderExecutables,
  findUvx,
  MCP_FOR_BLENDER_PACKAGE,
  MCP_FOR_BLENDER_VERSION,
  mergeBlenderServer,
  parseBlenderVersion,
  parseEnableResult,
  pickBlender,
  safeToSavePrefs,
  type ProbeDeps,
} from "../../src/blender/install-blender-mcp.js";

// Blender MCP のセットアップの、場所探しと設定の書き換え（docs/blender-mcp-integration.md §2）。
// 実際の Blender・uvx は動かさない。

function deps(
  platform: NodeJS.Platform,
  files: string[],
  env: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
): ProbeDeps {
  const set = new Set(files);
  return {
    platform,
    env,
    homedir: platform === "win32" ? "C:\\Users\\u" : "/Users/u",
    exists: (p) => set.has(p),
    list: (d) => dirs[d] ?? [],
  };
}

describe("findUvx", () => {
  it("PATH にあればそれを使う", () => {
    const d = deps("win32", ["C:\\tools\\uvx.exe"], { PATH: "C:\\tools;C:\\other" });
    expect(findUvx(d)).toBe("C:\\tools\\uvx.exe");
  });
  it("PATH に無くても ~/.local/bin を見る（GUI から起動された時）", () => {
    const d = deps("win32", ["C:\\Users\\u\\.local\\bin\\uvx.exe"], { PATH: "" });
    expect(findUvx(d)).toBe("C:\\Users\\u\\.local\\bin\\uvx.exe");
  });
  it("macOS は Homebrew の場所も見る", () => {
    const d = deps("darwin", ["/opt/homebrew/bin/uvx"], { PATH: "/usr/bin" });
    expect(findUvx(d)).toBe("/opt/homebrew/bin/uvx");
  });
  it("どこにも無ければ null", () => {
    expect(findUvx(deps("linux", [], { PATH: "/usr/bin" }))).toBeNull();
  });
});

describe("findBlenderExecutables", () => {
  it("Windows: 環境変数の指定・Blender Foundation の新しい版・Steam の順", () => {
    const pf = "C:\\Program Files";
    const pf86 = "C:\\Program Files (x86)";
    const d = deps(
      "win32",
      [
        "D:\\b\\blender.exe",
        `${pf}\\Blender Foundation\\Blender 4.2\\blender.exe`,
        `${pf}\\Blender Foundation\\Blender 5.1\\blender.exe`,
        `${pf86}\\Steam\\steamapps\\common\\Blender\\blender.exe`,
      ],
      { LOCALLLM_BLENDER: "D:\\b\\blender.exe", ProgramFiles: pf, "ProgramFiles(x86)": pf86, PATH: "" },
      { [`${pf}\\Blender Foundation`]: ["Blender 4.2", "Blender 5.1"] },
    );
    expect(findBlenderExecutables(d)).toEqual([
      "D:\\b\\blender.exe",
      `${pf}\\Blender Foundation\\Blender 5.1\\blender.exe`,
      `${pf}\\Blender Foundation\\Blender 4.2\\blender.exe`,
      `${pf86}\\Steam\\steamapps\\common\\Blender\\blender.exe`,
    ]);
  });
  it("macOS: /Applications の Blender.app", () => {
    const d = deps(
      "darwin",
      ["/Applications/Blender.app/Contents/MacOS/Blender"],
      { PATH: "" },
      { "/Applications": ["Blender.app", "Safari.app"] },
    );
    expect(findBlenderExecutables(d)).toEqual(["/Applications/Blender.app/Contents/MacOS/Blender"]);
  });
  it("同じ物を二度挙げない", () => {
    const d = deps("linux", ["/usr/bin/blender"], { PATH: "/usr/bin" });
    expect(findBlenderExecutables(d)).toEqual(["/usr/bin/blender"]);
  });
});

describe("版と置き場所", () => {
  it("--version の出力から版を読む", () => {
    expect(parseBlenderVersion("Blender 5.2.3 LTS\n\tbuild date: ...")).toEqual([5, 2]);
    expect(parseBlenderVersion("nothing")).toBeNull();
  });
  it("一番新しい版を選び、動かない物は飛ばす", () => {
    const versions: Record<string, [number, number] | null> = { a: [4, 2], b: null, c: [5, 1] };
    expect(pickBlender(["a", "b", "c"], (e) => versions[e] ?? null)).toEqual({ exe: "c", version: [5, 1] });
    expect(pickBlender(["b"], () => null)).toBeNull();
  });
  it("設定の置き場所と addons", () => {
    const d = deps("win32", [], { APPDATA: "C:\\Users\\u\\AppData\\Roaming" });
    const base = blenderConfigBase(d);
    expect(base).toBe("C:\\Users\\u\\AppData\\Roaming\\Blender Foundation\\Blender");
    expect(addonsDirFor(base, [5, 2], "win32")).toBe(`${base}\\5.2\\scripts\\addons`);
    expect(blenderConfigBase(deps("darwin", []))).toBe("/Users/u/Library/Application Support/Blender");
  });
  it("初めて開く版で他の版があれば設定を保存しない（引き継ぎの問いを消さない）", () => {
    const base = "/cfg";
    expect(safeToSavePrefs(base, [5, 2], deps("linux", [], {}, { [base]: ["4.2", "5.2"] }))).toBe(false);
    expect(
      safeToSavePrefs(base, [5, 2], deps("linux", ["/cfg/5.2/config/userpref.blend"], {}, { [base]: ["4.2", "5.2"] })),
    ).toBe(true);
    expect(safeToSavePrefs(base, [5, 2], deps("linux", [], {}, { [base]: ["5.2"] }))).toBe(true);
  });
});

describe("mergeBlenderServer", () => {
  const uvx = "C:\\Users\\u\\.local\\bin\\uvx.exe";
  it("ファイルが無ければ作る（版を固定・確認あり・送信しない）", () => {
    const { text, changed } = mergeBlenderServer(null, uvx);
    expect(changed).toBe(true);
    const entry = JSON.parse(text).mcpServers.blender;
    expect(entry.command).toBe(uvx);
    expect(entry.args).toEqual([`${MCP_FOR_BLENDER_PACKAGE}@${MCP_FOR_BLENDER_VERSION}`]);
    expect(entry.transport).toBe("stdio");
    expect(entry.permissionLevel).toBe("ask");
    expect(entry.env.DISABLE_TELEMETRY).toBe("true");
  });
  it("他のサーバーと他の項目は残す", () => {
    const before = JSON.stringify({ note: "x", mcpServers: { other: { command: "a", transport: "stdio" } } });
    const doc = JSON.parse(mergeBlenderServer(before, uvx).text);
    expect(doc.note).toBe("x");
    expect(doc.mcpServers.other).toEqual({ command: "a", transport: "stdio" });
    expect(doc.mcpServers.blender).toBeDefined();
  });
  it("古い blender（uvx blender-mcp）を置き換え、利用者の決めた所は残す", () => {
    const before = JSON.stringify({
      mcpServers: {
        blender: {
          command: "uvx",
          args: ["blender-mcp"],
          transport: "stdio",
          permissionLevel: "auto",
          disabled: true,
          env: { BLENDER_HOST: "10.0.0.2" },
        },
      },
    });
    const entry = JSON.parse(mergeBlenderServer(before, uvx).text).mcpServers.blender;
    expect(entry.args[0]).toContain(MCP_FOR_BLENDER_PACKAGE);
    expect(entry.permissionLevel).toBe("auto");
    expect(entry.disabled).toBe(true);
    expect(entry.env).toEqual({ BLENDER_HOST: "10.0.0.2", DISABLE_TELEMETRY: "true" });
  });
  it("2 回目は変わらない", () => {
    const first = mergeBlenderServer(null, uvx).text;
    expect(mergeBlenderServer(first, uvx).changed).toBe(false);
  });
  it("壊れた JSON は触らない", () => {
    expect(() => mergeBlenderServer("{ not json", uvx)).toThrow();
    expect(() => mergeBlenderServer("[]", uvx)).toThrow();
  });
});

describe("parseEnableResult", () => {
  it("有効にした・済んでいた・失敗を読み分ける", () => {
    expect(parseEnableResult('noise\nLOCALLLM_RESULT {"already":[],"enabled":true,"error":null}\n').ok).toBe(true);
    expect(parseEnableResult('LOCALLLM_RESULT {"already":["blender_mcp"],"enabled":false,"error":null}').ok).toBe(true);
    const ng = parseEnableResult('LOCALLLM_RESULT {"already":[],"enabled":false,"error":"boom"}');
    expect(ng).toEqual({ ok: false, message: "boom" });
    expect(parseEnableResult("crashed").ok).toBe(false);
  });
});
