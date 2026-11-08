import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../src/security/containment.js", () => ({ isBashNetworkContained: vi.fn(() => false) }));

import type { SecurityConfig } from "../../src/config/types.js";
import { inspectBlenderCode } from "../../src/security/blender-code-inspector.js";
import {
  evaluateMcpToolPolicy,
  registerMcpContentInspector,
  registerMcpToolPolicy,
  resetMcpToolPolicies,
  type McpToolPolicyInfo,
} from "../../src/security/mcp-tool-policy.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { nonTTYReader } from "../../src/utils/non-tty-reader.js";
import { clearInteractionBridges, setInteractionBridge } from "../../src/agent/interaction-bridge-registry.js";
import type { PermissionRequest } from "../../src/agent/agent-events.js";

/**
 * MCP ツールの権限 (docs/mcp-tool-permission-design.md)。
 * 層 3 中身の検査器 → 層 1 mcp-servers.json の設定 → 層 2 注釈、 と PermissionManager での順番。
 */

const CWD = process.cwd();
const inCwd = (...p: string[]): string => path.join(CWD, ...p);
const outside = path.join(path.parse(CWD).root, "definitely-outside-localllm", "x.blend");
const skillsDir = path.join(os.homedir(), ".localllm", "skills");
const ctx = { cwd: CWD, skillsDir };
const py = (s: string): string => s.replace(/\\/g, "\\\\"); // 非 raw 文字列に入れるパス

const TOOL = "mcp__blender__execute_blender_code";
const SCENE = "mcp__blender__get_scene_info";

function mkConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return { allowedDirectories: [CWD], blockedCommands: [], rules: { allow: [], deny: [], ask: [] }, ...overrides };
}

function answer(choice: string) {
  return vi.spyOn(nonTTYReader, "readLine").mockResolvedValue(choice);
}

function policy(fullName: string, info: Partial<McpToolPolicyInfo>): void {
  const tool = fullName.split("__").pop() ?? fullName;
  registerMcpToolPolicy(fullName, { server: "blender", tool, ...info });
}

/** 典型的な形づくりのコード (部品箱を読み込み、 メッシュ・材質・モディファイアを作り、 作業フォルダへ保存・撮影) */
const MODELING = `
exec(open(r"${path.join(skillsDir, "blender-modeling", "references", "bkit.py")}", encoding="utf-8").read(), globals())
import bpy, bmesh, math, random
from mathutils import Vector, Euler
from mathutils.bvhtree import BVHTree
import os

# 机を作る (os.remove はコメントなので見ない)
OUT = r"${inCwd("out")}"
os.makedirs(OUT, exist_ok=True)
mesh = bpy.data.meshes.new("Top")
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
bm.to_mesh(mesh)
bm.free()
ob = bpy.data.objects.new("Top", mesh)
bpy.context.collection.objects.link(ob)
ob.scale = Vector((1.2, 0.6, 0.04))
mod = ob.modifiers.new("Bevel", "BEVEL")
mod.width = 0.01
mat = bpy.data.materials.new("Wood")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.3, 0.1, 1)
ob.data.materials.append(mat)
for i in range(4):
    leg = box(f"Leg{i}", (0.04, 0.04, 0.7), (math.cos(i) * 0.5, 0.0, 0.35))
name = "desk_%d" % random.randint(0, 9)
print("done".replace("d", "D"), re_ok := 1)
scene = bpy.context.scene
scene.render.filepath = os.path.join(OUT, "desk.png")
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=r"${inCwd("out", "desk.blend")}")
bpy.ops.export_scene.fbx(filepath="${py(inCwd("out", "desk.fbx"))}", use_selection=True)
render_views(OUT, prefix="desk")
`;

beforeEach(() => {
  resetMcpToolPolicies();
  clearInteractionBridges();
});
afterEach(() => vi.restoreAllMocks());

