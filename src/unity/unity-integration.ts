import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadPluginBundles, loadPluginSkills } from "../plugins/plugin-loader.js";
import { resolveGitExecutable } from "../git/git-command.js";

export const UNITY_SOURCE = "https://github.com/Unity-Technologies/unity-agent-plugin.git";
export const UNITY_REVISION = "c7055702b44e58402ee481ff408aee407bcf9483";

function run(command: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const failure = error as Error & { stdout?: string; code?: string };
    throw new Error(
      `${command} ${args[0]} failed: ${failure.code ?? failure.message}\n${failure.stdout ?? ""}\nCheck the executable path and Unity CLI installation; run unity doctor --format json for Editor/Pipeline recovery.`,
      { cause: error },
    );
  }
}

function projectRoot(project: string): string {
  const root = fs.realpathSync(project);
  for (const relative of ["ProjectSettings/ProjectVersion.txt", "Packages/manifest.json"]) {
    if (!fs.statSync(path.join(root, relative)).isFile()) throw new Error(`Unity project file missing: ${relative}`);
  }
  return root;
}

// Do not follow source symlinks or copy executable hooks from a third-party bundle.
function copyTree(source: string, target: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Unity source symlink is not supported: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(target);
    for (const name of fs.readdirSync(source).sort()) copyTree(path.join(source, name), path.join(target, name));
  } else if (stat.isFile()) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  } else throw new Error(`Unsupported Unity source entry: ${source}`);
}

function digestTree(root: string): string {
  const hash = createHash("sha256");
  function visit(relative: string): void {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      hash.update(JSON.stringify(relative.split(path.sep).join("/")));
      hash.update(fs.readFileSync(full));
    } else throw new Error(`Invalid installed Unity bundle: ${full}`);
  }
  visit("");
  return hash.digest("hex");
}

