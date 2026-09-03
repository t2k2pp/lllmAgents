import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentLoop } from "../dist/agent/agent-loop.js";
import { loadSession } from "../dist/agent/session-manager.js";
import { PermissionManager } from "../dist/security/permission-manager.js";
import { ToolRegistry } from "../dist/tools/tool-registry.js";

const SELF = fileURLToPath(import.meta.url);
const PHASE = process.argv[2];
const MARKER = process.env.LOCALLLM_DURABLE_SMOKE_MARKER;
const ENDPOINT = { providerType: "openai-compat", model: "restart-smoke-7b", baseUrl: "http://127.0.0.1:18080/v1" };

function securityConfig(toolNames) {
  return {
    allowedDirectories: [],
    blockedCommands: [],
    autoApproveTools: toolNames,
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
}

function provider(reply) {
  const chat = async function* () {
    yield* reply();
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat,
    chatWithTools: chat,
    supportsVision: async () => false,
    chatWithVision: chat,
  };
}

function makeLoop(llm, registry) {
  const loop = new AgentLoop(
    llm,
    "restart-smoke-7b",
    registry,
    new PermissionManager(securityConfig(registry.getToolNames())),
    32_000,
    0.8,
  );
  loop.setLiveBinding(ENDPOINT);
  return loop;
}

async function phase1() {
  if (!MARKER) throw new Error("phase1 marker path missing");
  const registry = new ToolRegistry();
  registry.register({
    name: "restart_probe",
    definition: {
      type: "function",
      function: { name: "restart_probe", description: "restart smoke", parameters: { type: "object", properties: {} } },
    },
    execute: async () => {
      fs.writeFileSync(MARKER, "1", "utf8");
      return { success: true, output: "probe complete" };
    },
  });
  let loop;
  const llm = provider(async function* () {
    loop.requestRunPause("durable");
    yield {
      type: "tool_call",
      toolCall: { id: "restart-call", type: "function", function: { name: "restart_probe", arguments: "{}" } },
    };
    yield { type: "done", finishReason: "tool_calls" };
  });
  loop = makeLoop(llm, registry);
  void loop.run("processを跨いで続ける");
  const started = Date.now();
  while (loop.getRunPauseSnapshot().state !== "paused") {
    if (Date.now() - started > 10_000) throw new Error("durable pause timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const status = loop.getDurableRunCheckpoint();
  if (status.status !== "durable_paused") throw new Error(`unexpected checkpoint state: ${status.status}`);
  process.stdout.write(`SESSION_ID=${loop.getCurrentSessionId()}\n`, () => process.exit(0));
}

async function phase2() {
  if (!MARKER) throw new Error("phase2 marker path missing");
  const sessionId = process.argv[3];
  const session = loadSession(sessionId);
  if (!session) throw new Error(`saved session not found: ${sessionId}`);
  const registry = new ToolRegistry();
  registry.register({
    name: "restart_probe",
    definition: {
      type: "function",
      function: { name: "restart_probe", description: "restart smoke", parameters: { type: "object", properties: {} } },
    },
    execute: async () => {
      const count = Number(fs.readFileSync(MARKER, "utf8")) + 1;
      fs.writeFileSync(MARKER, String(count), "utf8");
      return { success: true, output: "duplicate" };
    },
  });
  let apiCalls = 0;
  const loop = makeLoop(
    provider(async function* () {
      apiCalls++;
      yield { type: "text", text: "再起動後の処理が完了しました。" };
      yield { type: "done", finishReason: "stop" };
    }),
    registry,
  );
  loop.restoreSession(session);
  const resumed = loop.beginDurableRunResume();
  if (resumed.status !== "started") throw new Error(`resume blocked: ${resumed.status} ${resumed.reason ?? ""}`);
  await resumed.continuation;
  if (apiCalls !== 1) throw new Error(`expected one resumed API call, got ${apiCalls}`);
  if (fs.readFileSync(MARKER, "utf8") !== "1") throw new Error("pause前toolが再実行されました");
  if (loop.getDurableRunCheckpoint().status !== "none") throw new Error("completed checkpoint was not cleared");
  console.log("DURABLE_RESTART_OK");
}

function runChild(args, environment) {
  return spawnSync(process.execPath, [SELF, ...args], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function childFailure(label, result) {
  return new Error(
    `${label} failed (status=${result.status}, signal=${result.signal})\n${result.stdout}\n${result.stderr}`,
  );
}

async function parent() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "localllm-durable-restart-"));
  const marker = path.join(temp, "tool-count.txt");
  const environment = { ...process.env, HOME: temp, USERPROFILE: temp, LOCALLLM_DURABLE_SMOKE_MARKER: marker };
  let failure;
  try {
    const first = runChild(["--phase1"], environment);
    if (first.status !== 0) throw childFailure("phase1", first);
    const match = first.stdout.match(/SESSION_ID=([^\r\n]+)/);
    if (!match) throw new Error(`phase1 did not report session id\n${first.stdout}\n${first.stderr}`);
    const second = runChild(["--phase2", match[1]], environment);
    if (second.status !== 0) throw childFailure("phase2", second);
    if (!second.stdout.includes("DURABLE_RESTART_OK"))
      throw new Error(`phase2 completion marker missing\n${second.stdout}`);
    console.log("durable run cross-process restart smoke: OK");
  } catch (error) {
    failure = error;
  }
  const resolvedTemp = fs.realpathSync.native(temp);
  const resolvedRoot = fs.realpathSync.native(os.tmpdir());
  if (
    !resolvedTemp.startsWith(`${resolvedRoot}${path.sep}`) ||
    !path.basename(resolvedTemp).startsWith("localllm-durable-restart-")
  ) {
    failure ??= new Error(`refusing to remove unexpected smoke directory: ${resolvedTemp}`);
  } else {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

if (PHASE === "--phase1") await phase1();
else if (PHASE === "--phase2") await phase2();
else await parent();