describe("Blender の検査器 (execute_blender_code)", () => {
  it("ふつうの形づくりのコード・作業フォルダへの保存と撮影は通す", () => {
    expect(inspectBlenderCode(MODELING, ctx)).toEqual({ decision: "allow" });
  });

  it("作業フォルダの中への render (filepath を同じコードで決める) は通す", () => {
    const code = `import bpy\nbpy.context.scene.render.filepath = r"${inCwd("shots", "a.png")}"\nbpy.ops.render.render(write_still=True)\n`;
    expect(inspectBlenderCode(code, ctx).decision).toBe("allow");
  });

  it.each([
    ["subprocess", "import subprocess\nsubprocess.run(['calc'])", "subprocess"],
    ["os.remove", `import os\nos.remove(r"${inCwd("a.txt")}")`, "os.remove"],
    ["shutil", "import shutil\nshutil.rmtree('x')", "shutil"],
    ["socket", "import socket", "socket"],
    ["urllib", "from urllib.request import urlopen", "urllib"],
    ["exec", "code = 'print(1)'\nexec(code)", "exec"],
    ["eval", "eval('1+1')", "eval"],
    ["__import__", "m = __import__('os')", "__import__"],
    ["os の別名", "import os as o\no.system('x')", "別名"],
    ["os.system", "import os\nos.system('dir')", "os.system"],
    ["os.environ", "import os\nprint(os.environ)", "os.environ"],
    ["sys.modules", "import sys\nsys.modules.clear()", "sys.modules"],
    ["quit_blender", "import bpy\nbpy.ops.wm.quit_blender()", "終了"],
    ["アドオン", "import bpy\nbpy.ops.preferences.addon_enable(module='x')", "アドオン"],
    ["handlers", "import bpy\nbpy.app.handlers.load_post.append(lambda *a: None)", "handlers"],
    ["register_class", "import bpy\nbpy.utils.register_class(X)", "bpy.utils"],
    ["pathlib の書き込み", "from pathlib import Path\nPath('a').write_text('x')", "pathlib"],
  ])("%s は確認に回す", (_label, code, expected) => {
    const r = inspectBlenderCode(code, ctx);
    expect(r.decision).toBe("ask");
    expect(r.decision === "ask" && r.reason).toContain(expected);
  });

  it("open(…, 'w') で作業フォルダの外に書くのは確認、 中なら通す", () => {
    const bad = inspectBlenderCode(`with open(r"${outside}", "w") as f:\n    f.write("x")\n`, ctx);
    expect(bad.decision).toBe("ask");
    expect(bad.decision === "ask" && bad.reason).toContain("作業フォルダの外");
    const good = inspectBlenderCode(`with open(r"${inCwd("log.txt")}", "w") as f:\n    f.write("x")\n`, ctx);
    expect(good.decision).toBe("allow");
    // 相手が変数で確かめられない open は確認
    expect(inspectBlenderCode("p = make()\nopen(p, 'a').write('x')", ctx).decision).toBe("ask");
  });

  it("作業フォルダの外の絶対パス (Windows 形式・/ 区切り・POSIX・~) は確認", () => {
    for (const p of [outside, outside.replace(/\\/g, "/"), "/etc/passwd", "~/secret.blend"]) {
      const r = inspectBlenderCode(`import bpy\nbpy.ops.wm.save_as_mainfile(filepath=r"${p}")`, ctx);
      expect(r.decision, p).toBe("ask");
    }
    // 非 raw の \\ 区切りでも作業フォルダの中なら通す
    expect(
      inspectBlenderCode(`import bpy\nbpy.ops.wm.save_as_mainfile(filepath="${py(inCwd("a.blend"))}")`, ctx).decision,
    ).toBe("allow");
  });

  it("開いているファイルの上書き・相対パス・Blender のファイルの場所からの書き出しは確認", () => {
    expect(inspectBlenderCode("import bpy\nbpy.ops.wm.save_mainfile()", ctx).decision).toBe("ask");
    expect(inspectBlenderCode("import bpy\nbpy.ops.wm.save_as_mainfile(filepath='out.blend')", ctx).decision).toBe(
      "ask",
    );
    const dyn = `import bpy, os\nbpy.ops.export_scene.fbx(filepath=os.path.join(os.path.dirname(bpy.data.filepath), "a.fbx"))`;
    expect(inspectBlenderCode(dyn, ctx).decision).toBe("ask");
    expect(inspectBlenderCode("import bpy\nbpy.ops.render.render(write_still=True)", ctx).decision).toBe("ask");
  });

  it("部品箱の読み込みはスキルの置き場の .py だけ許す", () => {
    const other = `exec(open(r"${inCwd("evil.py")}", encoding="utf-8").read(), globals())`;
    expect(inspectBlenderCode(other, ctx).decision).toBe("ask");
  });

  it("code が文字列でなければ確認", () => {
    expect(inspectBlenderCode(undefined, ctx).decision).toBe("ask");
  });
});

