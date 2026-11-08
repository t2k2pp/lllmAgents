import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Blender MCP（mcp-for-blender）を 1 コマンドで使える状態にする。
 * `localllm --install-blender` / `localllm --check-blender` から呼ばれる。
 * 設計: docs/blender-mcp-integration.md
 *
 * やること:
 *  1. uvx（uv）を探す（無ければ入れ方を表示して終わる）
 *  2. Blender を探し、版を調べる
 *  3. `uvx mcp-for-blender@<版> install-addon` でアドオンを Blender のユーザーの addons に置く
 *  4. Blender を画面無しで起動してアドオンを有効にし、設定を保存する
 *     （アドオンは Blender を開くたびに自動で 9876 番を待ち受ける）
 *  5. ~/.localllm/mcp-servers.json に blender の項目を足す（他の項目は残す・前のファイルは .bak）
 *
 * サーバーとアドオンは同じパッケージに入っていて、通信の版が合っている必要があるので版を固定する。
 * 上げる時は MCP_FOR_BLENDER_VERSION を変えて --install-blender をやり直す。
 */

export const MCP_FOR_BLENDER_PACKAGE = "mcp-for-blender";
export const MCP_FOR_BLENDER_VERSION = "2.2.7";
export const BLENDER_MCP_SERVER_KEY = "blender";
export const BLENDER_MCP_PORT = 9876;
/** アドオンを置くファイル名（mcp-for-blender の install-addon と同じ）。Blender はこの名前のモジュールとして読む。 */
export const BLENDER_ADDON_MODULE = "blender_mcp";
/** Blender の場所を決め打ちしたい時（Steam の別ドライブのライブラリなど）。 */
export const BLENDER_PATH_ENV = "LOCALLLM_BLENDER";

type Env = Record<string, string | undefined>;

export interface ProbeDeps {
  platform: NodeJS.Platform;
  env: Env;
  homedir: string;
  exists: (p: string) => boolean;
  /** ディレクトリの中の名前（無ければ空） */
  list: (dir: string) => string[];
}

export function defaultProbeDeps(): ProbeDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    exists: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    list: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