/** Build an immutable, project-bound bundle. No Unity process or model is started. */
export function buildUnityBundle(source: string, project: string, revision: string, command = "unity"): string {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Unity revision must be a full Git SHA");
  const root = projectRoot(project);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, ".codex-plugin/plugin.json"), "utf8"));
  if (manifest.name !== "unity") throw new Error("Expected official unity plugin manifest");
  const parent = path.join(root, ".localllm", "unity", "bundles");
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, ".staging-"));
  try {
    copyTree(path.join(source, "skills"), path.join(staging, "skills"));
    copyTree(path.join(source, "LICENSE.md"), path.join(staging, "LICENSE.md"));
    fs.mkdirSync(path.join(staging, ".localllm-plugin"));
    fs.writeFileSync(
      path.join(staging, ".localllm-plugin/plugin.json"),
      JSON.stringify(
        {
          name: "unity",
          version: manifest.version,
          description: "Unity official skills with LocalLLM integration",
          skills: "./skills",
          mcpServers: "./.mcp.json",
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(staging, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            editor: {
              command,
              args: ["mcp", "--project-path", root],
              transport: "stdio",
              permissionLevel: "ask",
            },
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(staging, "source.json"),
      JSON.stringify(
        {
          repository: UNITY_SOURCE,
          revision,
          version: manifest.version,
          project: root,
          command,
          adapterVersion: 2,
        },
        null,
        2,
      ),
    );
    const workflowDir = path.join(staging, "skills", "local-development");
    fs.mkdirSync(workflowDir);
    fs.writeFileSync(
      path.join(workflowDir, "SKILL.md"),
      `---
name: local-development
description: UnityプロジェクトをローカルLLMで編集し、コンパイル・テスト結果を確認する。
---
対象プロジェクトは ${JSON.stringify(root)}。Editor操作では常に --project-path でこのパスを指定する。
まず skill ツールで unity-production を読み、登録済みUnity MCPで接続・対象シーン・保存状態・Consoleを限定的に確認する。CLIの実行成功をMCP利用の前提にしない。未接続・Safe Mode・対象不明なら観測した原因と復旧方法を報告し、変更操作を止める。
公式CLI手順は skill ツールで unity:unity-cli を読む。必要な他の公式スキルも unity: 接頭辞で指定する。
MCPで対応できない操作にCLIが必要な場合は bash ツールで実行し、--project-pathを指定する。スキル内の相対参照はそのスキルのディレクトリを基準に読む。
シーンとアセットは接続中のEditorのCLI/MCPで変更する。操作前に対象を確認し、変更後に保存状態とコンパイル結果を確認する。
テストは公式スキルの unity test を使用し、プロセス終了・レポートを確認する。実行不能とテスト不合格を区別し、実行していない検証を成功と報告しない。
MCPツールが更新されない場合は /mcp reload を案内する。失敗した変更操作を無条件に再実行しない。
MCP画像は保存先が返る。画面確認には vision_analyze と設定済みの画像対応モデルが必要。画像を保存しただけでは画面確認済みとしない。
利用者が実行テストを保留している間はPlayやテストを開始しない。許可済みの実装・保存・静的確認は継続する。入力自動化が使えなければ反復操作に固執せず、操作感の確認をユーザープレイへ残して成果物を仕上げる。
`,
    );
    const plugins = loadPluginBundles([staging]);
    const loaded = loadPluginSkills(plugins);
    const expected = fs
      .readdirSync(path.join(staging, "skills"))
      .filter((name) => fs.existsSync(path.join(staging, "skills", name, "SKILL.md")));
    if (loaded.length !== expected.length || !loaded.some((skill) => skill.name === "unity:unity-cli")) {
      throw new Error(
        `Unity skills incomplete: loaded ${loaded.length}, expected ${expected.length}. Check skill metadata.`,
      );
    }
    const destination = path.join(parent, `${revision}-${digestTree(staging).slice(0, 16)}`);
    if (fs.existsSync(destination)) {
      if (digestTree(destination) !== digestTree(staging)) throw new Error(`Unity bundle modified: ${destination}`);
    } else fs.renameSync(staging, destination);
    return destination;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function setupUnity(project: string, revision = UNITY_REVISION, command = "unity"): string {
  projectRoot(project);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("--revision requires a full Git SHA");
  const git = resolveGitExecutable();
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "localllm-unity-source-"));
  try {
    run(git, ["init", source]);
    run(git, ["-C", source, "fetch", "--depth=1", UNITY_SOURCE, revision]);
    run(git, ["-C", source, "checkout", "--detach", "FETCH_HEAD"]);
    if (run(git, ["-C", source, "rev-parse", "HEAD"]).trim() !== revision) throw new Error("Unity revision mismatch");
    return buildUnityBundle(source, project, revision, command);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}

export function diagnoseUnity(project: string, command = "unity"): Record<string, unknown> {
  const root = projectRoot(project);
  const version = run(command, ["--version"]).trim();
  const status = JSON.parse(run(command, ["status", "--format", "json"], root));
  const instances = status.data?.instances;
  if (status.success !== true || !Array.isArray(instances))
    throw new Error("Unity status unavailable. Run unity doctor --format json.");
  const target = instances.find(
    (instance: { project?: string; state?: string }) => instance.project && path.resolve(instance.project) === root,
  );
  if (!target || target.state !== "ready")
    throw new Error(
      `Unity Editor is not ready for ${root}. Open the project, resolve compile errors and install com.unity.pipeline; then retry doctor.`,
    );
  return { ready: true, project: root, version, editor: target, modelTestExecuted: false };
}

export function runUnityCommand(args: string[]): void {
  const [action, ...rest] = args;
  if (action !== "setup" && action !== "doctor")
    throw new Error(
      "Usage: localllm unity <setup|doctor> --project <path> [--command <unity executable>] [--revision <SHA>]",
    );
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (
      !["--project", "--command", ...(action === "setup" ? ["--revision"] : [])].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options.has(key)
    )
      throw new Error(`Invalid Unity option: ${key}`);
    options.set(key, value);
  }
  const project = options.get("--project");
  if (!project) throw new Error("--project <Unity project path> is required");
  const command = options.get("--command") ?? "unity";
  if (action === "doctor") console.log(JSON.stringify(diagnoseUnity(project, command), null, 2));
  else {
    const bundle = setupUnity(project, options.get("--revision"), command);
    console.log(
      JSON.stringify(
        {
          bundle,
          launchArgs: ["--plugin-dir", bundle],
          next: "Start localllm with launchArgs to enable Unity. setup did not launch Unity or a model.",
          update: "Run setup with --revision <full SHA>; previous bundles remain available for rollback.",
        },
        null,
        2,
      ),
    );
  }
}