describe("evaluateMcpToolPolicy (層 3 → 1 → 2)", () => {
  it("登録の無いツールは決めない", () => {
    expect(evaluateMcpToolPolicy("mcp__x__y", {}, true)).toBeNull();
  });

  it('層 1: "auto" は常に・"autorun" は自律実行モードの間だけ・"ask" は決めない', () => {
    policy(SCENE, { serverLevel: "auto" });
    expect(evaluateMcpToolPolicy(SCENE, {}, false)?.decision).toBe("allow");
    policy(SCENE, { serverLevel: "autorun" });
    expect(evaluateMcpToolPolicy(SCENE, {}, true)?.decision).toBe("allow");
    expect(evaluateMcpToolPolicy(SCENE, {}, false)).toBeNull();
    policy(SCENE, { serverLevel: "ask", annotations: { readOnlyHint: true } });
    expect(evaluateMcpToolPolicy(SCENE, {}, true)).toBeNull();
  });

  it("層 1: ツールごとの指定がサーバーの指定より勝つ", () => {
    policy(SCENE, { serverLevel: "ask", toolLevel: "auto" });
    expect(evaluateMcpToolPolicy(SCENE, {}, false)?.decision).toBe("allow");
    policy(SCENE, { serverLevel: "auto", toolLevel: "ask" });
    expect(evaluateMcpToolPolicy(SCENE, {}, true)).toBeNull();
  });

  it("層 2: 注釈。 readOnlyHint は自律実行モードの間だけ許可・destructiveHint は確認", () => {
    policy(SCENE, { annotations: { readOnlyHint: true } });
    expect(evaluateMcpToolPolicy(SCENE, {}, true)?.decision).toBe("allow");
    expect(evaluateMcpToolPolicy(SCENE, {}, false)).toBeNull();
    policy(SCENE, { annotations: { readOnlyHint: true, destructiveHint: true } });
    expect(evaluateMcpToolPolicy(SCENE, {}, true)?.decision).toBe("ask");
    // サーバー全体の auto は destructiveHint まで広げない。 ツールごとの指定は広げる
    policy(SCENE, { serverLevel: "auto", annotations: { destructiveHint: true } });
    expect(evaluateMcpToolPolicy(SCENE, {}, true)?.decision).toBe("ask");
    policy(SCENE, { serverLevel: "ask", toolLevel: "auto", annotations: { destructiveHint: true } });
    expect(evaluateMcpToolPolicy(SCENE, {}, true)?.decision).toBe("allow");
  });

  it('層 3: "inspect" は検査器の結果。 通っても自動許可は自律実行モードの間だけ・検査器が無ければ確認', () => {
    policy(TOOL, { serverLevel: "autorun", toolLevel: "inspect" });
    expect(evaluateMcpToolPolicy(TOOL, { code: "import bpy" }, true)?.decision).toBe("allow");
    expect(evaluateMcpToolPolicy(TOOL, { code: "import bpy" }, false)).toBeNull();
    const flagged = evaluateMcpToolPolicy(TOOL, { code: "import subprocess" }, true);
    expect(flagged?.decision).toBe("ask");
    expect(flagged?.reason).toContain("subprocess");

    policy("mcp__other__run", { server: "other", tool: "run", toolLevel: "inspect" });
    const none = evaluateMcpToolPolicy("mcp__other__run", {}, true);
    expect(none?.decision).toBe("ask");
    expect(none?.reason).toContain("検査器");

    registerMcpContentInspector({ server: "other", tool: "run" }, () => ({ decision: "allow" }));
    expect(evaluateMcpToolPolicy("mcp__other__run", {}, true)?.decision).toBe("allow");
  });
});