function pathModule(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathDirs(deps: ProbeDeps): string[] {
  const raw = deps.env.PATH ?? deps.env.Path ?? "";
  const sep = deps.platform === "win32" ? ";" : ":";
  return raw.split(sep).filter((d) => d.length > 0);
}

function uniq(items: string[]): string[] {
  return [...new Set(items)];
}

/** uvx の絶対パス。GUI から起動された時は PATH が違うことがあるので、よくある置き場所も見る。 */
export function findUvx(deps: ProbeDeps = defaultProbeDeps()): string | null {
  const p = pathModule(deps.platform);
  const exe = deps.platform === "win32" ? "uvx.exe" : "uvx";
  const extra =
    deps.platform === "win32"
      ? [p.join(deps.homedir, ".local", "bin"), p.join(deps.homedir, ".cargo", "bin")]
      : [
          p.join(deps.homedir, ".local", "bin"),
          p.join(deps.homedir, ".cargo", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
        ];
  for (const dir of [...pathDirs(deps), ...extra]) {
    const candidate = p.join(dir, exe);
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}

/** Blender の実行ファイルの候補（見つかった物だけ・重複なし）。先頭ほど優先。 */
export function findBlenderExecutables(deps: ProbeDeps = defaultProbeDeps()): string[] {
  const p = pathModule(deps.platform);
  const found: string[] = [];
  const override = deps.env[BLENDER_PATH_ENV];
  if (override && deps.exists(override)) found.push(override);

  const exe = deps.platform === "win32" ? "blender.exe" : deps.platform === "darwin" ? "Blender" : "blender";
  for (const dir of pathDirs(deps)) {
    const candidate = p.join(dir, deps.platform === "win32" ? "blender.exe" : "blender");
    if (deps.exists(candidate)) found.push(candidate);
  }

  if (deps.platform === "win32") {
    const roots = uniq(
      [deps.env.ProgramFiles ?? "C:\\Program Files", deps.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"].filter(
        (r) => r.length > 0,
      ),
    );
    for (const root of roots) {
      const foundation = p.join(root, "Blender Foundation");
      for (const name of deps
        .list(foundation)
        .filter((n) => /^Blender/i.test(n))
        .sort()
        .reverse()) {
        const candidate = p.join(foundation, name, exe);
        if (deps.exists(candidate)) found.push(candidate);
      }
    }
    const steam = p.join(
      deps.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Steam",
      "steamapps",
      "common",
      "Blender",
      exe,
    );
    if (deps.exists(steam)) found.push(steam);
  } else if (deps.platform === "darwin") {
    for (const apps of ["/Applications", p.join(deps.homedir, "Applications")]) {
      for (const name of deps
        .list(apps)
        .filter((n) => /^Blender.*\.app$/.test(n))
        .sort()
        .reverse()) {
        const candidate = p.join(apps, name, "Contents", "MacOS", exe);
        if (deps.exists(candidate)) found.push(candidate);
      }
    }
    const steam = p.join(
      deps.homedir,
      "Library",
      "Application Support",
      "Steam",
      "steamapps",
      "common",
      "Blender",
      "Blender.app",
      "Contents",
      "MacOS",
      exe,
    );
    if (deps.exists(steam)) found.push(steam);
  } else {
    for (const candidate of ["/snap/bin/blender", "/usr/bin/blender", "/usr/local/bin/blender"]) {
      if (deps.exists(candidate)) found.push(candidate);
    }
  }
  return uniq(found);
}

/** Blender のユーザー設定の置き場所（版ごとのフォルダの親）。 */
export function blenderConfigBase(deps: ProbeDeps = defaultProbeDeps()): string {
  const p = pathModule(deps.platform);
  if (deps.platform === "win32") {
    const appdata = deps.env.APPDATA ?? p.join(deps.homedir, "AppData", "Roaming");
    return p.join(appdata, "Blender Foundation", "Blender");
  }
  if (deps.platform === "darwin") return p.join(deps.homedir, "Library", "Application Support", "Blender");
  const xdg = deps.env.XDG_CONFIG_HOME ?? p.join(deps.homedir, ".config");
  return p.join(xdg, "blender");
}

/** `blender --version` の出力から [major, minor]。 */
export function parseBlenderVersion(stdout: string): [number, number] | null {
  const m = /Blender\s+(\d+)\.(\d+)/.exec(stdout);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** アドオンを置くフォルダ（その版の scripts/addons）。 */
export function addonsDirFor(base: string, version: [number, number], platform: NodeJS.Platform): string {
  return pathModule(platform).join(base, `${version[0]}.${version[1]}`, "scripts", "addons");
}

/**
 * 画面無しで設定を保存してよいか。初めて開く版は「前の版の設定を引き継ぐか」を聞いてくるが、
 * 先に設定を保存するとその問いが出なくなるので、他の版があってこの版の設定がまだ無い時は保存しない。
 */
export function safeToSavePrefs(
  base: string,
  version: [number, number],
  deps: Pick<ProbeDeps, "exists" | "list" | "platform">,
): boolean {
  const p = pathModule(deps.platform);
  const verName = `${version[0]}.${version[1]}`;
  if (deps.exists(p.join(base, verName, "config", "userpref.blend"))) return true;
  const others = deps.list(base).filter((n) => /^\d+\.\d+$/.test(n) && n !== verName);
  return others.length === 0;
}

export interface BlenderServerEntry {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  permissionLevel: "ask" | "auto" | "autorun";
  tools?: Record<string, "ask" | "auto" | "autorun" | "inspect">;
  disabled?: boolean;
}

export function blenderServerEntry(uvxPath: string): BlenderServerEntry {
  return {
    name: BLENDER_MCP_SERVER_KEY,
    transport: "stdio",
    command: uvxPath,
    args: [`${MCP_FOR_BLENDER_PACKAGE}@${MCP_FOR_BLENDER_VERSION}`],
    env: { DISABLE_TELEMETRY: "true" },
    // 自律実行モード (autorun) の間は道具を自動で許し、 任意の Python を動かす execute_blender_code だけは
    // 中身の検査器で見る (ファイルを消す・外へ書く・プロセスを動かす等は確認)。 docs/mcp-tool-permission-design.md
    permissionLevel: "autorun",
    tools: { execute_blender_code: "inspect" },
  };
}

/**
 * mcp-servers.json の中身に blender の項目を足す（他の項目はそのまま）。
 * 既に blender があれば、利用者が決める所（permissionLevel・tools・disabled・env の追加分）は残して作り直す。
 * 読めない JSON は触らない（throw）。
 */
export function mergeBlenderServer(existingText: string | null, uvxPath: string): { text: string; changed: boolean } {
  let doc: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (existingText !== null && existingText.trim().length > 0) {
    const parsed: unknown = JSON.parse(existingText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("mcp-servers.json はオブジェクトではありません");
    }
    doc = parsed as typeof doc;
  }
  const servers = (
    typeof doc.mcpServers === "object" && doc.mcpServers !== null ? { ...doc.mcpServers } : {}
  ) as Record<string, Record<string, unknown>>;
  const prev = servers[BLENDER_MCP_SERVER_KEY];
  const next: Record<string, unknown> = { ...blenderServerEntry(uvxPath) };
  if (prev && typeof prev === "object") {
    if (prev.permissionLevel === "auto" || prev.permissionLevel === "ask" || prev.permissionLevel === "autorun")
      next.permissionLevel = prev.permissionLevel;
    if (prev.tools && typeof prev.tools === "object" && !Array.isArray(prev.tools)) next.tools = prev.tools;
    if (typeof prev.disabled === "boolean") next.disabled = prev.disabled;
    if (prev.env && typeof prev.env === "object") {
      next.env = { ...(prev.env as Record<string, string>), ...(next.env as Record<string, string>) };
    }
  }
  servers[BLENDER_MCP_SERVER_KEY] = next;
  const text = `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`;
  const changed =
    existingText === null || JSON.stringify(JSON.parse(existingText || "{}")) !== JSON.stringify(JSON.parse(text));
  return { text, changed };
}

/** Blender の中で走らせる、アドオンを有効にして設定を保存するスクリプト。 */
export const ENABLE_ADDON_SCRIPT = `
import json, sys
import addon_utils, bpy
module = sys.argv[sys.argv.index("--") + 1]
names = {"MCP for Blender", "Blender MCP"}
result = {"already": [], "enabled": False, "error": None}
try:
    enabled = {a.module for a in bpy.context.preferences.addons}
    for mod in addon_utils.modules(refresh=True):
        if mod.__name__ in enabled and addon_utils.module_bl_info(mod).get("name") in names:
            result["already"].append(mod.__name__)
    if not result["already"]:
        result["enabled"] = addon_utils.enable(module, default_set=True) is not None
        if result["enabled"]:
            bpy.ops.wm.save_userpref()
        else:
            result["error"] = "Blender could not load " + module
except Exception as e:
    result["error"] = str(e)
print("LOCALLLM_RESULT " + json.dumps(result))
`;

export function parseEnableResult(stdout: string): { ok: boolean; message: string } {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("LOCALLLM_RESULT ")) continue;
    try {
      const r = JSON.parse(line.slice("LOCALLLM_RESULT ".length)) as {
        already?: string[];
        enabled?: boolean;
        error?: string | null;
      };
      if (r.already && r.already.length > 0) return { ok: true, message: "アドオンは有効になっていました" };
      if (r.enabled) return { ok: true, message: "アドオンを有効にしました" };
      return { ok: false, message: r.error ?? "アドオンを有効にできませんでした" };
    } catch {
      break;
    }
  }
  return { ok: false, message: "Blender が結果を返さずに終わりました" };
}

const MANUAL_ENABLE =
  "Blender で 編集 → プリファレンス → アドオン →「MCP for Blender」に印を付けてください（Blender を開くと 9876 番で自動で待ち受けます）。";

function runQuiet(cmd: string, args: string[], timeoutMs: number): { status: number | null; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return { status: r.status, stdout: `${r.stdout ?? ""}` };
}

function blenderVersionOf(exe: string): [number, number] | null {
  const r = runQuiet(exe, ["--version"], 60_000);
  return parseBlenderVersion(r.stdout);
}

/** 版が一番新しい Blender（動かなかった候補は除く）。 */
export function pickBlender(
  executables: string[],
  versionOf = blenderVersionOf,
): { exe: string; version: [number, number] } | null {
  let best: { exe: string; version: [number, number] } | null = null;
  for (const exe of executables) {
    const v = versionOf(exe);
    if (!v) continue;
    if (!best || v[0] > best.version[0] || (v[0] === best.version[0] && v[1] > best.version[1]))
      best = { exe, version: v };
  }
  return best;
}

function blenderIsRunning(): boolean {
  if (process.platform === "win32") {
    const r = runQuiet("tasklist", ["/FI", "IMAGENAME eq blender.exe", "/NH"], 15_000);
    return r.stdout.toLowerCase().includes("blender.exe");
  }
  return runQuiet("pgrep", ["-xi", "blender"], 15_000).status === 0;
}

function uvInstallHint(): string {
  return process.platform === "win32"
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    : "curl -LsSf https://astral.sh/uv/install.sh | sh   （macOS は brew install uv でも可）";
}

export function mcpServersPath(): string {
  return path.join(os.homedir(), ".localllm", "mcp-servers.json");
}

function writeMcpConfig(uvx: string): { ok: boolean; message: string } {
  const file = mcpServersPath();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  let merged: { text: string; changed: boolean };
  try {
    merged = mergeBlenderServer(existing, uvx);
  } catch (e) {
    return {
      ok: false,
      message: `${file} が読めないので触りませんでした (${e instanceof Error ? e.message : String(e)})。直してからやり直してください。`,
    };
  }
  if (!merged.changed) return { ok: true, message: `${file} には登録済みでした` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existing !== null) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, merged.text, "utf8");
  return { ok: true, message: `${file} に blender を登録しました${existing !== null ? "（前の内容は .bak）" : ""}` };
}

/** `localllm --install-blender`。0=全部済んだ / 1=手作業が残った・失敗。 */
export function installBlenderMcp(): number {
  const tag = "[install-blender]";
  const uvx = findUvx();
  if (!uvx) {
    console.error(
      `${tag} uv（uvx）が見つかりません。次で入れてから、新しいターミナルでやり直してください:\n  ${uvInstallHint()}`,
    );
    return 1;
  }
  console.log(`${tag} uvx: ${uvx}`);

  let rest = false;
  const blender = pickBlender(findBlenderExecutables());
  if (!blender) {
    console.error(
      `${tag} Blender が見つかりませんでした。入っている場合は ${BLENDER_PATH_ENV} に blender の実行ファイルの場所を入れてやり直してください。`,
    );
    rest = true;
  } else {
    console.log(`${tag} Blender ${blender.version.join(".")}: ${blender.exe}`);
    const base = blenderConfigBase();
    const addonsDir = addonsDirFor(base, blender.version, process.platform);
    console.log(`${tag} アドオンを ${addonsDir} に置きます...`);
    const pkg = `${MCP_FOR_BLENDER_PACKAGE}@${MCP_FOR_BLENDER_VERSION}`;
    const r = spawnSync(uvx, [pkg, "install-addon", "--addons-dir", addonsDir], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (r.status !== 0) {
      console.error(`${tag} アドオンを置けませんでした。ネットワークを確かめて、手で: ${uvx} ${pkg} install-addon`);
      rest = true;
    } else if (blenderIsRunning()) {
      console.log(
        `${tag} Blender が開いているので、有効にするのは飛ばしました。Blender を閉じてやり直すか: ${MANUAL_ENABLE}`,
      );
      rest = true;
    } else if (!safeToSavePrefs(base, blender.version, defaultProbeDeps())) {
      console.log(
        `${tag} Blender ${blender.version.join(".")} はまだ一度も開かれていません。一度開いて設定の引き継ぎを選んでから、やり直すか: ${MANUAL_ENABLE}`,
      );
      rest = true;
    } else {
      const en = spawnSync(
        blender.exe,
        ["--background", "--python-expr", ENABLE_ADDON_SCRIPT, "--", BLENDER_ADDON_MODULE],
        {
          encoding: "utf8",
          timeout: 180_000,
          windowsHide: true,
          env: { ...process.env, BLENDERMCP_NO_UPDATE_CHECK: "1" },
        },
      );
      const res = parseEnableResult(`${en.stdout ?? ""}`);
      console.log(`${tag} ${res.message}`);
      if (!res.ok) {
        console.log(`${tag} ${MANUAL_ENABLE}`);
        rest = true;
      }
    }
  }

  const cfg = writeMcpConfig(uvx);
  console.log(`${tag} ${cfg.message}`);
  if (!cfg.ok) rest = true;

  console.log(
    rest
      ? `${tag} 残りの手作業を済ませてから、Blender を開き、localllm を起動し直してください。確かめるのは localllm --check-blender。`
      : `${tag} 完了。Blender を開いてから localllm を起動し直すと mcp__blender__* の道具が使えます。確かめるのは localllm --check-blender。`,
  );
  return rest ? 1 : 0;
}

function portOpen(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** `localllm --check-blender`。0=使える / 1=足りない物がある。 */
export async function checkBlenderMcp(): Promise<number> {
  const tag = "[check-blender]";
  let ok = true;
  const line = (good: boolean, msg: string) => {
    if (!good) ok = false;
    console.log(`${tag} ${good ? "OK" : "NG"} ${msg}`);
  };

  const uvx = findUvx();
  line(!!uvx, uvx ? `uvx: ${uvx}` : "uvx が見つかりません（localllm --install-blender の案内を見てください）");

  const exes = findBlenderExecutables();
  line(
    exes.length > 0,
    exes.length > 0 ? `Blender: ${exes[0]}` : `Blender が見つかりません（${BLENDER_PATH_ENV} で指定できます）`,
  );

  const file = mcpServersPath();
  let registered = false;
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, { disabled?: boolean }> };
    const entry = doc.mcpServers?.[BLENDER_MCP_SERVER_KEY];
    registered = !!entry && entry.disabled !== true;
  } catch {
    registered = false;
  }
  line(
    registered,
    registered ? `${file} に blender が登録済み` : `${file} に blender がありません（localllm --install-blender）`,
  );

  const listening = await portOpen(BLENDER_MCP_PORT);
  line(
    listening,
    listening
      ? `Blender が ${BLENDER_MCP_PORT} 番で待ち受けています`
      : `${BLENDER_MCP_PORT} 番に Blender がいません（Blender を開く。開いているなら N キーの「MCP for Blender」で Start）`,
  );
  return ok ? 0 : 1;
}