describe("PermissionManager (CLI)", () => {
  it("設定が無ければ従来どおり確認 (autorun でも)", async () => {
    policy(SCENE, {});
    const pm = new PermissionManager(mkConfig());
    pm.setAutorunMode(true);
    const ask = answer("4");
    expect((await pm.checkToolPermission(SCENE, {})).allowed).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("autorun の間、 検査を通ったコードは確認なし・引っかかったコードは理由を出して確認", async () => {
    policy(TOOL, { serverLevel: "autorun", toolLevel: "inspect" });
    policy(SCENE, { serverLevel: "autorun" });
    const pm = new PermissionManager(mkConfig());
    pm.setAutorunMode(true);
    const ask = answer("4");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await pm.checkToolPermission(TOOL, { code: MODELING })).allowed).toBe(true);
    expect((await pm.checkToolPermission(SCENE, {})).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();

    expect((await pm.checkToolPermission(TOOL, { code: "import subprocess" })).allowed).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join("\n")).toContain(
      "確認する理由: 検査器: 許していないモジュールを読み込む (subprocess)",
    );

    // autorun を切ると従来どおり確認
    pm.setAutorunMode(false);
    expect((await pm.checkToolPermission(SCENE, {})).allowed).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("deny ルールは auto に勝つ", async () => {
    policy(SCENE, { serverLevel: "auto" });
    const pm = new PermissionManager(mkConfig({ rules: { allow: [], deny: [SCENE], ask: [] } }));
    const r = await pm.checkToolPermission(SCENE, {});
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("ブロック");
  });

  it("ask ルールは検査器の allow に勝つ", async () => {
    policy(TOOL, { serverLevel: "autorun", toolLevel: "inspect" });
    const pm = new PermissionManager(mkConfig({ rules: { allow: [], deny: [], ask: [TOOL] } }));
    pm.setAutorunMode(true);
    const ask = answer("4");
    expect((await pm.checkToolPermission(TOOL, { code: "import bpy" })).allowed).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("ツール名だけの allow ルールは検査器の ask より勝つ (従来どおり)", async () => {
    policy(TOOL, { serverLevel: "autorun", toolLevel: "inspect" });
    const pm = new PermissionManager(mkConfig({ rules: { allow: [`cli:${TOOL}`], deny: [], ask: [] } }));
    pm.setAutorunMode(true);
    const ask = answer("4");
    expect((await pm.checkToolPermission(TOOL, { code: "import subprocess" })).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("CoT 不整合のターンは auto でも確認", async () => {
    policy(SCENE, { serverLevel: "auto" });
    const pm = new PermissionManager(mkConfig());
    pm.setAutorunMode(true);
    pm.setCotMismatchForTurn("ツール不要と推論");
    const ask = answer("4");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await pm.checkToolPermission(SCENE, {})).allowed).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });
});

describe("PermissionManager (Discord / Slack)", () => {
  it("その面の autorun の間は検査を通ったコードを許可・引っかかったコードは理由つきで拒否", async () => {
    policy(TOOL, { serverLevel: "autorun", toolLevel: "inspect" });
    const pm = new PermissionManager(mkConfig()); // slackAutorun 既定 true
    expect((await pm.checkToolPermission(TOOL, { code: "import bpy" }, "slack")).allowed).toBe(true);
    const r = await pm.checkToolPermission(TOOL, { code: "import subprocess" }, "slack");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("subprocess");
  });

  it("面の autorun が切れていれば autorun の指定は効かず、 ブリッジ確認に理由を出す", async () => {
    policy(TOOL, { serverLevel: "autorun", toolLevel: "inspect" });
    policy(SCENE, { serverLevel: "autorun" });
    const calls: PermissionRequest[] = [];
    setInteractionBridge("discord", {
      async requestPermission(req) {
        calls.push(req);
        return "deny";
      },
    });
    const pm = new PermissionManager(mkConfig({ discordAutorun: false }));
    expect((await pm.checkToolPermission(SCENE, {}, "discord")).allowed).toBe(false);
    expect(calls).toHaveLength(1);
    await pm.checkToolPermission(TOOL, { code: "import socket" }, "discord");
    expect(calls).toHaveLength(2);
    expect(calls[1].summary).toContain("socket");
  });

  it("deny ルールと CoT 不整合は面でも auto に勝つ", async () => {
    policy(SCENE, { serverLevel: "auto" });
    const denied = new PermissionManager(mkConfig({ rules: { allow: [], deny: [`slack:${SCENE}`], ask: [] } }));
    expect((await denied.checkToolPermission(SCENE, {}, "slack")).allowed).toBe(false);
    const pm = new PermissionManager(mkConfig());
    pm.setCotMismatchForTurn("ツール不要と推論");
    const r = await pm.checkToolPermission(SCENE, {}, "slack");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("CoT");
  });
});
